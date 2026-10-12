/**
 * Access control. Every route that touches a server, channel or message goes
 * through these helpers; the UI only mirrors what they allow.
 *
 * Role/overwrite/member data is cached in-process and invalidated on writes.
 * This assumes a single app instance (see docs/DEPLOYMENT.md for scaling).
 */
import { db, one, many } from '../db/index.ts';
import { forbidden, notFound } from '../http/router.ts';
import {
  P, has, computeBasePermissions, computeChannelPermissions, highestPosition,
  type RoleLike, type OverwriteLike,
} from '../../shared/permissions.ts';

export interface RoleRow extends RoleLike { server_id: string; name: string; color: string | null; hoist: boolean; mentionable: boolean }
export interface ChannelRow {
  id: string; server_id: string | null; category_id: string | null; parent_channel_id: string | null;
  type: 'text' | 'voice' | 'thread' | 'dm' | 'group_dm'; name: string | null; topic: string; position: number;
  owner_id: string | null; icon_key: string | null; slowmode_seconds: number; archived: boolean;
  last_message_id: string | null; created_at: Date;
}
interface ServerCache { id: string; ownerId: string; roles: RoleRow[]; overwrites: Map<string, OverwriteLike[]>; at: number }
interface MemberCache { roleIds: string[]; timeoutUntil: Date | null; nickname: string | null; joinedAt: Date; at: number }

export const DM_PERMS = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_HISTORY | P.ADD_REACTIONS | P.ATTACH_FILES | P.CONNECT | P.SPEAK | P.VIDEO;

const TTL = 5 * 60_000;
const servers = new Map<string, ServerCache>();
const members = new Map<string, MemberCache | null>();
const memberSets = new Map<string, Set<string>>();

export function invalidateServer(serverId: string) { servers.delete(serverId); }
export function invalidateMember(serverId: string, userId: string) { members.delete(`${serverId}:${userId}`); }
export function invalidateMemberSet(serverId: string) { memberSets.delete(serverId); }
export function invalidateAllForServer(serverId: string) {
  servers.delete(serverId); memberSets.delete(serverId);
  for (const k of members.keys()) if (k.startsWith(serverId + ':')) members.delete(k);
}

export const roleFromRow = (r: any): RoleRow => ({ ...r, permissions: Number(r.permissions) });

export async function getServerCache(serverId: string): Promise<ServerCache | null> {
  const hit = servers.get(serverId);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const s = await one<{ id: string; owner_id: string }>('SELECT id, owner_id FROM servers WHERE id = $1', [serverId]);
  if (!s) return null;
  const roles = (await many('SELECT * FROM roles WHERE server_id = $1 ORDER BY position DESC, id', [serverId])).map(roleFromRow);
  const ows = await many<any>(
    `SELECT o.* FROM channel_overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.server_id = $1`, [serverId]);
  const overwrites = new Map<string, OverwriteLike[]>();
  for (const o of ows) {
    const list = overwrites.get(o.channel_id) ?? [];
    list.push({ target_type: o.target_type, target_id: o.target_id, allow: Number(o.allow), deny: Number(o.deny) });
    overwrites.set(o.channel_id, list);
  }
  const entry = { id: s.id, ownerId: s.owner_id, roles, overwrites, at: Date.now() };
  servers.set(serverId, entry);
  return entry;
}

export async function getMember(serverId: string, userId: string): Promise<MemberCache | null> {
  const key = `${serverId}:${userId}`;
  const hit = members.get(key);
  if (hit !== undefined && (hit === null || Date.now() - hit.at < TTL)) return hit;
  const m = await one<any>(
    `SELECT m.nickname, m.timeout_until, m.joined_at,
            COALESCE(array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}') AS role_ids
       FROM server_members m LEFT JOIN member_roles mr ON mr.server_id = m.server_id AND mr.user_id = m.user_id
      WHERE m.server_id = $1 AND m.user_id = $2 GROUP BY m.server_id, m.user_id`,
    [serverId, userId],
  );
  const entry = m ? { roleIds: m.role_ids, timeoutUntil: m.timeout_until, nickname: m.nickname, joinedAt: m.joined_at, at: Date.now() } : null;
  members.set(key, entry);
  return entry;
}

/** All member ids of a server (cached). */
export async function getMemberIds(serverId: string): Promise<Set<string>> {
  const hit = memberSets.get(serverId);
  if (hit) return hit;
  const rows = await many<{ user_id: string }>('SELECT user_id FROM server_members WHERE server_id = $1', [serverId]);
  const set = new Set(rows.map((r) => r.user_id));
  memberSets.set(serverId, set);
  return set;
}

export async function basePermissions(serverId: string, userId: string): Promise<number> {
  const s = await getServerCache(serverId);
  if (!s) return 0;
  const m = await getMember(serverId, userId);
  if (!m) return 0;
  return computeBasePermissions({ ownerId: s.ownerId, userId, roles: s.roles, memberRoleIds: m.roleIds, timedOutUntil: m.timeoutUntil });
}

export async function getChannel(channelId: string): Promise<ChannelRow | null> {
  return one<ChannelRow>('SELECT * FROM channels WHERE id = $1', [channelId]);
}

export async function isDmParticipant(channelId: string, userId: string) {
  return !!(await one('SELECT 1 FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [channelId, userId]));
}

export async function channelPermissions(userId: string, ch: ChannelRow): Promise<number> {
  if (ch.type === 'dm' || ch.type === 'group_dm') return (await isDmParticipant(ch.id, userId)) ? DM_PERMS : 0;
  if (ch.type === 'thread') {
    const parent = ch.parent_channel_id ? await getChannel(ch.parent_channel_id) : null;
    if (!parent) return 0;
    const perms = await channelPermissions(userId, parent);
    // Threads use the parent's permissions; sending in a thread needs SEND_MESSAGES in the parent.
    return ch.archived ? perms & ~P.SEND_MESSAGES : perms;
  }
  const s = await getServerCache(ch.server_id!);
  if (!s) return 0;
  const m = await getMember(ch.server_id!, userId);
  if (!m) return 0;
  return computeChannelPermissions(
    { ownerId: s.ownerId, userId, roles: s.roles, memberRoleIds: m.roleIds, timedOutUntil: m.timeoutUntil },
    s.overwrites.get(ch.id) ?? [],
  );
}

/** Load a channel the user can see; hides existence when they can't. */
export async function requireChannel(userId: string, channelId: string, flag: number = P.VIEW_CHANNEL) {
  const ch = await getChannel(channelId);
  if (!ch) throw notFound('Channel');
  const perms = await channelPermissions(userId, ch);
  if (!has(perms, P.VIEW_CHANNEL)) throw notFound('Channel');
  if (!has(perms, flag)) throw forbidden();
  return { channel: ch, perms };
}

/** Require membership (404 otherwise) and a server-level permission. */
export async function requireServerPerm(userId: string, serverId: string, flag = 0) {
  const s = await getServerCache(serverId);
  if (!s) throw notFound('Server');
  const m = await getMember(serverId, userId);
  if (!m) throw notFound('Server');
  const perms = computeBasePermissions({ ownerId: s.ownerId, userId, roles: s.roles, memberRoleIds: m.roleIds, timedOutUntil: m.timeoutUntil });
  if (flag && !has(perms, flag)) throw forbidden();
  return { server: s, member: m, perms };
}

export async function userHighest(serverId: string, userId: string) {
  const s = await getServerCache(serverId);
  const m = await getMember(serverId, userId);
  if (!s || !m) return 0;
  return highestPosition({ ownerId: s.ownerId, userId, roles: s.roles, memberRoleIds: m.roleIds });
}

/** Hierarchy rule: you can only act on members whose top role is strictly below yours, and never on the owner. */
export async function assertCanActOn(serverId: string, actorId: string, targetId: string) {
  const s = await getServerCache(serverId);
  if (!s) throw notFound('Server');
  if (targetId === s.ownerId) throw forbidden("You can't do that to the server owner.");
  if (actorId === targetId) throw forbidden("You can't do that to yourself.");
  const [a, t] = await Promise.all([userHighest(serverId, actorId), userHighest(serverId, targetId)]);
  if (!(a > t)) throw forbidden('That member has a role equal to or higher than yours.');
}

export async function isBlockedEitherWay(a: string, b: string) {
  return !!(await one('SELECT 1 FROM blocks WHERE (user_id = $1 AND blocked_id = $2) OR (user_id = $2 AND blocked_id = $1)', [a, b]));
}

/** Channel ids in a server a user can view (for search and unread). */
export async function viewableChannelIds(serverId: string, userId: string): Promise<string[]> {
  const chans = await many<ChannelRow>(`SELECT * FROM channels WHERE server_id = $1 AND type IN ('text','voice','thread')`, [serverId]);
  const out: string[] = [];
  const parentPerms = new Map<string, number>();
  for (const c of chans.filter((c) => c.type !== 'thread')) {
    const p = await channelPermissions(userId, c);
    parentPerms.set(c.id, p);
    if (has(p, P.VIEW_CHANNEL | P.READ_HISTORY)) out.push(c.id);
  }
  for (const t of chans.filter((c) => c.type === 'thread')) {
    const p = parentPerms.get(t.parent_channel_id!) ?? 0;
    if (has(p, P.VIEW_CHANNEL | P.READ_HISTORY)) out.push(t.id);
  }
  return out;
}

export { db };
