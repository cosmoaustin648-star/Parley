import {
  getState, setState, applyServer, removeServer, rememberUsers, upsertMessage, patchMessage, toast, getChannel, cmpId,
  type State,
} from './store.ts';
import type { Server, DmChannel, Message, Member, Presence, ReadState, NotifSetting, VoiceState, User, Channel, Me } from './types.ts';
import { navigate } from './router.ts';
import { notifyForMessage, mentionsMe, playTone } from './notify.ts';
import { api } from './api.ts';

type Handler = (d: any) => void;
const listeners = new Map<string, Set<Handler>>();
/** Subscribe to raw gateway events (used by the voice engine and some views). */
export function onGateway(t: string, h: Handler) {
  const set = listeners.get(t) ?? new Set();
  set.add(h); listeners.set(t, set);
  return () => set.delete(h);
}

let ws: WebSocket | null = null;
let attempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let stopped = false;
let everConnected = false;

export function send(op: string, d: unknown = {}) {
  if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ op, d })); return true; }
  return false;
}

export function connectGateway() {
  stopped = false;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setState(() => ({ conn: everConnected ? 'reconnecting' : 'connecting' }));
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/gateway`;
  const sock = new WebSocket(url);
  ws = sock;
  sock.onmessage = (e) => {
    let msg: { t: string; d: any };
    try { msg = JSON.parse(e.data); } catch { return; }
    try { reduce(msg.t, msg.d); } catch (err) { console.error('[gateway] reducer failed', msg.t, err); }
    for (const h of listeners.get(msg.t) ?? []) { try { h(msg.d); } catch (err) { console.error(err); } }
  };
  sock.onopen = () => {
    attempts = 0;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => send('ping'), 25_000);
  };
  sock.onclose = (e) => {
    if (pingTimer) clearInterval(pingTimer);
    if (ws === sock) ws = null;
    for (const h of listeners.get('DISCONNECTED') ?? []) h({ code: e.code });
    if (stopped) return;
    if (e.code === 4004) { // session revoked elsewhere
      setState(() => ({ boot: 'anon', me: null }));
      navigate('/login', true);
      toast('You were signed out.', 'info');
      return;
    }
    setState(() => ({ conn: navigator.onLine ? 'reconnecting' : 'offline' }));
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(15_000, 1000 * 2 ** attempts) + Math.random() * 500;
  attempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // If the session is gone (401), stop and show the login screen instead of looping.
    fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => {
      if (r.status === 401) { setState(() => ({ boot: 'anon', me: null })); navigate('/login', true); return; }
      connectGateway();
    }).catch(() => connectGateway());
  }, delay);
}

export function disconnectGateway() {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  ws?.close();
  ws = null;
}

window.addEventListener('online', () => { if (!ws && !stopped) { attempts = 0; if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } connectGateway(); } });
window.addEventListener('offline', () => setState(() => ({ conn: 'offline' })));

/* ───────────── idle detection ───────────── */
let lastActivity = Date.now();
let idleSent = false;
const markActive = () => {
  lastActivity = Date.now();
  if (idleSent) { idleSent = false; send('presence', { idle: false }); }
};
for (const ev of ['mousemove', 'keydown', 'pointerdown', 'focus']) window.addEventListener(ev, markActive, { passive: true });
setInterval(() => {
  if (!idleSent && Date.now() - lastActivity > 10 * 60_000) { idleSent = true; send('presence', { idle: true }); }
}, 30_000);

/* ───────────── reducers ───────────── */

function bump(s: State, channelId: string, messageId: string): Partial<State> {
  if (s.channels[channelId]) {
    const c = s.channels[channelId];
    if (c.last_message_id && cmpId(c.last_message_id, messageId) >= 0) return {};
    return { channels: { ...s.channels, [channelId]: { ...c, last_message_id: messageId } } };
  }
  if (s.dms[channelId]) {
    const c = s.dms[channelId];
    return { dms: { ...s.dms, [channelId]: { ...c, last_message_id: messageId } } };
  }
  return {};
}

function setMember(s: State, serverId: string, m: Member): Partial<State> {
  const out: Partial<State> = {};
  if (s.members[serverId]) out.members = { ...s.members, [serverId]: { ...s.members[serverId], [m.user.id]: m } };
  const users = rememberUsers(s, [m.user]);
  if (users) out.users = users;
  if (m.presence) out.presences = { ...s.presences, [m.user.id]: m.presence };
  return out;
}

async function resyncLoadedChannels() {
  const s = getState();
  const current = s.route.name === 'server' ? s.route.channelId : s.route.name === 'home' ? s.route.dmId : undefined;
  // Drop stale caches; refresh the open channel in place by fetching what we missed.
  const keep = new Set([current, s.ui.threadId].filter(Boolean) as string[]);
  setState((st) => ({ messages: Object.fromEntries(Object.entries(st.messages).filter(([id]) => keep.has(id))) }));
  for (const id of keep) {
    const cm = getState().messages[id];
    const last = cm?.items.filter((m) => !m.pending).at(-1);
    if (!last) continue;
    try {
      const missed = await api.get<Message[]>(`/api/channels/${id}/messages?after=${last.id}&limit=100`);
      setState((st) => { let acc: Partial<State> = {}; let cur = st; for (const m of missed) { acc = { ...acc, ...upsertMessage(cur, m) }; cur = { ...cur, ...acc }; } return acc; });
      if (missed.length === 100) setState((st) => ({ messages: { ...st.messages, [id]: { ...st.messages[id], loaded: false, items: [] } } }));
    } catch { /* channel may be gone */ }
  }
}

function reduce(t: string, d: any) {
  switch (t) {
    case 'READY': {
      const wasConnected = everConnected;
      everConnected = true;
      setState((s) => {
        let next: State = { ...s, servers: {}, serverOrder: [], channels: {} };
        for (const sv of d.servers as Server[]) next = { ...next, ...applyServer(next, sv) };
        const dms: Record<string, DmChannel> = {};
        const users: Record<string, User> = { ...s.users };
        for (const dm of d.dms as DmChannel[]) { dms[dm.id] = dm; for (const u of dm.recipients) users[u.id] = u; }
        const me = d.user as Me;
        users[me.id] = me;
        return {
          ...next, me, dms, users, boot: 'ready', conn: 'connected',
          readStates: Object.fromEntries((d.read_states as ReadState[]).map((r) => [r.channel_id, r])),
          notif: Object.fromEntries((d.notification_settings as NotifSetting[]).map((n) => [`${n.scope_type}:${n.scope_id}`, n])),
          blocked: Object.fromEntries((d.blocked_users as User[]).map((u) => [u.id, u])),
          presences: Object.fromEntries((d.presences as Presence[]).map((p) => [p.user_id, p])),
          voice: Object.fromEntries((d.voice_states as VoiceState[]).map((v) => [v.user_id, v])),
          membersLoaded: {}, members: {}, typing: {},
        };
      });
      if (wasConnected) void resyncLoadedChannels();
      return;
    }
    case 'MESSAGE_CREATE': {
      const m = d as Message;
      setState((s) => {
        let acc: Partial<State> = { ...upsertMessage(s, m), ...bump(s, m.channel_id, m.id) };
        const users = rememberUsers(s, [m.author]);
        if (users) acc.users = users;
        if (m.author && s.typing[m.channel_id]?.[m.author.id]) {
          const tc = { ...s.typing[m.channel_id] }; delete tc[m.author.id];
          acc.typing = { ...s.typing, [m.channel_id]: tc };
        }
        const rs = s.readStates[m.channel_id];
        if (m.author?.id === s.me?.id) {
          acc.readStates = { ...s.readStates, [m.channel_id]: { channel_id: m.channel_id, last_read_message_id: m.id, mention_count: 0 } };
        } else if (mentionsMe(m) || (getChannel(m.channel_id)?.server_id === null && m.author)) {
          acc.readStates = { ...s.readStates, [m.channel_id]: { channel_id: m.channel_id, last_read_message_id: rs?.last_read_message_id ?? null, mention_count: (rs?.mention_count ?? 0) + 1 } };
        }
        return acc;
      });
      notifyForMessage(m);
      return;
    }
    case 'MESSAGE_UPDATE':
      setState((s) => upsertMessage(s, d));
      return;
    case 'MESSAGE_DELETE':
      setState((s) => patchMessage(s, d.channel_id, d.id, () => null));
      return;
    case 'MESSAGE_DELETE_BULK':
      setState((s) => {
        const cm = s.messages[d.channel_id];
        if (!cm) return {};
        const ids = new Set(d.ids);
        return { messages: { ...s.messages, [d.channel_id]: { ...cm, items: cm.items.filter((m) => !ids.has(m.id)) } } };
      });
      return;
    case 'REACTION_ADD':
    case 'REACTION_REMOVE': {
      const add = t === 'REACTION_ADD';
      setState((s) => patchMessage(s, d.channel_id, d.message_id, (m) => {
        const reactions = m.reactions.map((r) => ({ ...r, user_ids: [...r.user_ids] }));
        let r = reactions.find((x) => x.emoji === d.emoji);
        if (add) {
          if (!r) { r = { emoji: d.emoji, count: 0, user_ids: [] }; reactions.push(r); }
          if (!r.user_ids.includes(d.user_id)) { r.user_ids.push(d.user_id); r.count++; }
        } else if (r && r.user_ids.includes(d.user_id)) {
          r.user_ids = r.user_ids.filter((u) => u !== d.user_id); r.count--;
        }
        return { ...m, reactions: reactions.filter((x) => x.count > 0) };
      }));
      return;
    }
    case 'TYPING_START':
      if (getState().blocked[d.user_id]) return;
      setState((s) => ({ typing: { ...s.typing, [d.channel_id]: { ...(s.typing[d.channel_id] ?? {}), [d.user_id]: Date.now() + 8000 } } }));
      return;
    case 'PRESENCE_UPDATE':
      setState((s) => ({ presences: { ...s.presences, [d.user_id]: d } }));
      return;
    case 'USER_UPDATE':
      setState((s) => ({ me: d, users: { ...s.users, [d.id]: d } }));
      return;
    case 'USER_PUBLIC_UPDATE':
      setState((s) => {
        const acc: Partial<State> = { users: { ...s.users, [d.id]: d } };
        const members = { ...s.members };
        let touched = false;
        for (const [sid, ms] of Object.entries(s.members)) if (ms[d.id]) { members[sid] = { ...ms, [d.id]: { ...ms[d.id], user: d } }; touched = true; }
        if (touched) acc.members = members;
        return acc;
      });
      return;
    case 'SERVER_CREATE':
    case 'SERVER_SYNC':
      setState((s) => {
        const acc = applyServer(s, d);
        // Permissions may have changed: refresh the member list next time it's shown.
        if (t === 'SERVER_SYNC' && s.members[d.id]) return acc;
        return acc;
      });
      return;
    case 'SERVER_UPDATE':
      setState((s) => (s.servers[d.id] ? { servers: { ...s.servers, [d.id]: { ...s.servers[d.id], ...d } } } : {}));
      return;
    case 'SERVER_DELETE': {
      const s = getState();
      const name = s.servers[d.id]?.name;
      setState((st) => removeServer(st, d.id));
      if (s.route.name === 'server' && s.route.serverId === d.id) {
        navigate('/channels/@me', true);
        if (name) toast(`You're no longer in ${name}.`);
      }
      return;
    }
    case 'CHANNEL_UPDATE':
      setState((s) => {
        if (s.channels[d.id]) return { channels: { ...s.channels, [d.id]: { ...s.channels[d.id], ...d, my_permissions: s.channels[d.id].my_permissions } } };
        if (s.dms[d.id]) return { dms: { ...s.dms, [d.id]: { ...s.dms[d.id], ...d } } };
        return {};
      });
      return;
    case 'CHANNEL_DELETE':
      setState((s) => { const channels = { ...s.channels }; delete channels[d.id]; return { channels, ui: s.ui.threadId === d.id ? { ...s.ui, threadId: null } : s.ui }; });
      return;
    case 'THREAD_CREATE':
    case 'THREAD_UPDATE':
      setState((s) => {
        const parent = s.channels[d.parent_channel_id];
        if (!parent) return {};
        const prev = s.channels[d.id];
        return { channels: { ...s.channels, [d.id]: { ...prev, ...d, my_permissions: parent.my_permissions } } };
      });
      return;
    case 'THREAD_ACTIVITY':
      setState((s) => {
        const cm = s.messages[d.parent_channel_id];
        const acc: Partial<State> = bump(s, d.thread_id, d.last_message_id);
        if (cm) acc.messages = { ...s.messages, [d.parent_channel_id]: { ...cm, items: cm.items.map((m) => (m.thread?.id === d.thread_id ? { ...m, thread: { ...m.thread, message_count: d.message_count } } : m)) } };
        return acc;
      });
      return;
    case 'MEMBER_ADD':
    case 'MEMBER_UPDATE':
      setState((s) => {
        const acc = setMember(s, d.server_id, d.member);
        if (t === 'MEMBER_ADD' && s.servers[d.server_id]) acc.servers = { ...s.servers, [d.server_id]: { ...s.servers[d.server_id], member_count: s.servers[d.server_id].member_count + 1 } };
        return acc;
      });
      return;
    case 'MEMBER_REMOVE':
      setState((s) => {
        const acc: Partial<State> = {};
        if (s.members[d.server_id]) { const ms = { ...s.members[d.server_id] }; delete ms[d.user_id]; acc.members = { ...s.members, [d.server_id]: ms }; }
        if (s.servers[d.server_id]) acc.servers = { ...s.servers, [d.server_id]: { ...s.servers[d.server_id], member_count: Math.max(0, s.servers[d.server_id].member_count - 1) } };
        return acc;
      });
      return;
    case 'VOICE_STATE_UPDATE': {
      const prev = getState().voice[d.user_id];
      const mine = getState().voice[getState().me?.id ?? '']?.channel_id;
      setState((s) => {
        const voice = { ...s.voice };
        if (d.channel_id) voice[d.user_id] = d; else delete voice[d.user_id];
        return { voice };
      });
      if (mine && d.user_id !== getState().me?.id) {
        if (d.channel_id === mine && prev?.channel_id !== mine) playTone('join');
        if (prev?.channel_id === mine && d.channel_id !== mine) playTone('leave');
      }
      return;
    }
    case 'READ_STATE_UPDATE':
      setState((s) => ({ readStates: { ...s.readStates, [d.channel_id]: d } }));
      return;
    case 'READ_RECEIPT':
      setState((s) => ({ readReceipts: { ...s.readReceipts, [d.channel_id]: { ...(s.readReceipts[d.channel_id] ?? {}), [d.user_id]: d.message_id } } }));
      return;
    case 'DM_CHANNEL_CREATE':
    case 'DM_CHANNEL_UPDATE':
      setState((s) => ({ dms: { ...s.dms, [d.id]: d }, users: rememberUsers(s, d.recipients) ?? s.users }));
      return;
    case 'DM_CHANNEL_DELETE':
      setState((s) => { const dms = { ...s.dms }; delete dms[d.id]; return { dms }; });
      if (getState().route.name === 'home' && (getState().route as any).dmId === d.id) navigate('/channels/@me', true);
      return;
    case 'NOTIFICATION_SETTINGS_UPDATE':
      setState((s) => ({ notif: { ...s.notif, [`${d.scope_type}:${d.scope_id}`]: d } }));
      return;
    case 'BLOCK_ADD':
      setState((s) => ({ blocked: { ...s.blocked, [d.id]: d } }));
      return;
    case 'BLOCK_REMOVE':
      setState((s) => { const blocked = { ...s.blocked }; delete blocked[d.user_id]; return { blocked }; });
      return;
    case 'CALL_RING':
      if (getState().blocked[d.from_user_id]) return;
      setState(() => ({ incomingCall: d }));
      if (getState().me?.status !== 'dnd') playTone('ring');
      return;
    case 'CALL_ENDED':
      setState((s) => (s.incomingCall?.channel_id === d.channel_id ? { incomingCall: null } : {}));
      return;
    case 'REPORT_CREATE': {
      const sv = getState().servers[d.server_id];
      if (sv) toast(`New report to review in ${sv.name}.`, 'info');
      return;
    }
    case 'ERROR':
      if (d.op && d.op !== 'typing' && d.message) toast(d.message, 'error');
      return;
  }
}

export type { Channel };
