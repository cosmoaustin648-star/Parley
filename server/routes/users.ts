import { z } from 'zod';
import { Router, badRequest, conflict, forbidden, notFound, idParam, HttpError } from '../http/router.ts';
import { db, one, many } from '../db/index.ts';
import { hashPassword, verifyPassword, randomToken, sha256 } from '../lib/crypto.ts';
import { usernameSchema, emailSchema, passwordSchema, displayNameSchema } from './auth.ts';
import { publicUser, privateUser, USER_COLS } from '../services/serialize.ts';
import { receiveUpload, storage } from '../storage/index.ts';
import { limits } from '../http/ratelimit.ts';
import { toUser, toUsers, relatedUserIds, setPreference, presenceOf, isOnline, disconnectUser } from '../realtime/gateway.ts';
import { verificationEmail } from '../mail/index.ts';
import { destroyOtherSessions, invalidateSessionCache } from '../auth/session.ts';
import { dmChannelsFor } from '../services/state.ts';

export const router = new Router('/api/users');

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #e0663d.');
const keybind = z.string().max(40);

export const settingsSchema = z.object({
  theme: z.enum(['harbor', 'deep', 'midnight', 'daylight']),
  accent: hex,
  font: z.enum(['default', 'rounded', 'serif', 'mono', 'readable']),
  font_scale: z.number().int().min(12).max(22),
  message_spacing: z.number().int().min(0).max(24),
  compact: z.boolean(),
  reduced_motion: z.boolean(),
  high_contrast: z.boolean(),
  saturation: z.number().int().min(0).max(100),
  underline_links: z.boolean(),
  show_timestamps_24h: z.boolean(),
  notifications: z.object({
    desktop: z.boolean(), sounds: z.boolean(), dm: z.boolean(), mentions_only_when_unfocused: z.boolean(),
  }).partial(),
  privacy: z.object({
    allow_dms_from_server_members: z.boolean(), read_receipts: z.boolean(), show_typing: z.boolean(),
  }).partial(),
  voice: z.object({
    input_device: z.string().max(200).nullable(), output_device: z.string().max(200).nullable(), video_device: z.string().max(200).nullable(),
    input_volume: z.number().min(0).max(200), output_volume: z.number().min(0).max(200),
    noise_suppression: z.boolean(), echo_cancellation: z.boolean(), auto_gain: z.boolean(),
    input_mode: z.enum(['voice', 'ptt']), vad_threshold: z.number().min(0).max(100),
  }).partial(),
  keybinds: z.object({
    toggle_mute: keybind, toggle_deafen: keybind, push_to_talk: keybind, quick_switcher: keybind, mark_read: keybind,
  }).partial(),
}).partial().strict();

function deepMerge(a: any, b: any): any {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = typeof v === 'object' && v !== null && !Array.isArray(v) ? deepMerge(a[k] ?? {}, v) : v;
  return out;
}

async function broadcastUserUpdate(userId: string) {
  const u = await one('SELECT * FROM users WHERE id = $1', [userId]);
  toUser(userId, 'USER_UPDATE', privateUser(u));
  const pub = publicUser(u);
  const related = (await relatedUserIds(userId)).filter((id) => id !== userId && isOnline(id));
  toUsers(related, 'USER_PUBLIC_UPDATE', pub);
  return u;
}

router.patch('/@me', async (ctx) => {
  const a = ctx.user();
  limits.writes.check(`u:${a.userId}`);
  const body = await ctx.body(z.object({
    display_name: displayNameSchema.nullable().optional(),
    bio: z.string().max(190).optional(),
    accent_color: hex.nullable().optional(),
    custom_status: z.string().trim().max(128).nullable().optional(),
    status: z.enum(['online', 'idle', 'dnd', 'invisible']).optional(),
    settings: settingsSchema.optional(),
  }).strict());
  const cur = await one('SELECT * FROM users WHERE id = $1', [a.userId]);
  const next = {
    display_name: body.display_name !== undefined ? body.display_name || null : cur.display_name,
    bio: body.bio ?? cur.bio,
    accent_color: body.accent_color !== undefined ? body.accent_color : cur.accent_color,
    custom_status: body.custom_status !== undefined ? body.custom_status || null : cur.custom_status,
    status: body.status ?? cur.status,
    settings: body.settings ? deepMerge(cur.settings, body.settings) : cur.settings,
  };
  await db.query(
    `UPDATE users SET display_name=$2, bio=$3, accent_color=$4, custom_status=$5, status=$6, settings=$7 WHERE id=$1`,
    [a.userId, next.display_name, next.bio, next.accent_color, next.custom_status, next.status, next.settings],
  );
  const u = await broadcastUserUpdate(a.userId);
  if (body.status !== undefined || body.custom_status !== undefined) await setPreference(a.userId, next.status, next.custom_status);
  return { user: privateUser(u) };
});

router.patch('/@me/account', async (ctx) => {
  const a = ctx.user();
  limits.auth.check(`acct:${a.userId}`);
  const body = await ctx.body(z.object({
    current_password: z.string().min(1).max(128),
    username: usernameSchema.optional(),
    email: emailSchema.optional(),
    new_password: passwordSchema.optional(),
  }).strict());
  const u = await one('SELECT * FROM users WHERE id = $1', [a.userId]);
  if (!(await verifyPassword(body.current_password, u.password_hash))) throw new HttpError(401, 'invalid_password', 'Your current password is incorrect.');
  if (body.username && body.username !== u.username) {
    if (await one('SELECT 1 FROM users WHERE lower(username) = $1 AND id <> $2', [body.username, a.userId])) throw conflict('That username is taken.', 'username_taken');
    await db.query('UPDATE users SET username = $1 WHERE id = $2', [body.username, a.userId]);
  }
  if (body.email && body.email !== u.email.toLowerCase()) {
    if (await one('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [body.email, a.userId])) throw conflict('An account with that email already exists.', 'email_taken');
    await db.query('UPDATE users SET email = $1, email_verified_at = NULL WHERE id = $2', [body.email, a.userId]);
    const token = randomToken(32);
    await db.query(`INSERT INTO email_tokens (token_hash, user_id, kind, email, expires_at) VALUES ($1,$2,'verify',$3, now() + interval '24 hours')`, [sha256(token), a.userId, body.email]);
    await verificationEmail(body.email, body.username ?? u.username, token).catch((e) => console.error('[mail]', e.message));
  }
  if (body.new_password) {
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(body.new_password), a.userId]);
    // Changing the password signs out every other session.
    const others = await many<{ id: string }>('SELECT id FROM sessions WHERE user_id = $1 AND id <> $2', [a.userId, a.sessionId]);
    await destroyOtherSessions(a.userId, a.sessionId);
    for (const s of others) disconnectUser(a.userId, s.id);
  }
  invalidateSessionCache(a.userId);
  const updated = await broadcastUserUpdate(a.userId);
  return { user: privateUser(updated) };
});

async function setImage(userId: string, column: 'avatar_key' | 'banner_key', key: string | null) {
  const old = await one(`SELECT ${column} AS k FROM users WHERE id = $1`, [userId]);
  await db.query(`UPDATE users SET ${column} = $1 WHERE id = $2`, [key, userId]);
  if (old?.k) await storage.remove(old.k).catch(() => {});
  return broadcastUserUpdate(userId);
}

router.put('/@me/avatar', async (ctx) => {
  const a = ctx.user();
  limits.uploads.check(`u:${a.userId}`);
  const f = await receiveUpload(ctx.req, 'avatars', 8 * 1024 * 1024, true);
  return { user: privateUser(await setImage(a.userId, 'avatar_key', f.key)) };
});
router.delete('/@me/avatar', async (ctx) => ({ user: privateUser(await setImage(ctx.user().userId, 'avatar_key', null)) }));
router.put('/@me/banner', async (ctx) => {
  const a = ctx.user();
  limits.uploads.check(`u:${a.userId}`);
  const f = await receiveUpload(ctx.req, 'banners', 10 * 1024 * 1024, true);
  return { user: privateUser(await setImage(a.userId, 'banner_key', f.key)) };
});
router.delete('/@me/banner', async (ctx) => ({ user: privateUser(await setImage(ctx.user().userId, 'banner_key', null)) }));

router.delete('/@me', async (ctx) => {
  const a = ctx.user();
  const { password } = await ctx.body(z.object({ password: z.string().min(1).max(128) }));
  const u = await one('SELECT * FROM users WHERE id = $1', [a.userId]);
  if (!(await verifyPassword(password, u.password_hash))) throw new HttpError(401, 'invalid_password', 'Your password is incorrect.');
  const owned = await many('SELECT id, name FROM servers WHERE owner_id = $1', [a.userId]);
  if (owned.length) {
    throw conflict(`Transfer ownership or delete your servers first: ${owned.map((s: any) => s.name).join(', ')}.`, 'owns_servers');
  }
  disconnectUser(a.userId);
  await db.query('DELETE FROM users WHERE id = $1', [a.userId]); // messages keep author_id NULL ("Deleted User")
  for (const k of [u.avatar_key, u.banner_key]) if (k) await storage.remove(k).catch(() => {});
  ctx.setCookie('parley_session', '', { maxAge: 0 });
  return { ok: true };
});

router.get('/search', async (ctx) => {
  const a = ctx.user();
  limits.search.check(`u:${a.userId}`);
  const q = (ctx.query.get('q') || '').trim().toLowerCase().replace(/^@/, '');
  if (q.length < 1) return [];
  const rows = await many(
    `SELECT ${USER_COLS} FROM users u
      WHERE u.disabled_at IS NULL AND u.id <> $2
        AND (lower(u.username) LIKE $1 || '%' OR lower(coalesce(u.display_name,'')) LIKE $1 || '%' OR u.username % $1)
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.user_id = u.id AND b.blocked_id = $2)
      ORDER BY (lower(u.username) = $1) DESC, (lower(u.username) LIKE $1 || '%') DESC, similarity(u.username, $1) DESC LIMIT 20`,
    [q.replace(/[%_\\]/g, ''), a.userId],
  );
  return rows.map((r: any) => ({ ...publicUser(r), presence: presenceOf(r.id) }));
});

router.get('/:id', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  const u = await one(`SELECT ${USER_COLS} FROM users u WHERE u.id = $1 AND u.disabled_at IS NULL`, [id]);
  if (!u) throw notFound('User');
  const mutual = await many(
    `SELECT s.id, s.name FROM servers s
       JOIN server_members a ON a.server_id = s.id AND a.user_id = $1
       JOIN server_members b ON b.server_id = s.id AND b.user_id = $2 ORDER BY s.name LIMIT 50`, [a.userId, id]);
  const blocked = !!(await one('SELECT 1 FROM blocks WHERE user_id = $1 AND blocked_id = $2', [a.userId, id]));
  const related = mutual.length > 0 || !!(await one(
    `SELECT 1 FROM dm_participants p1 JOIN dm_participants p2 ON p1.channel_id = p2.channel_id WHERE p1.user_id = $1 AND p2.user_id = $2`, [a.userId, id]));
  return {
    ...publicUser(u),
    mutual_servers: mutual,
    blocked,
    // Presence is only shared with people you have something in common with.
    presence: related || id === a.userId ? presenceOf(id) : { user_id: id, status: 'offline', custom_status: null },
  };
});

/* ───────────── blocks ───────────── */
router.get('/@me/blocks', async (ctx) => {
  const a = ctx.user();
  const rows = await many(`SELECT ${USER_COLS} FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = $1 ORDER BY b.created_at DESC`, [a.userId]);
  return rows.map(publicUser);
});
router.put('/@me/blocks/:id', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  if (id === a.userId) throw badRequest("You can't block yourself.");
  const u = await one(`SELECT ${USER_COLS} FROM users u WHERE u.id = $1`, [id]);
  if (!u) throw notFound('User');
  await db.query('INSERT INTO blocks (user_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [a.userId, id]);
  toUser(a.userId, 'BLOCK_ADD', publicUser(u));
  return { ok: true };
});
router.delete('/@me/blocks/:id', async (ctx) => {
  const a = ctx.user();
  const id = idParam(ctx, 'id');
  await db.query('DELETE FROM blocks WHERE user_id = $1 AND blocked_id = $2', [a.userId, id]);
  toUser(a.userId, 'BLOCK_REMOVE', { user_id: id });
  return { ok: true };
});

router.get('/@me/dms', async (ctx) => dmChannelsFor(ctx.user().userId));

export { forbidden };
