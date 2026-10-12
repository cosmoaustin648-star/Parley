import { z } from 'zod';
import { Router, HttpError, badRequest, conflict, unauthorized, serializeCookie, type Ctx } from '../http/router.ts';
import { db, one, many } from '../db/index.ts';
import { config } from '../config.ts';
import { hashPassword, verifyPassword, getDummyHash, randomToken, sha256 } from '../lib/crypto.ts';
import { createSession, destroySession, destroyOtherSessions, invalidateSessionCache, SESSION_COOKIE } from '../auth/session.ts';
import { limits } from '../http/ratelimit.ts';
import { verificationEmail, passwordResetEmail } from '../mail/index.ts';
import { privateUser } from '../services/serialize.ts';
import { disconnectUser } from '../realtime/gateway.ts';

export const router = new Router('/api/auth');

export const usernameSchema = z.string().trim().toLowerCase()
  .min(2, 'Username must be at least 2 characters.').max(32, 'Username must be at most 32 characters.')
  .regex(/^[a-z0-9_.]+$/, 'Usernames can only use letters, numbers, underscores and periods.')
  .refine((s) => !s.includes('..'), 'Usernames cannot contain consecutive periods.');
export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters.').max(128, 'Password must be at most 128 characters.');
export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
export const displayNameSchema = z.string().trim().max(32, 'Display name must be at most 32 characters.');

const WEAK = new Set(['password', 'password1', '12345678', '123456789', 'qwertyui', 'iloveyou', 'parley123', '11111111', 'abcdefgh']);

export function requireVerified(ctx: Ctx) {
  const a = ctx.user();
  if (config.requireEmailVerification && !a.emailVerified) {
    throw new HttpError(403, 'email_unverified', 'Please verify your email address first.');
  }
  return a;
}

async function issueEmailToken(userId: string, email: string, kind: 'verify' | 'reset') {
  const token = randomToken(32);
  const ttl = kind === 'verify' ? '24 hours' : '1 hour';
  await db.query(`UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`, [userId, kind]);
  await db.query(
    `INSERT INTO email_tokens (token_hash, user_id, kind, email, expires_at) VALUES ($1,$2,$3,$4, now() + $5::interval)`,
    [sha256(token), userId, kind, email, ttl],
  );
  return token;
}

function setSessionCookie(ctx: Ctx, token: string, maxAge: number) {
  ctx.setCookie(SESSION_COOKIE, token, { maxAge, httpOnly: true, sameSite: 'Lax' });
}

router.post('/register', async (ctx) => {
  limits.auth.check(`reg:${ctx.ip}`);
  const body = await ctx.body(z.object({
    email: emailSchema,
    username: usernameSchema,
    password: passwordSchema,
    display_name: displayNameSchema.optional(),
  }));
  if (WEAK.has(body.password.toLowerCase())) throw badRequest('That password is too common. Pick something harder to guess.');
  if (await one('SELECT 1 FROM users WHERE lower(username) = $1', [body.username])) throw conflict('That username is taken.', 'username_taken');
  if (await one('SELECT 1 FROM users WHERE lower(email) = $1', [body.email])) throw conflict('An account with that email already exists.', 'email_taken');
  const hash = await hashPassword(body.password);
  const isStaff = config.staffEmails.includes(body.email);
  const user = await one(
    `INSERT INTO users (username, display_name, email, password_hash, is_staff) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [body.username, body.display_name || null, body.email, hash, isStaff],
  );
  const token = await issueEmailToken(user.id, body.email, 'verify');
  await verificationEmail(body.email, body.username, token).catch((e) => console.error('[mail] verification failed', e.message));
  const s = await createSession(user.id, ctx.req, ctx.ip);
  setSessionCookie(ctx, s.token, s.maxAge);
  return { user: privateUser(user) };
});

router.post('/login', async (ctx) => {
  limits.auth.check(`login:${ctx.ip}`);
  const body = await ctx.body(z.object({ login: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) }));
  const ident = body.login.toLowerCase();
  limits.auth.check(`login-acct:${ident}`);
  const user = await one(`SELECT * FROM users WHERE lower(email) = $1 OR lower(username) = $1 LIMIT 1`, [ident]);
  const ok = await verifyPassword(body.password, user?.password_hash ?? (await getDummyHash()));
  if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'Incorrect email/username or password.');
  if (user.disabled_at) throw new HttpError(403, 'account_disabled', 'This account has been disabled.');
  const s = await createSession(user.id, ctx.req, ctx.ip);
  setSessionCookie(ctx, s.token, s.maxAge);
  return { user: privateUser(user) };
});

router.post('/logout', async (ctx) => {
  if (ctx.auth) {
    await destroySession(ctx.auth.sessionId);
    disconnectUser(ctx.auth.userId, ctx.auth.sessionId);
  }
  ctx.setCookie(SESSION_COOKIE, '', { maxAge: 0 });
  return { ok: true };
});

router.get('/me', async (ctx) => {
  const a = ctx.user();
  const u = await one('SELECT * FROM users WHERE id = $1', [a.userId]);
  return { user: privateUser(u) };
});

router.get('/sessions', async (ctx) => {
  const a = ctx.user();
  const rows = await many('SELECT id, created_at, last_seen_at, user_agent, ip FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC', [a.userId]);
  return rows.map((r: any) => ({
    id: r.id.slice(0, 16), current: r.id === a.sessionId, created_at: r.created_at, last_seen_at: r.last_seen_at, user_agent: r.user_agent, ip: r.ip,
  }));
});

router.delete('/sessions/:id', async (ctx) => {
  const a = ctx.user();
  const prefix = ctx.params.id;
  if (!/^[0-9a-f]{16}$/.test(prefix)) throw badRequest('Invalid session id.');
  const row = await one<{ id: string }>('SELECT id FROM sessions WHERE user_id = $1 AND left(id, 16) = $2', [a.userId, prefix]);
  if (row) { await destroySession(row.id); disconnectUser(a.userId, row.id); }
  return { ok: true };
});

router.post('/logout-others', async (ctx) => {
  const a = ctx.user();
  const others = await many<{ id: string }>('SELECT id FROM sessions WHERE user_id = $1 AND id <> $2', [a.userId, a.sessionId]);
  await destroyOtherSessions(a.userId, a.sessionId);
  for (const s of others) disconnectUser(a.userId, s.id);
  return { ok: true };
});

router.post('/verify-email', async (ctx) => {
  limits.auth.check(`verify:${ctx.ip}`);
  const { token } = await ctx.body(z.object({ token: z.string().min(10).max(100) }));
  const row = await one(
    `UPDATE email_tokens SET used_at = now() WHERE token_hash = $1 AND kind = 'verify' AND used_at IS NULL AND expires_at > now() RETURNING user_id, email`,
    [sha256(token)],
  );
  if (!row) throw badRequest('This verification link is invalid or has expired.');
  const user = await one(
    `UPDATE users SET email_verified_at = now() WHERE id = $1 AND lower(email) = lower($2) RETURNING *`, [row.user_id, row.email]);
  if (!user) throw badRequest('This verification link no longer matches your email address.');
  invalidateSessionCache(user.id);
  return { user: privateUser(user) };
});

router.post('/resend-verification', async (ctx) => {
  const a = ctx.user();
  limits.authEmail.check(`verify:${a.userId}`);
  const u = await one('SELECT * FROM users WHERE id = $1', [a.userId]);
  if (u.email_verified_at) return { ok: true, already_verified: true };
  const token = await issueEmailToken(u.id, u.email, 'verify');
  await verificationEmail(u.email, u.username, token);
  return { ok: true };
});

router.post('/forgot-password', async (ctx) => {
  limits.auth.check(`forgot:${ctx.ip}`);
  const { email } = await ctx.body(z.object({ email: emailSchema }));
  limits.authEmail.check(`reset:${email}`);
  const u = await one('SELECT * FROM users WHERE lower(email) = $1 AND disabled_at IS NULL', [email]);
  if (u) {
    const token = await issueEmailToken(u.id, u.email, 'reset');
    await passwordResetEmail(u.email, u.username, token).catch((e) => console.error('[mail] reset failed', e.message));
  }
  // Same response either way so this can't be used to discover accounts.
  return { ok: true };
});

router.post('/reset-password', async (ctx) => {
  limits.auth.check(`reset:${ctx.ip}`);
  const { token, password } = await ctx.body(z.object({ token: z.string().min(10).max(100), password: passwordSchema }));
  if (WEAK.has(password.toLowerCase())) throw badRequest('That password is too common. Pick something harder to guess.');
  const row = await one(
    `UPDATE email_tokens SET used_at = now() WHERE token_hash = $1 AND kind = 'reset' AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [sha256(token)],
  );
  if (!row) throw badRequest('This reset link is invalid or has expired.');
  // Possession of the reset email also proves the address.
  await db.query('UPDATE users SET password_hash = $1, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $2', [await hashPassword(password), row.user_id]);
  await destroyOtherSessions(row.user_id);
  disconnectUser(row.user_id);
  return { ok: true };
});

export { unauthorized };
