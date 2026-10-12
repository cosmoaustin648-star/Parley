import { db, many, one } from '../db/index.ts';
import {
  getServerCache, getMember, channelPermissions, basePermissions, type ChannelRow,
} from './access.ts';
import { channelJson, roleJson, publicUser, privateUser, mediaUrl, USER_COLS } from './serialize.ts';
import { P, has } from '../../shared/permissions.ts';
import { presencesFor, toUser, isOnline } from '../realtime/gateway.ts';
import { voiceStatesVisibleTo } from '../realtime/voice.ts';

/** Everything a member needs to render a server, filtered to what they may see. */
export async function serverPayload(serverId: string, userId: string) {
  const s = await one<any>(
    `SELECT s.*, (SELECT count(*)::int FROM server_members WHERE server_id = s.id) AS member_count FROM servers s WHERE s.id = $1`,
    [serverId],
  );
  if (!s) return null;
  const member = await getMember(serverId, userId);
  if (!member) return null;
  const cache = await getServerCache(serverId);
  const [categories, channels] = await Promise.all([
    many('SELECT * FROM categories WHERE server_id = $1 ORDER BY position, id', [serverId]),
    many<ChannelRow>(`SELECT * FROM channels WHERE server_id = $1 AND (type <> 'thread' OR archived = false) ORDER BY position, id`, [serverId]),
  ]);
  const visible: any[] = [];
  const parentPerms = new Map<string, number>();
  const everyoneId = cache?.roles.find((r) => r.is_default)?.id;
  const isPrivate = (channelId: string) =>
    !!cache?.overwrites.get(channelId)?.some((o) => o.target_type === 'role' && o.target_id === everyoneId && (o.deny & P.VIEW_CHANNEL));
  for (const c of channels.filter((c) => c.type !== 'thread')) {
    const perms = await channelPermissions(userId, c);
    parentPerms.set(c.id, perms);
    if (has(perms, P.VIEW_CHANNEL)) visible.push({ ...channelJson(c, perms), is_private: isPrivate(c.id) });
  }
  for (const t of channels.filter((c) => c.type === 'thread')) {
    const pp = parentPerms.get(t.parent_channel_id!) ?? 0;
    if (has(pp, P.VIEW_CHANNEL)) visible.push(channelJson(t, pp));
  }
  const myPerms = await basePermissions(serverId, userId);
  // Hide categories that contain no visible channel unless the user can manage channels.
  const usedCats = new Set(visible.map((c) => c.category_id).filter(Boolean));
  const cats = has(myPerms, P.MANAGE_CHANNELS) ? categories : categories.filter((c: any) => usedCats.has(c.id));
  return {
    id: s.id, name: s.name, owner_id: s.owner_id, icon_url: mediaUrl(s.icon_key), description: s.description,
    rules: s.rules, is_public: s.is_public, is_demo: s.is_demo, system_channel_id: s.system_channel_id,
    member_count: s.member_count, created_at: s.created_at.toISOString(),
    roles: (cache?.roles ?? []).map(roleJson),
    categories: cats.map((c: any) => ({ id: c.id, server_id: c.server_id, name: c.name, position: c.position })),
    channels: visible,
    my_permissions: myPerms,
    member: {
      user_id: userId, nickname: member.nickname, role_ids: member.roleIds,
      timeout_until: member.timeoutUntil ? new Date(member.timeoutUntil).toISOString() : null,
      joined_at: new Date(member.joinedAt).toISOString(),
    },
  };
}

/** Push a fresh server payload to every online member (after permission-affecting changes). */
export async function syncServerToMembers(serverId: string, onlyUserIds?: string[]) {
  const ids = onlyUserIds ?? (await many<{ user_id: string }>('SELECT user_id FROM server_members WHERE server_id = $1', [serverId])).map((r) => r.user_id);
  for (const id of ids) {
    if (!isOnline(id)) continue;
    const payload = await serverPayload(serverId, id);
    if (payload) toUser(id, 'SERVER_SYNC', payload);
  }
}

export async function dmChannelJson(channelId: string) {
  const c = await one<any>('SELECT * FROM channels WHERE id = $1', [channelId]);
  if (!c) return null;
  const recips = await many(
    `SELECT ${USER_COLS} FROM dm_participants p JOIN users u ON u.id = p.user_id WHERE p.channel_id = $1 ORDER BY p.joined_at`, [channelId]);
  return { ...channelJson(c), recipients: recips.map(publicUser) };
}

export async function dmChannelsFor(userId: string) {
  const rows = await many<{ channel_id: string }>(
    `SELECT p.channel_id FROM dm_participants p JOIN channels c ON c.id = p.channel_id
      WHERE p.user_id = $1 AND p.hidden = false ORDER BY COALESCE(c.last_message_id, 0) DESC, c.id DESC LIMIT 100`, [userId]);
  const out = [];
  for (const r of rows) { const j = await dmChannelJson(r.channel_id); if (j) out.push(j); }
  return out;
}

export async function buildReady(userId: string) {
  const u = await one(`SELECT * FROM users WHERE id = $1`, [userId]);
  const serverIds = (await many<{ server_id: string }>(
    'SELECT server_id FROM server_members WHERE user_id = $1 ORDER BY joined_at', [userId])).map((r) => r.server_id);
  const servers = [];
  for (const id of serverIds) { const p = await serverPayload(id, userId); if (p) servers.push(p); }
  const dms = await dmChannelsFor(userId);
  const related = new Set<string>();
  for (const d of dms) for (const r of d.recipients) related.add(r.id);
  const memberRows = await many<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM server_members WHERE server_id = ANY($1::bigint[])`, [serverIds]);
  for (const r of memberRows) related.add(r.user_id);
  related.delete(userId);

  const [readStates, notif, blocks] = await Promise.all([
    many('SELECT channel_id, last_read_message_id, mention_count FROM read_states WHERE user_id = $1', [userId]),
    many('SELECT scope_type, scope_id, level, muted, muted_until, suppress_everyone FROM notification_settings WHERE user_id = $1', [userId]),
    many(`SELECT ${USER_COLS} FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = $1`, [userId]),
  ]);
  return {
    user: privateUser(u),
    servers,
    dms,
    read_states: readStates,
    notification_settings: notif,
    blocked_users: blocks.map(publicUser),
    presences: presencesFor(related),
    voice_states: await voiceStatesVisibleTo(userId),
    server_time: new Date().toISOString(),
  };
}

export { db };
