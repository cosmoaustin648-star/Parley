import { z } from 'zod';
import { Router, badRequest, forbidden, notFound, idParam } from '../http/router.ts';
import { db, one, many } from '../db/index.ts';
import { limits } from '../http/ratelimit.ts';
import {
  requireServerPerm, assertCanActOn, getMember, invalidateMember, basePermissions, requireChannel,
} from '../services/access.ts';
import { syncServerToMembers } from '../services/state.ts';
import { publicUser, USER_COLS } from '../services/serialize.ts';
import { audit } from '../services/audit.ts';
import { invalidateAutomod, keywordMatcher } from '../services/automod.ts';
import { toServer, toUsers, presenceOf } from '../realtime/gateway.ts';
import { moderateVoice, recheckVoicePermissions } from '../realtime/voice.ts';
import { removeMember } from './servers.ts';
import { P, has, isTimedOut } from '../../shared/permissions.ts';
import { storage } from '../storage/index.ts';

export const router = new Router('/api');

const reasonSchema = z.string().trim().max(512).optional();

/* ───────────── kick / ban / timeout ───────────── */

router.post('/servers/:id/members/:uid/kick', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id'); const uid = idParam(ctx, 'uid');
  await requireServerPerm(a.userId, id, P.KICK_MEMBERS);
  limits.writes.check(`mod:${a.userId}`);
  const { reason } = await ctx.body(z.object({ reason: reasonSchema }));
  if (!(await getMember(id, uid))) throw notFound('Member');
  await assertCanActOn(id, a.userId, uid);
  await removeMember(id, uid);
  await audit(id, a.userId, 'member_kick', { type: 'user', id: uid }, reason);
  return { ok: true };
});

router.get('/servers/:id/bans', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id, P.BAN_MEMBERS);
  const rows = await many(
    `SELECT b.reason, b.created_at AS banned_at, b.banned_by, ${USER_COLS} FROM bans b JOIN users u ON u.id = b.user_id WHERE b.server_id = $1 ORDER BY b.created_at DESC`, [id]);
  return rows.map((r: any) => ({ user: publicUser(r), reason: r.reason, banned_at: r.banned_at, banned_by: r.banned_by }));
});

router.put('/servers/:id/bans/:uid', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id'); const uid = idParam(ctx, 'uid');
  await requireServerPerm(a.userId, id, P.BAN_MEMBERS);
  limits.writes.check(`mod:${a.userId}`);
  const body = await ctx.body(z.object({ reason: reasonSchema, delete_message_seconds: z.number().int().min(0).max(7 * 86400).optional() }));
  if (!(await one('SELECT 1 FROM users WHERE id = $1', [uid]))) throw notFound('User');
  const isMember = !!(await getMember(id, uid));
  if (isMember) await assertCanActOn(id, a.userId, uid);
  else if (uid === a.userId) throw forbidden("You can't ban yourself.");
  await db.query(
    `INSERT INTO bans (server_id, user_id, reason, banned_by) VALUES ($1,$2,$3,$4) ON CONFLICT (server_id, user_id) DO UPDATE SET reason = EXCLUDED.reason`,
    [id, uid, body.reason ?? null, a.userId]);
  if (isMember) await removeMember(id, uid);
  let deleted = 0;
  if (body.delete_message_seconds) {
    const rows = await many<{ id: string; channel_id: string }>(
      `DELETE FROM messages m USING channels c WHERE m.channel_id = c.id AND c.server_id = $1 AND m.author_id = $2
         AND m.created_at > now() - make_interval(secs => $3) RETURNING m.id, m.channel_id`, [id, uid, body.delete_message_seconds]);
    deleted = rows.length;
    const byChannel = new Map<string, string[]>();
    for (const r of rows) byChannel.set(r.channel_id, [...(byChannel.get(r.channel_id) ?? []), r.id]);
    for (const [cid, ids] of byChannel) await toServer(id, 'MESSAGE_DELETE_BULK', { ids, channel_id: cid });
  }
  await audit(id, a.userId, 'member_ban', { type: 'user', id: uid }, body.reason, { deleted_messages: deleted });
  return { ok: true, deleted_messages: deleted };
});

router.delete('/servers/:id/bans/:uid', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id'); const uid = idParam(ctx, 'uid');
  await requireServerPerm(a.userId, id, P.BAN_MEMBERS);
  const r = await db.query('DELETE FROM bans WHERE server_id = $1 AND user_id = $2', [id, uid]);
  if (!r.rowCount) throw notFound('Ban');
  await audit(id, a.userId, 'member_unban', { type: 'user', id: uid });
  return { ok: true };
});

async function memberUpdated(serverId: string, uid: string) {
  invalidateMember(serverId, uid);
  const m = await one(
    `SELECT ${USER_COLS}, m.nickname, m.joined_at, m.timeout_until,
            COALESCE(array_agg(mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}') AS role_ids
       FROM server_members m JOIN users u ON u.id = m.user_id LEFT JOIN member_roles mr ON mr.server_id = m.server_id AND mr.user_id = m.user_id
      WHERE m.server_id = $1 AND m.user_id = $2 GROUP BY u.id, m.server_id, m.user_id`, [serverId, uid]);
  if (m) await toServer(serverId, 'MEMBER_UPDATE', {
    server_id: serverId,
    member: {
      user: publicUser(m), nickname: m.nickname, role_ids: m.role_ids, joined_at: m.joined_at,
      timeout_until: m.timeout_until && isTimedOut(m.timeout_until) ? m.timeout_until : null, presence: presenceOf(uid),
    },
  });
  await syncServerToMembers(serverId, [uid]);
  await recheckVoicePermissions(serverId);
}

router.put('/servers/:id/members/:uid/timeout', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id'); const uid = idParam(ctx, 'uid');
  await requireServerPerm(a.userId, id, P.MODERATE_MEMBERS);
  const body = await ctx.body(z.object({ duration_seconds: z.number().int().min(10).max(28 * 86400), reason: reasonSchema }));
  if (!(await getMember(id, uid))) throw notFound('Member');
  await assertCanActOn(id, a.userId, uid);
  if (has(await basePermissions(id, uid), P.ADMINISTRATOR)) throw forbidden("Administrators can't be timed out.");
  const until = new Date(Date.now() + body.duration_seconds * 1000);
  await db.query('UPDATE server_members SET timeout_until = $3 WHERE server_id = $1 AND user_id = $2', [id, uid, until]);
  await audit(id, a.userId, 'member_timeout', { type: 'user', id: uid }, body.reason, { until: until.toISOString(), seconds: body.duration_seconds });
  await memberUpdated(id, uid);
  return { ok: true, timeout_until: until.toISOString() };
});

router.delete('/servers/:id/members/:uid/timeout', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id'); const uid = idParam(ctx, 'uid');
  await requireServerPerm(a.userId, id, P.MODERATE_MEMBERS);
  if (!(await getMember(id, uid))) throw notFound('Member');
  await assertCanActOn(id, a.userId, uid);
  await db.query('UPDATE server_members SET timeout_until = NULL WHERE server_id = $1 AND user_id = $2', [id, uid]);
  await audit(id, a.userId, 'member_timeout_remove', { type: 'user', id: uid });
  await memberUpdated(id, uid);
  return { ok: true };
});

/* ───────────── voice moderation ───────────── */

router.patch('/servers/:id/members/:uid/voice', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id'); const uid = idParam(ctx, 'uid');
  const { perms } = await requireServerPerm(a.userId, id);
  const body = await ctx.body(z.object({
    mute: z.boolean().optional(), deaf: z.boolean().optional(), channel_id: z.string().regex(/^\d+$/).nullable().optional(),
  }).strict());
  if (body.mute !== undefined && !has(perms, P.MUTE_MEMBERS)) throw forbidden();
  if (body.deaf !== undefined && !has(perms, P.DEAFEN_MEMBERS)) throw forbidden();
  if (body.channel_id !== undefined && !has(perms, P.MOVE_MEMBERS)) throw forbidden();
  if (!(await getMember(id, uid))) throw notFound('Member');
  if (uid !== a.userId) await assertCanActOn(id, a.userId, uid);
  const state = await moderateVoice(id, uid, body);
  if (body.mute !== undefined) await audit(id, a.userId, 'member_voice_mute', { type: 'user', id: uid }, null, { mute: body.mute });
  if (body.deaf !== undefined) await audit(id, a.userId, 'member_voice_deafen', { type: 'user', id: uid }, null, { deaf: body.deaf });
  if (body.channel_id === null) await audit(id, a.userId, 'member_voice_disconnect', { type: 'user', id: uid });
  else if (body.channel_id) await audit(id, a.userId, 'member_voice_move', { type: 'user', id: uid }, null, { channel_id: body.channel_id });
  return { voice_state: state };
});

/* ───────────── audit log ───────────── */

router.get('/servers/:id/audit-log', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id, P.VIEW_AUDIT_LOG);
  const before = ctx.query.get('before');
  const action = ctx.query.get('action');
  const actor = ctx.query.get('actor_id');
  if (before && !/^\d+$/.test(before)) throw badRequest('Invalid cursor.');
  if (actor && !/^\d+$/.test(actor)) throw badRequest('Invalid actor.');
  const rows = await many(
    `SELECT l.*, ${USER_COLS.replace('u.id, ', 'u.id AS uid, ')} FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
      WHERE l.server_id = $1 AND ($2::bigint IS NULL OR l.id < $2) AND ($3::text IS NULL OR l.action = $3) AND ($4::bigint IS NULL OR l.actor_id = $4)
      ORDER BY l.id DESC LIMIT 50`, [id, before, action, actor]);
  const targetUserIds = [...new Set(rows.filter((r: any) => r.target_type === 'user' && r.target_id).map((r: any) => r.target_id))];
  const targets = targetUserIds.length ? await many(`SELECT ${USER_COLS} FROM users u WHERE u.id = ANY($1::bigint[])`, [targetUserIds]) : [];
  const tmap = new Map(targets.map((t: any) => [t.id, publicUser(t)]));
  return rows.map((r: any) => ({
    id: r.id, action: r.action, reason: r.reason, changes: r.changes, created_at: r.created_at,
    actor: r.uid ? publicUser({ ...r, id: r.uid }) : null, // null = AutoMod/system
    target_type: r.target_type, target_id: r.target_id,
    target_user: r.target_type === 'user' ? tmap.get(r.target_id) ?? null : null,
  }));
});

/* ───────────── AutoMod rules ───────────── */

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  trigger_type: z.enum(['keyword', 'mention_spam', 'links', 'invites']),
  config: z.object({
    keywords: z.array(z.string().trim().min(1).max(60)).max(1000).optional(),
    allow: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    allowed_domains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+$/)).max(100).optional(),
  }).default({}),
  action: z.enum(['block', 'block_and_timeout']).default('block'),
  timeout_seconds: z.number().int().min(10).max(7 * 86400).default(60),
  exempt_role_ids: z.array(z.string().regex(/^\d+$/)).max(50).default([]),
});

router.get('/servers/:id/automod-rules', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id, P.MANAGE_SERVER);
  return many('SELECT * FROM automod_rules WHERE server_id = $1 ORDER BY id', [id]);
});

router.post('/servers/:id/automod-rules', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id, P.MANAGE_SERVER);
  const b = await ctx.body(ruleSchema);
  if (b.trigger_type === 'keyword' && !keywordMatcher(b.config.keywords ?? [])) throw badRequest('Add at least one keyword.');
  const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM automod_rules WHERE server_id = $1', [id]);
  if (n!.n >= 25) throw badRequest('This server has the maximum number of AutoMod rules.');
  const r = await one(
    `INSERT INTO automod_rules (server_id, name, enabled, trigger_type, config, action, timeout_seconds, exempt_role_ids, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [id, b.name, b.enabled, b.trigger_type, b.config, b.action, b.timeout_seconds, b.exempt_role_ids, a.userId]);
  invalidateAutomod(id);
  await audit(id, a.userId, 'automod_rule_create', { type: 'automod_rule', id: r.id }, null, { name: b.name, trigger_type: b.trigger_type });
  return r;
});

router.patch('/servers/:id/automod-rules/:rid', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id'); const rid = idParam(ctx, 'rid');
  await requireServerPerm(a.userId, id, P.MANAGE_SERVER);
  const b = await ctx.body(ruleSchema.partial());
  const cur = await one('SELECT * FROM automod_rules WHERE id = $1 AND server_id = $2', [rid, id]);
  if (!cur) throw notFound('Rule');
  const next = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
  const r = await one(
    `UPDATE automod_rules SET name=$3, enabled=$4, trigger_type=$5, config=$6, action=$7, timeout_seconds=$8, exempt_role_ids=$9
      WHERE id = $1 AND server_id = $2 RETURNING *`,
    [rid, id, next.name, next.enabled, next.trigger_type, next.config, next.action, next.timeout_seconds, next.exempt_role_ids]);
  invalidateAutomod(id);
  await audit(id, a.userId, 'automod_rule_update', { type: 'automod_rule', id: rid }, null, b);
  return r;
});

router.delete('/servers/:id/automod-rules/:rid', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id'); const rid = idParam(ctx, 'rid');
  await requireServerPerm(a.userId, id, P.MANAGE_SERVER);
  const r = await db.query('DELETE FROM automod_rules WHERE id = $1 AND server_id = $2', [rid, id]);
  if (!r.rowCount) throw notFound('Rule');
  invalidateAutomod(id);
  await audit(id, a.userId, 'automod_rule_delete', { type: 'automod_rule', id: rid });
  return { ok: true };
});

/* ───────────── reports ───────────── */

router.post('/reports', async (ctx) => {
  const a = ctx.user();
  limits.writes.check(`report:${a.userId}`);
  const b = await ctx.body(z.object({
    message_id: z.string().regex(/^\d+$/).optional(),
    user_id: z.string().regex(/^\d+$/).optional(),
    server_id: z.string().regex(/^\d+$/).optional(),
    reason: z.string().trim().min(3, 'Tell us what is wrong.').max(1000),
  }).refine((x) => x.message_id || x.user_id, 'Report a message or a user.'));
  let serverId: string | null = null, channelId: string | null = null, targetUserId = b.user_id ?? null, snapshot: string | null = null;
  if (b.message_id) {
    const m = await one('SELECT * FROM messages WHERE id = $1', [b.message_id]);
    if (!m) throw notFound('Message');
    const { channel } = await requireChannel(a.userId, m.channel_id);
    serverId = channel.server_id; channelId = channel.id; targetUserId = m.author_id; snapshot = m.content;
  } else if (b.server_id) {
    await requireServerPerm(a.userId, b.server_id);
    if (!(await getMember(b.server_id, b.user_id!))) throw notFound('Member');
    serverId = b.server_id;
  }
  if (targetUserId === a.userId) throw badRequest("You can't report yourself.");
  const r = await one(
    `INSERT INTO reports (reporter_id, server_id, channel_id, message_id, target_user_id, message_snapshot, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [a.userId, serverId, channelId, b.message_id ?? null, targetUserId, snapshot, b.reason]);
  if (serverId) {
    // Let online moderators know there is something to review.
    const mods = await many<{ user_id: string }>('SELECT user_id FROM server_members WHERE server_id = $1', [serverId]);
    const notify: string[] = [];
    for (const m of mods) if (has(await basePermissions(serverId, m.user_id), P.KICK_MEMBERS)) notify.push(m.user_id);
    toUsers(notify, 'REPORT_CREATE', { server_id: serverId, report_id: r.id });
  }
  return { ok: true, id: r.id };
});

async function reportRows(where: string, params: unknown[]) {
  const rows = await many(
    `SELECT r.*, ${USER_COLS.replace('u.id, ', 'u.id AS uid, ')},
            t.username AS t_username, t.display_name AS t_display_name, t.avatar_key AS t_avatar_key
       FROM reports r LEFT JOIN users u ON u.id = r.reporter_id LEFT JOIN users t ON t.id = r.target_user_id
      WHERE ${where} ORDER BY (r.status = 'open') DESC, r.id DESC LIMIT 100`, params);
  return rows.map((r: any) => ({
    id: r.id, server_id: r.server_id, channel_id: r.channel_id, message_id: r.message_id, reason: r.reason, status: r.status,
    message_snapshot: r.message_snapshot, created_at: r.created_at, resolved_at: r.resolved_at,
    reporter: r.uid ? publicUser({ ...r, id: r.uid }) : null,
    target: r.target_user_id ? publicUser({ id: r.target_user_id, username: r.t_username, display_name: r.t_display_name, avatar_key: r.t_avatar_key, bio: '', created_at: r.created_at }) : null,
  }));
}

router.get('/servers/:id/reports', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireServerPerm(a.userId, id, P.KICK_MEMBERS);
  return reportRows('r.server_id = $1', [id]);
});

router.patch('/reports/:id', async (ctx) => {
  const a = ctx.user();
  const rid = idParam(ctx, 'id');
  const { status } = await ctx.body(z.object({ status: z.enum(['open', 'resolved', 'dismissed']) }));
  const r = await one('SELECT * FROM reports WHERE id = $1', [rid]);
  if (!r) throw notFound('Report');
  if (r.server_id) await requireServerPerm(a.userId, r.server_id, P.KICK_MEMBERS);
  else if (!a.isStaff) throw notFound('Report');
  await db.query(`UPDATE reports SET status = $2, resolved_by = $3, resolved_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END WHERE id = $1`, [rid, status, a.userId]);
  if (r.server_id) await audit(r.server_id, a.userId, 'report_resolve', { type: 'report', id: rid }, null, { status });
  return { ok: true };
});

/* Platform staff (STAFF_EMAILS): reports from DMs and account suspension. */
router.get('/staff/reports', async (ctx) => {
  const a = ctx.user();
  if (!a.isStaff) throw notFound();
  return reportRows('r.server_id IS NULL', []);
});

router.post('/staff/users/:id/disable', async (ctx) => {
  const a = ctx.user();
  if (!a.isStaff) throw notFound();
  const uid = idParam(ctx, 'id');
  const { disabled } = await ctx.body(z.object({ disabled: z.boolean() }));
  await db.query('UPDATE users SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1 AND NOT is_staff', [uid, disabled]);
  if (disabled) {
    await db.query('DELETE FROM sessions WHERE user_id = $1', [uid]);
    const { disconnectUser } = await import('../realtime/gateway.ts');
    const { invalidateSessionCache } = await import('../auth/session.ts');
    invalidateSessionCache(uid);
    disconnectUser(uid);
  }
  return { ok: true };
});

export { storage };
