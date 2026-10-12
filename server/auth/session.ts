import type { IncomingMessage } from 'node:http';
import { db, one } from '../db/index.ts';
import { config } from '../config.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { parseCookies, type AuthInfo } from '../http/router.ts';

export const SESSION_COOKIE = 'parley_session';

export async function createSession(userId: string, req: IncomingMessage, ip: string) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  await db.query(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5)`,
    [sha256(token), userId, expires, String(req.headers['user-agent'] || '').slice(0, 300), ip],
  );
  return { token, maxAge: config.sessionDays * 86400 };
}

// Short-lived cache so every request doesn't hit the sessions table.
const cache = new Map<string, { info: AuthInfo; at: number }>();
const CACHE_MS = 15_000;

export function invalidateSessionCache(userId?: string) {
  if (!userId) return cache.clear();
  for (const [k, v] of cache) if (v.info.userId === userId) cache.delete(k);
}

export async function resolveSessionToken(token: string | undefined): Promise<AuthInfo | null> {
  if (!token || token.length > 100) return null;
  const id = sha256(token);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const row = await one<{ user_id: string; username: string; email_verified_at: Date | null; is_staff: boolean; last_seen_at: Date }>(
    `SELECT s.user_id, s.last_seen_at, u.username, u.email_verified_at, u.is_staff
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [id],
  );
  if (!row) { cache.delete(id); return null; }
  const info: AuthInfo = {
    userId: row.user_id, sessionId: id, username: row.username,
    emailVerified: !!row.email_verified_at, isStaff: row.is_staff,
  };
  cache.set(id, { info, at: Date.now() });
  // Sliding expiry: refresh at most every 10 minutes.
  if (Date.now() - new Date(row.last_seen_at).getTime() > 600_000) {
    db.query(`UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2) WHERE id = $1`, [id, config.sessionDays]).catch(() => {});
  }
  return info;
}

export function sessionFromRequest(req: IncomingMessage) {
  return resolveSessionToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

export async function destroySession(sessionId: string) {
  for (const [k] of cache) if (k === sessionId) cache.delete(k);
  await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export async function destroyOtherSessions(userId: string, keepSessionId?: string) {
  invalidateSessionCache(userId);
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR id <> $2)', [userId, keepSessionId ?? null]);
}
