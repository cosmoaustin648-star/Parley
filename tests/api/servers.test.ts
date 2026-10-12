import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetLimits, Client, serverFixture } from './helpers.ts';
import { P } from '../../shared/permissions.ts';

before(startServer);
after(stopServer);
beforeEach(resetLimits);

test('new server has default roles, channels and owner permissions', async () => {
  const { server, owner } = await serverFixture('olga');
  assert.deepEqual(server.roles.map((r: any) => r.name).sort(), ['@everyone', 'Admin', 'Moderator']);
  assert.ok(server.channels.some((c: any) => c.name === 'general' && c.type === 'text'));
  assert.ok(server.channels.some((c: any) => c.type === 'voice'));
  assert.equal(server.owner_id, owner.user.id);
  assert.ok(server.my_permissions & P.ADMINISTRATOR);
});

test('non-members cannot see a server or its channels (404, not 403)', async () => {
  const { server, general } = await serverFixture('pat');
  const stranger = await new Client().register('stranger1');
  assert.equal((await stranger.get(`/api/servers/${server.id}`)).status, 404);
  assert.equal((await stranger.get(`/api/channels/${general.id}/messages`)).status, 404);
  assert.equal((await stranger.post(`/api/channels/${general.id}/messages`, { content: 'hi' })).status, 404);
  assert.equal((await stranger.get(`/api/servers/${server.id}/members`)).status, 404);
});

test('invites: preview, accept, max uses, revoke, expiry', async () => {
  const { owner, server } = await serverFixture('quinn');
  const inv = await owner.post(`/api/servers/${server.id}/invites`, { max_uses: 1 });
  assert.equal(inv.status, 200);
  const preview = await new Client().get(`/api/invites/${inv.body.code}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.server.name, server.name);
  const a = await new Client().register('ivy1');
  assert.equal((await a.post(`/api/invites/${inv.body.code}/accept`)).status, 200);
  const b = await new Client().register('ivy2');
  assert.equal((await b.post(`/api/invites/${inv.body.code}/accept`)).status, 404, 'max uses reached');

  const inv2 = await owner.post(`/api/servers/${server.id}/invites`, {});
  assert.equal((await a.del(`/api/invites/${inv2.body.code}`)).status, 403, 'members cannot revoke other people\'s invites');
  assert.equal((await owner.del(`/api/invites/${inv2.body.code}`)).status, 200);
  assert.equal((await b.post(`/api/invites/${inv2.body.code}/accept`)).status, 404, 'revoked');
});

test('members without permission are blocked by the backend', async () => {
  const { server, general, join } = await serverFixture('rita');
  const m = await join('member1');
  const attempts: Array<[string, string, any]> = [
    ['POST', `/api/servers/${server.id}/channels`, { name: 'hack', type: 'text' }],
    ['PATCH', `/api/channels/${general.id}`, { name: 'renamed' }],
    ['DELETE', `/api/channels/${general.id}`, undefined],
    ['PATCH', `/api/servers/${server.id}`, { name: 'Taken over' }],
    ['POST', `/api/servers/${server.id}/roles`, { name: 'mine', permissions: P.ADMINISTRATOR }],
    ['GET', `/api/servers/${server.id}/audit-log`, undefined],
    ['GET', `/api/servers/${server.id}/bans`, undefined],
    ['POST', `/api/servers/${server.id}/members/${server.owner_id}/kick`, {}],
    ['DELETE', `/api/servers/${server.id}`, undefined],
    ['PUT', `/api/channels/${general.id}/overwrites/member/${m.user.id}`, { allow: P.MANAGE_MESSAGES, deny: 0 }],
  ];
  for (const [method, url, body] of attempts) {
    const r = await m.req(method, url, body);
    assert.equal(r.status, 403, `${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
  }
});

test('role hierarchy: moderators cannot act on admins or grant what they lack', async () => {
  const { owner, server, roles, join } = await serverFixture('sam');
  const mod = await join('mod1');
  const admin = await join('admin1');
  const pleb = await join('pleb1');
  assert.equal((await owner.patch(`/api/servers/${server.id}/members/${mod.user.id}`, { role_ids: [roles.Moderator.id] })).status, 200);
  assert.equal((await owner.patch(`/api/servers/${server.id}/members/${admin.user.id}`, { role_ids: [roles.Admin.id] })).status, 200);

  assert.equal((await mod.post(`/api/servers/${server.id}/members/${admin.user.id}/kick`, {})).status, 403);
  assert.equal((await admin.post(`/api/servers/${server.id}/members/${server.owner_id}/kick`, {})).status, 403, 'owner is untouchable');
  // Moderator lacks MANAGE_ROLES entirely.
  assert.equal((await mod.patch(`/api/servers/${server.id}/members/${pleb.user.id}`, { role_ids: [roles.Moderator.id] })).status, 403);
  // Admin can't promote someone to their own top role.
  assert.equal((await admin.patch(`/api/servers/${server.id}/members/${pleb.user.id}`, { role_ids: [roles.Admin.id] })).status, 403);
  assert.equal((await admin.patch(`/api/servers/${server.id}/members/${pleb.user.id}`, { role_ids: [roles.Moderator.id] })).status, 200);
  // Moderator can kick a regular member.
  const pleb2 = await join('pleb2');
  assert.equal((await mod.post(`/api/servers/${server.id}/members/${pleb2.user.id}/kick`, { reason: 'test kick' })).status, 200);
  assert.equal((await pleb2.get(`/api/servers/${server.id}`)).status, 404);

  // A role manager without ADMINISTRATOR can't grant permissions they don't have.
  const mgrRole = await owner.post(`/api/servers/${server.id}/roles`, { name: 'Role Manager', permissions: P.MANAGE_ROLES });
  const mgr = await join('mgr1');
  await owner.patch(`/api/servers/${server.id}/members/${mgr.user.id}`, { role_ids: [mgrRole.body.id] });
  const sneaky = await mgr.post(`/api/servers/${server.id}/roles`, { name: 'sneaky', permissions: P.BAN_MEMBERS });
  assert.equal(sneaky.status, 403);
});

test('private channels and overwrites control visibility', async () => {
  const { owner, server, roles, join } = await serverFixture('tina');
  const m = await join('viewer1');
  const priv = await owner.post(`/api/servers/${server.id}/channels`, { name: 'Staff Only', type: 'text', private: true });
  assert.equal(priv.status, 200);
  assert.equal(priv.body.name, 'staff-only', 'text channel names are slugified');
  await owner.post(`/api/channels/${priv.body.id}/messages`, { content: 'secret plans' });

  const payload = await m.get(`/api/servers/${server.id}`);
  assert.ok(!payload.body.channels.some((c: any) => c.id === priv.body.id), 'hidden from channel list');
  assert.equal((await m.get(`/api/channels/${priv.body.id}/messages`)).status, 404);
  const search = await m.get(`/api/search/messages?server_id=${server.id}&q=secret`);
  assert.equal(search.body.total, 0, 'search respects channel permissions');

  // Grant the Moderator role view access via overwrite, then give the member that role.
  assert.equal((await owner.put(`/api/channels/${priv.body.id}/overwrites/role/${roles.Moderator.id}`, { allow: P.VIEW_CHANNEL, deny: 0 })).status, 200);
  await owner.patch(`/api/servers/${server.id}/members/${m.user.id}`, { role_ids: [roles.Moderator.id] });
  assert.equal((await m.get(`/api/channels/${priv.body.id}/messages`)).status, 200);
  assert.equal((await m.get(`/api/search/messages?server_id=${server.id}&q=secret`)).body.total, 1);

  // Read-only announcements: deny SEND for @everyone.
  const ann = await owner.post(`/api/servers/${server.id}/channels`, { name: 'announcements', type: 'text' });
  await owner.put(`/api/channels/${ann.body.id}/overwrites/role/${roles['@everyone'].id}`, { allow: 0, deny: P.SEND_MESSAGES });
  const viewer2 = await join('viewer2');
  assert.equal((await viewer2.get(`/api/channels/${ann.body.id}/messages`)).status, 200);
  assert.equal((await viewer2.post(`/api/channels/${ann.body.id}/messages`, { content: 'hi' })).status, 403);
});

test('timeouts stop a member from sending until removed', async () => {
  const { owner, server, general, join } = await serverFixture('uma');
  const m = await join('loud1');
  assert.equal((await owner.put(`/api/servers/${server.id}/members/${m.user.id}/timeout`, { duration_seconds: 600, reason: 'spam' })).status, 200);
  assert.equal((await m.post(`/api/channels/${general.id}/messages`, { content: 'still here' })).status, 403);
  assert.equal((await m.get(`/api/channels/${general.id}/messages`)).status, 200, 'can still read');
  assert.equal((await owner.del(`/api/servers/${server.id}/members/${m.user.id}/timeout`)).status, 200);
  assert.equal((await m.post(`/api/channels/${general.id}/messages`, { content: 'back' })).status, 200);
});

test('bans remove the member and block rejoining; audit log records actors', async () => {
  const { owner, server, join } = await serverFixture('vic');
  const m = await join('banned1');
  assert.equal((await owner.put(`/api/servers/${server.id}/bans/${m.user.id}`, { reason: 'rule 1' })).status, 200);
  assert.equal((await m.get(`/api/servers/${server.id}`)).status, 404);
  const inv = await owner.post(`/api/servers/${server.id}/invites`, {});
  const rejoin = await m.post(`/api/invites/${inv.body.code}/accept`);
  assert.equal(rejoin.status, 403);
  const bans = await owner.get(`/api/servers/${server.id}/bans`);
  assert.equal(bans.body[0].user.id, m.user.id);
  assert.equal(bans.body[0].reason, 'rule 1');
  assert.equal((await owner.del(`/api/servers/${server.id}/bans/${m.user.id}`)).status, 200);
  assert.equal((await m.post(`/api/invites/${inv.body.code}/accept`)).status, 200);

  const log = await owner.get(`/api/servers/${server.id}/audit-log`);
  const actions = log.body.map((e: any) => e.action);
  assert.ok(actions.includes('member_ban') && actions.includes('member_unban'));
  const ban = log.body.find((e: any) => e.action === 'member_ban');
  assert.equal(ban.actor.id, owner.user.id);
  assert.equal(ban.reason, 'rule 1');
  assert.ok(ban.created_at);
});

test('ownership transfer and leaving', async () => {
  const { owner, server, join } = await serverFixture('wes');
  const m = await join('heir1');
  assert.equal((await owner.post(`/api/servers/${server.id}/leave`)).status, 400, 'owner must transfer first');
  assert.equal((await owner.post(`/api/servers/${server.id}/transfer`, { user_id: m.user.id, password: 'wrong' })).status, 401);
  assert.equal((await owner.post(`/api/servers/${server.id}/transfer`, { user_id: m.user.id, password: 'a-solid-passphrase' })).status, 200);
  assert.equal((await owner.post(`/api/servers/${server.id}/leave`)).status, 200);
  assert.equal((await m.del(`/api/servers/${server.id}`)).status, 200);
  assert.equal((await m.get(`/api/servers/${server.id}`)).status, 404);
});

test('public servers appear in discovery and can be joined directly', async () => {
  const owner = await new Client().register('xena');
  const pub = await owner.post('/api/servers', { name: 'Open Garden', is_public: true });
  await owner.post('/api/servers', { name: 'Hidden Garden' });
  const other = await new Client().register('yuri');
  const found = await other.get('/api/discover?q=garden');
  assert.deepEqual(found.body.map((s: any) => s.name), ['Open Garden']);
  assert.equal((await other.post(`/api/servers/${pub.body.id}/join`)).status, 200);
});

test('role reorder respects hierarchy', async () => {
  const { owner, server, roles, join } = await serverFixture('zed');
  const r1 = (await owner.post(`/api/servers/${server.id}/roles`, { name: 'Helper' })).body;
  const all = (await owner.get(`/api/servers/${server.id}/roles`)).body.filter((r: any) => !r.is_default);
  const order = all.map((r: any) => r.id);
  // Move Helper to the top as owner.
  const reordered = await owner.put(`/api/servers/${server.id}/roles-order`, { role_ids: [r1.id, ...order.filter((id: string) => id !== r1.id)] });
  assert.equal(reordered.status, 200);
  assert.equal(reordered.body[0].name, 'Helper');
  const mgr = await join('mgr2');
  await owner.patch(`/api/servers/${server.id}/members/${mgr.user.id}`, { role_ids: [roles.Admin.id] });
  const cur = (await owner.get(`/api/servers/${server.id}/roles`)).body.filter((r: any) => !r.is_default).map((r: any) => r.id);
  // Admin (position below Helper now) tries to move Admin above Helper.
  const adminIdx = cur.indexOf(roles.Admin.id);
  const swapped = [...cur]; [swapped[0], swapped[adminIdx]] = [swapped[adminIdx], swapped[0]];
  assert.equal((await mgr.put(`/api/servers/${server.id}/roles-order`, { role_ids: swapped })).status, 403);
});
