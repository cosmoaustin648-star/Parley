import { getState } from './store.ts';

const use24h = () => !!getState().me?.settings.show_timestamps_24h;

export function timeShort(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !use24h() });
}

export function timeLong(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const t = timeShort(iso);
  if (d.toDateString() === now.toDateString()) return `Today at ${t}`;
  if (d.toDateString() === yest.toDateString()) return `Yesterday at ${t}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}, ${t}`;
}

export const fullDate = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'full', timeStyle: 'short', hour12: !use24h() });
export const dayLabel = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

export function relative(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function duration(sec: number) {
  if (sec < 60) return `${sec} seconds`;
  if (sec < 3600) return `${Math.round(sec / 60)} minutes`;
  if (sec < 86400) return `${Math.round(sec / 3600)} hours`;
  return `${Math.round(sec / 86400)} days`;
}

/** Strip markdown & mention syntax for notification previews. */
export function plainText(content: string) {
  const s = getState();
  return content
    .replace(/<@(\d+)>/g, (_, id) => '@' + (s.users[id]?.display_name || s.users[id]?.username || 'user'))
    .replace(/<@&(\d+)>/g, '@role')
    .replace(/<#(\d+)>/g, (_, id) => '#' + (s.channels[id]?.name || 'channel'))
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\|\|[\s\S]*?\|\|/g, '[spoiler]')
    .replace(/[*_~`>#]/g, '');
}

/** Pleasant deterministic colour for avatars without images. */
const AVATAR_COLORS = ['#2F6FD6', '#D64541', '#C9971C', '#2E9E74', '#7A5CC9', '#C2577F', '#3B8A9E', '#8A6A3B'];
export function hashColor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 3).map((w) => [...w][0]).join('').toUpperCase() || '?';

export function readableInk(hex: string) {
  const m = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.4 ? '#14110A' : '#FFFFFF';
}
