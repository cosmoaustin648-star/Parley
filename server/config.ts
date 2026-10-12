import fs from 'node:fs';
import path from 'node:path';

/** Load a .env file (KEY=VALUE lines) without overriding real environment variables. */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

const env = process.env;
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

const isProd = env.NODE_ENV === 'production';

export const config = {
  env: env.NODE_ENV || 'development',
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  /** Public base URL used in emails and invite links. */
  appUrl: (env.APP_URL || `http://localhost:${num(env.PORT, 3000)}`).replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL || 'postgres://parley:parley_dev_pw@127.0.0.1:5432/parley',
  dbPoolMax: num(env.DB_POOL_MAX, 10),
  /** Trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy. */
  trustProxy: bool(env.TRUST_PROXY, false),
  cookieSecure: bool(env.COOKIE_SECURE, isProd),
  sessionDays: num(env.SESSION_DAYS, 30),
  requireEmailVerification: bool(env.REQUIRE_EMAIL_VERIFICATION, false),

  smtp: {
    host: env.SMTP_HOST || '',
    port: num(env.SMTP_PORT, 587),
    secure: bool(env.SMTP_SECURE, false), // true = implicit TLS (465); false = STARTTLS when offered
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'Parley <no-reply@localhost>',
  },

  storage: {
    dir: path.resolve(env.STORAGE_DIR || './data/uploads'),
    maxUploadBytes: num(env.MAX_UPLOAD_MB, 25) * 1024 * 1024,
  },

  rtc: {
    /** JSON array of RTCIceServer objects; defaults to a public STUN server. */
    iceServers: env.ICE_SERVERS ? JSON.parse(env.ICE_SERVERS) : [{ urls: 'stun:stun.l.google.com:19302' }],
    /** coturn `static-auth-secret` for time-limited TURN credentials (optional). */
    turnSecret: env.TURN_SECRET || '',
    turnUrls: (env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxVoiceParticipants: num(env.MAX_VOICE_PARTICIPANTS, 8),
  },

  staffEmails: (env.STAFF_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** Directory of the built client bundle. */
  clientDir: path.resolve(env.CLIENT_DIR || './dist/client'),
};

export type Config = typeof config;
