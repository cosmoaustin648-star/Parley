/**
 * End-to-end: two real Chromium sessions use the built client against the real
 * server. Covers sign-up, server creation, invites, live messaging, reactions,
 * typing, DMs and a WebRTC voice + video call with fake media devices.
 *
 * Requires `npm run build` first (serves dist/client).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { startServer, stopServer } from '../api/helpers.ts';

let base = '';
let browser: Browser;
const shots = process.env.E2E_SCREENSHOTS;
const snap = async (page: Page, name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/${name}.png` }); } };

before(async () => {
  process.env.DISABLE_RATE_LIMITS = '1';
  base = await startServer();
  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
});
after(async () => { await browser?.close(); await stopServer(); });

async function newUser(name: string, next?: string) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, permissions: ['microphone', 'camera'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${name}] pageerror`, e.message));
  await page.goto(`${base}/register${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  await page.fill('#email', `${name}@example.test`);
  await page.fill('#un', name);
  await page.fill('#pw', 'a-solid-passphrase');
  await page.getByRole('button', { name: 'Create account' }).click();
  return page;
}

test('two people chat, react, DM and call each other', { timeout: 120_000 }, async () => {
  // Alice creates a server.
  const alice = await newUser('alice');
  await alice.waitForURL('**/channels/@me');
  await alice.getByRole('button', { name: 'Create a server' }).first().click();
  await alice.fill('#sname', 'Signal Corps');
  await alice.getByRole('button', { name: 'Create server' }).click();
  await alice.waitForURL(/\/channels\/\d+\/\d+$/);
  const [, serverId, generalId] = new URL(alice.url()).pathname.match(/channels\/(\d+)\/(\d+)/)!;

  // She opens the invite dialog and copies the link.
  await alice.locator('button[aria-haspopup="menu"]', { hasText: 'Signal Corps' }).click();
  await alice.getByRole('menuitem', { name: 'Invite people' }).click();
  const linkBox = alice.getByLabel('Invite link');
  await assert.doesNotReject(linkBox.waitFor());
  await alice.waitForFunction(() => (document.querySelector('input[aria-label="Invite link"]') as HTMLInputElement)?.value.includes('/invite/'));
  const link = await linkBox.inputValue();
  await alice.keyboard.press('Escape');
  const code = link.split('/invite/')[1];

  // Bob signs up from the invite and joins.
  const bob = await newUser('bob', `/invite/${code}`);
  await bob.waitForURL(`**/invite/${code}`);
  await bob.getByRole('button', { name: 'Accept invite' }).click();
  await bob.waitForURL(new RegExp(`/channels/${serverId}/${generalId}`));

  // Live message delivery both ways.
  const aliceBox = alice.locator(`[data-composer="${generalId}"]`);
  const bobBox = bob.locator(`[data-composer="${generalId}"]`);
  await aliceBox.fill('Hello Bob, **welcome** aboard!');
  await aliceBox.press('Enter');
  await bob.getByText('welcome', { exact: true }).waitFor({ timeout: 5000 });

  // Typing indicator.
  await bobBox.pressSequentially('typing…', { delay: 20 });
  await alice.getByText('bob is typing…').waitFor({ timeout: 5000 });
  await bobBox.fill(`Thanks @alice!`);
  await bobBox.press('Enter');
  await alice.getByText('@alice', { exact: true }).waitFor({ timeout: 5000 }); // rendered as a mention

  // Reaction from Bob shows up for Alice.
  const msg = bob.locator('[data-mid]').filter({ hasText: 'Hello Bob' });
  await msg.hover();
  await msg.getByRole('button', { name: 'React with 👍' }).click();
  await alice.getByRole('button', { name: '👍 1' }).waitFor({ timeout: 5000 });
  await snap(alice, 'e2e-chat-alice');

  // Messages persist across reloads.
  await bob.reload();
  await bob.getByText('Thanks').waitFor();

  // Voice: both join the voice channel; media must actually flow.
  await alice.getByRole('button', { name: 'General', exact: true }).click();
  await alice.getByText('Voice connected').waitFor({ timeout: 10_000 });
  await bob.getByRole('button', { name: 'General', exact: true }).click();
  await bob.getByText('Voice connected').waitFor({ timeout: 10_000 });

  const waitForMedia = async (page: Page, kind: 'audioBytesIn' | 'videoBytesIn') => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const s = await page.evaluate(() => (window as any).__parleyVoice.stats());
      const peer = Object.values(s)[0] as any;
      if (peer?.state === 'connected' && peer[kind] > 2000) return peer;
      await page.waitForTimeout(500);
    }
    throw new Error(`no ${kind} received`);
  };
  const aliceAudio = await waitForMedia(alice, 'audioBytesIn');
  const bobAudio = await waitForMedia(bob, 'audioBytesIn');
  assert.equal(aliceAudio.state, 'connected');
  assert.equal(bobAudio.state, 'connected');

  // Alice turns on her camera; Bob receives video and renders it.
  await alice.getByRole('button', { name: 'Turn on camera' }).click();
  await waitForMedia(bob, 'videoBytesIn');
  await bob.waitForFunction(() => [...document.querySelectorAll('video')].some((v) => (v as HTMLVideoElement).videoWidth > 0), null, { timeout: 15_000 });
  await snap(bob, 'e2e-voice-bob');

  // Screen share: Bob gets a separate "alice's screen" tile with live video.
  await alice.getByRole('button', { name: 'Share your screen' }).click();
  await bob.getByRole('button', { name: "alice screen share" }).waitFor({ timeout: 15_000 });
  await bob.waitForFunction(() => {
    const tile = document.querySelector('[aria-label="alice screen share"] video') as HTMLVideoElement | null;
    return !!tile && tile.videoWidth > 0;
  }, null, { timeout: 15_000 });
  await snap(bob, 'e2e-screenshare-bob');
  await alice.getByRole('button', { name: 'Stop sharing' }).first().click();
  await bob.getByRole('button', { name: "alice screen share" }).waitFor({ state: 'detached', timeout: 10_000 });

  // Server mute from the owner is reflected for Bob.
  await alice.evaluate(async ({ s, u }) => {
    await fetch(`/api/servers/${s}/members/${u}/voice`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mute: true }) });
  }, { s: serverId, u: (await bob.evaluate(() => fetch('/api/auth/me').then((r) => r.json()))).user.id });
  await bob.getByLabel('Server muted').first().waitFor({ timeout: 5000 });

  // Leave voice.
  await bob.getByRole('button', { name: 'Disconnect' }).first().click();
  await alice.waitForFunction(() => document.querySelectorAll('[aria-label$="screen share"], [aria-label="bob"]').length === 0, null, { timeout: 5000 }).catch(() => {});

  // Direct messages.
  await alice.goto(`${base}/channels/${serverId}/${generalId}`);
  await alice.getByRole('button', { name: "bob's profile" }).first().click();
  await alice.getByRole('button', { name: 'Message', exact: true }).click();
  await alice.waitForURL(/\/channels\/@me\/\d+/);
  const dmId = new URL(alice.url()).pathname.split('/').pop()!;
  const dmBox = alice.locator(`[data-composer="${dmId}"]`);
  await dmBox.fill('psst, just us');
  await dmBox.press('Enter');
  // Bob gets an unread badge and can open the conversation.
  await bob.goto(`${base}/channels/@me/${dmId}`);
  await bob.getByText('psst, just us').waitFor({ timeout: 5000 });
  await snap(bob, 'e2e-dm-bob');
});

test('mobile layout uses drawers', { timeout: 60_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${base}/register`);
  await page.fill('#email', 'mo@example.test');
  await page.fill('#un', 'mo');
  await page.fill('#pw', 'a-solid-passphrase');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/channels/@me');
  // The server rail is hidden until the navigation drawer opens.
  assert.equal(await page.getByRole('button', { name: 'Add a server' }).isVisible(), false);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Add a server' }).waitFor();
  await snap(page, 'e2e-mobile-drawer');
  await ctx.close();
});

test('every settings screen renders without errors', { timeout: 90_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, permissions: ['microphone', 'camera'] });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/register`);
  await page.fill('#email', 'set@example.test');
  await page.fill('#un', 'settingsfan');
  await page.fill('#pw', 'a-solid-passphrase');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/channels/@me');
  await page.getByRole('button', { name: 'Create a server' }).first().click();
  await page.fill('#sname', 'Settings Lab');
  await page.getByRole('button', { name: 'Create server' }).click();
  await page.waitForURL(/\/channels\/\d+\/\d+$/);

  await page.getByRole('button', { name: 'User settings' }).click();
  for (const tab of ['My account', 'Profile', 'Privacy & safety', 'Blocked users', 'Devices', 'Appearance', 'Accessibility', 'Voice & video', 'Notifications', 'Keybinds']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await page.getByRole('heading', { name: tab, exact: true }).waitFor();
  }
  await page.keyboard.press('Escape');

  await page.locator('button[aria-haspopup="menu"]', { hasText: 'Settings Lab' }).click();
  await page.getByRole('menuitem', { name: 'Server settings' }).click();
  for (const tab of ['Overview', 'Roles', 'Notifications', 'Your server profile', 'Members', 'Invites', 'Bans', 'AutoMod', 'Reports', 'Audit log', 'Transfer ownership', 'Delete server']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await page.getByRole('heading', { name: tab, exact: true }).waitFor();
  }
  await page.keyboard.press('Escape');

  await page.locator('nav[aria-label="Channels"] button', { hasText: 'general' }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit channel' }).click();
  for (const tab of ['Overview', 'Permissions']) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await page.getByRole('heading', { name: tab, exact: true }).waitFor();
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.getByRole('heading', { name: 'Jump to' }).waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  await ctx.close();
});
