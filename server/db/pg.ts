/**
 * Minimal, dependency-free PostgreSQL client (protocol v3).
 *
 * Supports: SCRAM-SHA-256 / MD5 / cleartext auth, optional TLS (SSLRequest),
 * the extended query protocol with text-format parameters, simple multi-statement
 * queries (used for migrations), a connection pool and transactions.
 *
 * It intentionally covers only what Parley needs. The public surface (`query`,
 * `one`, `many`, `tx`) mirrors node-postgres closely enough that swapping in `pg`
 * later is a one-file change.
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export interface PgConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string };
  max?: number;
  idleTimeoutMs?: number;
  applicationName?: string;
}

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
  command: string;
}

export class PgError extends Error {
  code: string;
  detail?: string;
  constraint?: string;
  table?: string;
  column?: string;
  severity?: string;
  constructor(fields: Record<string, string>) {
    super(fields.M || 'PostgreSQL error');
    this.name = 'PgError';
    this.code = fields.C;
    this.detail = fields.D;
    this.constraint = fields.n;
    this.table = fields.t;
    this.column = fields.c;
    this.severity = fields.S;
  }
}

export function parseDatabaseUrl(url: string): PgConfig {
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode');
  let ssl: PgConfig['ssl'] = false;
  if (sslmode === 'require' || sslmode === 'prefer') ssl = { rejectUnauthorized: false };
  if (sslmode === 'verify-full' || sslmode === 'verify-ca') ssl = { rejectUnauthorized: true };
  return {
    host: u.hostname || 'localhost',
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    ssl,
  };
}

/* ------------------------------------------------------------------ */
/* Value encoding / decoding                                           */
/* ------------------------------------------------------------------ */

function encodeArrayElement(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (Array.isArray(v)) return encodeArray(v);
  const s = typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : String(v);
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function encodeArray(arr: unknown[]): string {
  return '{' + arr.map(encodeArrayElement).join(',') + '}';
}

export function encodeParam(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return encodeArray(v);
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parseTimestamp(s: string): Date {
  // Session TimeZone is UTC, DateStyle ISO: "2026-10-11 18:59:00.123456+00"
  let iso = s.replace(' ', 'T');
  if (/[+-]\d\d$/.test(iso)) iso += ':00';
  else if (!/[zZ]|[+-]\d\d:\d\d$/.test(iso)) iso += 'Z';
  return new Date(iso);
}

function parseArrayLiteral(s: string, conv: (x: string) => unknown): unknown[] {
  // Handles one-dimensional arrays, quoted elements, escapes and NULL.
  const out: unknown[] = [];
  if (s === '{}') return out;
  let i = 1;
  while (i < s.length - 1) {
    if (s[i] === '"') {
      let val = '';
      i++;
      while (s[i] !== '"') {
        if (s[i] === '\\') i++;
        val += s[i++];
      }
      i++; // closing quote
      out.push(conv(val));
    } else {
      let j = i;
      while (j < s.length - 1 && s[j] !== ',') j++;
      const raw = s.slice(i, j);
      out.push(raw === 'NULL' ? null : conv(raw));
      i = j;
    }
    if (s[i] === ',') i++;
  }
  return out;
}

const identity = (x: string) => x;
const OID_PARSERS: Record<number, (s: string) => unknown> = {
  16: (s) => s === 't', // bool
  20: identity, // int8 -> string (ids exceed 2^53 safely)
  21: Number, // int2
  23: Number, // int4
  26: Number, // oid
  700: Number, // float4
  701: Number, // float8
  1700: identity, // numeric
  114: (s) => JSON.parse(s), // json
  3802: (s) => JSON.parse(s), // jsonb
  1114: parseTimestamp,
  1184: parseTimestamp,
  1000: (s) => parseArrayLiteral(s, (x) => x === 't'), // bool[]
  1005: (s) => parseArrayLiteral(s, Number), // int2[]
  1007: (s) => parseArrayLiteral(s, Number), // int4[]
  1016: (s) => parseArrayLiteral(s, identity), // int8[]
  1009: (s) => parseArrayLiteral(s, identity), // text[]
  1015: (s) => parseArrayLiteral(s, identity), // varchar[]
  3807: (s) => parseArrayLiteral(s, (x) => JSON.parse(x)), // jsonb[]
};

/* ------------------------------------------------------------------ */
/* Message writer                                                      */
/* ------------------------------------------------------------------ */

class Writer {
  private chunks: Buffer[] = [];
  private len = 0;
  int32(n: number) { const b = Buffer.alloc(4); b.writeInt32BE(n); return this.push(b); }
  int16(n: number) { const b = Buffer.alloc(2); b.writeInt16BE(n); return this.push(b); }
  cstr(s: string) { return this.push(Buffer.from(s + '\0', 'utf8')); }
  bytes(b: Buffer) { return this.push(b); }
  private push(b: Buffer) { this.chunks.push(b); this.len += b.length; return this; }
  /** Frame as a protocol message with a 1-byte type code (or none for startup). */
  frame(type?: string): Buffer {
    const body = Buffer.concat(this.chunks, this.len);
    const header = Buffer.alloc(type ? 5 : 4);
    if (type) { header.write(type, 0, 'ascii'); header.writeInt32BE(body.length + 4, 1); }
    else header.writeInt32BE(body.length + 4, 0);
    return Buffer.concat([header, body]);
  }
}

/* ------------------------------------------------------------------ */
/* SCRAM-SHA-256                                                        */
/* ------------------------------------------------------------------ */

function scramStart() {
  const nonce = crypto.randomBytes(18).toString('base64');
  return { nonce, clientFirstBare: `n=*,r=${nonce}` };
}
function hmac(key: Buffer, data: string) { return crypto.createHmac('sha256', key).update(data).digest(); }
function xor(a: Buffer, b: Buffer) { const o = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i]; return o; }

function scramContinue(password: string, clientNonce: string, clientFirstBare: string, serverFirst: string) {
  const attrs = Object.fromEntries(serverFirst.split(',').map((p) => [p[0], p.slice(2)]));
  const r = attrs.r, s = attrs.s, iter = Number(attrs.i);
  if (!r?.startsWith(clientNonce)) throw new Error('SCRAM: server nonce mismatch');
  const salted = crypto.pbkdf2Sync(password.normalize('NFKC'), Buffer.from(s, 'base64'), iter, 32, 'sha256');
  const clientKey = hmac(salted, 'Client Key');
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const clientFinalNoProof = `c=biws,r=${r}`;
  const authMessage = `${clientFirstBare},${serverFirst},${clientFinalNoProof}`;
  const clientSig = hmac(storedKey, authMessage);
  const proof = xor(clientKey, clientSig).toString('base64');
  const serverKey = hmac(salted, 'Server Key');
  const serverSig = hmac(serverKey, authMessage).toString('base64');
  return { clientFinal: `${clientFinalNoProof},p=${proof}`, serverSig };
}

/* ------------------------------------------------------------------ */
/* Connection                                                           */
/* ------------------------------------------------------------------ */

type Field = { name: string; oid: number };
interface Pending {
  resolve: (r: QueryResult) => void;
  reject: (e: Error) => void;
  rows: any[];
  fields: Field[];
  command: string;
  rowCount: number;
  error?: PgError;
}

export class PgConnection {
  private socket!: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private queue: Array<{ msg: Buffer; pending: Pending }> = [];
  private current: Pending | null = null;
  private onReady?: (err?: Error) => void;
  private scram?: { nonce: string; bare: string; serverSig?: string };
  dead = false;
  lastUsed = Date.now();

  constructor(private cfg: PgConfig) {}

  async connect(): Promise<void> {
    let sock: net.Socket = net.connect({ host: this.cfg.host, port: this.cfg.port });
    sock.setNoDelay(true);
    await new Promise<void>((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    if (this.cfg.ssl) {
      // SSLRequest
      const req = Buffer.alloc(8); req.writeInt32BE(8, 0); req.writeInt32BE(80877103, 4);
      sock.write(req);
      const answer: Buffer = await new Promise((res, rej) => { sock.once('data', res); sock.once('error', rej); });
      if (answer[0] !== 0x53) throw new Error('Server does not support SSL');
      const opts = typeof this.cfg.ssl === 'object' ? this.cfg.ssl : {};
      sock = tls.connect({ socket: sock, servername: this.cfg.host, rejectUnauthorized: opts.rejectUnauthorized ?? true, ca: opts.ca });
      await new Promise<void>((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
    }
    this.socket = sock;
    sock.on('data', (d: Buffer) => this.onData(d));
    sock.on('error', (e) => this.fail(e));
    sock.on('close', () => this.fail(new Error('Connection closed')));

    const ready = new Promise<void>((res, rej) => { this.onReady = (err) => (err ? rej(err) : res()); });
    const w = new Writer().int32(196608)
      .cstr('user').cstr(this.cfg.user)
      .cstr('database').cstr(this.cfg.database)
      .cstr('application_name').cstr(this.cfg.applicationName || 'parley')
      .cstr('client_encoding').cstr('UTF8')
      .cstr('TimeZone').cstr('UTC')
      .cstr('DateStyle').cstr('ISO, MDY')
      .cstr('');
    sock.write(w.frame());
    await ready;
  }

  private fail(err: Error) {
    if (this.dead) return;
    this.dead = true;
    if (this.onReady) { this.onReady(err); this.onReady = undefined; }
    if (this.current) { this.current.reject(err); this.current = null; }
    for (const q of this.queue) q.pending.reject(err);
    this.queue = [];
  }

  close() {
    if (this.dead) return;
    try { this.socket.write(new Writer().frame('X')); } catch { /* ignore */ }
    this.socket.end();
    this.dead = true;
  }

  private onData(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const type = String.fromCharCode(this.buf[0]);
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      try { this.handle(type, body); } catch (e) { this.fail(e as Error); this.socket.destroy(); return; }
    }
  }

  private handle(type: string, body: Buffer) {
    switch (type) {
      case 'R': return this.handleAuth(body);
      case 'S': case 'K': case 'N': case 'A': return; // param status, key data, notice, notification
      case 'E': {
        const fields: Record<string, string> = {};
        let i = 0;
        while (body[i] !== 0) {
          const code = String.fromCharCode(body[i]);
          const end = body.indexOf(0, i + 1);
          fields[code] = body.toString('utf8', i + 1, end);
          i = end + 1;
        }
        const err = new PgError(fields);
        if (this.onReady) { this.onReady(err); this.onReady = undefined; return; }
        if (this.current) this.current.error = err;
        return;
      }
      case 'Z': { // ReadyForQuery
        if (this.onReady) { this.onReady(); this.onReady = undefined; }
        const p = this.current;
        this.current = null;
        if (p) {
          if (p.error) p.reject(p.error);
          else p.resolve({ rows: p.rows, rowCount: p.rowCount, command: p.command });
        }
        this.pump();
        return;
      }
      case 'T': { // RowDescription
        const n = body.readInt16BE(0);
        let i = 2;
        const fields: Field[] = [];
        for (let f = 0; f < n; f++) {
          const end = body.indexOf(0, i);
          const name = body.toString('utf8', i, end);
          i = end + 1;
          const oid = body.readInt32BE(i + 6);
          i += 18;
          fields.push({ name, oid });
        }
        if (this.current) { this.current.fields = fields; this.current.rows = []; }
        return;
      }
      case 'D': { // DataRow
        const p = this.current;
        if (!p) return;
        const n = body.readInt16BE(0);
        let i = 2;
        const row: Record<string, unknown> = {};
        for (let c = 0; c < n; c++) {
          const len = body.readInt32BE(i);
          i += 4;
          const f = p.fields[c];
          if (len === -1) { row[f.name] = null; continue; }
          const text = body.toString('utf8', i, i + len);
          i += len;
          const parser = OID_PARSERS[f.oid];
          row[f.name] = parser ? parser(text) : text;
        }
        p.rows.push(row);
        return;
      }
      case 'C': { // CommandComplete
        const tag = body.toString('utf8', 0, body.length - 1);
        if (this.current) {
          const parts = tag.split(' ');
          this.current.command = parts[0];
          const last = Number(parts[parts.length - 1]);
          this.current.rowCount = Number.isFinite(last) ? last : 0;
        }
        return;
      }
      default: return; // '1','2','n','I','s','t' etc.
    }
  }

  private handleAuth(body: Buffer) {
    const code = body.readInt32BE(0);
    if (code === 0) return; // AuthenticationOk
    if (code === 3) { this.socket.write(new Writer().cstr(this.cfg.password).frame('p')); return; }
    if (code === 5) {
      const salt = body.subarray(4, 8);
      const inner = crypto.createHash('md5').update(this.cfg.password + this.cfg.user).digest('hex');
      const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      this.socket.write(new Writer().cstr('md5' + outer).frame('p'));
      return;
    }
    if (code === 10) {
      const mechs = body.toString('utf8', 4).split('\0');
      if (!mechs.includes('SCRAM-SHA-256')) throw new Error('No supported SASL mechanism');
      const { nonce, clientFirstBare } = scramStart();
      this.scram = { nonce, bare: clientFirstBare };
      const first = Buffer.from('n,,' + clientFirstBare);
      this.socket.write(new Writer().cstr('SCRAM-SHA-256').int32(first.length).bytes(first).frame('p'));
      return;
    }
    if (code === 11) {
      const serverFirst = body.toString('utf8', 4);
      const { clientFinal, serverSig } = scramContinue(this.cfg.password, this.scram!.nonce, this.scram!.bare, serverFirst);
      this.scram!.serverSig = serverSig;
      this.socket.write(new Writer().bytes(Buffer.from(clientFinal)).frame('p'));
      return;
    }
    if (code === 12) {
      const final = body.toString('utf8', 4);
      if (!final.includes(`v=${this.scram!.serverSig}`)) throw new Error('SCRAM: server signature mismatch');
      return;
    }
    throw new Error(`Unsupported auth method ${code}`);
  }

  private pump() {
    if (this.current || !this.queue.length || this.dead) return;
    const next = this.queue.shift()!;
    this.current = next.pending;
    this.socket.write(next.msg);
  }

  private enqueue(msg: Buffer): Promise<QueryResult> {
    if (this.dead) return Promise.reject(new Error('Connection is closed'));
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, pending: { resolve, reject, rows: [], fields: [], command: '', rowCount: 0 } });
      this.pump();
    });
  }

  /** Extended protocol: one statement, text parameters. */
  query<T = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const parse = new Writer().cstr('').cstr(sql).int16(0).frame('P');
    const bind = new Writer().cstr('').cstr('').int16(0).int16(params.length);
    for (const p of params) {
      const enc = encodeParam(p);
      if (enc === null) bind.int32(-1);
      else { const b = Buffer.from(enc, 'utf8'); bind.int32(b.length).bytes(b); }
    }
    bind.int16(0);
    const describe = new Writer().bytes(Buffer.from('P')).cstr('').frame('D');
    const execute = new Writer().cstr('').int32(0).frame('E');
    const sync = new Writer().frame('S');
    return this.enqueue(Buffer.concat([parse, bind.frame('B'), describe, execute, sync])) as Promise<QueryResult<T>>;
  }

  /** Simple protocol; allows multiple statements (migrations). */
  exec(sql: string): Promise<QueryResult> {
    return this.enqueue(new Writer().cstr(sql).frame('Q'));
  }
}

/* ------------------------------------------------------------------ */
/* Pool                                                                 */
/* ------------------------------------------------------------------ */

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export class PgPool implements Queryable {
  private idle: PgConnection[] = [];
  private total = 0;
  private waiters: Array<(c: PgConnection) => void> = [];
  private reaper: NodeJS.Timeout;
  private ended = false;

  constructor(private cfg: PgConfig) {
    this.reaper = setInterval(() => this.reap(), 10_000);
    this.reaper.unref();
  }

  get stats() { return { total: this.total, idle: this.idle.length, waiting: this.waiters.length }; }

  private reap() {
    const cutoff = Date.now() - (this.cfg.idleTimeoutMs ?? 30_000);
    this.idle = this.idle.filter((c) => {
      if (c.lastUsed < cutoff && this.idle.length > 1) { c.close(); this.total--; return false; }
      return true;
    });
  }

  async acquire(): Promise<PgConnection> {
    if (this.ended) throw new Error('Pool has ended');
    while (this.idle.length) {
      const c = this.idle.pop()!;
      if (!c.dead) return c;
      this.total--;
    }
    if (this.total < (this.cfg.max ?? 10)) {
      this.total++;
      const c = new PgConnection(this.cfg);
      try { await c.connect(); } catch (e) { this.total--; throw e; }
      return c;
    }
    return new Promise((res) => this.waiters.push(res));
  }

  release(c: PgConnection) {
    if (c.dead) {
      this.total--;
      // A slot freed up; let a waiter open a fresh connection.
      const w = this.waiters.shift();
      if (w) this.acquire().then(w, () => this.waiters.unshift(w));
      return;
    }
    const w = this.waiters.shift();
    if (w) w(c);
    else this.idle.push(c);
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const c = await this.acquire();
    try { return await c.query<T>(sql, params); } finally { this.release(c); }
  }

  async exec(sql: string) {
    const c = await this.acquire();
    try { return await c.exec(sql); } finally { this.release(c); }
  }

  /** Run fn inside a transaction; rolls back on throw. */
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const c = await this.acquire();
    try {
      await c.query('BEGIN');
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      if (!c.dead) await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      this.release(c);
    }
  }

  async end() {
    this.ended = true;
    clearInterval(this.reaper);
    for (const c of this.idle) c.close();
    this.idle = [];
  }
}
