import { z } from 'zod';
import { Router, HttpError, badRequest, forbidden, notFound, idParam } from '../http/router.ts';
import { db, one, many } from '../db/index.ts';
import { limits } from '../http/ratelimit.ts';
import { isBlockedEitherWay, isDmParticipant } from '../services/access.ts';
import { dmChannelJson } from '../services/state.ts';
import { hydrateMessages } from '../services/serialize.ts';
import { toUser, toUsers, toChannel } from '../realtime/gateway.ts';
import { requireVerified } from './auth.ts';

export const router = new Router('/api/dms');

const MAX_GROUP = 10;

/** Whether `fromId` may open a new conversation with `toId`. */
async function assertCanDm(fromId: string, toId: string) {
  const target = await one('SELECT id, settings, disabled_at FROM users WHERE id = $1', [toId]);
  if (!target || target.disabled_at) throw notFound('User');
  if (await isBlockedEitherWay(fromId, toId)) throw new HttpError(403, 'blocked', "You can't message this user.");
  if (target.settings?.privacy?.allow_dms_from_server_members === false) {
    throw new HttpError(403, 'dms_closed', 'This user is not accepting direct messages.');
  }
}

async function systemMessage(channelId: string, authorId: string, content: string) {
  const m = await one(`INSERT INTO messages (channel_id, author_id, type, content) VALUES ($1,$2,'system',$3) RETURNING *`, [channelId, authorId, content]);
  await db.query('UPDATE channels SET last_message_id = $1 WHERE id = $2', [m.id, channelId]);
  const ch = await one('SELECT * FROM channels WHERE id = $1', [channelId]);
  const [msg] = await hydrateMessages([m]);
  await toChannel(ch, 'MESSAGE_CREATE', msg);
}

router.post('/', async (ctx) => {
  const a = requireVerified(ctx);
  limits.writes.check(`u:${a.userId}`);
  const { user_id } = await ctx.body(z.object({ user_id: z.string().regex(/^\d+$/) }));
  if (user_id === a.userId) throw badRequest("You can't message yourself.");
  const [lo, hi] = BigInt(a.userId) < BigInt(user_id) ? [a.userId, user_id] : [user_id, a.userId];
  const existing = await one<{ channel_id: string }>('SELECT channel_id FROM dm_pairs WHERE user_a = $1 AND user_b = $2', [lo, hi]);
  let channelId: string;
  if (existing) {
    // Re-opening an existing conversation is always allowed (history stays), but blocks still apply.
    if (await isBlockedEitherWay(a.userId, user_id)) throw new HttpError(403, 'blocked', "You can't message this user.");
    channelId = existing.channel_id;
    await db.query('UPDATE dm_participants SET hidden = false WHERE channel_id = $1 AND user_id = $2', [channelId, a.userId]);
  } else {
    await assertCanDm(a.userId, user_id);
    channelId = await db.tx(async (q) => {
      const c = await one(`INSERT INTO channels (type) VALUES ('dm') RETURNING id`, [], q);
      await q.query('INSERT INTO dm_participants (channel_id, user_id, hidden) VALUES ($1,$2,false), ($1,$3,true)', [c.id, a.userId, user_id]);
      await q.query('INSERT INTO dm_pairs (user_a, user_b, channel_id) VALUES ($1,$2,$3)', [lo, hi, c.id]);
      return c.id;
    }).catch(async (e) => {
      // Concurrent creation by the other user: use theirs.
      const again = await one<{ channel_id: string }>('SELECT channel_id FROM dm_pairs WHERE user_a = $1 AND user_b = $2', [lo, hi]);
      if (again) return again.channel_id;
      throw e;
    });
  }
  const dm = await dmChannelJson(channelId);
  toUser(a.userId, 'DM_CHANNEL_CREATE', dm);
  return dm;
});

router.post('/group', async (ctx) => {
  const a = requireVerified(ctx);
  limits.writes.check(`u:${a.userId}`);
  const body = await ctx.body(z.object({ user_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(MAX_GROUP - 1), name: z.string().trim().max(100).optional() }));
  const ids = [...new Set(body.user_ids.filter((id) => id !== a.userId))];
  if (!ids.length) throw badRequest('Pick at least one other person.');
  for (const id of ids) await assertCanDm(a.userId, id);
  const channelId = await db.tx(async (q) => {
    const c = await one(`INSERT INTO channels (type, owner_id, name) VALUES ('group_dm', $1, $2) RETURNING id`, [a.userId, body.name || null], q);
    for (const uid of [a.userId, ...ids]) await q.query('INSERT INTO dm_participants (channel_id, user_id) VALUES ($1,$2)', [c.id, uid]);
    return c.id;
  });
  const dm = await dmChannelJson(channelId);
  toUsers([a.userId, ...ids], 'DM_CHANNEL_CREATE', dm);
  return dm;
});

router.put('/:id/recipients/:uid', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const uid = idParam(ctx, 'uid');
  const ch = await one(`SELECT * FROM channels WHERE id = $1 AND type = 'group_dm'`, [id]);
  if (!ch || !(await isDmParticipant(id, a.userId))) throw notFound('Conversation');
  if (await isDmParticipant(id, uid)) return dmChannelJson(id);
  const n = await one<{ n: number }>('SELECT count(*)::int AS n FROM dm_participants WHERE channel_id = $1', [id]);
  if (n!.n >= MAX_GROUP) throw badRequest(`Group DMs are limited to ${MAX_GROUP} people.`);
  await assertCanDm(a.userId, uid);
  await db.query('INSERT INTO dm_participants (channel_id, user_id) VALUES ($1,$2)', [id, uid]);
  const dm = await dmChannelJson(id);
  const all = (await many<{ user_id: string }>('SELECT user_id FROM dm_participants WHERE channel_id = $1', [id])).map((r) => r.user_id);
  toUsers(all, 'DM_CHANNEL_CREATE', dm);
  await systemMessage(id, a.userId, `added <@${uid}>`);
  return dm;
});

router.delete('/:id/recipients/:uid', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const uid = ctx.params.uid === '@me' ? a.userId : idParam(ctx, 'uid');
  const ch = await one(`SELECT * FROM channels WHERE id = $1 AND type = 'group_dm'`, [id]);
  if (!ch || !(await isDmParticipant(id, a.userId))) throw notFound('Conversation');
  if (uid !== a.userId && ch.owner_id !== a.userId) throw forbidden('Only the group owner can remove people.');
  if (!(await isDmParticipant(id, uid))) throw notFound('Member');
  await systemMessage(id, a.userId, uid === a.userId ? 'left the group' : `removed <@${uid}>`);
  await db.query('DELETE FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [id, uid]);
  toUser(uid, 'DM_CHANNEL_DELETE', { id });
  const rest = await many<{ user_id: string }>('SELECT user_id FROM dm_participants WHERE channel_id = $1 ORDER BY joined_at', [id]);
  if (!rest.length) { await db.query('DELETE FROM channels WHERE id = $1', [id]); return { ok: true }; }
  if (ch.owner_id === uid) await db.query('UPDATE channels SET owner_id = $1 WHERE id = $2', [rest[0].user_id, id]);
  const dm = await dmChannelJson(id);
  toUsers(rest.map((r) => r.user_id), 'DM_CHANNEL_UPDATE', dm);
  return { ok: true };
});

/** Close a 1:1 DM (hide it until a new message arrives) or leave a group DM. */
router.delete('/:id', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const ch = await one(`SELECT * FROM channels WHERE id = $1 AND type IN ('dm','group_dm')`, [id]);
  if (!ch || !(await isDmParticipant(id, a.userId))) throw notFound('Conversation');
  if (ch.type === 'dm') {
    await db.query('UPDATE dm_participants SET hidden = true WHERE channel_id = $1 AND user_id = $2', [id, a.userId]);
    toUser(a.userId, 'DM_CHANNEL_DELETE', { id });
    return { ok: true };
  }
  await systemMessage(id, a.userId, 'left the group');
  await db.query('DELETE FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [id, a.userId]);
  toUser(a.userId, 'DM_CHANNEL_DELETE', { id });
  const rest = await many<{ user_id: string }>('SELECT user_id FROM dm_participants WHERE channel_id = $1 ORDER BY joined_at', [id]);
  if (!rest.length) await db.query('DELETE FROM channels WHERE id = $1', [id]);
  else {
    if (ch.owner_id === a.userId) await db.query('UPDATE channels SET owner_id = $1 WHERE id = $2', [rest[0].user_id, id]);
    toUsers(rest.map((r) => r.user_id), 'DM_CHANNEL_UPDATE', await dmChannelJson(id));
  }
  return { ok: true };
});
