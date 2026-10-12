import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError, type ZodTypeAny, type infer as ZInfer } from 'zod';
import { PgError } from '../db/pg.ts';
import { config } from '../config.ts';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: unknown) {
    super(message || code);
  }
}
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'You need to be logged in.') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', msg);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found.`);
export const conflict = (msg: string, code = 'conflict') => new HttpError(409, code, msg);

export interface AuthInfo {
  userId: string;
  sessionId: string;
  username: string;
  emailVerified: boolean;
  isStaff: boolean;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  ip: string;
  auth: AuthInfo | null;
  /** Parsed JSON body (validated when a schema is passed). */
  body<S extends ZodTypeAny>(schema: S): Promise<ZInfer<S>>;
  /** The authenticated user; throws 401 otherwise. */
  user(): AuthInfo;
  setCookie(name: string, value: string, opts?: CookieOpts): void;
  cookies: Record<string, string>;
}

export interface CookieOpts { maxAge?: number; httpOnly?: boolean; sameSite?: 'Lax' | 'Strict' | 'None'; path?: string }

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
interface Route { method: string; parts: string[]; handler: Handler }

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

export function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, 'payload_too_large', 'Request body is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', 'Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export class Router {
  private routes: Route[] = [];
  constructor(private prefix = '') {}

  add(method: string, path: string, handler: Handler) {
    const full = (this.prefix + path).replace(/\/+$/, '') || '/';
    this.routes.push({ method, parts: full.split('/').filter(Boolean), handler });
  }
  get(p: string, h: Handler) { this.add('GET', p, h); }
  post(p: string, h: Handler) { this.add('POST', p, h); }
  put(p: string, h: Handler) { this.add('PUT', p, h); }
  patch(p: string, h: Handler) { this.add('PATCH', p, h); }
  delete(p: string, h: Handler) { this.add('DELETE', p, h); }

  /** Merge routes from another router. */
  use(other: Router) { this.routes.push(...other.routes); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    const segs = pathname.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(':')) {
          try { params[p.slice(1)] = decodeURIComponent(segs[i]); } catch { ok = false; break; }
        } else if (p !== segs[i]) { ok = false; break; }
      }
      if (!ok) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { methodMismatch = true; continue; }
      return { handler: r.handler, params };
    }
    return methodMismatch ? 'method' : null;
  }
}

/** Convert anything thrown in a handler into a JSON error response. */
export function errorResponse(res: ServerResponse, err: unknown) {
  if (res.headersSent) { res.end(); return; }
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    return sendJson(res, 400, {
      error: { code: 'validation_error', message: first ? `${first.path ? first.path + ': ' : ''}${first.message}` : 'Invalid input.', details: issues },
    });
  }
  if (err instanceof PgError && err.code === '23505') {
    return sendJson(res, 409, { error: { code: 'conflict', message: 'That already exists.' } });
  }
  if (err instanceof PgError && err.code === '22P02') {
    return sendJson(res, 400, { error: { code: 'bad_request', message: 'Malformed identifier.' } });
  }
  console.error('[http] unhandled error', err);
  return sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong on our end.' } });
}

export function serializeCookie(name: string, value: string, opts: CookieOpts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`, `SameSite=${opts.sameSite ?? 'Lax'}`];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (config.cookieSecure) parts.push('Secure');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  return parts.join('; ');
}

export const ID = /^\d{1,19}$/;
/** Validate a path id param. */
export function idParam(ctx: Ctx, name: string): string {
  const v = ctx.params[name];
  if (!v || !ID.test(v)) throw notFound();
  return v;
}
