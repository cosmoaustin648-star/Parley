import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { db, many, one } from '../db/index.ts';
import { config } from '../config.ts';
import { sessionFromRequest } from '../auth/session.ts';
import { RateLimiter } from '../http/ratelimit.ts';
import { channelPermissions, getMemberIds, getChannel, type ChannelRow } from '../services/access.ts';
import { P, has } from '../../shared/permissions.ts';
import { publicUser, USER_COLS } from '../services/serialize.ts';

export type Status = 'online' | 'idle' | 'dnd' | 'offline';

export interface Client {
  id: number;
  ws: WebSocket;
  userId: string;
  sessionId: string;
  idle: boolean;
  alive: boolean;
}

let nextClientId = 1;
const clients = new Map<string, Set<Client>>(); // userId -> connections
const prefs = new Map<string, { status: 'online' | 'idle' | 'dnd' | 'invisible'; custom: string | null }>();
const opLimiter = new RateLimiter(240, 60);

type OpHandler = (c: Client, d: any) => Promise<void> | void;
const opHandlers = new Map<string, OpHandler>();
/** Other modules (voice) register gateway ops here. */
export function onOp(op: string, h: OpHandler) { opHandlers.set(op, h); }
const disconnectHooks: Array<(c: Client) => void> = [];
export function onDisconnect(h: (c: Client) => void) { disconnectHooks.push(h); }

/* ───────────── dispatch helpers ───────────── */

function send(c: Client, t: string, d: unknown) {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t, d }));
}
export function isOnline(userId: string) { return (clients.get(userId)?.size ?? 0) > 0; }
export function onlineUserIds() { return [...clients.keys()]; }

export function toUser(userId: string, t: string, d: unknown) {
  for (const c of clients.get(userId) ?? []) send(c, t, d);
}
/** A single specific connection (used for WebRTC signaling). */
export function toClient(userId: string, clientId: number, t: string, d: unknown) {
  for (const c of clients.get(userId) ?? []) if (c.id === clientId) send(c, t, d);
}
export function toUsers(userIds: Iterable<string>, t: string, d: unknown) {
  for (const id of userIds) toUser(id, t, d);
}
/** Every online member of a server. */
export async function toServer(serverId: string, t: string, d: unknown, except?: string) {
  const ids = await getMemberIds(serverId);
  for (const id of ids) if (id !== except && isOnline(id)) toUser(id, t, d);
}
/** Everyone who can see a channel (server members with VIEW, or DM participants). */
export async function toChannel(ch: ChannelRow, t: string, d: unknown, opts: { except?: string; requires?: number } = {}) {
  const recipients = await channelAudience(ch, opts.requires ?? P.VIEW_CHANNEL);
  for (const id of recipients) if (id !== opts.except) toUser(id, t, d);
}
export async function channelAudience(ch: ChannelRow, requires = P.VIEW_CHANNEL): Promise<string[]> {
  if (ch.type === 'dm' || ch.type === 'group_dm') {
    const rows = await many<{ user_id: string }>('SELECT user_id FROM dm_participants WHERE channel_id = $1', [ch.id]);
    return rows.map((r) => r.user_id).filter(isOnline);
  }
  const serverId = ch.server_id!;
  const ids = await getMemberIds(serverId);
  const out: string[] = [];
  for (const id of ids) {
    if (!isOnline(id)) continue;
    if (has(await channelPermissions(id, ch), requires)) out.push(id);
  }
  return out;
}

/* ───────────── presence ───────────── */

export function statusOf(userId: string): Status {
  const conns = clients.get(userId);
  if (!conns || conns.size === 0) return 'offline';
  const p = prefs.get(userId);
  if (p?.status === 'invisible') return 'offline';
  if (p?.status === 'dnd') return 'dnd';
  if (p?.status === 'idle') return 'idle';
  return [...conns].every((c) => c.idle) ? 'idle' : 'online';
}
export function presenceOf(userId: string) {
  return { user_id: userId, status: statusOf(userId), custom_status: prefs.get(userId)?.custom ?? null };
}

/** Users who share a server or DM with userId. */
export async function relatedUserIds(userId: string): Promise<string[]> {
  const rows = await many<{ user_id: string }>(
    `SELECT sm2.user_id FROM server_members sm1 JOIN server_members sm2 ON sm2.server_id = sm1.server_id WHERE sm1.user_id = $1
     UNION
     SELECT p2.user_id FROM dm_participants p1 JOIN dm_participants p2 ON p2.channel_id = p1.channel_id WHERE p1.user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.user_id);
}

const lastBroadcast = new Map<string, string>();
export async function broadcastPresence(userId: string, force = false) {
  const p = presenceOf(userId);
  const sig = `${p.status}|${p.custom_status}`;
  if (!force && lastBroadcast.get(userId) === sig) return;
  lastBroadcast.set(userId, sig);
  const related = await relatedUserIds(userId);
  for (const id of related) if (isOnline(id)) toUser(id, 'PRESENCE_UPDATE', p);
}

export function setPreference(userId: string, status: 'online' | 'idle' | 'dnd' | 'invisible', custom: string | null) {
  prefs.set(userId, { status, custom });
  return broadcastPresence(userId);
}

/** Forcefully close sockets for a user (logout everywhere, account deletion). */
export function disconnectUser(userId: string, sessionId?: string) {
  for (const c of clients.get(userId) ?? []) if (!sessionId || c.sessionId === sessionId) c.ws.close(4004, 'Session ended');
}

/* ───────────── typing ───────────── */
const typingLimiter = new RateLimiter(8, 10);
onOp('typing', async (c, d) => {
  const id = z.object({ channel_id: z.string().regex(/^\d+$/) }).parse(d).channel_id;
  if (typingLimiter.take(`${c.userId}:${id}`)) return;
  const ch = await getChannel(id);
  if (!ch || !has(await channelPermissions(c.userId, ch), P.SEND_MESSAGES)) return;
  await toChannel(ch, 'TYPING_START', { channel_id: id, user_id: c.userId, at: Date.now() }, { except: c.userId });
});

onOp('presence', async (c, d) => {
  const { idle } = z.object({ idle: z.boolean() }).parse(d);
  c.idle = idle;
  await broadcastPresence(c.userId);
});

onOp('ping', (c) => send(c, 'PONG', { at: Date.now() }));

/* ───────────── connection lifecycle ───────────── */

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
type ReadyBuilder = (userId: string) => Promise<unknown>;
let buildReady: ReadyBuilder = async () => ({});
export function setReadyBuilder(fn: ReadyBuilder) { buildReady = fn; }

function originAllowed(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients
  try {
    const o = new URL(origin);
    return o.host === req.headers.host || o.host === new URL(config.appUrl).host;
  } catch { return false; }
}

export async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const reject = (code: number, msg: string) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (!originAllowed(req)) return reject(403, 'Forbidden');
  const auth = await sessionFromRequest(req).catch(() => null);
  if (!auth) return reject(401, 'Unauthorized');
  wss.handleUpgrade(req, socket, head, (ws) => { void onConnection(ws, auth.userId, auth.sessionId); });
}

async function onConnection(ws: WebSocket, userId: string, sessionId: string) {
  const c: Client = { id: nextClientId++, ws, userId, sessionId, idle: false, alive: true };
  const u = await one<{ status: any; custom_status: string | null }>('SELECT status, custom_status FROM users WHERE id = $1', [userId]);
  prefs.set(userId, { status: u?.status ?? 'online', custom: u?.custom_status ?? null });
  const set = clients.get(userId) ?? new Set();
  set.add(c);
  clients.set(userId, set);

  ws.on('pong', () => { c.alive = true; });
  ws.on('message', async (raw) => {
    let msg: { op?: string; d?: unknown; ref?: number };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.op !== 'string') return;
    if (opLimiter.take(`${c.id}`)) { send(c, 'ERROR', { op: msg.op, code: 'rate_limited' }); return; }
    const h = opHandlers.get(msg.op);
    if (!h) return;
    try { await h(c, msg.d ?? {}); }
    catch (e: any) {
      send(c, 'ERROR', { op: msg.op, ref: msg.ref, code: e?.code || 'error', message: e?.issues ? 'Invalid payload' : e?.message || 'Error' });
    }
  });
  ws.on('close', () => {
    set.delete(c);
    if (!set.size) clients.delete(userId);
    for (const h of disconnectHooks) { try { h(c); } catch (e) { console.error(e); } }
    void broadcastPresence(userId).catch(() => {});
  });
  ws.on('error', () => {});

  try {
    const ready = await buildReady(userId);
    send(c, 'READY', ready);
    await broadcastPresence(userId, set.size === 1);
  } catch (e) {
    console.error('[gateway] READY failed', e);
    ws.close(1011, 'Ready failed');
  }
}

// Detect dead connections.
const heartbeat = setInterval(() => {
  for (const set of clients.values()) for (const c of set) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch { /* ignore */ }
  }
}, 30_000);
heartbeat.unref();

export function closeGateway() {
  clearInterval(heartbeat);
  for (const set of clients.values()) for (const c of set) c.ws.terminate();
  wss.close();
}

/** Presence of a set of users, only those online. */
export function presencesFor(userIds: Iterable<string>) {
  const out = [];
  for (const id of userIds) { const p = presenceOf(id); if (p.status !== 'offline') out.push(p); }
  return out;
}

export async function publicUserById(id: string) {
  const r = await one(`SELECT ${USER_COLS} FROM users u WHERE u.id = $1`, [id]);
  return r ? publicUser(r) : null;
}

export { db };
