/**
 * Small SMTP client: implicit TLS or STARTTLS, AUTH PLAIN/LOGIN, single message.
 * Enough for transactional email (verification, password reset) through any
 * standard provider (Postmark, SES SMTP, Mailgun, Resend SMTP, Gmail, …).
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export interface SmtpOptions { host: string; port: number; secure: boolean; user?: string; pass?: string; timeoutMs?: number }
export interface MailMessage { from: string; to: string; subject: string; text: string; html?: string }

class Conn {
  private buf = '';
  private waiters: Array<(lines: string[]) => void> = [];
  private lines: string[] = [];
  constructor(public sock: net.Socket) { this.attach(sock); }
  attach(sock: net.Socket) {
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.lines.push(line);
        // Final line of a reply: "250 OK" (space after code) vs continuation "250-..."
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const w = this.waiters.shift();
          const reply = this.lines;
          this.lines = [];
          w?.(reply);
        }
      }
    });
  }
  read(): Promise<string[]> { return new Promise((r) => this.waiters.push(r)); }
  async cmd(line: string | null, expect: number[]): Promise<string[]> {
    if (line !== null) this.sock.write(line + '\r\n');
    const reply = await this.read();
    const code = Number(reply[reply.length - 1].slice(0, 3));
    if (!expect.includes(code)) throw new Error(`SMTP ${line?.split(' ')[0] ?? 'greeting'} failed: ${reply.join(' | ')}`);
    return reply;
  }
}

function encodeHeader(s: string) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
}
function addrOf(s: string) { const m = s.match(/<([^>]+)>/); return (m ? m[1] : s).trim(); }

export function buildMime(msg: MailMessage, domain: string): string {
  const boundary = 'b_' + crypto.randomBytes(12).toString('hex');
  const headers = [
    `From: ${msg.from}`, `To: ${msg.to}`, `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${domain}>`, 'MIME-Version: 1.0',
  ];
  const b64 = (s: string) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
  let body: string;
  if (msg.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(msg.text),
      `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(msg.html),
      `--${boundary}--`, '',
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
    body = b64(msg.text);
  }
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

export async function sendSmtp(opts: SmtpOptions, msg: MailMessage): Promise<void> {
  const timeout = opts.timeoutMs ?? 15_000;
  const raw: net.Socket = opts.secure
    ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host })
    : net.connect({ host: opts.host, port: opts.port });
  raw.setTimeout(timeout, () => raw.destroy(new Error('SMTP timeout')));
  const errored = new Promise<never>((_, rej) => raw.once('error', rej));
  const run = async () => {
    const c = new Conn(raw);
    await c.cmd(null, [220]);
    let ehlo = await c.cmd('EHLO parley.local', [250]);
    if (!opts.secure && ehlo.some((l) => /STARTTLS/i.test(l))) {
      await c.cmd('STARTTLS', [220]);
      const secured = tls.connect({ socket: raw, servername: opts.host });
      await new Promise<void>((res, rej) => { secured.once('secureConnect', res); secured.once('error', rej); });
      raw.removeAllListeners('data');
      c.attach(secured);
      ehlo = await c.cmd('EHLO parley.local', [250]);
    }
    if (opts.user) {
      const authLine = ehlo.find((l) => /AUTH/i.test(l)) || '';
      if (/PLAIN/i.test(authLine)) {
        await c.cmd('AUTH PLAIN ' + Buffer.from(`\0${opts.user}\0${opts.pass ?? ''}`).toString('base64'), [235]);
      } else {
        await c.cmd('AUTH LOGIN', [334]);
        await c.cmd(Buffer.from(opts.user).toString('base64'), [334]);
        await c.cmd(Buffer.from(opts.pass ?? '').toString('base64'), [235]);
      }
    }
    await c.cmd(`MAIL FROM:<${addrOf(msg.from)}>`, [250]);
    await c.cmd(`RCPT TO:<${addrOf(msg.to)}>`, [250, 251]);
    await c.cmd('DATA', [354]);
    const domain = addrOf(msg.from).split('@')[1] || 'localhost';
    const data = buildMime(msg, domain).replace(/^\./gm, '..');
    await c.cmd(data + '\r\n.', [250]);
    await c.cmd('QUIT', [221]).catch(() => {});
    c.sock.end();
  };
  await Promise.race([run(), errored]);
}
