import { useSyncExternalStore } from 'react';
import type {
  Me, Server, Channel, DmChannel, Message, Member, User, Presence, ReadState, NotifSetting, VoiceState,
} from './types.ts';

export type ServerMeta = Omit<Server, 'channels'>;
export interface ChannelMessages { items: Message[]; hasMoreBefore: boolean; loading: boolean; loaded: boolean; error?: string; jumpTo?: string }

export type Route =
  | { name: 'login'; next?: string } | { name: 'register'; next?: string } | { name: 'forgot' }
  | { name: 'reset'; token: string } | { name: 'verify'; token: string } | { name: 'invite'; code: string }
  | { name: 'home'; dmId?: string } | { name: 'server'; serverId: string; channelId?: string } | { name: 'discover' };

export type Modal =
  | { kind: 'createServer' } | { kind: 'invite'; serverId: string } | { kind: 'createChannel'; serverId: string; categoryId?: string | null; type?: 'text' | 'voice' }
  | { kind: 'createCategory'; serverId: string }
  | { kind: 'serverSettings'; serverId: string; tab?: string } | { kind: 'channelSettings'; channelId: string; tab?: string }
  | { kind: 'userSettings'; tab?: string } | { kind: 'profile'; userId: string; serverId?: string | null }
  | { kind: 'newDm' } | { kind: 'quickSwitcher' } | { kind: 'report'; messageId?: string; userId?: string; serverId?: string }
  | { kind: 'confirm'; title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<void> | void }
  | { kind: 'moderate'; action: 'kick' | 'ban' | 'timeout'; serverId: string; user: User }
  | { kind: 'thread'; channelId: string; messageId: string } | { kind: 'image'; url: string; name: string }
  | { kind: 'editGroup'; channelId: string } | { kind: 'shortcuts' } | { kind: 'serverInfo'; serverId: string };

export interface Toast { id: number; text: string; tone: 'info' | 'error' | 'ok'; action?: { label: string; run: () => void } }

export interface State {
  boot: 'loading' | 'anon' | 'ready';
  me: Me | null;
  conn: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  route: Route;
  servers: Record<string, ServerMeta>;
  serverOrder: string[];
  channels: Record<string, Channel>;
  dms: Record<string, DmChannel>;
  messages: Record<string, ChannelMessages>;
  members: Record<string, Record<string, Member>>;
  membersLoaded: Record<string, 'loading' | 'loaded'>;
  users: Record<string, User>;
  presences: Record<string, Presence>;
  readStates: Record<string, ReadState>;
  notif: Record<string, NotifSetting>;
  typing: Record<string, Record<string, number>>;
  voice: Record<string, VoiceState>;
  blocked: Record<string, User>;
  readReceipts: Record<string, Record<string, string>>;
  incomingCall: { channel_id: string; from_user_id: string } | null;
  modal: Modal | null;
  toasts: Toast[];
  ui: {
    membersOpen: boolean; mobileNav: boolean; mobileMembers: boolean;
    threadId: string | null; pinsOpen: boolean; searchOpen: boolean; searchQuery: string;
    replyTo: Record<string, Message | null>; editing: string | null; drafts: Record<string, string>;
    lastChannelByServer: Record<string, string>;
  };
  meta: { require_email_verification: boolean; dev_outbox: boolean; max_upload_mb: number; turn_configured: boolean } | null;
}

const initial: State = {
  boot: 'loading', me: null, conn: 'connecting', route: { name: 'home' },
  servers: {}, serverOrder: [], channels: {}, dms: {}, messages: {}, members: {}, membersLoaded: {}, users: {}, presences: {},
  readStates: {}, notif: {}, typing: {}, voice: {}, blocked: {}, readReceipts: {}, incomingCall: null, modal: null, toasts: [],
  ui: {
    membersOpen: true, mobileNav: false, mobileMembers: false, threadId: null, pinsOpen: false, searchOpen: false, searchQuery: '',
    replyTo: {}, editing: null, drafts: {}, lastChannelByServer: loadLastChannels(),
  },
  meta: null,
};

function loadLastChannels(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem('parley.lastChannels') || '{}'); } catch { return {}; }
}

let state = initial;
const listeners = new Set<() => void>();
let scheduled = false;

export const getState = () => state;
export function setState(fn: (s: State) => Partial<State>) {
  state = { ...state, ...fn(state) };
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(() => { scheduled = false; for (const l of listeners) l(); });
  }
}
export function setUi(patch: Partial<State['ui']>) { setState((s) => ({ ui: { ...s.ui, ...patch } })); }
export function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
const DEV = process.env.NODE_ENV !== 'production';
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => {
    const v = sel(state);
    // Selectors must return stable references, or React re-renders forever (error #185).
    if (DEV && typeof v === 'object' && v !== null && !Object.is(v, sel(state))) {
      console.error('[store] selector returns a new object on every call; return existing state or a primitive:', sel.toString());
    }
    return v;
  });
}
export function resetState(partial: Partial<State> = {}) {
  state = { ...initial, route: state.route, meta: state.meta, ui: { ...initial.ui, lastChannelByServer: state.ui.lastChannelByServer }, ...partial };
  for (const l of listeners) l();
}

/* ───────────── toasts & modals ───────────── */
let toastId = 1;
export function toast(text: string, tone: Toast['tone'] = 'info', action?: Toast['action']) {
  const id = toastId++;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone, action }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'error' ? 6000 : 3500);
}
export const openModal = (m: Modal) => setState(() => ({ modal: m }));
export const closeModal = () => setState(() => ({ modal: null }));
export function confirmDialog(opts: Omit<Extract<Modal, { kind: 'confirm' }>, 'kind'>) { openModal({ kind: 'confirm', ...opts }); }

/* ───────────── normalization helpers ───────────── */
export function applyServer(s: State, payload: Server): Partial<State> {
  const { channels, ...meta } = payload;
  const nextChannels = { ...s.channels };
  for (const [id, c] of Object.entries(nextChannels)) if (c.server_id === payload.id) delete nextChannels[id];
  for (const c of channels) nextChannels[c.id] = c;
  const users = { ...s.users };
  return {
    servers: { ...s.servers, [payload.id]: meta },
    serverOrder: s.serverOrder.includes(payload.id) ? s.serverOrder : [...s.serverOrder, payload.id],
    channels: nextChannels,
    users,
  };
}
export function removeServer(s: State, id: string): Partial<State> {
  const servers = { ...s.servers }; delete servers[id];
  const channels = { ...s.channels };
  for (const [cid, c] of Object.entries(channels)) if (c.server_id === id) delete channels[cid];
  const members = { ...s.members }; delete members[id];
  return { servers, channels, members, serverOrder: s.serverOrder.filter((x) => x !== id) };
}
export function rememberUsers(s: State, list: (User | null | undefined)[]): Record<string, User> | undefined {
  let changed = false;
  const users = { ...s.users };
  for (const u of list) if (u && users[u.id] !== u) { users[u.id] = u; changed = true; }
  return changed ? users : undefined;
}

export function getChannel(id: string | undefined | null): Channel | DmChannel | undefined {
  if (!id) return undefined;
  return state.channels[id] ?? state.dms[id];
}

/* ───────────── message list helpers ───────────── */
export const cmpId = (a: string, b: string) => { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; };

export function upsertMessage(s: State, m: Message): Partial<State> {
  const cm = s.messages[m.channel_id];
  // Not viewing this channel: nothing cached to update. While the first page is
  // still loading we keep live messages so the merge in loadMessages can't lose them.
  if (!cm || (!cm.loaded && !cm.loading)) return {};
  let items = cm.items;
  const byNonce = m.nonce ? items.findIndex((x) => x.pending && x.nonce === m.nonce) : -1;
  const byId = items.findIndex((x) => x.id === m.id);
  if (byId >= 0) items = items.map((x, i) => (i === byId ? { ...m } : x));
  else if (byNonce >= 0) items = items.map((x, i) => (i === byNonce ? { ...m } : x));
  else {
    // keep order: pending messages stay at the end
    const confirmed = items.filter((x) => !x.pending);
    const pending = items.filter((x) => x.pending);
    const idx = confirmed.findIndex((x) => cmpId(x.id, m.id) > 0);
    if (idx === -1) confirmed.push(m); else confirmed.splice(idx, 0, m);
    items = [...confirmed, ...pending];
  }
  return { messages: { ...s.messages, [m.channel_id]: { ...cm, items } } };
}

export function patchMessage(s: State, channelId: string, id: string, fn: (m: Message) => Message | null): Partial<State> {
  const cm = s.messages[channelId];
  if (!cm) return {};
  const items: Message[] = [];
  let changed = false;
  for (const m of cm.items) {
    if (m.id === id) { const n = fn(m); changed = true; if (n) items.push(n); }
    else items.push(m);
  }
  return changed ? { messages: { ...s.messages, [channelId]: { ...cm, items } } } : {};
}

/* ───────────── display helpers ───────────── */
export function displayName(u: User | null | undefined, serverId?: string | null) {
  if (!u) return 'Deleted User';
  if (serverId) { const m = state.members[serverId]?.[u.id]; if (m?.nickname) return m.nickname; }
  return u.display_name || u.username;
}

export function roleColor(serverId: string | null | undefined, userId: string | undefined): string | null {
  if (!serverId || !userId) return null;
  const server = state.servers[serverId];
  const member = state.members[serverId]?.[userId] ?? (state.me?.id === userId ? { role_ids: server?.member.role_ids ?? [] } : null);
  if (!server || !member) return null;
  let best: { position: number; color: string | null } | null = null;
  for (const r of server.roles) if (member.role_ids.includes(r.id) && r.color && (!best || r.position > best.position)) best = r;
  return best?.color ?? null;
}

// Fallback presence objects are cached so selectors return stable references
// (useSyncExternalStore re-renders forever if a snapshot changes identity each call).
const presenceFallbacks = new Map<string, Presence>();
function cachedPresence(p: Presence): Presence {
  const key = `${p.user_id}|${p.status}|${p.custom_status ?? ''}`;
  let hit = presenceFallbacks.get(key);
  if (!hit) { hit = p; presenceFallbacks.set(key, p); }
  return hit;
}

export function presenceOf(userId: string): Presence {
  const p = state.presences[userId];
  if (p) return p;
  if (state.me?.id === userId && state.conn === 'connected') {
    return cachedPresence({ user_id: userId, status: state.me.status === 'invisible' ? 'offline' : (state.me.status as any), custom_status: state.me.custom_status });
  }
  return cachedPresence({ user_id: userId, status: 'offline', custom_status: null });
}
