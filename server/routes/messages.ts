import { z } from 'zod';
import { Router, HttpError, badRequest, forbidden, notFound, idParam } from '../http/router.ts';
import { db, one, many } from '../db/index.ts';
import { limits } from '../http/ratelimit.ts';
import { requireChannel, getServerCache, getMember, channelPermissions, isBlockedEitherWay, type ChannelRow } from '../services/access.ts';
import { hydrateMessages, attachmentJson } from '../services/serialize.ts';
import { audit } from '../services/audit.ts';
import { enforceAutomod } from '../services/automod.ts';
import { receiveUpload, safeFilename, storage } from '../storage/index.ts';
import { toChannel, toUser, toUsers } from '../realtime/gateway.ts';
import { dmChannelJson } from '../services/state.ts';
import { P, has } from '../../shared/permissions.ts';
import { requireVerified } from './auth.ts';

export const router = new Router('/api');

const MAX_CONTENT = 4000;
const MAX_ATTACHMENTS = 10;

/* ───────────── mentions ───────────── */

export interface ParsedMentions { users: string[]; roles: string[]; channels: string[]; everyone: boolean }

/** Mentions are encoded in content as <@userId>, <@&roleId>, <#channelId>, plus @everyone / @here. */
export async function parseMentions(content: string, ch: ChannelRow, perms: number): Promise<ParsedMentions> {
  const stripped = content.replace(/```[\s\S]*?```|`[^`\n]*`/g, ''); // ignore code
  const users = [...new Set([...stripped.matchAll(/<@(\d{1,19})>/g)].map((m) => m[1]))].slice(0, 50);
  const rolesRaw = [...new Set([...stripped.matchAll(/<@&(\d{1,19})>/g)].map((m) => m[1]))];
  const chans = [...new Set([...stripped.matchAll(/<#(\d{1,19})>/g)].map((m) => m[1]))].slice(0, 50);
  let roles: string[] = [];
  let everyone = false;
  if (ch.server_id) {
    const s = await getServerCache(ch.server_id);
    const canAll = has(perms, P.MENTION_EVERYONE);
    roles = rolesRaw.filter((rid) => { const r = s?.roles.find((x) => x.id === rid && !x.is_default); return r && (r.mentionable || canAll); });
    everyone = canAll && /(^|[^\w`])@(everyone|here)\b/.test(stripped);
  }
  // Only keep user mentions that resolve to real users.
  const valid = users.length ? (await many<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::bigint[])', [users])).map((r) => r.id) : [];
  return { users: valid, roles, channels: chans, everyone };
}

/** Users who should get a mention badge for a message (they can see the channel, aren't the author). */
async function mentionRecipients(ch: ChannelRow, authorId: string, m: ParsedMentions): Promise<string[]> {
  if (ch.type === 'dm' || ch.type === 'group_dm') {
    const rows = await many<{ user_id: string }>('SELECT user_id FROM dm_participants WHERE channel_id = $1 AND user_id <> $2', [ch.id, authorId]);
    return rows.map((r) => r.user_id); // every DM message counts toward the unread badge
  }
  const serverId = ch.server_id!;
  let candidates: string[];
  if (m.everyone) {
    candidates = (await many<{ user_id: string }>('SELECT user_id FROM server_members WHERE server_id = $1', [serverId])).map((r) => r.user_id);
  } else {
    const set = new Set(m.users);
    if (m.roles.length) {
      const rows = await many<{ user_id: string }>('SELECT DISTINCT user_id FROM member_roles WHERE server_id = $1 AND role_id = ANY($2::bigint[])', [serverId, m.roles]);
      rows.forEach((r) => set.add(r.user_id));
    }
    candidates = [...set];
  }
  const out: string[] = [];
  for (const uid of candidates) {
    if (uid === authorId) continue;
    if (!(await getMember(serverId, uid))) continue;
    if (has(await channelPermissions(uid, ch), P.VIEW_CHANNEL)) out.push(uid);
  }
  return out;
}

/* ───────────── read messages ───────────── */

router.get('/channels/:id/messages', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireChannel(a.userId, id, P.READ_HISTORY);
  const limit = Math.min(100, Math.max(1, Number(ctx.query.get('limit') || 50)));
  const before = ctx.query.get('before'), after = ctx.query.get('after'), around = ctx.query.get('around');
  for (const v of [before, after, around]) if (v && !/^\d{1,19}$/.test(v)) throw badRequest('Invalid cursor.');
  let rows: any[];
  if (around) {
    const half = Math.floor(limit / 2);
    const older = await many('SELECT * FROM messages WHERE channel_id = $1 AND id <= $2 ORDER BY id DESC LIMIT $3', [id, around, half + 1]);
    const newer = await many('SELECT * FROM messages WHERE channel_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3', [id, around, half]);
    rows = [...older.reverse(), ...newer];
  } else if (after) {
    rows = await many('SELECT * FROM messages WHERE channel_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3', [id, after, limit]);
  } else {
    rows = (await many(
      `SELECT * FROM messages WHERE channel_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`, [id, before, limit])).reverse();
  }
  return hydrateMessages(rows);
});

router.get('/messages/:id', async (ctx) => {
  const a = ctx.user();
  const m = await one('SELECT * FROM messages WHERE id = $1', [idParam(ctx, 'id')]);
  if (!m) throw notFound('Message');
  await requireChannel(a.userId, m.channel_id, P.READ_HISTORY);
  return (await hydrateMessages([m]))[0];
});

/* ───────────── send ───────────── */

const sendSchema = z.object({
  content: z.string().max(MAX_CONTENT, `Messages can be at most ${MAX_CONTENT} characters.`).default(''),
  nonce: z.string().max(64).optional(),
  reply_to_id: z.string().regex(/^\d+$/).nullable().optional(),
  attachment_ids: z.array(z.string().regex(/^\d+$/)).max(MAX_ATTACHMENTS).optional(),
});

async function dmSendCheck(ch: ChannelRow, userId: string) {
  if (ch.type !== 'dm') return;
  const other = await one<{ user_id: string }>('SELECT user_id FROM dm_participants WHERE channel_id = $1 AND user_id <> $2', [ch.id, userId]);
  if (other && (await isBlockedEitherWay(userId, other.user_id))) {
    throw new HttpError(403, 'blocked', "Your message could not be delivered. You and this user can't message each other.");
  }
}

router.post('/channels/:id/messages', async (ctx) => {
  const a = requireVerified(ctx);
  const id = idParam(ctx, 'id');
  limits.messages.check(`u:${a.userId}`);
  const body = await ctx.body(sendSchema);
  const content = body.content.replace(/\r\n/g, '\n').trim();
  const attIds = [...new Set(body.attachment_ids ?? [])];
  if (!content && !attIds.length) throw badRequest('Message cannot be empty.');

  // Idempotency: a retried request with the same nonce returns the original message.
  if (body.nonce) {
    const dup = await one('SELECT * FROM messages WHERE author_id = $1 AND nonce = $2', [a.userId, body.nonce]);
    if (dup) return (await hydrateMessages([dup]))[0];
  }

  const { channel: ch, perms } = await requireChannel(a.userId, id, P.SEND_MESSAGES);
  if (ch.type === 'voice') throw badRequest("You can't send messages in a voice channel.");
  if (attIds.length && !has(perms, P.ATTACH_FILES)) throw forbidden("You don't have permission to attach files here.");
  await dmSendCheck(ch, a.userId);

  // Slowmode (bypassed by moderators).
  if (ch.slowmode_seconds > 0 && !has(perms, P.MANAGE_MESSAGES) && !has(perms, P.MANAGE_CHANNELS)) {
    const last = await one(`SELECT created_at FROM messages WHERE channel_id = $1 AND author_id = $2 AND type = 'default' ORDER BY id DESC LIMIT 1`, [id, a.userId]);
    if (last) {
      const wait = Math.ceil(ch.slowmode_seconds - (Date.now() - last.created_at.getTime()) / 1000);
      if (wait > 0) throw new HttpError(429, 'slowmode', `Slowmode is on. You can send another message in ${wait}s.`, { retryAfter: wait });
    }
  }

  if (body.reply_to_id) {
    const target = await one('SELECT id FROM messages WHERE id = $1 AND channel_id = $2', [body.reply_to_id, id]);
    if (!target) throw badRequest('The message you are replying to no longer exists.');
  }

  const mentions = await parseMentions(content, ch, perms);
  const serverId = ch.server_id;
  if (serverId) await enforceAutomod(serverId, id, a.userId, content, mentions.users.length + mentions.roles.length + (mentions.everyone ? 1 : 0));

  const inserted = await db.tx(async (q) => {
    const r = await q.query(
      `INSERT INTO messages (channel_id, author_id, content, nonce, reply_to_id, mention_everyone, mention_user_ids, mention_role_ids, mention_channel_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (author_id, nonce) WHERE nonce IS NOT NULL DO NOTHING RETURNING *`,
      [id, a.userId, content, body.nonce ?? null, body.reply_to_id ?? null, mentions.everyone, mentions.users, mentions.roles, mentions.channels]);
    if (!r.rowCount) return null; // lost a race with an identical retry
    const msg = r.rows[0];
    if (attIds.length) {
      const claimed = await q.query(
        `UPDATE attachments SET message_id = $1 WHERE id = ANY($2::bigint[]) AND uploader_id = $3 AND message_id IS NULL RETURNING id`,
        [msg.id, attIds, a.userId]);
      if (claimed.rowCount !== attIds.length) throw badRequest('One or more attachments are invalid or already used.');
    }
    await q.query('UPDATE channels SET last_message_id = $1 WHERE id = $2', [msg.id, id]);
    await q.query(
      `INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count) VALUES ($1,$2,$3,0)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_message_id = EXCLUDED.last_read_message_id, mention_count = 0, updated_at = now()`,
      [a.userId, id, msg.id]);
    return msg;
  });
  if (!inserted) {
    const dup = await one('SELECT * FROM messages WHERE author_id = $1 AND nonce = $2', [a.userId, body.nonce]);
    return (await hydrateMessages([dup]))[0];
  }

  const [msg] = await hydrateMessages([inserted]);

  // DMs: reopen the conversation for anyone who had closed it.
  if (ch.type === 'dm' || ch.type === 'group_dm') {
    const reopened = await many<{ user_id: string }>(
      'UPDATE dm_participants SET hidden = false WHERE channel_id = $1 AND hidden RETURNING user_id', [id]);
    if (reopened.length) {
      const dm = await dmChannelJson(id);
      toUsers(reopened.map((r) => r.user_id), 'DM_CHANNEL_CREATE', dm);
    }
  }

  const recipients = await mentionRecipients(ch, a.userId, mentions);
  if (recipients.length) {
    await db.query(
      `INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count)
       SELECT u, $2, NULL, 1 FROM unnest($1::bigint[]) AS u
       ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = read_states.mention_count + 1, updated_at = now()`,
      [recipients, id]);
  }
  await toChannel(ch, 'MESSAGE_CREATE', { ...msg, mentioned_user_ids: recipients });

  if (ch.type === 'thread' && ch.parent_channel_id) {
    const parent = await one<ChannelRow>('SELECT * FROM channels WHERE id = $1', [ch.parent_channel_id]);
    const count = await one<{ n: number }>('SELECT count(*)::int AS n FROM messages WHERE channel_id = $1', [id]);
    if (parent) await toChannel(parent, 'THREAD_ACTIVITY', { thread_id: id, parent_channel_id: parent.id, message_count: count!.n, last_message_id: msg.id });
  }
  return msg;
});

/* ───────────── edit & delete ───────────── */

router.patch('/messages/:id', async (ctx) => {
  const a = ctx.user();
  limits.messages.check(`u:${a.userId}`);
  const mid = idParam(ctx, 'id');
  const { content: raw } = await ctx.body(z.object({ content: z.string().max(MAX_CONTENT) }));
  const content = raw.replace(/\r\n/g, '\n').trim();
  const m = await one('SELECT * FROM messages WHERE id = $1', [mid]);
  if (!m) throw notFound('Message');
  const { channel: ch, perms } = await requireChannel(a.userId, m.channel_id);
  if (m.author_id !== a.userId) throw forbidden('You can only edit your own messages.');
  if (m.type !== 'default') throw badRequest("System messages can't be edited.");
  const hasAtt = await one('SELECT 1 FROM attachments WHERE message_id = $1', [mid]);
  if (!content && !hasAtt) throw badRequest('Message cannot be empty. Delete it instead.');
  const mentions = await parseMentions(content, ch, perms);
  if (ch.server_id) await enforceAutomod(ch.server_id, ch.id, a.userId, content, mentions.users.length + mentions.roles.length);
  const updated = await one(
    `UPDATE messages SET content = $2, edited_at = now(), mention_everyone = $3, mention_user_ids = $4, mention_role_ids = $5, mention_channel_ids = $6
      WHERE id = $1 RETURNING *`, [mid, content, mentions.everyone, mentions.users, mentions.roles, mentions.channels]);
  const [msg] = await hydrateMessages([updated]);
  await toChannel(ch, 'MESSAGE_UPDATE', msg);
  return msg;
});

async function deleteMessageFiles(messageIds: string[]) {
  const keys = await many<{ storage_key: string }>('SELECT storage_key FROM attachments WHERE message_id = ANY($1::bigint[])', [messageIds]);
  return () => Promise.all(keys.map((k) => storage.remove(k.storage_key).catch(() => {})));
}

router.delete('/messages/:id', async (ctx) => {
  const a = ctx.user();
  const mid = idParam(ctx, 'id');
  const m = await one('SELECT * FROM messages WHERE id = $1', [mid]);
  if (!m) throw notFound('Message');
  const { channel: ch, perms } = await requireChannel(a.userId, m.channel_id);
  const own = m.author_id === a.userId;
  const isDm = ch.type === 'dm' || ch.type === 'group_dm';
  if (!own && (isDm || !has(perms, P.MANAGE_MESSAGES))) throw forbidden("You can't delete this message.");
  const cleanup = await deleteMessageFiles([mid]);
  await db.query('DELETE FROM messages WHERE id = $1', [mid]);
  await db.query('UPDATE channels SET last_message_id = (SELECT max(id) FROM messages WHERE channel_id = $1) WHERE id = $1 AND last_message_id IS NULL', [ch.id]);
  await cleanup();
  if (!own && ch.server_id) {
    await audit(ch.server_id, a.userId, 'message_delete', { type: 'user', id: m.author_id }, null, { channel_id: ch.id, content: String(m.content).slice(0, 500) });
  }
  await toChannel(ch, 'MESSAGE_DELETE', { id: mid, channel_id: ch.id });
  return { ok: true };
});

router.post('/channels/:id/messages/bulk-delete', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { channel: ch } = await requireChannel(a.userId, id, P.MANAGE_MESSAGES);
  if (!ch.server_id) throw badRequest('Bulk delete is only available in servers.');
  const { message_ids } = await ctx.body(z.object({ message_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(100) }));
  const cleanup = await deleteMessageFiles(message_ids);
  const r = await many<{ id: string }>('DELETE FROM messages WHERE channel_id = $1 AND id = ANY($2::bigint[]) RETURNING id', [id, message_ids]);
  await cleanup();
  await audit(ch.server_id, a.userId, 'message_bulk_delete', { type: 'channel', id }, null, { count: r.length });
  await toChannel(ch, 'MESSAGE_DELETE_BULK', { ids: r.map((x) => x.id), channel_id: id });
  return { deleted: r.length };
});

/* ───────────── reactions ───────────── */

const EMOJI_RE = /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣]{1,16}$/u;
function parseEmoji(raw: string) {
  let e: string;
  try { e = decodeURIComponent(raw); } catch { throw badRequest('Invalid emoji.'); }
  if (!EMOJI_RE.test(e) || /^[\d#*]$/.test(e)) throw badRequest('Invalid emoji.');
  return e;
}

async function messageForReaction(userId: string, mid: string) {
  const m = await one('SELECT id, channel_id FROM messages WHERE id = $1', [mid]);
  if (!m) throw notFound('Message');
  const { channel, perms } = await requireChannel(userId, m.channel_id, P.READ_HISTORY);
  return { m, channel, perms };
}

router.put('/messages/:id/reactions/:emoji', async (ctx) => {
  const a = ctx.user();
  limits.writes.check(`react:${a.userId}`);
  const mid = idParam(ctx, 'id');
  const emoji = parseEmoji(ctx.params.emoji);
  const { channel, perms } = await messageForReaction(a.userId, mid);
  if (channel.type === 'dm') await dmSendCheck(channel, a.userId);
  const exists = await one('SELECT 1 FROM reactions WHERE message_id = $1 AND emoji = $2 LIMIT 1', [mid, emoji]);
  // Joining an existing reaction is allowed without ADD_REACTIONS; adding a new emoji needs it (and SEND for timeouts).
  if (!exists) {
    if (!has(perms, P.ADD_REACTIONS)) throw forbidden("You can't add reactions here.");
    const distinct = await one<{ n: number }>('SELECT count(DISTINCT emoji)::int AS n FROM reactions WHERE message_id = $1', [mid]);
    if ((distinct?.n ?? 0) >= 20) throw badRequest('This message has the maximum number of reactions.');
  }
  const r = await db.query('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [mid, a.userId, emoji]);
  if (r.rowCount) await toChannel(channel, 'REACTION_ADD', { message_id: mid, channel_id: channel.id, emoji, user_id: a.userId });
  return { ok: true };
});

router.delete('/messages/:id/reactions/:emoji', async (ctx) => {
  const a = ctx.user();
  const mid = idParam(ctx, 'id');
  const emoji = parseEmoji(ctx.params.emoji);
  const { channel } = await messageForReaction(a.userId, mid);
  const r = await db.query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [mid, a.userId, emoji]);
  if (r.rowCount) await toChannel(channel, 'REACTION_REMOVE', { message_id: mid, channel_id: channel.id, emoji, user_id: a.userId });
  return { ok: true };
});

router.delete('/messages/:id/reactions/:emoji/:uid', async (ctx) => {
  const a = ctx.user();
  const mid = idParam(ctx, 'id');
  const uid = idParam(ctx, 'uid');
  const emoji = parseEmoji(ctx.params.emoji);
  const { channel, perms } = await messageForReaction(a.userId, mid);
  if (uid !== a.userId && !has(perms, P.MANAGE_MESSAGES)) throw forbidden();
  const r = await db.query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [mid, uid, emoji]);
  if (r.rowCount) await toChannel(channel, 'REACTION_REMOVE', { message_id: mid, channel_id: channel.id, emoji, user_id: uid });
  return { ok: true };
});

/* ───────────── pins ───────────── */

async function setPinned(userId: string, mid: string, pinned: boolean) {
  const m = await one('SELECT * FROM messages WHERE id = $1', [mid]);
  if (!m) throw notFound('Message');
  const { channel: ch, perms } = await requireChannel(userId, m.channel_id);
  const isDm = ch.type === 'dm' || ch.type === 'group_dm';
  if (!isDm && !has(perms, P.MANAGE_MESSAGES)) throw forbidden('You need Manage Messages to pin.');
  if (m.type !== 'default') throw badRequest("System messages can't be pinned.");
  if (m.pinned === pinned) return;
  if (pinned) {
    const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM messages WHERE channel_id = $1 AND pinned', [ch.id]);
    if ((n?.n ?? 0) >= 50) throw badRequest('This channel has reached the maximum of 50 pins.');
  }
  const updated = await one('UPDATE messages SET pinned = $2 WHERE id = $1 RETURNING *', [mid, pinned]);
  if (ch.server_id) await audit(ch.server_id, userId, pinned ? 'message_pin' : 'message_unpin', { type: 'message', id: mid }, null, { channel_id: ch.id });
  const [msg] = await hydrateMessages([updated]);
  await toChannel(ch, 'MESSAGE_UPDATE', msg);
  await toChannel(ch, 'PINS_UPDATE', { channel_id: ch.id });
  if (pinned) {
    const sys = await one(`INSERT INTO messages (channel_id, author_id, type, content, reply_to_id) VALUES ($1,$2,'system','pinned',$3) RETURNING *`, [ch.id, userId, mid]);
    await db.query('UPDATE channels SET last_message_id = $1 WHERE id = $2', [sys.id, ch.id]);
    const [s] = await hydrateMessages([sys]);
    await toChannel(ch, 'MESSAGE_CREATE', s);
  }
}
router.put('/messages/:id/pin', async (ctx) => { await setPinned(ctx.user().userId, idParam(ctx, 'id'), true); return { ok: true }; });
router.delete('/messages/:id/pin', async (ctx) => { await setPinned(ctx.user().userId, idParam(ctx, 'id'), false); return { ok: true }; });

router.get('/channels/:id/pins', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await requireChannel(a.userId, id, P.READ_HISTORY);
  return hydrateMessages(await many('SELECT * FROM messages WHERE channel_id = $1 AND pinned ORDER BY id DESC LIMIT 50', [id]));
});

/* ───────────── read state ───────────── */

router.post('/channels/:id/ack', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { message_id } = await ctx.body(z.object({ message_id: z.string().regex(/^\d+$/) }));
  const { channel: ch } = await requireChannel(a.userId, id);
  const rs = await one(
    `INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count) VALUES ($1,$2,$3,0)
     ON CONFLICT (user_id, channel_id) DO UPDATE
       SET last_read_message_id = GREATEST(COALESCE(read_states.last_read_message_id, 0), EXCLUDED.last_read_message_id),
           mention_count = 0, updated_at = now()
     RETURNING channel_id, last_read_message_id, mention_count`, [a.userId, id, message_id]);
  toUser(a.userId, 'READ_STATE_UPDATE', rs);
  if (ch.type === 'dm' || ch.type === 'group_dm') {
    const u = await one('SELECT settings FROM users WHERE id = $1', [a.userId]);
    if (u?.settings?.privacy?.read_receipts !== false) {
      await toChannel(ch, 'READ_RECEIPT', { channel_id: id, user_id: a.userId, message_id: rs.last_read_message_id }, { except: a.userId });
    }
  }
  return rs;
});

router.post('/servers/:id/ack', async (ctx) => {
  const a = ctx.user();
  const sid = idParam(ctx, 'id');
  const { viewableChannelIds } = await import('../services/access.ts');
  const ids = await viewableChannelIds(sid, a.userId);
  if (!ids.length) return { ok: true };
  await db.query(
    `INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count)
     SELECT $1, c.id, c.last_message_id, 0 FROM channels c WHERE c.id = ANY($2::bigint[]) AND c.last_message_id IS NOT NULL
     ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_message_id = EXCLUDED.last_read_message_id, mention_count = 0, updated_at = now()`,
    [a.userId, ids]);
  const states = await many('SELECT channel_id, last_read_message_id, mention_count FROM read_states WHERE user_id = $1 AND channel_id = ANY($2::bigint[])', [a.userId, ids]);
  for (const s of states) toUser(a.userId, 'READ_STATE_UPDATE', s);
  return { ok: true };
});

/** In DMs, who has read up to where (respects each user's read-receipt setting). */
router.get('/channels/:id/read-receipts', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const { channel: ch } = await requireChannel(a.userId, id);
  if (ch.type !== 'dm' && ch.type !== 'group_dm') return [];
  return many(
    `SELECT rs.user_id, rs.last_read_message_id AS message_id FROM read_states rs
       JOIN dm_participants p ON p.channel_id = rs.channel_id AND p.user_id = rs.user_id
       JOIN users u ON u.id = rs.user_id
      WHERE rs.channel_id = $1 AND rs.user_id <> $2 AND COALESCE((u.settings->'privacy'->>'read_receipts')::boolean, true)`, [id, a.userId]);
});

/* ───────────── attachments ───────────── */

router.post('/channels/:id/attachments', async (ctx) => {
  const a = requireVerified(ctx);
  const id = idParam(ctx, 'id');
  limits.uploads.check(`u:${a.userId}`);
  await requireChannel(a.userId, id, P.ATTACH_FILES | P.SEND_MESSAGES);
  const filename = safeFilename(decodeURIComponent(String(ctx.req.headers['x-filename'] || 'file')));
  const f = await receiveUpload(ctx.req, 'attachments');
  const row = await one(
    `INSERT INTO attachments (uploader_id, storage_key, filename, content_type, size, width, height) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [a.userId, f.key, filename, f.contentType, f.size, f.width ?? null, f.height ?? null]);
  return attachmentJson(row);
});

/** Remove uploads that were never attached to a message. */
export async function cleanupOrphanAttachments() {
  const rows = await many<{ id: string; storage_key: string }>(
    `DELETE FROM attachments WHERE message_id IS NULL AND created_at < now() - interval '1 day' RETURNING id, storage_key`);
  for (const r of rows) await storage.remove(r.storage_key).catch(() => {});
  return rows.length;
}
