import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetLimits, Client, devOutbox, limits } from './helpers.ts';

before(startServer);
after(stopServer);
beforeEach(resetLimits);

test('registration validates input', async () => {
  const c = new Client();
  const cases: Array<[any, string]> = [
    [{ email: 'bad', username: 'okname', password: 'long enough pw' }, 'validation_error'],
    [{ email: 'x@y.io', username: 'Bad Name!', password: 'long enough pw' }, 'validation_error'],
    [{ email: 'x@y.io', username: 'okname', password: 'short' }, 'validation_error'],
    [{ email: 'x@y.io', username: 'okname', password: 'password1' }, 'bad_request'],
  ];
  for (const [body, code] of cases) {
    const r = await c.post('/api/auth/register', body);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error.code, code);
  }
});

test('register, duplicate checks, me, logout', async () => {
  const c = new Client();
  const r = await c.post('/api/auth/register', { email: 'Alice@Example.test', username: 'Alice', password: 'a-solid-passphrase', display_name: 'Alice A.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, 'alice', 'usernames are normalized to lowercase');
  assert.equal(r.body.user.email_verified, false);
  assert.ok(!('password_hash' in r.body.user));
  assert.match(r.headers.get('set-cookie') || '', /HttpOnly/);

  const dupUser = await new Client().post('/api/auth/register', { email: 'other@example.test', username: 'ALICE', password: 'a-solid-passphrase' });
  assert.equal(dupUser.status, 409); assert.equal(dupUser.body.error.code, 'username_taken');
  const dupEmail = await new Client().post('/api/auth/register', { email: 'alice@example.test', username: 'alice2', password: 'a-solid-passphrase' });
  assert.equal(dupEmail.status, 409); assert.equal(dupEmail.body.error.code, 'email_taken');

  assert.equal((await c.get('/api/auth/me')).body.user.display_name, 'Alice A.');
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('login works with email or username and gives a generic error', async () => {
  await new Client().register('bob', 'bobs-secret-pass');
  const a = new Client();
  assert.equal((await a.post('/api/auth/login', { login: 'BOB', password: 'bobs-secret-pass' })).status, 200);
  const b = new Client();
  assert.equal((await b.post('/api/auth/login', { login: 'bob@example.test', password: 'bobs-secret-pass' })).status, 200);
  const wrong = await new Client().post('/api/auth/login', { login: 'bob', password: 'nope-nope-nope' });
  const missing = await new Client().post('/api/auth/login', { login: 'nobody', password: 'nope-nope-nope' });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(wrong.body.error.message, missing.body.error.message, 'no account enumeration');
});

test('login is rate limited', async () => {
  await new Client().register('carol');
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await new Client().post('/api/auth/login', { login: 'carol', password: 'wrong-password' })).status;
  assert.equal(last, 429);
  limits.auth.reset();
});

test('email verification via emailed token', async () => {
  const c = await new Client().register('dave');
  const mail = devOutbox.find((m) => m.to === 'dave@example.test');
  assert.ok(mail, 'verification email captured');
  const token = new URL(mail!.text.match(/https?:\S+/)![0]).searchParams.get('token')!;
  const r = await c.post('/api/auth/verify-email', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email_verified, true);
  assert.equal((await c.post('/api/auth/verify-email', { token })).status, 400, 'tokens are single-use');
  assert.equal((await c.post('/api/auth/verify-email', { token: 'x'.repeat(40) })).status, 400);
});

test('password reset flow revokes existing sessions', async () => {
  const c = await new Client().register('erin', 'erins-old-password');
  const other = new Client();
  await other.post('/api/auth/login', { login: 'erin', password: 'erins-old-password' });
  // Unknown email gets the same response.
  assert.equal((await new Client().post('/api/auth/forgot-password', { email: 'ghost@example.test' })).status, 200);
  assert.equal((await new Client().post('/api/auth/forgot-password', { email: 'erin@example.test' })).status, 200);
  const mail = devOutbox.find((m) => m.to === 'erin@example.test' && /Reset/.test(m.subject))!;
  const token = new URL(mail.text.match(/https?:\S+/)![0]).searchParams.get('token')!;
  assert.equal((await new Client().post('/api/auth/reset-password', { token, password: 'erins-new-password' })).status, 200);
  assert.equal((await c.get('/api/auth/me')).status, 401, 'old session revoked');
  assert.equal((await other.get('/api/auth/me')).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { login: 'erin', password: 'erins-old-password' })).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { login: 'erin', password: 'erins-new-password' })).status, 200);
  assert.equal((await new Client().post('/api/auth/reset-password', { token, password: 'another-password' })).status, 400);
});

test('account changes require the current password; sessions can be managed', async () => {
  const c = await new Client().register('frank', 'franks-password');
  const second = new Client();
  await second.post('/api/auth/login', { login: 'frank', password: 'franks-password' });
  assert.equal((await c.patch('/api/users/@me/account', { current_password: 'wrong', username: 'franky' })).status, 401);
  const ok = await c.patch('/api/users/@me/account', { current_password: 'franks-password', username: 'franky' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.username, 'franky');
  const sessions = await c.get('/api/auth/sessions');
  assert.equal(sessions.body.length, 2);
  assert.equal(sessions.body.filter((s: any) => s.current).length, 1);
  await c.post('/api/auth/logout-others');
  assert.equal((await second.get('/api/auth/me')).status, 401);
  assert.equal((await c.get('/api/auth/me')).status, 200);
});

test('profile and settings updates are validated', async () => {
  const c = await new Client().register('gina');
  const r = await c.patch('/api/users/@me', { bio: 'hi', custom_status: 'Building things', status: 'dnd', settings: { theme: 'midnight', notifications: { desktop: false } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.status, 'dnd');
  assert.equal(r.body.user.settings.theme, 'midnight');
  const merged = await c.patch('/api/users/@me', { settings: { font_scale: 18 } });
  assert.equal(merged.body.user.settings.theme, 'midnight', 'settings merge');
  assert.equal(merged.body.user.settings.notifications.desktop, false);
  assert.equal((await c.patch('/api/users/@me', { settings: { theme: 'neon' } })).status, 400);
  assert.equal((await c.patch('/api/users/@me', { is_staff: true })).status, 400, 'unknown fields rejected');
});

test('avatar upload accepts images only and is served back', async () => {
  const c = await new Client().register('hank');
  // 1x1 PNG
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  const up = await c.req('PUT', '/api/users/@me/avatar', new Uint8Array(png), { 'content-type': 'image/png' });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const url = up.body.user.avatar_url;
  assert.match(url, /^\/api\/media\/avatars\//);
  const img = await new Client().get(url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const html = await c.req('PUT', '/api/users/@me/avatar', new Uint8Array(Buffer.from('<html><script>alert(1)</script></html>')), { 'content-type': 'image/png' });
  assert.equal(html.status, 415, 'content is sniffed, not trusted');
});

test('unauthenticated access is rejected and cross-site writes blocked', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/api/users/search?q=a')).status, 401);
  const c = await new Client().register('ivan');
  const r = await c.req('POST', '/api/servers', { name: 'x server' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'bad_origin');
});
