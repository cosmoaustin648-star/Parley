import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendSmtp } from '../../server/mail/smtp.ts';

/** A tiny fake SMTP server that records the conversation. */
function fakeSmtp(opts: { auth: 'PLAIN' | 'LOGIN' }) {
  const log: string[] = [];
  let data = '';
  const server = net.createServer((sock) => {
    let inData = false;
    let buf = '';
    const say = (s: string) => sock.write(s + '\r\n');
    say('220 fake.smtp ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; say('250 queued'); } else data += line + '\n';
          continue;
        }
        log.push(line);
        if (line.startsWith('EHLO')) { sock.write(`250-fake.smtp\r\n250-AUTH ${opts.auth}\r\n250 SIZE 1000000\r\n`); }
        else if (line.startsWith('AUTH PLAIN')) say(Buffer.from(line.slice(11), 'base64').toString() === '\0me\0secret' ? '235 ok' : '535 bad');
        else if (line === 'AUTH LOGIN') say('334 VXNlcm5hbWU6');
        else if (line === Buffer.from('me').toString('base64')) say('334 UGFzc3dvcmQ6');
        else if (line === Buffer.from('secret').toString('base64')) say('235 ok');
        else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) say('250 ok');
        else if (line === 'DATA') { inData = true; say('354 go ahead'); }
        else if (line === 'QUIT') { say('221 bye'); sock.end(); }
        else say('500 unknown');
      }
    });
  });
  return { server, log, getData: () => data };
}

for (const auth of ['PLAIN', 'LOGIN'] as const) {
  test(`SMTP client delivers with AUTH ${auth}`, async () => {
    const f = fakeSmtp({ auth });
    await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r));
    const port = (f.server.address() as net.AddressInfo).port;
    await sendSmtp({ host: '127.0.0.1', port, secure: false, user: 'me', pass: 'secret' }, {
      from: 'Parley <no-reply@parley.test>', to: 'someone@example.test', subject: 'Résumé check', text: 'Hello there', html: '<p>Hello there</p>',
    });
    f.server.close();
    assert.ok(f.log.includes('MAIL FROM:<no-reply@parley.test>'));
    assert.ok(f.log.includes('RCPT TO:<someone@example.test>'));
    const data = f.getData();
    assert.match(data, /Subject: =\?UTF-8\?B\?/, 'non-ASCII subjects are encoded');
    assert.match(data, /multipart\/alternative/);
    assert.match(data, new RegExp(Buffer.from('Hello there').toString('base64')));
  });
}

test('SMTP client surfaces server rejections', async () => {
  const f = fakeSmtp({ auth: 'PLAIN' });
  await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r));
  const port = (f.server.address() as net.AddressInfo).port;
  await assert.rejects(
    sendSmtp({ host: '127.0.0.1', port, secure: false, user: 'me', pass: 'wrong' }, { from: 'a@b.c', to: 'c@d.e', subject: 's', text: 't' }),
    /AUTH failed/,
  );
  f.server.close();
});
