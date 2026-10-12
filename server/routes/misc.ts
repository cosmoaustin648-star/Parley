import { z } from 'zod';
import { Router, badRequest, notFound, forbidden } from '../http/router.ts';
import { db, one, many } from '../db/index.ts';
import { config } from '../config.ts';
import { limits } from '../http/ratelimit.ts';
import { requireServerPerm, viewableChannelIds, requireChannel, getChannel, channelPermissions } from '../services/access.ts';
import { hydrateMessages } from '../services/serialize.ts';
import { toUser } from '../realtime/gateway.ts';
import { iceServers } from '../realtime/voice.ts';
import { devOutbox, mailConfigured } from '../mail/index.ts';
import { P, has } from '../../shared/permissions.ts';

export const router = new Router('/api');

/* ───────────── notification settings ───────────── */

router.put('/notification-settings', async (ctx) => {
  const a = ctx.user();
  const b = await ctx.body(z.object({
    scope_type: z.enum(['server', 'channel']),
    scope_id: z.string().regex(/^\d+$/),
    level: z.enum(['all', 'mentions', 'none']).nullable().optional(),
    muted: z.boolean().optional(),
    muted_until: z.string().datetime().nullable().optional(),
    suppress_everyone: z.boolean().optional(),
  }));
  if (b.scope_type === 'server') await requireServerPerm(a.userId, b.scope_id);
  else await requireChannel(a.userId, b.scope_id);
  const cur = await one('SELECT * FROM notification_settings WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3', [a.userId, b.scope_type, b.scope_id]);
  const next = {
    level: b.level !== undefined ? b.level : cur?.level ?? null,
    muted: b.muted ?? cur?.muted ?? false,
    muted_until: b.muted_until !== undefined ? b.muted_until : cur?.muted_until ?? null,
    suppress_everyone: b.suppress_everyone ?? cur?.suppress_everyone ?? false,
  };
  const row = await one(
    `INSERT INTO notification_settings (user_id, scope_type, scope_id, level, muted, muted_until, suppress_everyone) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, scope_type, scope_id) DO UPDATE SET level = $4, muted = $5, muted_until = $6, suppress_everyone = $7
     RETURNING scope_type, scope_id, level, muted, muted_until, suppress_everyone`,
    [a.userId, b.scope_type, b.scope_id, next.level, next.muted, next.muted_until, next.suppress_everyone]);
  toUser(a.userId, 'NOTIFICATION_SETTINGS_UPDATE', row);
  return row;
});

/* ───────────── search ───────────── */

/**
 * Message search. Scope is a server (only channels the user can read), a single
 * channel/DM, or all of the user's DMs. Supports filters: author, has:file|image|link,
 * date range, pinned.
 */
router.get('/search/messages', async (ctx) => {
  const a = ctx.user();
  limits.search.check(`u:${a.userId}`);
  const q = ctx.query;
  const text = (q.get('q') || '').trim().slice(0, 200);
  const serverId = q.get('server_id'), channelId = q.get('channel_id'), authorId = q.get('author_id');
  const hasFilter = q.get('has');
  const before = q.get('before'), after = q.get('after');
  const offset = Math.min(1000, Math.max(0, Number(q.get('offset') || 0)));
  for (const v of [serverId, channelId, authorId]) if (v && !/^\d+$/.test(v)) throw badRequest('Invalid id.');
  if (!text && !authorId && !hasFilter && q.get('pinned') !== 'true') throw badRequest('Enter something to search for.');

  let channelIds: string[];
  if (channelId) {
    await requireChannel(a.userId, channelId, P.READ_HISTORY);
    channelIds = [channelId];
  } else if (serverId) {
    await requireServerPerm(a.userId, serverId);
    channelIds = await viewableChannelIds(serverId, a.userId);
  } else if (q.get('scope') === 'dms') {
    channelIds = (await many<{ channel_id: string }>('SELECT channel_id FROM dm_participants WHERE user_id = $1', [a.userId])).map((r) => r.channel_id);
  } else throw badRequest('Choose a server, channel or your DMs to search.');
  if (!channelIds.length) return { total: 0, messages: [] };

  const conds = ['m.channel_id = ANY($1::bigint[])', "m.type = 'default'"];
  const params: unknown[] = [channelIds];
  const add = (sql: string, v: unknown) => { params.push(v); conds.push(sql.replace('?', `$${params.length}`)); };
  if (text) {
    // Full-text match on words, plus substring fallback for short/partial terms.
    params.push(text);
    const i = params.length;
    conds.push(`(m.search_vector @@ plainto_tsquery('simple', $${i}) OR m.content ILIKE '%' || replace(replace($${i}, '%', '\\%'), '_', '\\_') || '%')`);
  }
  if (authorId) add('m.author_id = ?', authorId);
  if (before) add('m.created_at < ?::timestamptz', before);
  if (after) add('m.created_at > ?::timestamptz', after);
  if (q.get('pinned') === 'true') conds.push('m.pinned');
  if (hasFilter === 'file') conds.push('EXISTS (SELECT 1 FROM attachments x WHERE x.message_id = m.id)');
  if (hasFilter === 'image') conds.push(`EXISTS (SELECT 1 FROM attachments x WHERE x.message_id = m.id AND x.content_type LIKE 'image/%')`);
  if (hasFilter === 'link') conds.push(`m.content ~* 'https?://'`);
  const where = conds.join(' AND ');
  const total = await one<{ n: number }>(`SELECT count(*)::int AS n FROM messages m WHERE ${where}`, params);
  params.push(offset);
  const rows = await many(`SELECT m.* FROM messages m WHERE ${where} ORDER BY m.id DESC LIMIT 25 OFFSET $${params.length}`, params);
  return { total: total!.n, messages: await hydrateMessages(rows) };
});

/** Quick switcher: channels across the user's servers they can see. */
router.get('/search/channels', async (ctx) => {
  const a = ctx.user();
  limits.search.check(`u:${a.userId}`);
  const text = (ctx.query.get('q') || '').trim().toLowerCase().replace(/^#/, '').slice(0, 100);
  const rows = await many(
    `SELECT c.*, s.name AS server_name FROM channels c JOIN servers s ON s.id = c.server_id
       JOIN server_members m ON m.server_id = c.server_id AND m.user_id = $1
      WHERE c.type IN ('text','voice') AND lower(c.name) LIKE '%' || $2 || '%'
      ORDER BY (lower(c.name) LIKE $2 || '%') DESC, length(c.name), c.id LIMIT 60`, [a.userId, text.replace(/[%_\\]/g, '')]);
  const out = [];
  for (const r of rows) {
    if (has(await channelPermissions(a.userId, r), P.VIEW_CHANNEL)) out.push({ id: r.id, name: r.name, type: r.type, server_id: r.server_id, server_name: r.server_name });
    if (out.length >= 20) break;
  }
  return out;
});

/* ───────────── voice config ───────────── */

router.get('/rtc/config', async (ctx) => {
  const a = ctx.user();
  return { ice_servers: iceServers(a.userId), max_participants: config.rtc.maxVoiceParticipants };
});

/* ───────────── meta / dev ───────────── */

router.get('/meta', async () => ({
  name: 'Parley',
  require_email_verification: config.requireEmailVerification,
  mail_configured: mailConfigured(),
  dev_outbox: !config.isProd,
  max_upload_mb: Math.round(config.storage.maxUploadBytes / 1024 / 1024),
  turn_configured: !!(config.rtc.turnSecret && config.rtc.turnUrls.length) || config.rtc.iceServers.some((s: any) => String(s.urls).includes('turn:')),
}));

/** Development-only: read emails that would have been sent. Disabled in production. */
router.get('/dev/outbox', async () => {
  if (config.isProd) throw notFound();
  return devOutbox;
});

export { forbidden, getChannel, db };
