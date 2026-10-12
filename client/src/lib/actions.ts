import { api, upload, errMsg, ApiError } from './api.ts';
import { getState, setState, upsertMessage, patchMessage, toast, rememberUsers, cmpId, getChannel, type State } from './store.ts';
import type { Message, Member, Attachment, DmChannel } from './types.ts';
import { navigate } from './router.ts';

const PAGE = 50;

export async function loadMessages(channelId: string, opts: { before?: string; around?: string } = {}) {
  const cur = getState().messages[channelId];
  if (cur?.loading) return;
  setState((s) => ({ messages: { ...s.messages, [channelId]: { items: cur?.items ?? [], hasMoreBefore: cur?.hasMoreBefore ?? true, loaded: cur?.loaded ?? false, loading: true } } }));
  try {
    const q = opts.before ? `?before=${opts.before}&limit=${PAGE}` : opts.around ? `?around=${opts.around}&limit=${PAGE}` : `?limit=${PAGE}`;
    const page = await api.get<Message[]>(`/api/channels/${channelId}/messages${q}`);
    setState((s) => {
      const prev = s.messages[channelId];
      let items: Message[];
      if (opts.before && prev) {
        const ids = new Set(prev.items.map((m) => m.id));
        items = [...page.filter((m) => !ids.has(m.id)), ...prev.items];
      } else {
        // Keep anything that arrived live while this page was in flight (newer than the page), plus pending sends.
        const ids = new Set(page.map((m) => m.id));
        const newest = page.at(-1)?.id;
        const live = (prev?.items ?? []).filter((m) => !m.pending && !ids.has(m.id) && (!newest || cmpId(m.id, newest) > 0));
        const pending = prev?.items.filter((m) => m.pending && m.channel_id === channelId) ?? [];
        items = [...page, ...live, ...pending];
      }
      return {
        messages: { ...s.messages, [channelId]: { items, loaded: true, loading: false, hasMoreBefore: opts.around ? true : page.length === PAGE, jumpTo: opts.around } },
        users: rememberUsers(s, page.map((m) => m.author)) ?? s.users,
      };
    });
  } catch (e) {
    setState((s) => ({ messages: { ...s.messages, [channelId]: { ...(s.messages[channelId] ?? { items: [], hasMoreBefore: true }), loading: false, loaded: true, error: errMsg(e) } } }));
  }
}

let nonceSeq = 0;
const newNonce = () => `${Date.now().toString(36)}${(nonceSeq++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export interface OutgoingFile { file: File; name: string }

/** Optimistic send: the message appears immediately, then is confirmed (or marked failed with retry). */
export async function sendMessage(channelId: string, content: string, files: OutgoingFile[] = [], replyTo: Message | null = null, nonce = newNonce()) {
  const s = getState();
  const me = s.me!;
  const optimistic: Message = {
    id: `pending-${nonce}`, channel_id: channelId, type: 'default', content, nonce, author: me, created_at: new Date().toISOString(),
    edited_at: null, pinned: false, reply_to_id: replyTo?.id ?? null,
    reply_to: replyTo ? { id: replyTo.id, content: replyTo.content, author: replyTo.author } : null,
    attachments: [], reactions: [], mention_everyone: false, mention_user_ids: [], mention_role_ids: [], mention_channel_ids: [], thread: null,
    pending: 'sending', localFiles: files.map((f) => ({ name: f.name, progress: 0 })),
  };
  setState((st) => {
    const cm = st.messages[channelId];
    if (!cm) return {};
    const items = cm.items.filter((m) => m.nonce !== nonce);
    return { messages: { ...st.messages, [channelId]: { ...cm, items: [...items, optimistic] } } };
  });
  const setPending = (fn: (m: Message) => Message) => setState((st) => patchMessage(st, channelId, optimistic.id, fn));
  try {
    const attachmentIds: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const att = await upload<Attachment>('POST', `/api/channels/${channelId}/attachments`, f.file, {
        filename: f.name,
        onProgress: (p) => setPending((m) => ({ ...m, localFiles: m.localFiles?.map((lf, j) => (j === i ? { ...lf, progress: p } : lf)) })),
      });
      attachmentIds.push(att.id);
    }
    const msg = await api.post<Message>(`/api/channels/${channelId}/messages`, { content, nonce, reply_to_id: replyTo?.id ?? null, attachment_ids: attachmentIds });
    setState((st) => {
      // Remove the optimistic copy, then upsert the real one (the gateway event may already have done it).
      const cm = st.messages[channelId];
      if (!cm) return {};
      const cleaned: State = { ...st, messages: { ...st.messages, [channelId]: { ...cm, items: cm.items.filter((m) => m.id !== optimistic.id) } } };
      const up = upsertMessage(cleaned, msg);
      return { messages: up.messages ?? cleaned.messages };
    });
  } catch (e) {
    const err = errMsg(e);
    if (e instanceof ApiError && (e.code === 'automod_blocked' || e.status === 403 || e.code === 'slowmode' || e.code === 'validation_error')) {
      // Not retryable as-is: drop it and keep the text so the user can edit.
      setState((st) => patchMessage(st, channelId, optimistic.id, () => null));
      setState((st) => ({ ui: { ...st.ui, drafts: { ...st.ui.drafts, [channelId]: content } } }));
      toast(err, 'error');
      return;
    }
    setPending((m) => ({ ...m, pending: 'failed', error: err }));
  }
}

export function retryMessage(m: Message) {
  setState((st) => patchMessage(st, m.channel_id, m.id, () => null));
  void sendMessage(m.channel_id, m.content, [], null, m.nonce ?? undefined);
}
export function discardMessage(m: Message) { setState((st) => patchMessage(st, m.channel_id, m.id, () => null)); }

/* ───────────── read state ───────────── */
const ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function ackChannel(channelId: string) {
  const s = getState();
  const ch = getChannel(channelId);
  const last = ch?.last_message_id;
  if (!last) return;
  const rs = s.readStates[channelId];
  if (rs && rs.last_read_message_id && cmpId(rs.last_read_message_id, last) >= 0 && !rs.mention_count) return;
  setState((st) => ({ readStates: { ...st.readStates, [channelId]: { channel_id: channelId, last_read_message_id: last, mention_count: 0 } } }));
  clearTimeout(ackTimers.get(channelId));
  ackTimers.set(channelId, setTimeout(() => { api.post(`/api/channels/${channelId}/ack`, { message_id: last }).catch(() => {}); }, 400));
}

export function isUnread(channelId: string, s: State = getState()) {
  const ch = s.channels[channelId] ?? s.dms[channelId];
  if (!ch?.last_message_id) return false;
  const rs = s.readStates[channelId];
  if (!rs?.last_read_message_id) return true;
  return cmpId(ch.last_message_id, rs.last_read_message_id) > 0;
}

/* ───────────── members ───────────── */
export async function loadMembers(serverId: string, force = false) {
  const st = getState().membersLoaded[serverId];
  if (st && !force) return;
  setState((s) => ({ membersLoaded: { ...s.membersLoaded, [serverId]: 'loading' } }));
  try {
    const list = await api.get<Member[]>(`/api/servers/${serverId}/members`);
    setState((s) => ({
      members: { ...s.members, [serverId]: Object.fromEntries(list.map((m) => [m.user.id, m])) },
      membersLoaded: { ...s.membersLoaded, [serverId]: 'loaded' },
      users: rememberUsers(s, list.map((m) => m.user)) ?? s.users,
      presences: { ...s.presences, ...Object.fromEntries(list.filter((m) => m.presence && m.presence.status !== 'offline').map((m) => [m.user.id, m.presence!])) },
    }));
  } catch (e) {
    setState((s) => { const ml = { ...s.membersLoaded }; delete ml[serverId]; return { membersLoaded: ml }; });
    toast(errMsg(e), 'error');
  }
}

/* ───────────── DMs ───────────── */
export async function openDm(userId: string) {
  try {
    const dm = await api.post<DmChannel>('/api/dms', { user_id: userId });
    setState((s) => ({ dms: { ...s.dms, [dm.id]: dm } }));
    navigate(`/channels/@me/${dm.id}`);
    return dm;
  } catch (e) { toast(errMsg(e), 'error'); }
}

/* ───────────── misc ───────────── */
export async function run<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try { const r = await fn(); if (success) toast(success, 'ok'); return r; }
  catch (e) { toast(errMsg(e), 'error'); return undefined; }
}

export async function logout() {
  const { disconnectGateway } = await import('./gateway.ts');
  const { voice } = await import('../voice/engine.ts');
  voice.leave();
  disconnectGateway();
  await api.post('/api/auth/logout').catch(() => {});
  const { resetState } = await import('./store.ts');
  resetState({ boot: 'anon' });
  navigate('/login', true);
}
