/**
 * Test harness: boots the real server in-process against a dedicated test
 * database (TEST_DATABASE_URL), wiping the schema first. Clients keep their own
 * cookie jar and can open authenticated WebSocket gateways.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://parley:parley_dev_pw@127.0.0.1:5432/parley_test';
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parley-test-'));
process.env.APP_URL = 'http://localhost:0';

const { db } = await import('../../server/db/index.ts');
const { migrate } = await import('../../server/db/migrate.ts');
const { createServer } = await import('../../server/app.ts');
const { limits } = await import('../../server/http/ratelimit.ts');
const { devOutbox } = await import('../../server/mail/index.ts');
const { closeGateway } = await import('../../server/realtime/gateway.ts');
const { invalidateSessionCache } = await import('../../server/auth/session.ts');
const { resetVoice } = await import('../../server/realtime/voice.ts');

export { db, limits, devOutbox };

let base = '';
let server: ReturnType<typeof createServer> | null = null;

export async function startServer() {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  server = createServer();
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return base;
}

export async function stopServer() {
  closeGateway();
  await new Promise<void>((r) => server?.close(() => r()) ?? r());
  await db.end();
}

export function resetLimits() {
  for (const l of Object.values(limits)) l.reset();
  invalidateSessionCache();
  resetVoice();
}

export interface Res<T = any> { status: number; body: T; headers: Headers }

export class Client {
  cookie = '';
  user: any = null;
  constructor(public name = 'client') {}

  async req<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const isRaw = body instanceof Uint8Array;
    const r = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined && !isRaw ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isRaw ? (body as any) : JSON.stringify(body),
    });
    const set = r.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (k === 'parley_session') this.cookie = v ? `parley_session=${v}` : '';
    }
    const text = await r.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* binary */ }
    return { status: r.status, body: parsed, headers: r.headers };
  }
  get<T = any>(u: string) { return this.req<T>('GET', u); }
  post<T = any>(u: string, b: unknown = {}) { return this.req<T>('POST', u, b); }
  patch<T = any>(u: string, b: unknown = {}) { return this.req<T>('PATCH', u, b); }
  put<T = any>(u: string, b: unknown = {}) { return this.req<T>('PUT', u, b); }
  del<T = any>(u: string, b?: unknown) { return this.req<T>('DELETE', u, b); }

  async register(username: string, password = 'a-solid-passphrase') {
    const r = await this.post('/api/auth/register', { email: `${username}@example.test`, username, password });
    if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
    this.user = r.body.user;
    return this;
  }

  /** Open a gateway connection and wait for READY. */
  async connect(): Promise<Gateway> {
    const g = new Gateway(base.replace('http', 'ws') + '/gateway', this.cookie);
    await g.waitFor('READY');
    return g;
  }
}

export class Gateway {
  ws: WebSocket;
  events: Array<{ t: string; d: any }> = [];
  private waiters: Array<{ t: string; pred: (d: any) => boolean; resolve: (d: any) => void }> = [];
  closed: Promise<number>;
  constructor(url: string, cookie: string) {
    this.ws = new WebSocket(url, { headers: { cookie } });
    this.closed = new Promise((r) => this.ws.on('close', (code) => r(code)));
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.events.push(msg);
      for (const w of [...this.waiters]) {
        if (w.t === msg.t && w.pred(msg.d)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(msg.d); }
      }
    });
    this.ws.on('error', () => {});
  }
  send(op: string, d: unknown = {}) { this.ws.send(JSON.stringify({ op, d })); }
  /** Resolves with the first matching event (already received or future). */
  waitFor(t: string, pred: (d: any) => boolean = () => true, timeoutMs = 3000): Promise<any> {
    const found = this.events.find((e) => e.t === t && pred(e.d));
    if (found) { this.events.splice(this.events.indexOf(found), 1); return Promise.resolve(found.d); }
    return new Promise((resolve, reject) => {
      const w = { t, pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error(`timed out waiting for ${t}`)); }
      }, timeoutMs);
    });
  }
  /** Assert no matching event arrives within ms. */
  async expectNone(t: string, pred: (d: any) => boolean = () => true, ms = 300) {
    await new Promise((r) => setTimeout(r, ms));
    const hit = this.events.find((e) => e.t === t && pred(e.d));
    if (hit) throw new Error(`unexpected ${t}: ${JSON.stringify(hit.d).slice(0, 200)}`);
  }
  close() { this.ws.close(); }
}

/** Common fixture: owner with a server, plus helpers to add members. */
export async function serverFixture(ownerName = 'owner') {
  const owner = await new Client(ownerName).register(ownerName);
  const created = await owner.post('/api/servers', { name: `${ownerName}'s place` });
  const server = created.body;
  const general = server.channels.find((c: any) => c.name === 'general');
  const voice = server.channels.find((c: any) => c.type === 'voice');
  const roles = Object.fromEntries(server.roles.map((r: any) => [r.name, r]));
  async function join(name: string) {
    const c = await new Client(name).register(name);
    const inv = await owner.post(`/api/servers/${server.id}/invites`, {});
    const r = await c.post(`/api/invites/${inv.body.code}/accept`);
    if (r.status !== 200) throw new Error(`join failed: ${JSON.stringify(r.body)}`);
    return c;
  }
  return { owner, server, general, voice, roles, join };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
