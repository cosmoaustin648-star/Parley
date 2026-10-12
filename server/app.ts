import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import {
  Router, HttpError, errorResponse, sendJson, parseCookies, clientIp, readBody, serializeCookie, unauthorized,
  type Ctx, type AuthInfo,
} from './http/router.ts';
import { limits } from './http/ratelimit.ts';
import { sessionFromRequest } from './auth/session.ts';
import { handleUpgrade, setReadyBuilder } from './realtime/gateway.ts';
import './realtime/voice.ts';
import { buildReady } from './services/state.ts';
import { storage, INLINE_TYPES } from './storage/index.ts';
import { one } from './db/index.ts';
import { requireChannel } from './services/access.ts';
import { router as authRoutes } from './routes/auth.ts';
import { router as userRoutes } from './routes/users.ts';
import { router as serverRoutes } from './routes/servers.ts';
import { router as channelRoutes } from './routes/channels.ts';
import { router as messageRoutes } from './routes/messages.ts';
import { router as dmRoutes } from './routes/dms.ts';
import { router as moderationRoutes } from './routes/moderation.ts';
import { router as miscRoutes } from './routes/misc.ts';

setReadyBuilder(buildReady);

export const api = new Router();
for (const r of [authRoutes, userRoutes, serverRoutes, channelRoutes, messageRoutes, dmRoutes, moderationRoutes, miscRoutes]) api.use(r);

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:", "style-src 'self' 'unsafe-inline'",
    "script-src 'self'", "connect-src 'self' ws: wss:", "font-src 'self' data:", "frame-ancestors 'none'",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  ].join('; '),
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Reject cross-site state-changing requests (CSRF). SameSite=Lax cookies are the first line; this is the second. */
function checkOrigin(req: http.IncomingMessage) {
  if (!MUTATING.has(req.method || '')) return;
  const origin = req.headers.origin;
  if (!origin) return; // non-browser clients don't send Origin; browsers always do on cross-site requests
  let host: string;
  try { host = new URL(origin).host; } catch { throw new HttpError(403, 'bad_origin', 'Cross-origin request blocked.'); }
  if (host !== req.headers.host && host !== new URL(config.appUrl).host) throw new HttpError(403, 'bad_origin', 'Cross-origin request blocked.');
}

function streamFile(res: http.ServerResponse, key: string, contentType: string, filename: string | null, size?: number) {
  const inline = INLINE_TYPES.has(contentType);
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=86400',
    // Uploaded content can never run script in our origin.
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
  if (size) headers['Content-Length'] = String(size);
  if (filename) headers['Content-Disposition'] = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`;
  res.writeHead(200, headers);
  const s = storage.stream(key);
  s.on('error', () => res.destroy());
  s.pipe(res);
}

async function serveMedia(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  // Avatars, banners and server icons: public by unguessable key.
  const key = decodeURIComponent(pathname.slice('/api/media/'.length));
  if (!/^(avatars|banners|icons)\/\d{4}\/\d{2}\/[0-9a-f]{32}$/.test(key)) throw new HttpError(404, 'not_found', 'Not found.');
  const st = await storage.stat(key);
  if (!st) throw new HttpError(404, 'not_found', 'Not found.');
  const fd = fs.openSync(path.join(config.storage.dir, key), 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  const { sniffType } = await import('./storage/index.ts');
  streamFile(res, key, sniffType(Buffer.concat([head, Buffer.alloc(16)])), null, st.size);
}

async function serveAttachment(auth: AuthInfo | null, res: http.ServerResponse, id: string) {
  if (!auth) throw unauthorized();
  if (!/^\d+$/.test(id)) throw new HttpError(404, 'not_found', 'Not found.');
  const a = await one<any>(
    `SELECT a.*, m.channel_id FROM attachments a LEFT JOIN messages m ON m.id = a.message_id WHERE a.id = $1`, [id]);
  if (!a) throw new HttpError(404, 'not_found', 'Not found.');
  if (a.channel_id) await requireChannel(auth.userId, a.channel_id); // must be able to see the channel
  else if (a.uploader_id !== auth.userId) throw new HttpError(404, 'not_found', 'Not found.');
  streamFile(res, a.storage_key, a.content_type, a.filename, Number(a.size));
}

/* ───────────── static client ───────────── */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.map': 'application/json',
};
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  const dir = config.clientDir;
  let file = path.resolve(dir, '.' + pathname);
  if (!file.startsWith(dir)) file = path.join(dir, 'index.html');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html'); // SPA fallback
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Client bundle not built. Run `npm run build` (or `npm run dev`).');
    return;
  }
  const ext = path.extname(file);
  const immutable = /\/assets\/.+-[a-z0-9]{8,}\./i.test(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ───────────── request handler ───────────── */
export async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;
  const ip = clientIp(req);

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  try {
    limits.global.check(`ip:${ip}`);
    checkOrigin(req);
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    const auth = await sessionFromRequest(req);
    if (pathname.startsWith('/api/media/')) return await serveMedia(req, res, pathname);
    const att = pathname.match(/^\/api\/attachments\/(\d+)\/[^/]+$/);
    if (att && req.method === 'GET') return await serveAttachment(auth, res, att[1]);

    const m = api.match(req.method || 'GET', pathname);
    if (m === 'method') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
    if (!m) throw new HttpError(404, 'not_found', 'Unknown API route.');

    const cookies = parseCookies(req.headers.cookie);
    const setCookies: string[] = [];
    let bodyCache: unknown;
    const ctx: Ctx = {
      req, res, url, params: m.params, query: url.searchParams, ip, auth, cookies,
      async body(schema) {
        if (bodyCache === undefined) {
          const ct = String(req.headers['content-type'] || '');
          const raw = await readBody(req, 1024 * 1024);
          if (raw.length && !ct.includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Send JSON.');
          try { bodyCache = raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
          catch { throw new HttpError(400, 'bad_json', 'Malformed JSON body.'); }
        }
        return schema.parse(bodyCache);
      },
      user() { if (!auth) throw unauthorized(); return auth; },
      setCookie(name, value, opts) { setCookies.push(serializeCookie(name, value, opts)); },
    };
    const result = await m.handler(ctx);
    if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
    if (res.headersSent || res.writableEnded) return;
    if (result === undefined) { res.writeHead(204); res.end(); return; }
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429 && (err.details as any)?.retryAfter) {
      res.setHeader('Retry-After', String((err.details as any).retryAfter));
    }
    errorResponse(res, err);
  }
}

export function createServer() {
  const server = http.createServer((req, res) => { void handle(req, res); });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/gateway') void handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000; // uploads
  return server;
}
