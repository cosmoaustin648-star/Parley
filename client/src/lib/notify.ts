import { getState, displayName, getChannel } from './store.ts';
import type { Message, NotifSetting } from './types.ts';
import { navigate } from './router.ts';
import { plainText } from './format.ts';

/* ───────────── sounds (synthesized; no audio assets needed) ───────────── */
let ctx: AudioContext | null = null;
function audio() { return (ctx ??= new AudioContext()); }

export function playTone(kind: 'message' | 'mention' | 'join' | 'leave' | 'ring' | 'mute' | 'unmute') {
  const s = getState();
  if (s.me?.settings.notifications?.sounds === false) return;
  try {
    const ac = audio();
    if (ac.state === 'suspended') void ac.resume();
    const seq: Record<string, [number, number][]> = {
      message: [[880, 0.07]], mention: [[988, 0.07], [1319, 0.1]], join: [[523, 0.08], [784, 0.12]], leave: [[784, 0.08], [523, 0.12]],
      ring: [[659, 0.18], [0, 0.08], [659, 0.18], [0, 0.5]], mute: [[440, 0.06]], unmute: [[660, 0.06]],
    };
    let t = ac.currentTime;
    for (const [f, d] of seq[kind]) {
      if (f) {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g).connect(ac.destination); o.start(t); o.stop(t + d + 0.02);
      }
      t += d;
    }
  } catch { /* audio not available */ }
}

/* ───────────── notification preference resolution ───────────── */
export function setting(scope: 'server' | 'channel', id: string | null | undefined): NotifSetting | undefined {
  return id ? getState().notif[`${scope}:${id}`] : undefined;
}
const activeMute = (n?: NotifSetting) => !!n?.muted && (!n.muted_until || new Date(n.muted_until).getTime() > Date.now());

export function isChannelMuted(channelId: string) {
  const ch = getChannel(channelId);
  if (!ch) return false;
  if (activeMute(setting('channel', ch.type === 'thread' ? ch.parent_channel_id : channelId))) return true;
  return !!ch.server_id && activeMute(setting('server', ch.server_id));
}
export const isServerMuted = (serverId: string) => activeMute(setting('server', serverId));

/** Effective level: channel override → server setting → default (mentions for servers, all for DMs). */
export function effectiveLevel(channelId: string): 'all' | 'mentions' | 'none' {
  const ch = getChannel(channelId);
  if (!ch) return 'mentions';
  if (!ch.server_id) return 'all';
  const cid = ch.type === 'thread' ? ch.parent_channel_id : channelId;
  return setting('channel', cid)?.level ?? setting('server', ch.server_id)?.level ?? 'mentions';
}

export function mentionsMe(m: Message): boolean {
  const s = getState();
  const me = s.me?.id;
  if (!me) return false;
  if (m.mentioned_user_ids?.includes(me)) {
    const ch = getChannel(m.channel_id);
    // Explicit user mentions always count; @everyone may be suppressed per server.
    if (m.mention_everyone && !m.mention_user_ids.includes(me) && ch?.server_id && setting('server', ch.server_id)?.suppress_everyone) return false;
    return true;
  }
  return m.mention_user_ids.includes(me);
}

/* ───────────── desktop notifications ───────────── */
export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

export function notifyForMessage(m: Message) {
  const s = getState();
  if (!s.me || !m.author || m.author.id === s.me.id) return;
  if (s.blocked[m.author.id]) return;
  if (m.type !== 'default' && m.type !== 'call') return;
  const ch = getChannel(m.channel_id);
  if (!ch) return;
  const viewing = document.visibilityState === 'visible' && document.hasFocus() &&
    ((s.route.name === 'server' && s.route.channelId === m.channel_id) || (s.route.name === 'home' && s.route.dmId === m.channel_id) || s.ui.threadId === m.channel_id);
  if (viewing) return;
  const isDm = ch.type === 'dm' || ch.type === 'group_dm';
  const mentioned = mentionsMe(m);
  if (isChannelMuted(m.channel_id) && !mentioned) return;
  const level = effectiveLevel(m.channel_id);
  if (level === 'none' && !isDm) return;
  if (level === 'mentions' && !mentioned && !isDm) return;
  if (isDm && s.me.settings.notifications?.dm === false) return;
  if (s.me.status === 'dnd') return; // Do Not Disturb: no sounds or popups (badges still update)

  playTone(mentioned ? 'mention' : 'message');
  if (s.me.settings.notifications?.desktop === false) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const server = ch.server_id ? s.servers[ch.server_id] : null;
  const title = isDm
    ? (ch.type === 'group_dm' ? `${displayName(m.author)} (${ch.name || 'Group'})` : displayName(m.author))
    : `${displayName(m.author, ch.server_id)} (#${ch.name}, ${server?.name ?? ''})`;
  const body = m.type === 'call' ? 'Started a call' : plainText(m.content).slice(0, 180) || (m.attachments.length ? `Sent ${m.attachments.length} attachment(s)` : '');
  try {
    const n = new Notification(title, { body, icon: m.author.avatar_url || '/favicon.svg', tag: `msg-${m.channel_id}`, silent: true });
    n.onclick = () => {
      window.focus();
      navigate(isDm ? `/channels/@me/${ch.id}` : `/channels/${ch.server_id}/${ch.type === 'thread' ? ch.parent_channel_id : ch.id}`);
      n.close();
    };
  } catch { /* some browsers need a service worker */ }
}
