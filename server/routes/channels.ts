import { z } from 'zod';
import { Router, badRequest, forbidden, notFound, idParam } from '../http/router.ts';
import { db, one, many } from '../db/index.ts';
import { limits } from '../http/ratelimit.ts';
import {
  requireChannel, requireServerPerm, invalidateServer, getServerCache, getMember, channelPermissions, basePermissions,
} from '../services/access.ts';
import { syncServerToMembers } from '../services/state.ts';
import { channelJson, hydrateMessages, publicUser, USER_COLS } from '../services/serialize.ts';
import { audit } from '../services/audit.ts';
import { toChannel } from '../realtime/gateway.ts';
import { recheckVoicePermissions } from '../realtime/voice.ts';
import { P, has, ALL_PERMISSIONS } from '../../shared/permissions.ts';
import { textChannelName, voiceChannelName } from './servers.ts';

export const router = new Router('/api/channels');

router.get('/:id', async (ctx) => {
  const a = ctx.user();
  const { channel, perms } = await requireChannel(a.userId, idParam(ctx, 'id'));
  return channelJson(channel, perms);
});

router.patch('/:id', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { channel: ch, perms } = await requireChannel(a.userId, id);
  limits.writes.check(`u:${a.userId}`);
  const body = await ctx.body(z.object({
    name: z.string().optional(),
    topic: z.string().max(1024).optional(),
    category_id: z.string().regex(/^\d+$/).nullable().optional(),
    position: z.number().int().min(0).max(10000).optional(),
    slowmode_seconds: z.number().int().min(0).max(21600).optional(),
    archived: z.boolean().optional(),
  }).strict());

  if (ch.type === 'thread') {
    if (ch.owner_id !== a.userId && !has(perms, P.MANAGE_MESSAGES)) throw forbidden();
    const name = body.name !== undefined ? z.string().trim().min(1).max(100).parse(body.name) : ch.name;
    const updated = await one('UPDATE channels SET name = $2, archived = COALESCE($3, archived) WHERE id = $1 RETURNING *', [id, name, body.archived ?? null]);
    const parent = await one('SELECT * FROM channels WHERE id = $1', [ch.parent_channel_id]);
    await audit(ch.server_id!, a.userId, 'thread_update', { type: 'channel', id }, null, body);
    if (parent) await toChannel(parent, 'THREAD_UPDATE', channelJson(updated));
    return channelJson(updated, perms);
  }
  if (ch.type === 'group_dm') {
    const name = body.name !== undefined ? z.string().trim().max(100).parse(body.name) || null : ch.name;
    const updated = await one('UPDATE channels SET name = $2 WHERE id = $1 RETURNING *', [id, name]);
    await toChannel(updated, 'CHANNEL_UPDATE', channelJson(updated));
    return channelJson(updated, perms);
  }
  if (ch.type === 'dm') throw badRequest("Direct messages can't be edited.");
  if (!has(perms, P.MANAGE_CHANNELS)) throw forbidden();
  const name = body.name !== undefined ? (ch.type === 'text' ? textChannelName.parse(body.name) : voiceChannelName.parse(body.name)) : undefined;
  if (body.category_id && !(await one('SELECT 1 FROM categories WHERE id = $1 AND server_id = $2', [body.category_id, ch.server_id]))) throw badRequest('Unknown category.');
  const fields: Record<string, unknown> = { name, topic: body.topic, category_id: body.category_id, position: body.position, slowmode_seconds: body.slowmode_seconds };
  const sets: string[] = []; const vals: unknown[] = [id]; const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) {
    vals.push(v); sets.push(`${k} = $${vals.length}`);
    if ((ch as any)[k] !== v) changes[k] = { from: (ch as any)[k], to: v };
  }
  const updated = sets.length ? await one(`UPDATE channels SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals) : ch;
  if (Object.keys(changes).length) await audit(ch.server_id!, a.userId, 'channel_update', { type: 'channel', id }, null, changes);
  if (body.category_id !== undefined || body.position !== undefined) await syncServerToMembers(ch.server_id!);
  else await toChannel(updated, 'CHANNEL_UPDATE', channelJson(updated));
  return channelJson(updated, perms);
});

router.delete('/:id', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { channel: ch, perms } = await requireChannel(a.userId, id);
  if (ch.type === 'dm' || ch.type === 'group_dm') throw badRequest('Use the DM endpoints to close a conversation.');
  if (ch.type === 'thread') { if (ch.owner_id !== a.userId && !has(perms, P.MANAGE_MESSAGES)) throw forbidden(); }
  else if (!has(perms, P.MANAGE_CHANNELS)) throw forbidden();
  const audience = ch.type === 'thread' ? await one('SELECT * FROM channels WHERE id = $1', [ch.parent_channel_id]) : ch;
  await db.query('DELETE FROM channels WHERE id = $1', [id]);
  await audit(ch.server_id!, a.userId, 'channel_delete', { type: 'channel', id }, null, { name: ch.name, type: ch.type });
  invalidateServer(ch.server_id!);
  if (ch.type === 'thread' && audience) await toChannel(audience, 'CHANNEL_DELETE', { id, server_id: ch.server_id, parent_channel_id: ch.parent_channel_id });
  else await syncServerToMembers(ch.server_id!);
  return { ok: true };
});

/* ───────────── permission overwrites ───────────── */

router.get('/:id/overwrites', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { channel: ch, perms } = await requireChannel(a.userId, id);
  if (!ch.server_id || ch.type === 'thread') throw badRequest('This channel has no permission overrides.');
  if (!has(perms, P.MANAGE_ROLES) && !has(perms, P.MANAGE_CHANNELS)) throw forbidden();
  const rows = await many(
    `SELECT o.*, r.name AS role_name, r.color AS role_color, ${USER_COLS.replace('u.id, ', 'u.id AS uid, ')}
       FROM channel_overwrites o
       LEFT JOIN roles r ON o.target_type = 'role' AND r.id = o.target_id
       LEFT JOIN users u ON o.target_type = 'member' AND u.id = o.target_id
      WHERE o.channel_id = $1`, [id]);
  return rows.map((r: any) => ({
    target_type: r.target_type, target_id: r.target_id, allow: Number(r.allow), deny: Number(r.deny),
    role: r.target_type === 'role' ? { id: r.target_id, name: r.role_name, color: r.role_color } : null,
    user: r.target_type === 'member' && r.uid ? publicUser({ ...r, id: r.uid }) : null,
  }));
});

router.put('/:id/overwrites/:type/:target', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const target = idParam(ctx, 'target');
  const type = ctx.params.type === 'role' ? 'role' : ctx.params.type === 'member' ? 'member' : null;
  if (!type) throw notFound();
  const { channel: ch, perms } = await requireChannel(a.userId, id);
  if (!ch.server_id || ch.type === 'thread') throw badRequest('This channel has no permission overrides.');
  if (!has(perms, P.MANAGE_ROLES)) throw forbidden('You need Manage Roles to edit channel permissions.');
  const body = await ctx.body(z.object({ allow: z.number().int().min(0).max(ALL_PERMISSIONS), deny: z.number().int().min(0).max(ALL_PERMISSIONS) }));
  if (body.allow & body.deny) throw badRequest('A permission cannot be both allowed and denied.');
  const server = await getServerCache(ch.server_id);
  const isAdmin = server!.ownerId === a.userId || has(await basePermissions(ch.server_id, a.userId), P.ADMINISTRATOR);
  const prev = await one('SELECT allow, deny FROM channel_overwrites WHERE channel_id = $1 AND target_type = $2 AND target_id = $3', [id, type, target]);
  const changedBits = (body.allow ^ Number(prev?.allow ?? 0)) | (body.deny ^ Number(prev?.deny ?? 0));
  if (!isAdmin && (changedBits & ~perms) !== 0) throw forbidden("You can't change permissions you don't have yourself.");
  if (body.allow & P.ADMINISTRATOR || body.deny & P.ADMINISTRATOR) throw badRequest('Administrator cannot be set per-channel.');
  if (type === 'role' && !server!.roles.some((r) => r.id === target)) throw badRequest('Unknown role.');
  if (type === 'member' && !(await getMember(ch.server_id, target))) throw badRequest('That user is not a member.');
  await db.query(
    `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (channel_id, target_type, target_id) DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny`,
    [id, type, target, body.allow, body.deny]);
  await audit(ch.server_id, a.userId, 'channel_overwrite_update', { type: 'channel', id }, null, { target_type: type, target_id: target, allow: body.allow, deny: body.deny });
  invalidateServer(ch.server_id);
  await syncServerToMembers(ch.server_id);
  await recheckVoicePermissions(ch.server_id);
  return { ok: true };
});

router.delete('/:id/overwrites/:type/:target', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const target = idParam(ctx, 'target');
  const { channel: ch, perms } = await requireChannel(a.userId, id);
  if (!ch.server_id) throw badRequest('This channel has no permission overrides.');
  if (!has(perms, P.MANAGE_ROLES)) throw forbidden('You need Manage Roles to edit channel permissions.');
  await db.query('DELETE FROM channel_overwrites WHERE channel_id = $1 AND target_type = $2 AND target_id = $3', [id, ctx.params.type, target]);
  await audit(ch.server_id, a.userId, 'channel_overwrite_delete', { type: 'channel', id }, null, { target_type: ctx.params.type, target_id: target });
  invalidateServer(ch.server_id);
  await syncServerToMembers(ch.server_id);
  await recheckVoicePermissions(ch.server_id);
  return { ok: true };
});

/* ───────────── threads ───────────── */

router.post('/:id/threads', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { channel: parent, perms } = await requireChannel(a.userId, id, P.CREATE_THREADS | P.SEND_MESSAGES);
  if (parent.type !== 'text') throw badRequest('Threads can only be created in text channels.');
  limits.writes.check(`u:${a.userId}`);
  const body = await ctx.body(z.object({ name: z.string().trim().min(1).max(100), message_id: z.string().regex(/^\d+$/).optional() }));
  const thread = await db.tx(async (q) => {
    if (body.message_id) {
      const m = await one('SELECT id, thread_id FROM messages WHERE id = $1 AND channel_id = $2 FOR UPDATE', [body.message_id, id], q);
      if (!m) throw notFound('Message');
      if (m.thread_id) throw badRequest('That message already has a thread.');
    }
    const t = await one(
      `INSERT INTO channels (server_id, parent_channel_id, type, name, owner_id) VALUES ($1,$2,'thread',$3,$4) RETURNING *`,
      [parent.server_id, id, body.name, a.userId], q);
    if (body.message_id) await q.query('UPDATE messages SET thread_id = $1 WHERE id = $2', [t.id, body.message_id]);
    const sys = await one(`INSERT INTO messages (channel_id, author_id, type, content, thread_id) VALUES ($1,$2,'thread_created',$3,$4) RETURNING *`,
      [id, a.userId, body.name, t.id], q);
    await q.query('UPDATE channels SET last_message_id = $1 WHERE id = $2', [sys.id, id]);
    return { t, sys };
  });
  await audit(parent.server_id!, a.userId, 'thread_create', { type: 'channel', id: thread.t.id }, null, { name: body.name });
  await toChannel(parent, 'THREAD_CREATE', channelJson(thread.t));
  const [sysMsg] = await hydrateMessages([thread.sys]);
  await toChannel(parent, 'MESSAGE_CREATE', sysMsg);
  if (body.message_id) {
    const [starter] = await hydrateMessages(await many('SELECT * FROM messages WHERE id = $1', [body.message_id]));
    await toChannel(parent, 'MESSAGE_UPDATE', starter);
  }
  return channelJson(thread.t, perms);
});

router.get('/:id/threads', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { perms } = await requireChannel(a.userId, id);
  const rows = await many(
    `SELECT c.*, (SELECT count(*)::int FROM messages WHERE channel_id = c.id) AS message_count
       FROM channels c WHERE c.parent_channel_id = $1 ORDER BY c.archived, COALESCE(c.last_message_id, c.id) DESC LIMIT 100`, [id]);
  return rows.map((r: any) => ({ ...channelJson(r, perms), message_count: r.message_count }));
});

export { channelPermissions, requireServerPerm };
