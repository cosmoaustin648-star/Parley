import { z } from 'zod';
import { Router, HttpError, badRequest, forbidden, notFound, conflict, idParam, type Ctx } from '../http/router.ts';
import { db, one, many, type Queryable } from '../db/index.ts';
import { limits } from '../http/ratelimit.ts';
import { inviteCode, verifyPassword } from '../lib/crypto.ts';
import {
  requireServerPerm, invalidateServer, invalidateMember, invalidateMemberSet, invalidateAllForServer,
  getServerCache, userHighest, assertCanActOn, getMember, roleFromRow,
} from '../services/access.ts';
import { serverPayload, syncServerToMembers } from '../services/state.ts';
import { roleJson, publicUser, mediaUrl, USER_COLS, channelJson, hydrateMessages } from '../services/serialize.ts';
import { audit } from '../services/audit.ts';
import { receiveUpload, storage } from '../storage/index.ts';
import { toServer, toUser, presenceOf, toChannel } from '../realtime/gateway.ts';
import { evictFromServerVoice, recheckVoicePermissions } from '../realtime/voice.ts';
import { P, has, ALL_PERMISSIONS, DEFAULT_EVERYONE, DEFAULT_MODERATOR, isTimedOut } from '../../shared/permissions.ts';
import { requireVerified } from './auth.ts';

export const router = new Router('/api');

export const serverNameSchema = z.string().trim().min(2, 'Server name must be at least 2 characters.').max(100);
export const textChannelName = z.string().trim().toLowerCase()
  .transform((s) => s.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, ''))
  .pipe(z.string().min(1, 'Channel name is required.').max(100));
export const voiceChannelName = z.string().trim().min(1, 'Channel name is required.').max(100);
const roleColor = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable();

/* ───────────── helpers ───────────── */

export async function postSystemMessage(channelId: string | null, authorId: string, content: string, q: Queryable = db) {
  if (!channelId) return;
  const r = await q.query(`INSERT INTO messages (channel_id, author_id, type, content) VALUES ($1,$2,'system',$3) RETURNING *`, [channelId, authorId, content]);
  await q.query('UPDATE channels SET last_message_id = $1 WHERE id = $2', [r.rows[0].id, channelId]);
  const ch = await one('SELECT * FROM channels WHERE id = $1', [channelId], q);
  const [msg] = await hydrateMessages(r.rows, q);
  if (ch) await toChannel(ch, 'MESSAGE_CREATE', msg);
}

async function memberJson(serverId: string, userId: string) {
  const r = await one(
    `SELECT ${USER_COLS}, m.nickname, m.joined_at, m.timeout_until,
            COALESCE(array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}') AS role_ids
       FROM server_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN member_roles mr ON mr.server_id = m.server_id AND mr.user_id = m.user_id
      WHERE m.server_id = $1 AND m.user_id = $2 GROUP BY u.id, m.server_id, m.user_id`, [serverId, userId]);
  return r ? toMember(r) : null;
}
function toMember(r: any) {
  return {
    user: publicUser(r), nickname: r.nickname, role_ids: r.role_ids, joined_at: r.joined_at.toISOString(),
    timeout_until: r.timeout_until && isTimedOut(r.timeout_until) ? r.timeout_until.toISOString() : null,
    presence: presenceOf(r.id),
  };
}

export async function addMember(serverId: string, userId: string) {
  const ban = await one('SELECT 1 FROM bans WHERE server_id = $1 AND user_id = $2', [serverId, userId]);
  if (ban) throw forbidden('You are banned from this server.');
  const count = await one<{ n: number }>('SELECT count(*)::int AS n FROM server_members WHERE user_id = $1', [userId]);
  if ((count?.n ?? 0) >= 200) throw badRequest("You've reached the maximum of 200 servers.");
  const ins = await db.query('INSERT INTO server_members (server_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING user_id', [serverId, userId]);
  if (!ins.rowCount) return false; // already a member
  invalidateMember(serverId, userId);
  invalidateMemberSet(serverId);
  const s = await one('SELECT system_channel_id FROM servers WHERE id = $1', [serverId]);
  const m = await memberJson(serverId, userId);
  await toServer(serverId, 'MEMBER_ADD', { server_id: serverId, member: m }, userId);
  await postSystemMessage(s?.system_channel_id, userId, 'joined');
  const payload = await serverPayload(serverId, userId);
  toUser(userId, 'SERVER_CREATE', payload);
  // Let existing members see this user's presence right away.
  await toServer(serverId, 'PRESENCE_UPDATE', presenceOf(userId), userId);
  return true;
}

export async function removeMember(serverId: string, userId: string) {
  await db.query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, userId]);
  invalidateMember(serverId, userId);
  invalidateMemberSet(serverId);
  await evictFromServerVoice(serverId, userId);
  toUser(userId, 'SERVER_DELETE', { id: serverId });
  await toServer(serverId, 'MEMBER_REMOVE', { server_id: serverId, user_id: userId });
}

async function shareServer(serverId: string) {
  const payloadUpdate = await one('SELECT id, name, icon_key, description, rules, is_public, system_channel_id, owner_id FROM servers WHERE id = $1', [serverId]);
  await toServer(serverId, 'SERVER_UPDATE', {
    id: payloadUpdate.id, name: payloadUpdate.name, icon_url: mediaUrl(payloadUpdate.icon_key), description: payloadUpdate.description,
    rules: payloadUpdate.rules, is_public: payloadUpdate.is_public, system_channel_id: payloadUpdate.system_channel_id, owner_id: payloadUpdate.owner_id,
  });
}

async function afterRoleChange(serverId: string) {
  invalidateAllForServer(serverId);
  await syncServerToMembers(serverId);
  await recheckVoicePermissions(serverId);
}

/* ───────────── servers ───────────── */

router.post('/servers', async (ctx) => {
  const a = requireVerified(ctx);
  limits.writes.check(`u:${a.userId}`);
  const body = await ctx.body(z.object({
    name: serverNameSchema,
    description: z.string().max(500).optional(),
    is_public: z.boolean().optional(),
  }));
  const owned = await one<{ n: number }>('SELECT count(*)::int AS n FROM servers WHERE owner_id = $1', [a.userId]);
  if ((owned?.n ?? 0) >= 100) throw badRequest("You've reached the maximum number of servers you can own.");
  const serverId = await db.tx(async (q) => {
    const s = await one(`INSERT INTO servers (name, owner_id, description, is_public) VALUES ($1,$2,$3,$4) RETURNING id`,
      [body.name, a.userId, body.description ?? '', body.is_public ?? false], q);
    await q.query(`INSERT INTO roles (server_id, name, position, permissions, is_default) VALUES ($1,'@everyone',0,$2,true)`, [s.id, DEFAULT_EVERYONE]);
    await q.query(`INSERT INTO roles (server_id, name, color, position, permissions, hoist, mentionable) VALUES ($1,'Moderator','#3ba55c',1,$2,true,true)`, [s.id, DEFAULT_MODERATOR]);
    await q.query(`INSERT INTO roles (server_id, name, color, position, permissions, hoist) VALUES ($1,'Admin','#e0663d',2,$2,true)`, [s.id, P.ADMINISTRATOR]);
    await q.query('INSERT INTO server_members (server_id, user_id) VALUES ($1,$2)', [s.id, a.userId]);
    const tc = await one(`INSERT INTO categories (server_id, name, position) VALUES ($1,'Text channels',0) RETURNING id`, [s.id], q);
    const vc = await one(`INSERT INTO categories (server_id, name, position) VALUES ($1,'Voice channels',1) RETURNING id`, [s.id], q);
    const gen = await one(`INSERT INTO channels (server_id, category_id, type, name, topic, position) VALUES ($1,$2,'text','general','Say hello!',0) RETURNING id`, [s.id, tc.id], q);
    await q.query(`INSERT INTO channels (server_id, category_id, type, name, position) VALUES ($1,$2,'voice','General',0)`, [s.id, vc.id]);
    await q.query('UPDATE servers SET system_channel_id = $1 WHERE id = $2', [gen.id, s.id]);
    return s.id as string;
  });
  const payload = await serverPayload(serverId, a.userId);
  toUser(a.userId, 'SERVER_CREATE', payload);
  return payload;
});

router.get('/servers/:id', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id);
  return serverPayload(id, a.userId);
});

router.patch('/servers/:id', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id, P.MANAGE_SERVER);
  const body = await ctx.body(z.object({
    name: serverNameSchema.optional(),
    description: z.string().max(500).optional(),
    rules: z.string().max(4000).optional(),
    is_public: z.boolean().optional(),
    system_channel_id: z.string().regex(/^\d+$/).nullable().optional(),
  }).strict());
  if (body.system_channel_id) {
    const ch = await one(`SELECT 1 FROM channels WHERE id = $1 AND server_id = $2 AND type = 'text'`, [body.system_channel_id, id]);
    if (!ch) throw badRequest('System channel must be a text channel in this server.');
  }
  const before = await one('SELECT name, description, rules, is_public, system_channel_id FROM servers WHERE id = $1', [id]);
  const sets: string[] = []; const vals: unknown[] = [id];
  for (const [k, v] of Object.entries(body)) if (v !== undefined) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
  if (sets.length) await db.query(`UPDATE servers SET ${sets.join(', ')} WHERE id = $1`, vals);
  const changes = Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && before[k] !== v).map(([k, v]) => [k, { from: before[k], to: v }]));
  if (Object.keys(changes).length) await audit(id, a.userId, 'server_update', { type: 'server', id }, null, changes);
  await shareServer(id);
  return serverPayload(id, a.userId);
});

router.put('/servers/:id/icon', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id, P.MANAGE_SERVER);
  limits.uploads.check(`u:${a.userId}`);
  const f = await receiveUpload(ctx.req, 'icons', 8 * 1024 * 1024, true);
  const old = await one('SELECT icon_key FROM servers WHERE id = $1', [id]);
  await db.query('UPDATE servers SET icon_key = $1 WHERE id = $2', [f.key, id]);
  if (old?.icon_key) await storage.remove(old.icon_key).catch(() => {});
  await audit(id, a.userId, 'server_icon_update', { type: 'server', id });
  await shareServer(id);
  return { icon_url: mediaUrl(f.key) };
});

router.delete('/servers/:id/icon', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id, P.MANAGE_SERVER);
  const old = await one('SELECT icon_key FROM servers WHERE id = $1', [id]);
  await db.query('UPDATE servers SET icon_key = NULL WHERE id = $1', [id]);
  if (old?.icon_key) await storage.remove(old.icon_key).catch(() => {});
  await shareServer(id);
  return { icon_url: null };
});

router.delete('/servers/:id', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { server } = await requireServerPerm(a.userId, id);
  if (server.ownerId !== a.userId) throw forbidden('Only the server owner can delete the server.');
  const memberIds = (await many<{ user_id: string }>('SELECT user_id FROM server_members WHERE server_id = $1', [id])).map((r) => r.user_id);
  for (const uid of memberIds) await evictFromServerVoice(id, uid);
  const keys = await many<{ storage_key: string }>(
    `SELECT a.storage_key FROM attachments a JOIN messages m ON m.id = a.message_id JOIN channels c ON c.id = m.channel_id WHERE c.server_id = $1`, [id]);
  const icon = await one('SELECT icon_key FROM servers WHERE id = $1', [id]);
  await db.query('DELETE FROM servers WHERE id = $1', [id]);
  invalidateAllForServer(id);
  for (const uid of memberIds) toUser(uid, 'SERVER_DELETE', { id });
  for (const k of [...keys.map((x) => x.storage_key), icon?.icon_key].filter(Boolean)) await storage.remove(k).catch(() => {});
  return { ok: true };
});

router.post('/servers/:id/transfer', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { server } = await requireServerPerm(a.userId, id);
  if (server.ownerId !== a.userId) throw forbidden('Only the owner can transfer ownership.');
  const body = await ctx.body(z.object({ user_id: z.string().regex(/^\d+$/), password: z.string().min(1).max(128) }));
  const u = await one('SELECT password_hash FROM users WHERE id = $1', [a.userId]);
  if (!(await verifyPassword(body.password, u.password_hash))) throw new HttpError(401, 'invalid_password', 'Your password is incorrect.');
  if (!(await getMember(id, body.user_id))) throw badRequest('That user is not a member of this server.');
  await db.query('UPDATE servers SET owner_id = $1 WHERE id = $2', [body.user_id, id]);
  await audit(id, a.userId, 'ownership_transfer', { type: 'user', id: body.user_id });
  await afterRoleChange(id);
  return { ok: true };
});

router.post('/servers/:id/leave', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { server } = await requireServerPerm(a.userId, id);
  if (server.ownerId === a.userId) throw badRequest('Transfer ownership or delete the server before leaving.');
  await removeMember(id, a.userId);
  return { ok: true };
});

/* Public servers can be joined without an invite. */
router.post('/servers/:id/join', async (ctx) => {
  const a = requireVerified(ctx);
  const id = idParam(ctx, 'id');
  const s = await one('SELECT id, is_public FROM servers WHERE id = $1', [id]);
  if (!s || !s.is_public) throw notFound('Server');
  await addMember(id, a.userId);
  return serverPayload(id, a.userId);
});

router.get('/discover', async (ctx) => {
  const a = ctx.user();
  limits.search.check(`u:${a.userId}`);
  const q = (ctx.query.get('q') || '').trim().toLowerCase().slice(0, 100);
  const rows = await many(
    `SELECT s.id, s.name, s.description, s.icon_key, s.is_demo,
            (SELECT count(*)::int FROM server_members WHERE server_id = s.id) AS member_count,
            EXISTS (SELECT 1 FROM server_members WHERE server_id = s.id AND user_id = $2) AS joined
       FROM servers s
      WHERE s.is_public AND ($1 = '' OR lower(s.name) LIKE '%' || $1 || '%' OR lower(s.description) LIKE '%' || $1 || '%')
        AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.server_id = s.id AND b.user_id = $2)
      ORDER BY member_count DESC, s.id LIMIT 50`, [q.replace(/[%_\\]/g, ''), a.userId]);
  return rows.map((r: any) => ({ id: r.id, name: r.name, description: r.description, icon_url: mediaUrl(r.icon_key), member_count: r.member_count, joined: r.joined, is_demo: r.is_demo }));
});

/* ───────────── members ───────────── */

router.get('/servers/:id/members', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id);
  const rows = await many(
    `SELECT ${USER_COLS}, m.nickname, m.joined_at, m.timeout_until,
            COALESCE(array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}') AS role_ids
       FROM server_members m JOIN users u ON u.id = m.user_id
       LEFT JOIN member_roles mr ON mr.server_id = m.server_id AND mr.user_id = m.user_id
      WHERE m.server_id = $1 GROUP BY u.id, m.server_id, m.user_id ORDER BY lower(coalesce(m.nickname, u.display_name, u.username)) LIMIT 2000`, [id]);
  return rows.map(toMember);
});

router.patch('/servers/:id/members/:uid', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const uid = ctx.params.uid === '@me' ? a.userId : idParam(ctx, 'uid');
  const { perms, server } = await requireServerPerm(a.userId, id);
  limits.writes.check(`u:${a.userId}`);
  const body = await ctx.body(z.object({
    nickname: z.string().trim().max(32).nullable().optional(),
    role_ids: z.array(z.string().regex(/^\d+$/)).max(100).optional(),
  }).strict());
  const target = await getMember(id, uid);
  if (!target) throw notFound('Member');

  if (body.nickname !== undefined) {
    if (uid === a.userId) { if (!has(perms, P.CHANGE_NICKNAME)) throw forbidden(); }
    else { if (!has(perms, P.MANAGE_NICKNAMES)) throw forbidden(); await assertCanActOn(id, a.userId, uid); }
    await db.query('UPDATE server_members SET nickname = $1 WHERE server_id = $2 AND user_id = $3', [body.nickname || null, id, uid]);
    await audit(id, a.userId, 'member_nickname_update', { type: 'user', id: uid }, null, { nickname: { from: target.nickname, to: body.nickname || null } });
  }
  if (body.role_ids !== undefined) {
    if (!has(perms, P.MANAGE_ROLES)) throw forbidden();
    const mine = await userHighest(id, a.userId);
    if (uid !== a.userId && uid !== server.ownerId) {
      const theirs = await userHighest(id, uid);
      if (!(mine > theirs)) throw forbidden('That member has a role equal to or higher than yours.');
    }
    const wanted = new Set(body.role_ids);
    const current = new Set(target.roleIds);
    const roles = new Map(server.roles.map((r) => [r.id, r]));
    for (const rid of new Set([...wanted, ...current])) {
      if (wanted.has(rid) === current.has(rid)) continue;
      const r = roles.get(rid);
      if (!r || r.is_default) throw badRequest('Unknown role.');
      if (!(r.position < mine)) throw forbidden(`You can't assign or remove "${r.name}" — it's not below your highest role.`);
    }
    await db.tx(async (q) => {
      await q.query('DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2', [id, uid]);
      for (const rid of wanted) await q.query('INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1,$2,$3)', [id, uid, rid]);
    });
    const added = [...wanted].filter((r) => !current.has(r)), removed = [...current].filter((r) => !wanted.has(r));
    await audit(id, a.userId, 'member_role_update', { type: 'user', id: uid }, null, { added, removed });
  }
  invalidateMember(id, uid);
  const m = await memberJson(id, uid);
  await toServer(id, 'MEMBER_UPDATE', { server_id: id, member: m });
  if (body.role_ids !== undefined) { await syncServerToMembers(id, [uid]); await recheckVoicePermissions(id); }
  return m;
});

/* ───────────── roles ───────────── */

router.get('/servers/:id/roles', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { server } = await requireServerPerm(a.userId, id);
  return server.roles.map(roleJson);
});

const roleBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  color: roleColor.optional(),
  permissions: z.number().int().min(0).max(ALL_PERMISSIONS).optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
}).strict();

function assertGrantable(actorPerms: number, isOwner: boolean, requested: number, previous = 0) {
  if (isOwner || has(actorPerms, P.ADMINISTRATOR)) return;
  const changed = requested ^ previous;
  if ((changed & ~actorPerms) !== 0) throw forbidden("You can't grant or revoke permissions you don't have.");
}

router.post('/servers/:id/roles', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { perms, server } = await requireServerPerm(a.userId, id, P.MANAGE_ROLES);
  const body = await ctx.body(roleBody);
  if (server.roles.length >= 250) throw badRequest('This server has too many roles.');
  const permissions = body.permissions ?? 0;
  assertGrantable(perms, server.ownerId === a.userId, permissions);
  const role = await db.tx(async (q) => {
    await q.query('UPDATE roles SET position = position + 1 WHERE server_id = $1 AND NOT is_default', [id]);
    return one(
      `INSERT INTO roles (server_id, name, color, position, permissions, hoist, mentionable) VALUES ($1,$2,$3,1,$4,$5,$6) RETURNING *`,
      [id, body.name ?? 'new role', body.color ?? null, permissions, body.hoist ?? false, body.mentionable ?? false], q);
  });
  await audit(id, a.userId, 'role_create', { type: 'role', id: role.id }, null, { name: role.name, permissions });
  await afterRoleChange(id);
  return roleJson(roleFromRow(role));
});

router.patch('/servers/:id/roles/:rid', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const rid = idParam(ctx, 'rid');
  const { perms, server } = await requireServerPerm(a.userId, id, P.MANAGE_ROLES);
  const body = await ctx.body(roleBody);
  const role = server.roles.find((r) => r.id === rid);
  if (!role) throw notFound('Role');
  const isOwner = server.ownerId === a.userId;
  if (!isOwner && !(role.position < (await userHighest(id, a.userId)))) throw forbidden('You can only edit roles below your highest role.');
  if (body.permissions !== undefined) assertGrantable(perms, isOwner, body.permissions, role.permissions);
  if (role.is_default && body.name !== undefined && body.name !== '@everyone') throw badRequest("The @everyone role can't be renamed.");
  const sets: string[] = []; const vals: unknown[] = [rid];
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined) {
    vals.push(v); sets.push(`${k} = $${vals.length}`);
    if ((role as any)[k] !== v) changes[k] = { from: (role as any)[k], to: v };
  }
  if (sets.length) await db.query(`UPDATE roles SET ${sets.join(', ')} WHERE id = $1`, vals);
  if (Object.keys(changes).length) await audit(id, a.userId, 'role_update', { type: 'role', id: rid }, null, changes);
  await afterRoleChange(id);
  const updated = await one('SELECT * FROM roles WHERE id = $1', [rid]);
  return roleJson(roleFromRow(updated));
});

router.delete('/servers/:id/roles/:rid', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const rid = idParam(ctx, 'rid');
  const { server } = await requireServerPerm(a.userId, id, P.MANAGE_ROLES);
  const role = server.roles.find((r) => r.id === rid);
  if (!role) throw notFound('Role');
  if (role.is_default) throw badRequest("The @everyone role can't be deleted.");
  if (server.ownerId !== a.userId && !(role.position < (await userHighest(id, a.userId)))) throw forbidden('You can only delete roles below your highest role.');
  await db.tx(async (q) => {
    await q.query('DELETE FROM roles WHERE id = $1', [rid]);
    await q.query('UPDATE roles SET position = position - 1 WHERE server_id = $1 AND position > $2', [id, role.position]);
    await q.query(`DELETE FROM channel_overwrites WHERE target_type = 'role' AND target_id = $1`, [rid]);
  });
  await audit(id, a.userId, 'role_delete', { type: 'role', id: rid }, null, { name: role.name });
  await afterRoleChange(id);
  return { ok: true };
});

/** Reorder roles. `role_ids` lists every non-default role, highest first. */
router.put('/servers/:id/roles-order', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { server } = await requireServerPerm(a.userId, id, P.MANAGE_ROLES);
  const { role_ids } = await ctx.body(z.object({ role_ids: z.array(z.string().regex(/^\d+$/)).max(250) }));
  const nonDefault = server.roles.filter((r) => !r.is_default);
  if (role_ids.length !== nonDefault.length || new Set(role_ids).size !== role_ids.length || !role_ids.every((rid) => nonDefault.some((r) => r.id === rid))) {
    throw badRequest('Provide every role exactly once.');
  }
  const newPos = new Map(role_ids.map((rid, i) => [rid, role_ids.length - i]));
  if (server.ownerId !== a.userId) {
    const mine = await userHighest(id, a.userId);
    for (const r of nonDefault) {
      const moved = newPos.get(r.id) !== r.position;
      // Roles at or above yours can't move, and nothing can be placed at or above your top role.
      if ((r.position >= mine && moved) || (r.position < mine && newPos.get(r.id)! >= mine)) {
        throw forbidden('You can only reorder roles below your highest role.');
      }
    }
  }
  await db.tx(async (q) => { for (const [rid, pos] of newPos) await q.query('UPDATE roles SET position = $1 WHERE id = $2', [pos, rid]); });
  await audit(id, a.userId, 'role_reorder', { type: 'server', id }, null, { order: role_ids });
  await afterRoleChange(id);
  return (await getServerCache(id))!.roles.map(roleJson);
});

/* ───────────── categories ───────────── */

router.post('/servers/:id/categories', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id, P.MANAGE_CHANNELS);
  const { name } = await ctx.body(z.object({ name: z.string().trim().min(1).max(100) }));
  const pos = await one<{ p: number }>('SELECT COALESCE(max(position), -1) + 1 AS p FROM categories WHERE server_id = $1', [id]);
  const c = await one('INSERT INTO categories (server_id, name, position) VALUES ($1,$2,$3) RETURNING *', [id, name, pos!.p]);
  await audit(id, a.userId, 'category_create', { type: 'category', id: c.id }, null, { name });
  await syncServerToMembers(id);
  return c;
});

router.patch('/servers/:id/categories/:cid', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const cid = idParam(ctx, 'cid');
  await requireServerPerm(a.userId, id, P.MANAGE_CHANNELS);
  const body = await ctx.body(z.object({ name: z.string().trim().min(1).max(100).optional(), position: z.number().int().min(0).max(1000).optional() }));
  const c = await one('UPDATE categories SET name = COALESCE($3, name), position = COALESCE($4, position) WHERE id = $1 AND server_id = $2 RETURNING *',
    [cid, id, body.name ?? null, body.position ?? null]);
  if (!c) throw notFound('Category');
  await audit(id, a.userId, 'category_update', { type: 'category', id: cid }, null, body);
  await syncServerToMembers(id);
  return c;
});

router.delete('/servers/:id/categories/:cid', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const cid = idParam(ctx, 'cid');
  await requireServerPerm(a.userId, id, P.MANAGE_CHANNELS);
  const r = await db.query('DELETE FROM categories WHERE id = $1 AND server_id = $2', [cid, id]);
  if (!r.rowCount) throw notFound('Category');
  await audit(id, a.userId, 'category_delete', { type: 'category', id: cid });
  await syncServerToMembers(id);
  return { ok: true };
});

/* ───────────── channels (create & order; per-channel routes live in channels.ts) ───────────── */

router.post('/servers/:id/channels', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { server } = await requireServerPerm(a.userId, id, P.MANAGE_CHANNELS);
  const body = await ctx.body(z.object({
    name: z.string(), type: z.enum(['text', 'voice']), category_id: z.string().regex(/^\d+$/).nullable().optional(),
    topic: z.string().max(1024).optional(), private: z.boolean().optional(),
  }));
  const name = body.type === 'text' ? textChannelName.parse(body.name) : voiceChannelName.parse(body.name);
  if (body.category_id && !(await one('SELECT 1 FROM categories WHERE id = $1 AND server_id = $2', [body.category_id, id]))) throw badRequest('Unknown category.');
  const count = await one<{ n: number }>(`SELECT count(*)::int AS n FROM channels WHERE server_id = $1 AND type <> 'thread'`, [id]);
  if ((count?.n ?? 0) >= 500) throw badRequest('This server has too many channels.');
  const pos = await one<{ p: number }>(`SELECT COALESCE(max(position), -1) + 1 AS p FROM channels WHERE server_id = $1 AND category_id IS NOT DISTINCT FROM $2`, [id, body.category_id ?? null]);
  const ch = await db.tx(async (q) => {
    const c = await one(
      `INSERT INTO channels (server_id, category_id, type, name, topic, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, body.category_id ?? null, body.type, name, body.topic ?? '', pos!.p], q);
    if (body.private) {
      const everyone = server.roles.find((r) => r.is_default)!;
      await q.query(`INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES ($1,'role',$2,0,$3)`, [c.id, everyone.id, P.VIEW_CHANNEL]);
      await q.query(`INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES ($1,'member',$2,$3,0)`, [c.id, a.userId, P.VIEW_CHANNEL]);
    }
    return c;
  });
  await audit(id, a.userId, 'channel_create', { type: 'channel', id: ch.id }, null, { name, type: body.type, private: !!body.private });
  invalidateServer(id);
  await syncServerToMembers(id);
  return channelJson(ch);
});

router.put('/servers/:id/channels-order', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id, P.MANAGE_CHANNELS);
  const { items } = await ctx.body(z.object({
    items: z.array(z.object({ id: z.string().regex(/^\d+$/), position: z.number().int().min(0).max(10000), category_id: z.string().regex(/^\d+$/).nullable() })).max(500),
  }));
  await db.tx(async (q) => {
    for (const it of items) {
      if (it.category_id && !(await one('SELECT 1 FROM categories WHERE id = $1 AND server_id = $2', [it.category_id, id], q))) throw badRequest('Unknown category.');
      await q.query(`UPDATE channels SET position = $1, category_id = $2 WHERE id = $3 AND server_id = $4 AND type <> 'thread'`, [it.position, it.category_id, it.id, id]);
    }
  });
  await syncServerToMembers(id);
  return { ok: true };
});

/* ───────────── invites ───────────── */

function inviteJson(r: any) {
  return {
    code: r.code, server_id: r.server_id, channel_id: r.channel_id, inviter_id: r.inviter_id,
    inviter: r.username ? publicUser({ ...r, id: r.inviter_id }) : null,
    max_uses: r.max_uses, uses: r.uses, expires_at: r.expires_at, revoked_at: r.revoked_at, created_at: r.created_at,
    url: `/invite/${r.code}`,
  };
}

router.post('/servers/:id/invites', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id, P.CREATE_INVITE);
  limits.writes.check(`u:${a.userId}`);
  const body = await ctx.body(z.object({
    max_uses: z.number().int().min(1).max(1000).nullable().optional(),
    max_age_seconds: z.number().int().min(0).max(30 * 86400).optional(), // 0 = never expires
    channel_id: z.string().regex(/^\d+$/).nullable().optional(),
  }));
  const age = body.max_age_seconds ?? 7 * 86400;
  let code = inviteCode();
  for (let i = 0; i < 5 && (await one('SELECT 1 FROM invites WHERE code = $1', [code])); i++) code = inviteCode(10);
  const inv = await one(
    `INSERT INTO invites (code, server_id, channel_id, inviter_id, max_uses, expires_at)
     VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int = 0 THEN NULL ELSE now() + make_interval(secs => $6::int) END) RETURNING *`,
    [code, id, body.channel_id ?? null, a.userId, body.max_uses ?? null, age]);
  await audit(id, a.userId, 'invite_create', { type: 'invite', id: code }, null, { max_uses: inv.max_uses, expires_at: inv.expires_at });
  return inviteJson(inv);
});

router.get('/servers/:id/invites', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { perms } = await requireServerPerm(a.userId, id);
  const all = has(perms, P.MANAGE_INVITES);
  const rows = await many(
    `SELECT i.*, u.username, u.display_name, u.avatar_key, u.banner_key, u.accent_color, u.bio, u.custom_status FROM invites i LEFT JOIN users u ON u.id = i.inviter_id
      WHERE i.server_id = $1 AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > now())
        AND (i.max_uses IS NULL OR i.uses < i.max_uses) AND ($2 OR i.inviter_id = $3) ORDER BY i.created_at DESC`, [id, all, a.userId]);
  return rows.map(inviteJson);
});

router.delete('/invites/:code', async (ctx) => {
  const a = ctx.user();
  const inv = await one('SELECT * FROM invites WHERE code = $1', [ctx.params.code]);
  if (!inv) throw notFound('Invite');
  const { perms } = await requireServerPerm(a.userId, inv.server_id);
  if (inv.inviter_id !== a.userId && !has(perms, P.MANAGE_INVITES)) throw forbidden();
  await db.query('UPDATE invites SET revoked_at = now() WHERE code = $1', [inv.code]);
  await audit(inv.server_id, a.userId, 'invite_delete', { type: 'invite', id: inv.code });
  return { ok: true };
});

/** Invite preview — available without signing in so the landing page can show it. */
router.get('/invites/:code', async (ctx) => {
  const code = ctx.params.code;
  if (!/^[A-Za-z0-9]{4,32}$/.test(code)) throw notFound('Invite');
  const inv = await one(
    `SELECT i.*, s.name, s.icon_key, s.description, (SELECT count(*)::int FROM server_members WHERE server_id = s.id) AS member_count
       FROM invites i JOIN servers s ON s.id = i.server_id
      WHERE i.code = $1 AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > now()) AND (i.max_uses IS NULL OR i.uses < i.max_uses)`, [code]);
  if (!inv) throw new HttpError(404, 'invite_invalid', 'This invite is invalid or has expired.');
  const joined = ctx.auth ? !!(await getMember(inv.server_id, ctx.auth.userId)) : false;
  return {
    code, server: { id: inv.server_id, name: inv.name, icon_url: mediaUrl(inv.icon_key), description: inv.description, member_count: inv.member_count },
    expires_at: inv.expires_at, joined,
  };
});

router.post('/invites/:code/accept', async (ctx) => {
  const a = requireVerified(ctx);
  limits.writes.check(`u:${a.userId}`);
  const code = ctx.params.code;
  const inv = await one('SELECT * FROM invites WHERE code = $1', [code]);
  if (!inv) throw new HttpError(404, 'invite_invalid', 'This invite is invalid or has expired.');
  if (await getMember(inv.server_id, a.userId)) return serverPayload(inv.server_id, a.userId);
  if (await one('SELECT 1 FROM bans WHERE server_id = $1 AND user_id = $2', [inv.server_id, a.userId])) throw forbidden('You are banned from this server.');
  // Atomically consume one use.
  const used = await db.query(
    `UPDATE invites SET uses = uses + 1 WHERE code = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND (max_uses IS NULL OR uses < max_uses) RETURNING code`, [code]);
  if (!used.rowCount) throw new HttpError(404, 'invite_invalid', 'This invite is invalid or has expired.');
  await addMember(inv.server_id, a.userId);
  return serverPayload(inv.server_id, a.userId);
});

export { conflict };
export type { Ctx };
