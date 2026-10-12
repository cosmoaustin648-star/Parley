/**
 * Voice & video engine (WebRTC full mesh).
 *
 * Signaling goes through the gateway (voice_join / voice_signal ops). Each pair
 * of participants has one RTCPeerConnection using the "perfect negotiation"
 * pattern so either side can renegotiate (camera/screen on and off).
 *
 * Outgoing audio runs through WebAudio: mic → input gain → gate → destination.
 * The gate implements voice activity detection or push-to-talk, and the
 * analyser drives speaking indicators.
 */
import { useSyncExternalStore } from 'react';
import { send, onGateway } from '../lib/gateway.ts';
import { getState, setState, toast } from '../lib/store.ts';
import { playTone } from '../lib/notify.ts';
import type { VoiceState } from '../lib/types.ts';

type Kind = 'audio' | 'camera' | 'screen';
type ConnStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface PeerView { state: RTCPeerConnectionState | 'new'; camera: MediaStream | null; screen: MediaStream | null; hasAudio: boolean }
export interface VoiceSnapshot {
  channelId: string | null;
  status: ConnStatus;
  selfMute: boolean;
  selfDeaf: boolean;
  camera: boolean;
  screen: boolean;
  micAvailable: boolean;
  canVideo: boolean;
  speaking: Record<string, boolean>;
  peers: Record<string, PeerView>;
  localCamera: MediaStream | null;
  localScreen: MediaStream | null;
  inputLevel: number;
  pttActive: boolean;
  volumes: Record<string, number>;
}

interface Peer {
  userId: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  kinds: Record<string, Kind>; // remote stream id → kind
  audioEl: HTMLAudioElement | null;
  audioStream: MediaStream | null;
  analyser: AnalyserNode | null;
  senders: Map<MediaStreamTrack, RTCRtpSender>;
  pendingCandidates: RTCIceCandidateInit[];
}

const VOL_KEY = 'parley.userVolumes';

class VoiceEngine {
  private snap: VoiceSnapshot = {
    channelId: null, status: 'idle', selfMute: false, selfDeaf: false, camera: false, screen: false, micAvailable: true, canVideo: true,
    speaking: {}, peers: {}, localCamera: null, localScreen: null, inputLevel: 0, pttActive: false, volumes: loadVolumes(),
  };
  private listeners = new Set<() => void>();
  private peers = new Map<string, Peer>();
  private iceServers: RTCIceServer[] = [];
  private ac: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private inputGain: GainNode | null = null;
  private gate: GainNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private outTrack: MediaStreamTrack | null = null;
  private outStream: MediaStream | null = null;
  private meter: ReturnType<typeof setInterval> | null = null;
  private gateOpenUntil = 0;
  private wantChannel: string | null = null;
  private testing = false;

  constructor() {
    onGateway('VOICE_READY', (d) => void this.onReady(d));
    onGateway('VOICE_SIGNAL', (d) => void this.onSignal(d.from, d.data));
    onGateway('VOICE_STATE_UPDATE', (d) => this.onStateUpdate(d));
    onGateway('VOICE_DISCONNECTED', (d) => {
      const reason = d.reason === 'moderator' ? 'A moderator disconnected you from voice.' : d.reason === 'permissions' ? 'You no longer have access to that voice channel.' : 'You were removed from voice.';
      this.cleanup();
      toast(reason, 'info');
    });
    onGateway('ERROR', (d) => {
      if (d.op === 'voice_join') { this.cleanup(); }
      if (d.op === 'voice_state' && (this.snap.camera || this.snap.screen)) { void this.setCamera(false); void this.setScreen(false); }
    });
    onGateway('DISCONNECTED', () => {
      if (this.snap.channelId) {
        // Server dropped our voice session with the socket; rejoin once the gateway is back.
        this.wantChannel = this.snap.channelId;
        this.closePeers();
        this.set({ status: 'reconnecting', peers: {}, speaking: {} });
      }
    });
    onGateway('READY', () => {
      if (this.wantChannel) {
        const ch = this.wantChannel;
        this.wantChannel = null;
        this.set({ channelId: null });
        void this.join(ch, true);
      }
    });
  }

  /* ───── store plumbing ───── */
  get = () => this.snap;
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  private set(p: Partial<VoiceSnapshot>) {
    this.snap = { ...this.snap, ...p };
    for (const l of this.listeners) l();
  }
  private setPeer(userId: string, p: Partial<PeerView>) {
    const cur = this.snap.peers[userId] ?? { state: 'new', camera: null, screen: null, hasAudio: false };
    this.set({ peers: { ...this.snap.peers, [userId]: { ...cur, ...p } } });
  }

  private settings() { return getState().me?.settings.voice ?? {}; }
  private myId() { return getState().me?.id ?? ''; }

  /* ───── microphone pipeline ───── */
  private audioCtx() {
    if (!this.ac) this.ac = new AudioContext();
    if (this.ac.state === 'suspended') void this.ac.resume();
    return this.ac;
  }

  private async startMic(): Promise<boolean> {
    this.stopMic();
    const v = this.settings();
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: v.input_device ? { ideal: v.input_device } : undefined,
          noiseSuppression: v.noise_suppression ?? true,
          echoCancellation: v.echo_cancellation ?? true,
          autoGainControl: v.auto_gain ?? true,
        },
      });
    } catch (e: any) {
      const name = e?.name;
      const msg = name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in your browser’s site settings to talk — you can still listen.'
        : name === 'NotFoundError' ? 'No microphone was found. You joined in listen-only mode.'
        : `Couldn't start your microphone (${e?.message || name}). You can still listen.`;
      toast(msg, 'error');
      this.set({ micAvailable: false });
      return false;
    }
    const ac = this.audioCtx();
    this.micSource = ac.createMediaStreamSource(this.micStream);
    this.inputGain = ac.createGain();
    this.inputGain.gain.value = (v.input_volume ?? 100) / 100;
    this.gate = ac.createGain();
    this.gate.gain.value = 0;
    this.micAnalyser = ac.createAnalyser();
    this.micAnalyser.fftSize = 512;
    const dest = ac.createMediaStreamDestination();
    this.micSource.connect(this.inputGain);
    this.inputGain.connect(this.micAnalyser);
    this.inputGain.connect(this.gate);
    this.gate.connect(dest);
    this.outStream = dest.stream;
    this.outTrack = dest.stream.getAudioTracks()[0];
    this.set({ micAvailable: true });
    this.applyMuteToTrack();
    this.startMeter();
    return true;
  }

  private stopMic() {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micSource?.disconnect();
    this.inputGain?.disconnect();
    this.gate?.disconnect();
    this.micStream = null; this.micSource = null; this.inputGain = null; this.gate = null; this.micAnalyser = null;
    this.outTrack = null; this.outStream = null;
  }

  private serverMuted() {
    const me = getState().voice[this.myId()];
    return !!me && (me.server_mute || me.suppress);
  }
  private effectiveMuted() { return this.snap.selfMute || this.snap.selfDeaf || this.serverMuted(); }
  private applyMuteToTrack() { if (this.outTrack) this.outTrack.enabled = !this.effectiveMuted(); }

  private level(an: AnalyserNode | null): number {
    if (!an) return 0;
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    const rms = Math.sqrt(sum / buf.length);
    const db = 20 * Math.log10(rms || 1e-8); // -∞..0
    return Math.max(0, Math.min(100, (db + 80) * 1.25)); // -80dB→0, 0dB→100
  }

  private startMeter() {
    if (this.meter) return;
    this.meter = setInterval(() => this.tick(), 60);
  }

  private tick() {
    const v = this.settings();
    const lvl = this.level(this.micAnalyser);
    const threshold = v.vad_threshold ?? 40;
    const now = performance.now();
    let open: boolean;
    if ((v.input_mode ?? 'voice') === 'ptt') open = this.snap.pttActive;
    else { if (lvl >= threshold) this.gateOpenUntil = now + 350; open = now < this.gateOpenUntil; }
    if (this.gate && this.ac) this.gate.gain.setTargetAtTime(open ? 1 : 0, this.ac.currentTime, 0.015);

    const speaking: Record<string, boolean> = {};
    const me = this.myId();
    if (this.snap.channelId || this.testing) speaking[me] = open && !this.effectiveMuted() && !!this.micStream && (this.testing || lvl > 5);
    for (const p of this.peers.values()) {
      const vs = getState().voice[p.userId];
      speaking[p.userId] = !!p.analyser && !vs?.self_mute && !vs?.server_mute && this.level(p.analyser) > 30;
    }
    const changed = Object.keys(speaking).length !== Object.keys(this.snap.speaking).length || Object.entries(speaking).some(([k, x]) => this.snap.speaking[k] !== x);
    if (changed || Math.abs(lvl - this.snap.inputLevel) > 2) this.set({ speaking: changed ? speaking : this.snap.speaking, inputLevel: lvl });
  }

  /* ───── joining & leaving ───── */
  async join(channelId: string, silent = false) {
    if (this.snap.channelId === channelId && this.snap.status !== 'reconnecting') return;
    if (this.snap.channelId) this.leave(true);
    this.set({ channelId, status: 'connecting', peers: {}, speaking: {} });
    if (!this.micStream) await this.startMic();
    const ok = send('voice_join', { channel_id: channelId, self_mute: this.snap.selfMute, self_deaf: this.snap.selfDeaf });
    if (!ok) { this.wantChannel = channelId; this.set({ status: 'reconnecting' }); }
    if (!silent) playTone('join');
  }

  leave(silent = false) {
    if (!this.snap.channelId && !this.wantChannel) return;
    send('voice_leave');
    this.cleanup();
    if (!silent) playTone('leave');
  }

  private cleanup() {
    this.wantChannel = null;
    this.closePeers();
    this.stopCameraTracks(); this.stopScreenTracks();
    if (!this.testing) {
      this.stopMic();
      if (this.meter) { clearInterval(this.meter); this.meter = null; }
    }
    this.set({ channelId: null, status: 'idle', peers: {}, speaking: {}, camera: false, screen: false, localCamera: null, localScreen: null });
  }

  private closePeers() {
    for (const p of this.peers.values()) this.closePeer(p);
    this.peers.clear();
  }
  private closePeer(p: Peer) {
    try { p.pc.close(); } catch { /* ignore */ }
    if (p.audioEl) { p.audioEl.srcObject = null; p.audioEl.remove(); }
    this.peers.delete(p.userId);
    const peers = { ...this.snap.peers }; delete peers[p.userId];
    this.set({ peers });
  }

  private async onReady(d: { channel_id: string; peers: string[]; ice_servers: RTCIceServer[]; can_video: boolean }) {
    if (this.snap.channelId && this.snap.channelId !== d.channel_id) {
      // Moved by a moderator into another channel.
      this.closePeers();
      toast('You were moved to another voice channel.', 'info');
    }
    this.iceServers = d.ice_servers;
    this.set({ channelId: d.channel_id, status: 'connected', canVideo: d.can_video });
    for (const uid of d.peers) this.ensurePeer(uid);
  }

  private ensurePeer(userId: string): Peer {
    let p = this.peers.get(userId);
    if (p) return p;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    p = {
      userId, pc, polite: BigInt(this.myId()) > BigInt(userId), makingOffer: false, ignoreOffer: false, kinds: {},
      audioEl: null, audioStream: null, analyser: null, senders: new Map(), pendingCandidates: [],
    };
    this.peers.set(userId, p);
    this.setPeer(userId, { state: 'new' });
    const peer = p;

    pc.onicecandidate = ({ candidate }) => { if (candidate) this.signal(userId, { candidate: candidate.toJSON() }); };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(userId, { description: pc.localDescription?.toJSON(), kinds: this.localKinds() });
      } catch (e) { console.warn('[voice] negotiation failed', e); }
      finally { peer.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => {
      this.setPeer(userId, { state: pc.connectionState });
      if (pc.connectionState === 'failed') pc.restartIce();
    };
    pc.ontrack = (e) => this.onTrack(peer, e);

    if (this.outTrack && this.outStream) peer.senders.set(this.outTrack, pc.addTrack(this.outTrack, this.outStream));
    for (const s of [this.snap.localCamera, this.snap.localScreen]) {
      if (s) for (const t of s.getTracks()) peer.senders.set(t, pc.addTrack(t, s));
    }
    // Make sure we can receive audio even if we have no microphone.
    if (!this.outTrack) pc.addTransceiver('audio', { direction: 'recvonly' });
    return peer;
  }

  private localKinds(): Record<string, Kind> {
    const k: Record<string, Kind> = {};
    if (this.outStream) k[this.outStream.id] = 'audio';
    if (this.snap.localCamera) k[this.snap.localCamera.id] = 'camera';
    if (this.snap.localScreen) k[this.snap.localScreen.id] = 'screen';
    return k;
  }

  private signal(to: string, data: Record<string, unknown>) { send('voice_signal', { to, data }); }

  private async onSignal(from: string, data: any) {
    if (!this.snap.channelId) return;
    const p = this.ensurePeer(from);
    if (data.kinds) { p.kinds = { ...p.kinds, ...data.kinds }; this.refreshRemoteVideo(p); }
    try {
      if (data.description) {
        const desc = data.description as RTCSessionDescriptionInit;
        const collision = desc.type === 'offer' && (p.makingOffer || p.pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await p.pc.setRemoteDescription(desc);
        for (const c of p.pendingCandidates.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
        if (desc.type === 'offer') {
          await p.pc.setLocalDescription();
          this.signal(from, { description: p.pc.localDescription?.toJSON(), kinds: this.localKinds() });
        }
      } else if (data.candidate) {
        if (!p.pc.remoteDescription) p.pendingCandidates.push(data.candidate);
        else await p.pc.addIceCandidate(data.candidate).catch((e) => { if (!p.ignoreOffer) throw e; });
      }
    } catch (e) { console.warn('[voice] signal error', e); }
  }

  private onTrack(p: Peer, e: RTCTrackEvent) {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    if (e.track.kind === 'audio') {
      p.audioStream = stream;
      if (!p.audioEl) {
        p.audioEl = document.createElement('audio');
        p.audioEl.autoplay = true;
        p.audioEl.dataset.peer = p.userId;
        p.audioEl.style.display = 'none';
        document.body.appendChild(p.audioEl);
      }
      p.audioEl.srcObject = stream;
      this.applyOutput(p);
      void p.audioEl.play().catch(() => { /* autoplay will resume on next interaction */ });
      try {
        const ac = this.audioCtx();
        const src = ac.createMediaStreamSource(stream);
        p.analyser = ac.createAnalyser();
        p.analyser.fftSize = 512;
        src.connect(p.analyser);
      } catch { /* analyser optional */ }
      this.setPeer(p.userId, { hasAudio: true });
      this.startMeter();
    } else {
      this.trackStream.set(e.track, stream.id);
      stream.onremovetrack = () => this.refreshRemoteVideo(p);
      e.track.onended = () => this.refreshRemoteVideo(p);
      e.track.onmute = () => this.refreshRemoteVideo(p);
      e.track.onunmute = () => this.refreshRemoteVideo(p);
      this.refreshRemoteVideo(p);
    }
  }

  private trackStream = new WeakMap<MediaStreamTrack, string>();

  /** Recompute a peer's visible camera/screen streams from live receiving transceivers. */
  private refreshRemoteVideo(p: Peer) {
    let camera: MediaStream | null = null, screen: MediaStream | null = null;
    for (const tr of p.pc.getTransceivers()) {
      const t = tr.receiver.track;
      if (!t || t.kind !== 'video' || t.readyState !== 'live' || t.muted) continue;
      if (tr.currentDirection && tr.currentDirection !== 'recvonly' && tr.currentDirection !== 'sendrecv') continue;
      const sid = this.trackStream.get(t);
      const kind: Kind = (sid && p.kinds[sid]) || 'camera';
      if (kind === 'screen') screen = new MediaStream([t]); else camera = new MediaStream([t]);
    }
    const vs = getState().voice[p.userId];
    const cur = this.snap.peers[p.userId];
    const same = (a: MediaStream | null | undefined, b: MediaStream | null) => (a?.getTracks()[0] ?? null) === (b?.getTracks()[0] ?? null);
    const nextCam = vs && !vs.self_video ? null : camera;
    const nextScr = vs && !vs.self_stream ? null : screen;
    if (cur && same(cur.camera, nextCam) && same(cur.screen, nextScr)) return;
    this.setPeer(p.userId, { camera: nextCam, screen: nextScr });
  }

  private onStateUpdate(d: VoiceState & { channel_id: string | null }) {
    const me = this.myId();
    if (d.user_id === me) {
      this.applyMuteToTrack();
      if (d.server_deaf && !this.snap.selfDeaf) for (const p of this.peers.values()) this.applyOutput(p);
      return;
    }
    const p = this.peers.get(d.user_id);
    if (p && d.channel_id !== this.snap.channelId) { this.closePeer(p); return; }
    if (p) { this.applyOutput(p); this.refreshRemoteVideo(p); }
  }

  /* ───── output ───── */
  private applyOutput(p: Peer) {
    if (!p.audioEl) return;
    const meVs = getState().voice[this.myId()];
    const them = getState().voice[p.userId];
    const deaf = this.snap.selfDeaf || !!meVs?.server_deaf;
    p.audioEl.muted = deaf || !!them?.server_mute;
    const out = (this.settings().output_volume ?? 100) / 100;
    const per = (this.snap.volumes[p.userId] ?? 100) / 100;
    p.audioEl.volume = Math.max(0, Math.min(1, out * per));
    const sink = this.settings().output_device;
    if (sink && 'setSinkId' in p.audioEl) (p.audioEl as any).setSinkId(sink).catch(() => {});
  }

  setUserVolume(userId: string, v: number) {
    const volumes = { ...this.snap.volumes, [userId]: v };
    try { localStorage.setItem(VOL_KEY, JSON.stringify(volumes)); } catch { /* ignore */ }
    this.set({ volumes });
    const p = this.peers.get(userId);
    if (p) this.applyOutput(p);
  }

  /* ───── controls ───── */
  toggleMute() {
    const selfMute = !this.snap.selfMute;
    // Unmuting while deafened also undeafens (like most voice apps).
    const selfDeaf = selfMute ? this.snap.selfDeaf : false;
    this.set({ selfMute, selfDeaf });
    this.applyMuteToTrack();
    for (const p of this.peers.values()) this.applyOutput(p);
    playTone(selfMute ? 'mute' : 'unmute');
    if (this.snap.channelId) send('voice_state', { self_mute: selfMute, self_deaf: selfDeaf });
  }

  toggleDeafen() {
    const selfDeaf = !this.snap.selfDeaf;
    this.set({ selfDeaf, selfMute: selfDeaf ? this.snap.selfMute : this.snap.selfMute });
    this.applyMuteToTrack();
    for (const p of this.peers.values()) this.applyOutput(p);
    playTone(selfDeaf ? 'mute' : 'unmute');
    if (this.snap.channelId) send('voice_state', { self_mute: this.snap.selfMute, self_deaf: selfDeaf });
  }

  ptt(active: boolean) { if (this.snap.pttActive !== active) this.set({ pttActive: active }); }

  private addLocalTracks(stream: MediaStream) {
    for (const p of this.peers.values()) for (const t of stream.getTracks()) p.senders.set(t, p.pc.addTrack(t, stream));
  }
  private removeLocalTracks(stream: MediaStream | null) {
    if (!stream) return;
    for (const p of this.peers.values()) for (const t of stream.getTracks()) {
      const s = p.senders.get(t);
      if (s) { try { p.pc.removeTrack(s); } catch { /* closed */ } p.senders.delete(t); }
    }
  }
  private stopCameraTracks() { this.removeLocalTracks(this.snap.localCamera); this.snap.localCamera?.getTracks().forEach((t) => t.stop()); }
  private stopScreenTracks() { this.removeLocalTracks(this.snap.localScreen); this.snap.localScreen?.getTracks().forEach((t) => t.stop()); }

  async setCamera(on: boolean) {
    if (!this.snap.channelId) return;
    if (!on) {
      this.stopCameraTracks();
      this.set({ camera: false, localCamera: null });
      send('voice_state', { self_video: false });
      return;
    }
    if (!this.snap.canVideo) { toast("You don't have permission to use video in this channel.", 'error'); return; }
    try {
      const dev = this.settings().video_device;
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: dev ? { ideal: dev } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
      this.set({ camera: true, localCamera: s });
      send('voice_state', { self_video: true });
      this.addLocalTracks(s);
    } catch (e: any) {
      toast(e?.name === 'NotAllowedError' ? 'Camera access is blocked. Allow it in your browser’s site settings.' : e?.name === 'NotFoundError' ? 'No camera was found.' : `Couldn't start your camera: ${e?.message || e}`, 'error');
    }
  }

  async setScreen(on: boolean) {
    if (!this.snap.channelId) return;
    if (!on) {
      this.stopScreenTracks();
      this.set({ screen: false, localScreen: null });
      send('voice_state', { self_stream: false });
      return;
    }
    if (!this.snap.canVideo) { toast("You don't have permission to share your screen here.", 'error'); return; }
    if (!navigator.mediaDevices.getDisplayMedia) { toast('Screen sharing is not supported in this browser.', 'error'); return; }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
      s.getVideoTracks()[0].onended = () => void this.setScreen(false);
      this.set({ screen: true, localScreen: s });
      send('voice_state', { self_stream: true });
      this.addLocalTracks(s);
    } catch (e: any) {
      if (e?.name !== 'NotAllowedError') toast(`Couldn't share your screen: ${e?.message || e}`, 'error');
    }
  }

  /** Re-open the mic with new device/processing settings (from Voice & Video settings). */
  async applyDeviceSettings() {
    for (const p of this.peers.values()) this.applyOutput(p);
    if (!this.micStream) return;
    const oldTrack = this.outTrack;
    await this.startMic();
    if (this.outTrack && this.outStream) {
      for (const p of this.peers.values()) {
        const sender = oldTrack ? p.senders.get(oldTrack) : undefined;
        if (sender) { await sender.replaceTrack(this.outTrack); p.senders.delete(oldTrack!); p.senders.set(this.outTrack, sender); }
        else p.senders.set(this.outTrack, p.pc.addTrack(this.outTrack, this.outStream));
      }
    }
  }

  /** Diagnostics: per-peer connection state and received media bytes (used by tests and the debug console). */
  async stats() {
    const out: Record<string, { state: string; audioBytesIn: number; videoBytesIn: number; audioBytesOut: number }> = {};
    for (const p of this.peers.values()) {
      let audioBytesIn = 0, videoBytesIn = 0, audioBytesOut = 0;
      const report = await p.pc.getStats();
      report.forEach((r: any) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') audioBytesIn += r.bytesReceived ?? 0;
        if (r.type === 'inbound-rtp' && r.kind === 'video') videoBytesIn += r.bytesReceived ?? 0;
        if (r.type === 'outbound-rtp' && r.kind === 'audio') audioBytesOut += r.bytesSent ?? 0;
      });
      out[p.userId] = { state: p.pc.connectionState, audioBytesIn, videoBytesIn, audioBytesOut };
    }
    return out;
  }

  setInputVolume(v: number) { if (this.inputGain) this.inputGain.gain.value = v / 100; }

  /** Mic test in settings: run the pipeline without joining. */
  async startTest() {
    this.testing = true;
    if (!this.micStream) await this.startMic();
  }
  stopTest() {
    this.testing = false;
    if (!this.snap.channelId) { this.stopMic(); if (this.meter) { clearInterval(this.meter); this.meter = null; } this.set({ inputLevel: 0 }); }
  }
}

function loadVolumes(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(VOL_KEY) || '{}'); } catch { return {}; }
}

export const voice = new VoiceEngine();
(window as any).__parleyVoice = voice;

export function useVoice<T>(sel: (s: VoiceSnapshot) => T): T {
  return useSyncExternalStore(voice.subscribe, () => sel(voice.get()));
}

/** Keep store-derived audio state in sync when my voice state changes. */
export function voiceChannelOf(userId: string) { return getState().voice[userId]?.channel_id ?? null; }
export { setState };
