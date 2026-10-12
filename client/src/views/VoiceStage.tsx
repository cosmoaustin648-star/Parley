import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LuMic, LuMicOff, LuHeadphones, LuHeadphoneOff, LuVideo, LuVideoOff, LuMonitorUp, LuMonitorX, LuPhoneOff, LuVolume2, LuMaximize2, LuMinimize2, LuTriangleAlert, LuMenu,
} from 'react-icons/lu';
import { useStore, displayName, setUi } from '../lib/store.ts';
import { voice, useVoice } from '../voice/engine.ts';
import type { User, VoiceState } from '../lib/types.ts';
import { Avatar, Button, cx, Popover, Spinner } from '../components/ui.tsx';
import { P, has } from '../../../shared/permissions.ts';

function Video({ stream, mirror, contain }: { stream: MediaStream; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) { ref.current.srcObject = stream; void ref.current.play().catch(() => {}); } }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className={cx('absolute inset-0 size-full bg-black', contain ? 'object-contain' : 'object-cover', mirror && '-scale-x-100')} />;
}

interface Tile { key: string; userId: string; kind: 'person' | 'screen'; stream: MediaStream | null; mirror?: boolean }

export function VoiceStage({ channelId, compact }: { channelId: string; compact?: boolean }) {
  const states = useStore((s) => s.voice);
  const users = useStore((s) => s.users);
  const channel = useStore((s) => s.channels[channelId] ?? s.dms[channelId]);
  const meId = useStore((s) => s.me?.id)!;
  const me = useStore((s) => s.me)!;
  const v = useVoice((x) => x);
  const [focus, setFocus] = useState<string | null>(null);
  const [volumeFor, setVolumeFor] = useState<{ userId: string; at: { x: number; y: number } } | null>(null);
  const connected = v.channelId === channelId;
  const participants = useMemo(() => Object.values(states).filter((s) => s.channel_id === channelId).sort((a, b) => a.joined_at - b.joined_at), [states, channelId]);

  const tiles: Tile[] = [];
  if (connected) {
    for (const p of participants) {
      if (p.user_id === meId) {
        tiles.push({ key: `${meId}:person`, userId: meId, kind: 'person', stream: v.localCamera, mirror: true });
        if (v.localScreen) tiles.push({ key: `${meId}:screen`, userId: meId, kind: 'screen', stream: v.localScreen });
      } else {
        const pv = v.peers[p.user_id];
        tiles.push({ key: `${p.user_id}:person`, userId: p.user_id, kind: 'person', stream: pv?.camera ?? null });
        if (pv?.screen) tiles.push({ key: `${p.user_id}:screen`, userId: p.user_id, kind: 'screen', stream: pv.screen });
      }
    }
  }
  useEffect(() => { if (focus && !tiles.some((t) => t.key === focus)) setFocus(null); });
  // A new screen share takes the spotlight automatically.
  const screenKey = tiles.find((t) => t.kind === 'screen' && t.userId !== meId)?.key;
  useEffect(() => { if (screenKey) setFocus(screenKey); }, [screenKey]);

  if (!channel) return null;
  const perms = channel.my_permissions ?? (channel.server_id ? 0 : 0xffffff);
  const canConnect = !channel.server_id || has(perms, P.CONNECT);

  if (!connected) {
    if (compact) {
      return (
        <div className="shrink-0 flex items-center gap-3 px-4 py-3 bg-rail border-b border-line">
          <div className="flex -space-x-2">{participants.slice(0, 5).map((p) => <Avatar key={p.user_id} user={users[p.user_id] ?? null} size={28} className="ring-2 ring-rail rounded-full" />)}</div>
          <span className="flex-1 text-sm text-muted">A call is in progress.</span>
          <Button size="sm" onClick={() => void voice.join(channelId)}>Join call</Button>
        </div>
      );
    }
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-5 p-6 bg-rail text-center">
        <IconMenuMobile />
        <div className="flex flex-wrap justify-center gap-4 max-w-xl">
          {participants.map((p) => (
            <div key={p.user_id} className="flex flex-col items-center gap-1.5 w-24">
              <Avatar user={users[p.user_id] ?? null} size={64} />
              <span className="text-sm truncate w-full">{displayName(users[p.user_id], channel.server_id)}</span>
            </div>
          ))}
        </div>
        <div>
          <h2 className="font-display text-2xl font-bold">{channel.name}</h2>
          <p className="text-muted mt-1">{participants.length ? `${participants.length} ${participants.length === 1 ? 'person is' : 'people are'} here.` : 'No one is here yet.'}</p>
        </div>
        {canConnect ? <Button size="lg" onClick={() => void voice.join(channelId)}>Join voice</Button>
          : <p className="text-sm text-muted">You don't have permission to join this voice channel.</p>}
      </div>
    );
  }

  const focused = focus ? tiles.find((t) => t.key === focus) : null;
  const others = focused ? tiles.filter((t) => t !== focused) : tiles;
  const cols = tiles.length <= 1 ? 1 : tiles.length <= 4 ? 2 : 3;

  return (
    <div className={cx('flex flex-col bg-rail min-h-0', compact ? 'h-[22rem] shrink-0 border-b border-line' : 'flex-1')}>
      {!compact && <div className="md:hidden p-2"><IconMenuMobile /></div>}
      <div className="flex-1 min-h-0 p-3 flex flex-col gap-3">
        {focused ? (
          <>
            <div className="flex-1 min-h-0"><TileView t={focused} state={states[focused.userId]} user={users[focused.userId] ?? (focused.userId === meId ? me : null)} serverId={channel.server_id} focused onFocus={() => setFocus(null)} onVolume={(at) => setVolumeFor({ userId: focused.userId, at })} isMe={focused.userId === meId} /></div>
            {others.length > 0 && (
              <div className="h-28 shrink-0 flex gap-3 overflow-x-auto">
                {others.map((t) => <div key={t.key} className="w-44 shrink-0"><TileView t={t} state={states[t.userId]} user={users[t.userId] ?? (t.userId === meId ? me : null)} serverId={channel.server_id} onFocus={() => setFocus(t.key)} onVolume={(at) => setVolumeFor({ userId: t.userId, at })} isMe={t.userId === meId} small /></div>)}
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 min-h-0 grid gap-3 content-center" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {tiles.map((t) => (
              <div key={t.key} className="aspect-video min-h-0">
                <TileView t={t} state={states[t.userId]} user={users[t.userId] ?? (t.userId === meId ? me : null)} serverId={channel.server_id} onFocus={() => setFocus(t.key)} onVolume={(at) => setVolumeFor({ userId: t.userId, at })} isMe={t.userId === meId} />
              </div>
            ))}
            {v.status !== 'connected' && <div className="col-span-full flex justify-center"><Spinner /></div>}
          </div>
        )}
      </div>
      <Controls />
      {volumeFor && (
        <Popover anchor={volumeFor.at} onClose={() => setVolumeFor(null)} className="p-4 w-64">
          <label className="text-sm font-semibold flex justify-between">User volume <span className="tabular-nums text-muted">{v.volumes[volumeFor.userId] ?? 100}%</span></label>
          <input type="range" min={0} max={100} value={v.volumes[volumeFor.userId] ?? 100} className="w-full mt-2 accent-[var(--c-accent)]"
            onChange={(e: any) => voice.setUserVolume(volumeFor.userId, Number(e.target.value))} aria-label="User volume" />
          <p className="text-xs text-muted mt-2">Only changes how loud they are for you.</p>
        </Popover>
      )}
    </div>
  );
}

function IconMenuMobile() {
  return <button className="md:hidden self-start text-muted" aria-label="Open navigation" onClick={() => setUi({ mobileNav: true })}><LuMenu size={22} /></button>;
}

function TileView({ t, state, user, serverId, focused, small, onFocus, onVolume, isMe }: {
  t: Tile; state?: VoiceState; user: User | null; serverId: string | null; focused?: boolean; small?: boolean; onFocus: () => void; onVolume: (at: { x: number; y: number }) => void; isMe: boolean;
}) {
  const speaking = useVoice((v) => !!v.speaking[t.userId]);
  const peerState = useVoice((v) => v.peers[t.userId]?.state);
  const name = user ? displayName(user, serverId) : 'Someone';
  const failing = !isMe && (peerState === 'failed' || peerState === 'disconnected');
  const connecting = !isMe && (peerState === 'new' || peerState === 'connecting');
  return (
    <div role="button" tabIndex={0} onClick={onFocus} onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') onFocus(); }}
      onContextMenu={(e: MouseEvent) => { if (!isMe) { e.preventDefault(); onVolume({ x: e.clientX, y: e.clientY }); } }}
      aria-label={`${name}${t.kind === 'screen' ? ' screen share' : ''}`}
      className={cx('group relative size-full rounded-xl overflow-hidden bg-side cursor-pointer outline-offset-2 transition-shadow',
        speaking && t.kind === 'person' && 'ring-2 ring-ok')}>
      {t.stream ? <Video stream={t.stream} mirror={t.mirror} contain={t.kind === 'screen'} /> : (
        <div className="absolute inset-0 grid place-items-center" style={{ background: user?.accent_color ? `color-mix(in srgb, ${user.accent_color} 35%, var(--c-side))` : undefined }}>
          <Avatar user={user} size={small ? 44 : focused ? 112 : 72} speaking={speaking} />
        </div>
      )}
      <div className="absolute left-2 bottom-2 flex items-center gap-1.5 max-w-[calc(100%-1rem)] rounded-md bg-black/60 text-white px-2 h-7 text-[0.8rem]">
        {(state?.self_mute || state?.server_mute || state?.suppress) && <LuMicOff size={14} className={state?.server_mute ? 'text-danger' : ''} aria-label="Muted" />}
        {(state?.self_deaf || state?.server_deaf) && <LuHeadphoneOff size={14} aria-label="Deafened" />}
        <span className="truncate">{t.kind === 'screen' ? `${name}'s screen` : name}{isMe && t.kind === 'person' ? ' (you)' : ''}</span>
      </div>
      {(failing || connecting) && (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-black/60 text-white px-2 h-7 text-xs" data-tip={failing ? "Couldn't establish a direct connection. A TURN relay server may be required on restrictive networks." : undefined}>
          {failing ? <><LuTriangleAlert className="text-warn" /> Can't connect</> : <><Spinner className="size-3 text-white" /> Connecting</>}
        </div>
      )}
      <span className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 rounded-md bg-black/60 text-white p-1.5" aria-hidden>
        {focused ? <LuMinimize2 size={14} /> : <LuMaximize2 size={14} />}
      </span>
      {!isMe && !small && (
        <button aria-label={`Volume for ${name}`} className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 rounded-md bg-black/60 text-white p-1.5"
          onClick={(e: MouseEvent) => { e.stopPropagation(); onVolume({ x: e.clientX, y: e.clientY }); }}><LuVolume2 size={14} /></button>
      )}
    </div>
  );
}

function Controls() {
  const v = useVoice((x) => x);
  const btn = (on: boolean, danger?: boolean) => cx('size-12 rounded-full grid place-items-center transition-colors',
    danger ? 'bg-danger text-white hover:brightness-110' : on ? 'bg-fg text-deck' : 'bg-side text-fg hover:bg-active');
  return (
    <div className="shrink-0 flex items-center justify-center gap-3 py-3" role="toolbar" aria-label="Call controls">
      <button className={btn(v.selfMute)} aria-pressed={v.selfMute} aria-label={v.selfMute ? 'Unmute' : 'Mute'} data-tip={v.selfMute ? 'Unmute' : 'Mute'} onClick={() => voice.toggleMute()}>
        {v.selfMute ? <LuMicOff size={20} /> : <LuMic size={20} />}
      </button>
      <button className={btn(v.selfDeaf)} aria-pressed={v.selfDeaf} aria-label={v.selfDeaf ? 'Undeafen' : 'Deafen'} data-tip={v.selfDeaf ? 'Undeafen' : 'Deafen'} onClick={() => voice.toggleDeafen()}>
        {v.selfDeaf ? <LuHeadphoneOff size={20} /> : <LuHeadphones size={20} />}
      </button>
      <button className={btn(v.camera)} aria-pressed={v.camera} aria-label={v.camera ? 'Turn off camera' : 'Turn on camera'} data-tip={v.camera ? 'Turn off camera' : 'Turn on camera'} disabled={!v.canVideo} onClick={() => void voice.setCamera(!v.camera)}>
        {v.camera ? <LuVideoOff size={20} /> : <LuVideo size={20} />}
      </button>
      <button className={btn(v.screen)} aria-pressed={v.screen} aria-label={v.screen ? 'Stop sharing' : 'Share your screen'} data-tip={v.screen ? 'Stop sharing' : 'Share your screen'} disabled={!v.canVideo} onClick={() => void voice.setScreen(!v.screen)}>
        {v.screen ? <LuMonitorX size={20} /> : <LuMonitorUp size={20} />}
      </button>
      <button className={btn(false, true)} aria-label="Disconnect" data-tip="Disconnect" onClick={() => voice.leave()}><LuPhoneOff size={20} /></button>
    </div>
  );
}
