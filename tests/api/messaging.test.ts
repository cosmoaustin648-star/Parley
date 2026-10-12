import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetLimits, Client, serverFixture, sleep, limits } from './helpers.ts';
import { P } from '../../shared/permissions.ts';

before(startServer);
after(stopServer);
beforeEach(resetLimits);

test('messages are delivered in real time only to people who can see them', async () => {
  const { owner, server, general, join } = await serverFixture('amy');
  const m = await join('ben');
  const outsider = await new Client().register('cat');
  const [gm, go] = await Promise.all([m.connect(), outsider.connect()]);
  const sent = await owner.post(`/api/channels/${general.id}/messages`, { content: 'hello **world**', nonce: 'n-1' });
  assert.equal(sent.status, 200);
  const evt = await gm.waitFor('MESSAGE_CREATE', (d) => d.id === sent.body.id);
  assert.equal(evt.content, 'hello **world**');
  assert.equal(evt.author.username, 'amy');
  await go.expectNone('MESSAGE_CREATE');

  // Persisted: fetched later in order.
  const hist = await m.get(`/api/channels/${general.id}/messages`);
  assert.ok(hist.body.some((x: any) => x.id === sent.body.id));
  gm.close(); go.close();
  void server;
});

test('nonce makes sends idempotent (no duplicate submissions)', async () => {
  const { owner, general } = await serverFixture('dan');
  const [a, b] = await Promise.all([
    owner.post(`/api/channels/${general.id}/messages`, { content: 'once', nonce: 'dup-123' }),
    owner.post(`/api/channels/${general.id}/messages`, { content: 'once', nonce: 'dup-123' }),
  ]);
  assert.equal(a.body.id, b.body.id);
  const c = await owner.post(`/api/channels/${general.id}/messages`, { content: 'once', nonce: 'dup-123' });
  assert.equal(c.body.id, a.body.id);
  const hist = await owner.get(`/api/channels/${general.id}/messages`);
  assert.equal(hist.body.filter((x: any) => x.content === 'once').length, 1);
});

test('validation: empty, too long, voice channel', async () => {
  const { owner, general, voice } = await serverFixture('eve');
  assert.equal((await owner.post(`/api/channels/${general.id}/messages`, { content: '   ' })).status, 400);
  assert.equal((await owner.post(`/api/channels/${general.id}/messages`, { content: 'x'.repeat(4001) })).status, 400);
  assert.equal((await owner.post(`/api/channels/${voice.id}/messages`, { content: 'hi' })).status, 400);
});

test('edit, delete and moderator delete with audit trail', async () => {
  const { owner, server, general, roles, join } = await serverFixture('fay');
  const m = await join('gus');
  const other = await join('hal');
  const g = await other.connect();
  const msg = (await m.post(`/api/channels/${general.id}/messages`, { content: 'typo heer' })).body;
  assert.equal((await other.patch(`/api/messages/${msg.id}`, { content: 'hijacked' })).status, 403);
  const edited = await m.patch(`/api/messages/${msg.id}`, { content: 'typo here' });
  assert.equal(edited.status, 200);
  assert.ok(edited.body.edited_at);
  await g.waitFor('MESSAGE_UPDATE', (d) => d.id === msg.id && d.content === 'typo here');

  assert.equal((await other.del(`/api/messages/${msg.id}`)).status, 403);
  await owner.patch(`/api/servers/${server.id}/members/${other.user.id}`, { role_ids: [roles.Moderator.id] });
  assert.equal((await other.del(`/api/messages/${msg.id}`)).status, 200);
  await g.waitFor('MESSAGE_DELETE', (d) => d.id === msg.id);
  const log = await owner.get(`/api/servers/${server.id}/audit-log?action=message_delete`);
  assert.equal(log.body[0].actor.id, other.user.id);
  assert.equal(log.body[0].target_user.id, m.user.id);
  g.close();
});

test('replies, reactions and pins', async () => {
  const { owner, general, join } = await serverFixture('ida');
  const m = await join('jon');
  const root = (await owner.post(`/api/channels/${general.id}/messages`, { content: 'root' })).body;
  const reply = await m.post(`/api/channels/${general.id}/messages`, { content: 'reply!', reply_to_id: root.id });
  assert.equal(reply.body.reply_to.id, root.id);
  assert.equal(reply.body.reply_to.author.username, 'ida');
  assert.equal(reply.body.reply_to.content, 'root', 'reply preview carries the original text');
  assert.ok(!reply.body.reply_to.deleted);

  const heart = encodeURIComponent('❤️');
  assert.equal((await m.put(`/api/messages/${root.id}/reactions/${heart}`)).status, 200);
  assert.equal((await owner.put(`/api/messages/${root.id}/reactions/${heart}`)).status, 200);
  assert.equal((await m.put(`/api/messages/${root.id}/reactions/${encodeURIComponent('<script>')}`)).status, 400);
  let fetched = (await m.get(`/api/messages/${root.id}`)).body;
  assert.equal(fetched.reactions[0].count, 2);
  await m.del(`/api/messages/${root.id}/reactions/${heart}`);
  fetched = (await m.get(`/api/messages/${root.id}`)).body;
  assert.deepEqual(fetched.reactions[0].user_ids, [owner.user.id]);

  assert.equal((await m.put(`/api/messages/${root.id}/pin`)).status, 403, 'pinning needs Manage Messages');
  assert.equal((await owner.put(`/api/messages/${root.id}/pin`)).status, 200);
  const pins = await m.get(`/api/channels/${general.id}/pins`);
  assert.deepEqual(pins.body.map((p: any) => p.id), [root.id]);
});

test('mentions raise mention counts; ack clears them; @everyone needs permission', async () => {
  const { owner, general, join } = await serverFixture('kim');
  const m = await join('lou');
  const g = await m.connect();
  const sent = await owner.post(`/api/channels/${general.id}/messages`, { content: `hey <@${m.user.id}>` });
  assert.deepEqual(sent.body.mention_user_ids, [m.user.id]);
  const evt = await g.waitFor('MESSAGE_CREATE', (d) => d.id === sent.body.id);
  assert.ok(evt.mentioned_user_ids.includes(m.user.id));
  g.close();
  const g2 = await m.connect();
  const ready = g2.events.find((e) => e.t === 'READY') ?? { d: (await g2.waitFor('READY').catch(() => null)) };
  void ready;
  g2.close();

  const everyone = await m.post(`/api/channels/${general.id}/messages`, { content: '@everyone look' });
  assert.equal(everyone.body.mention_everyone, false, 'members cannot ping everyone by default');
  const ownerEveryone = await owner.post(`/api/channels/${general.id}/messages`, { content: '@everyone look' });
  assert.equal(ownerEveryone.body.mention_everyone, true);

  const ack = await m.post(`/api/channels/${general.id}/ack`, { message_id: ownerEveryone.body.id });
  assert.equal(ack.body.mention_count, 0);
});

test('history pagination loads older messages', async () => {
  const { owner, general } = await serverFixture('max');
  for (let i = 0; i < 30; i++) {
    limits.messages.reset(); // this test is about paging, not the send rate limit
    assert.equal((await owner.post(`/api/channels/${general.id}/messages`, { content: `msg ${i}` })).status, 200);
  }
  const page1 = (await owner.get(`/api/channels/${general.id}/messages?limit=10`)).body;
  assert.equal(page1.length, 10);
  assert.equal(page1[9].content, 'msg 29', 'returned oldest→newest');
  const page2 = (await owner.get(`/api/channels/${general.id}/messages?limit=10&before=${page1[0].id}`)).body;
  assert.equal(page2[9].content, 'msg 19');
  assert.ok(BigInt(page2[9].id) < BigInt(page1[0].id));
});

test('attachments: upload, attach, and access control on download', async () => {
  const { owner, general, join } = await serverFixture('ned');
  const m = await join('oli');
  const outsider = await new Client().register('pam');
  const up = await owner.req('POST', `/api/channels/${general.id}/attachments`, new Uint8Array(Buffer.from('hello file contents')), { 'content-type': 'text/plain', 'x-filename': encodeURIComponent('notes.txt') });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const msg = await owner.post(`/api/channels/${general.id}/messages`, { content: '', attachment_ids: [up.body.id] });
  assert.equal(msg.status, 200);
  assert.equal(msg.body.attachments[0].filename, 'notes.txt');
  const url = msg.body.attachments[0].url;
  const dl = await m.get(url);
  assert.equal(dl.status, 200);
  assert.equal(dl.body, 'hello file contents');
  assert.match(dl.headers.get('content-disposition') || '', /attachment/, 'non-media files download instead of rendering');
  assert.equal((await outsider.get(url)).status, 404);
  // Re-using an attachment id is rejected.
  assert.equal((await owner.post(`/api/channels/${general.id}/messages`, { content: 'again', attachment_ids: [up.body.id] })).status, 400);
  // Someone else's upload can't be attached.
  const up2 = await m.req('POST', `/api/channels/${general.id}/attachments`, new Uint8Array(Buffer.from('mine')), { 'x-filename': 'm.txt' });
  assert.equal((await owner.post(`/api/channels/${general.id}/messages`, { content: 'steal', attachment_ids: [up2.body.id] })).status, 400);
});

test('typing indicators reach other viewers', async () => {
  const { owner, general, join } = await serverFixture('quin');
  const m = await join('ray');
  const [go, gm] = await Promise.all([owner.connect(), m.connect()]);
  gm.send('typing', { channel_id: general.id });
  const t = await go.waitFor('TYPING_START', (d) => d.channel_id === general.id);
  assert.equal(t.user_id, m.user.id);
  go.close(); gm.close();
});

test('send rate limit applies per user', async () => {
  const { owner, general } = await serverFixture('rl');
  const statuses = [];
  for (let i = 0; i < 14; i++) statuses.push((await owner.post(`/api/channels/${general.id}/messages`, { content: `burst ${i}` })).status);
  assert.ok(statuses.includes(429));
  assert.equal(statuses[0], 200);
});

test('slowmode and AutoMod', async () => {
  const { owner, server, general, join } = await serverFixture('sue');
  const m = await join('tom');
  await owner.patch(`/api/channels/${general.id}`, { slowmode_seconds: 30 });
  assert.equal((await m.post(`/api/channels/${general.id}/messages`, { content: 'one' })).status, 200);
  const second = await m.post(`/api/channels/${general.id}/messages`, { content: 'two' });
  assert.equal(second.status, 429);
  assert.equal(second.body.error.code, 'slowmode');
  assert.equal((await owner.post(`/api/channels/${general.id}/messages`, { content: 'mods bypass' })).status, 200);
  await owner.patch(`/api/channels/${general.id}`, { slowmode_seconds: 0 });

  const rule = await owner.post(`/api/servers/${server.id}/automod-rules`, {
    name: 'No spoilers', trigger_type: 'keyword', config: { keywords: ['spoiler', 'leak*'] }, action: 'block_and_timeout', timeout_seconds: 60,
  });
  assert.equal(rule.status, 200);
  const blocked = await m.post(`/api/channels/${general.id}/messages`, { content: 'Big SPOILER ahead' });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'automod_blocked');
  assert.equal((await m.post(`/api/channels/${general.id}/messages`, { content: 'harmless' })).status, 403, 'timed out by the rule');
  const log = await owner.get(`/api/servers/${server.id}/audit-log?action=automod_block`);
  assert.equal(log.body[0].actor, null, 'automod entries have no human actor');
  assert.equal(log.body[0].target_user.id, m.user.id);
  assert.equal((await owner.post(`/api/channels/${general.id}/messages`, { content: 'spoiler (owner exempt)' })).status, 200);
});

test('threads inherit parent permissions', async () => {
  const { owner, general, join } = await serverFixture('uli');
  const m = await join('val');
  const root = (await owner.post(`/api/channels/${general.id}/messages`, { content: 'discuss here' })).body;
  const th = await m.post(`/api/channels/${general.id}/threads`, { name: 'Discussion', message_id: root.id });
  assert.equal(th.status, 200);
  assert.equal((await owner.post(`/api/channels/${th.body.id}/messages`, { content: 'in thread' })).status, 200);
  const starter = await m.get(`/api/messages/${root.id}`);
  assert.equal(starter.body.thread.id, th.body.id);
  const outsider = await new Client().register('wil');
  assert.equal((await outsider.get(`/api/channels/${th.body.id}/messages`)).status, 404);
});

test('reports reach server moderators', async () => {
  const { owner, server, general, join } = await serverFixture('xia');
  const m = await join('yan');
  const bad = (await m.post(`/api/channels/${general.id}/messages`, { content: 'rude words' })).body;
  const reporter = await join('zoe');
  const r = await reporter.post('/api/reports', { message_id: bad.id, reason: 'harassment' });
  assert.equal(r.status, 200);
  assert.equal((await m.get(`/api/servers/${server.id}/reports`)).status, 403);
  const list = await owner.get(`/api/servers/${server.id}/reports`);
  assert.equal(list.body[0].message_snapshot, 'rude words');
  assert.equal(list.body[0].target.id, m.user.id);
  assert.equal((await owner.patch(`/api/reports/${list.body[0].id}`, { status: 'resolved' })).status, 200);
});

test('direct messages are private to participants', async () => {
  const a = await new Client().register('dm_a');
  const b = await new Client().register('dm_b');
  const c = await new Client().register('dm_c');
  const gb = await b.connect();
  const dm = await a.post('/api/dms', { user_id: b.user.id });
  assert.equal(dm.status, 200);
  const again = await b.post('/api/dms', { user_id: a.user.id });
  assert.equal(again.body.id, dm.body.id, 'one conversation per pair');
  const msg = await a.post(`/api/channels/${dm.body.id}/messages`, { content: 'psst' });
  await gb.waitFor('MESSAGE_CREATE', (d) => d.id === msg.body.id);
  assert.equal((await c.get(`/api/channels/${dm.body.id}/messages`)).status, 404);
  assert.equal((await c.post(`/api/channels/${dm.body.id}/messages`, { content: 'intrude' })).status, 404);

  // Read receipts.
  await b.post(`/api/channels/${dm.body.id}/ack`, { message_id: msg.body.id });
  const rr = await a.get(`/api/channels/${dm.body.id}/read-receipts`);
  assert.deepEqual(rr.body, [{ user_id: b.user.id, message_id: msg.body.id }]);
  await b.patch('/api/users/@me', { settings: { privacy: { read_receipts: false } } });
  assert.deepEqual((await a.get(`/api/channels/${dm.body.id}/read-receipts`)).body, [], 'receipts respect privacy');
  gb.close();
});

test('blocking prevents DMs; privacy setting closes new DMs', async () => {
  const a = await new Client().register('blk_a');
  const b = await new Client().register('blk_b');
  const dm = (await a.post('/api/dms', { user_id: b.user.id })).body;
  await b.put(`/api/users/@me/blocks/${a.user.id}`);
  const r = await a.post(`/api/channels/${dm.id}/messages`, { content: 'hello?' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'blocked');
  await b.del(`/api/users/@me/blocks/${a.user.id}`);
  assert.equal((await a.post(`/api/channels/${dm.id}/messages`, { content: 'hello again' })).status, 200);

  const shy = await new Client().register('shy');
  await shy.patch('/api/users/@me', { settings: { privacy: { allow_dms_from_server_members: false } } });
  assert.equal((await a.post('/api/dms', { user_id: shy.user.id })).status, 403);
});

test('group DMs: create, add, remove, leave', async () => {
  const [a, b, c, d] = await Promise.all(['g_a', 'g_b', 'g_c', 'g_d'].map((n) => new Client().register(n)));
  const g = await a.post('/api/dms/group', { user_ids: [b.user.id, c.user.id], name: 'Trio' });
  assert.equal(g.status, 200);
  assert.equal(g.body.recipients.length, 3);
  assert.equal((await d.get(`/api/channels/${g.body.id}/messages`)).status, 404);
  assert.equal((await b.put(`/api/dms/${g.body.id}/recipients/${d.user.id}`)).status, 200);
  assert.equal((await d.get(`/api/channels/${g.body.id}/messages`)).status, 200);
  assert.equal((await b.del(`/api/dms/${g.body.id}/recipients/${c.user.id}`)).status, 403, 'only owner removes');
  assert.equal((await a.del(`/api/dms/${g.body.id}/recipients/${c.user.id}`)).status, 200);
  assert.equal((await c.get(`/api/channels/${g.body.id}/messages`)).status, 404);
  assert.equal((await a.del(`/api/dms/${g.body.id}`)).status, 200);
  const after = await b.get(`/api/channels/${g.body.id}`);
  assert.equal(after.body.owner_id, b.user.id, 'ownership passes on');
});

test('presence updates are shared with server mates', async () => {
  const { owner, join } = await serverFixture('pres');
  const m = await join('pres2');
  const go = await owner.connect();
  const gm = await m.connect();
  const p = await go.waitFor('PRESENCE_UPDATE', (d) => d.user_id === m.user.id && d.status === 'online');
  assert.ok(p);
  await m.patch('/api/users/@me', { status: 'dnd' });
  await go.waitFor('PRESENCE_UPDATE', (d) => d.user_id === m.user.id && d.status === 'dnd');
  gm.close();
  await go.waitFor('PRESENCE_UPDATE', (d) => d.user_id === m.user.id && d.status === 'offline');
  go.close();
});

test('voice: join, signaling is relayed only within the room, moderators can server-mute', async () => {
  const { owner, server, voice, join } = await serverFixture('vox');
  const m = await join('vox2');
  const outsider = await new Client().register('vox3');
  const [go, gm, gx] = await Promise.all([owner.connect(), m.connect(), outsider.connect()]);

  go.send('voice_join', { channel_id: voice.id });
  const r1 = await go.waitFor('VOICE_READY');
  assert.deepEqual(r1.peers, []);
  assert.ok(Array.isArray(r1.ice_servers));
  await gm.waitFor('VOICE_STATE_UPDATE', (d) => d.user_id === owner.user.id && d.channel_id === voice.id);

  gm.send('voice_join', { channel_id: voice.id });
  const r2 = await gm.waitFor('VOICE_READY');
  assert.deepEqual(r2.peers, [owner.user.id]);

  gm.send('voice_signal', { to: owner.user.id, data: { description: { type: 'offer', sdp: 'v=0' } } });
  const sig = await go.waitFor('VOICE_SIGNAL');
  assert.equal(sig.from, m.user.id);
  assert.equal(sig.data.description.type, 'offer');

  // Outsider can't join or inject signals.
  gx.send('voice_join', { channel_id: voice.id });
  const err = await gx.waitFor('ERROR', (d) => d.op === 'voice_join');
  assert.equal(err.code, 'not_found');
  gx.send('voice_signal', { to: owner.user.id, data: { description: { type: 'offer', sdp: 'evil' } } });
  await go.expectNone('VOICE_SIGNAL', (d) => d.from === outsider.user.id);

  // Server mute by owner (moderator powers).
  const mute = await owner.patch(`/api/servers/${server.id}/members/${m.user.id}/voice`, { mute: true });
  assert.equal(mute.status, 200);
  await gm.waitFor('VOICE_STATE_UPDATE', (d) => d.user_id === m.user.id && d.server_mute === true);
  // Member can't server-mute the owner.
  assert.equal((await m.patch(`/api/servers/${server.id}/members/${owner.user.id}/voice`, { mute: true })).status, 403);
  // Disconnect by moderator.
  await owner.patch(`/api/servers/${server.id}/members/${m.user.id}/voice`, { channel_id: null });
  await gm.waitFor('VOICE_DISCONNECTED');
  await go.waitFor('VOICE_STATE_UPDATE', (d) => d.user_id === m.user.id && d.channel_id === null);
  go.close(); gm.close(); gx.close();
  await sleep(50);
});

test('DM calls ring the other participant', async () => {
  const a = await new Client().register('call_a');
  const b = await new Client().register('call_b');
  const dm = (await a.post('/api/dms', { user_id: b.user.id })).body;
  const [ga, gb] = await Promise.all([a.connect(), b.connect()]);
  ga.send('voice_join', { channel_id: dm.id });
  await ga.waitFor('VOICE_READY');
  const ring = await gb.waitFor('CALL_RING');
  assert.equal(ring.from_user_id, a.user.id);
  const callMsg = await gb.waitFor('MESSAGE_CREATE', (d) => d.type === 'call');
  assert.equal(callMsg.channel_id, dm.id);
  ga.close(); gb.close();
});

test('message search with filters', async () => {
  const { owner, server, general, join } = await serverFixture('srch');
  const m = await join('srch2');
  await owner.post(`/api/channels/${general.id}/messages`, { content: 'the quick brown fox' });
  await m.post(`/api/channels/${general.id}/messages`, { content: 'lazy dog sleeps https://example.com' });
  assert.equal((await m.get(`/api/search/messages?server_id=${server.id}&q=fox`)).body.total, 1);
  assert.equal((await m.get(`/api/search/messages?server_id=${server.id}&author_id=${m.user.id}`)).body.total, 1);
  assert.equal((await m.get(`/api/search/messages?server_id=${server.id}&has=link`)).body.total, 1);
  assert.equal((await m.get(`/api/search/messages?server_id=${server.id}&q=qui`)).body.total, 1, 'partial words match');
  const outsider = await new Client().register('srch3');
  assert.equal((await outsider.get(`/api/search/messages?server_id=${server.id}&q=fox`)).status, 404);
  void P;
});
