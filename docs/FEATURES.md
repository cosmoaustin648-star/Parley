# Feature status

How to read this:

- **Tested**: covered by an automated test (`tests/api` = API integration against a real
  database; `tests/e2e` = two real Chromium browsers using the built app).
- **Built**: implemented end to end (UI + API + database) and checked by hand or screenshot, but
  without a dedicated automated test.
- **Partial** or **Not built**: see the note. Nothing in the UI pretends to work when it doesn't.

## 1. Interface and design

| Feature | Status | Notes |
| --- | --- | --- |
| Dark mode, customizable themes | Built | Harbor, Deep water, Midnight (OLED), Daylight. Theme picker in Settings → Appearance. |
| Server rail, channel panel, chat, member list, user panel | Tested (e2e) | Familiar four-column layout. |
| User panel: avatar, name, mic, headphones, settings | Built | Status menu, custom status, edit profile, log out from the avatar. |
| Animations, hover states, transitions | Built | Kept to responses to actions; honours reduced-motion. |
| Responsive (desktop and mobile) | Tested (e2e) | Below 768px navigation and member list become drawers. |
| Custom fonts, accent colours, interface settings | Built | 5 bundled fonts, 8 accent presets plus custom, text size, spacing, compact mode, 24-hour time. |
| Original branding | Built | Name, pennant logo, signal-flag server icons, palette. No Discord assets. |

## 2. Accounts and authentication

| Feature | Status | Notes |
| --- | --- | --- |
| Registration and login | Tested (api, e2e) | By email or username. Generic error messages (no account enumeration). Rate limited. |
| Email verification | Tested (api) | Single-use, 24h tokens. `REQUIRE_EMAIL_VERIFICATION` gates sending, server creation/joining and DMs. |
| Password reset | Tested (api) | 1h single-use tokens; resets sign out every session. |
| Unique usernames, display names | Tested (api) | Case-insensitive uniqueness; per-server nicknames too. |
| Profile pictures and banners | Tested (api: avatar) | Images are type-sniffed; non-images rejected. |
| Custom status | Built | |
| Online, idle, DND, offline (+ invisible) | Tested (api: online/dnd/offline) | Idle is automatic after 10 minutes without activity. |
| Profile pages | Built | Profile card with bio, roles, mutual servers, join dates, actions. |
| Account settings and privacy controls | Tested (api) | Change username/email/password (requires current password), delete account, DM privacy, read receipts, typing visibility. |
| Persistent sessions | Tested (api) | 30-day sliding sessions, device list with remote sign-out. |

## 3. Servers

| Feature | Status | Notes |
| --- | --- | --- |
| Create, rename, delete | Tested (api, e2e) | Delete requires typing the name; owner only. |
| Server icons | Built | Upload/remove; generated signal flag otherwise. |
| Invite links: join, generate, revoke | Tested (api, e2e) | Expiry and max uses; invite landing page works signed-out. |
| Public or private servers | Tested (api) | Public servers are listed in Discover and joinable without an invite. |
| Description and rules | Built | Rules support Markdown; members see them via the server menu → "Server info and rules". |
| Categories | Built | Create, rename, delete, collapse (remembered). |
| Member list with status | Tested (e2e) | Grouped by hoisted roles, then online/offline. |
| Custom roles, permissions | Tested (api) | See section 7. |
| Ownership transfer | Tested (api) | Requires password. |

## 4. Text channels and messaging

| Feature | Status | Notes |
| --- | --- | --- |
| Create, rename, delete channels | Tested (api) | Text channel names are normalised (`Staff Only` → `staff-only`). |
| Instant send/receive | Tested (api, e2e) | Fan-out only to users who can see the channel. |
| Edit, delete | Tested (api) | Moderator deletions are audit-logged. Shift-click skips the confirm. |
| Replies | Tested (api) | Click the preview to jump to the original. |
| Emoji reactions | Tested (api, e2e) | Unicode emoji; 20 distinct per message. |
| Attachments (images, video, docs, any file) | Tested (api) | Drag-and-drop, paste, file picker; progress bars; 25 MB default; access-checked downloads. |
| Timestamps, edit indicator | Built | |
| Typing indicators | Tested (api, e2e) | |
| Read receipts | Tested (api) | In DMs ("Seen"), respecting the reader's privacy setting. Not shown in servers. |
| Pins | Tested (api) | Pinned list per channel, jump to message. |
| Search | Tested (api) | Full-text + substring, filters (author, has file/image/link, scope), respects permissions. |
| Mentions: users, roles, channels, @everyone/@here | Tested (api) | Autocomplete in the composer; @everyone needs permission. |
| Markdown | Built | Bold, italics, underline, strike, spoilers, inline code, code blocks with highlighting, quotes, headings, lists, links, masked links. Rendered without innerHTML. |
| Avatars beside messages, grouping | Built | |
| Load older messages on scroll | Tested (api: pagination) | Scroll position is preserved; "Jump to present". |
| Threads | Tested (api) | Start from a message, side panel, archive/unarchive, thread list. |
| Persistence | Tested (e2e: reload) | PostgreSQL. |
| Duplicate-submission protection | Tested (api) | Client nonce + unique index; optimistic UI with retry. |
| Slowmode | Tested (api) | Moderators exempt. |

## 5. Voice and video

| Feature | Status | Notes |
| --- | --- | --- |
| Join/leave voice channels | Tested (e2e) | |
| Real-time voice | Tested (e2e) | The e2e test asserts audio RTP bytes arrive in both directions over a connected `RTCPeerConnection`. |
| Mute/unmute, deafen/undeafen | Built | Also via keybinds. Sounds on toggle. |
| Who is in a channel | Tested (api, e2e) | Shown under the channel and on the stage. |
| Active speaker indicators | Built | WebAudio level analysis; green ring. |
| Screen sharing | Tested (e2e) | Separate tile, auto-spotlighted. System audio is not shared. |
| Video | Tested (e2e) | Asserts video bytes arrive and the receiver renders frames. |
| Private calls between users (DMs, group DMs) | Tested (api: ring) | Incoming-call prompt with ringtone; call marker in the conversation. |
| Connection status | Built | Per-peer state; warns when a peer can't connect and suggests TURN. |
| Mic/camera permission handling | Built | Clear messages for blocked/missing devices; joins listen-only without a mic. |
| Server mute/deafen, move, disconnect | Tested (api, e2e: mute) | |
| Device selection, input/output volume, VAD threshold, push-to-talk, noise suppression/echo/AGC | Built | Live input meter in settings. Output device selection needs a browser with `setSinkId` (Chromium). Push-to-talk works while the tab is focused. |
| Per-user volume | Built | Right-click a tile. |
| **Limits** | Partial | Peer-to-peer mesh, capped at 8 per room by default. No TURN server is bundled (configure one; see DEPLOYMENT.md). Server mute is enforced by clients, not by a media server. |

## 6. Direct messages

| Feature | Status | Notes |
| --- | --- | --- |
| 1:1 conversations | Tested (api, e2e) | One conversation per pair; close/reopen keeps history. |
| Group DMs | Tested (api) | Up to 10 people; owner can remove; leaving passes ownership on. |
| Real-time delivery, history, attachments, reactions | Tested (api) | Same message system as channels. |
| User search | Built | By username or display name. |
| Online status, unread indicators, notifications | Built | Unread DMs also appear on the server rail. |
| Only participants can access | Tested (api) | Others get 404. Blocks and the "allow new DMs" setting are enforced. |

## 7. Roles and permissions

| Feature | Status | Notes |
| --- | --- | --- |
| Owner, Administrator, Moderator, Member, custom roles | Tested (api) | New servers get @everyone, Moderator and Admin. |
| Manage channels, roles, server, invites; send/delete messages; kick/ban; mute; move; view restricted channels | Tested (api) | 26 permissions in total. |
| Channel-level overrides | Tested (api) | Three-state editor per role or member; one-click private channels. |
| Hierarchy | Tested (api) | Can't act on equal/higher roles or the owner; can't grant permissions you lack. |
| Backend enforcement | Tested (api) | Every boundary is checked server-side; the UI only hides controls. |

## 8. Moderation

| Feature | Status | Notes |
| --- | --- | --- |
| Kick, ban/unban, timeout | Tested (api) | Ban can purge the last hour/day/week of messages. |
| Delete inappropriate messages | Tested (api) | Single and bulk (API). |
| Manage channel permissions | Tested (api) | |
| Review moderation actions / audit log | Tested (api) | Actor, target, reason, changes and timestamp; filter by action. |
| AutoMod | Tested (api: keywords + timeout) | Keywords (whole word or wildcard), mention spam, links (with allow-list), invites; block or block + timeout; exempt roles. |
| Report users and messages | Tested (api) | Server reports go to moderators (with a live notice); DM reports go to platform staff (`STAFF_EMAILS`), API only (`/api/staff/reports`), no staff UI yet. |
| Blocked users | Tested (api) | Blocks stop DMs and calls and hide messages. |

## 9. Notifications

| Feature | Status | Notes |
| --- | --- | --- |
| Desktop notifications | Built | Browser Notification API while Parley is open in a tab. **No web push** for closed tabs or mobile. |
| Unread badges | Built | Channels, servers, DMs and the browser tab title, e.g. "(3) Parley". |
| Server and channel settings, mute with durations | Tested (api: settings endpoint) | All / mentions / nothing; suppress @everyone. |
| Mention and DM notifications | Built | |
| Do Not Disturb | Built | Silences sounds and pop-ups; badges still update. |

## 10–14. Backend, settings, search, reliability

| Feature | Status | Notes |
| --- | --- | --- |
| PostgreSQL schema and migrations | Tested | 24 tables, migrations run at boot under an advisory lock. |
| Secure auth, validation, rate limiting, access control | Tested (api) | See ARCHITECTURE.md → Security summary. |
| Settings panel (all requested sections) | Tested (e2e: every tab renders) | |
| Server/user/channel/message search, invites, Discover | Tested (api) | Quick switcher with `Ctrl+K`. |
| Many users at once, real-time status | Tested (api, e2e) | Single instance; see scaling notes. |
| Reconnect after connection loss | Built | Backoff, offline banner, resync of the open channel, voice rejoin. |
| Loading, error and empty states | Built | |
| Demo data clearly separated | Built | `npm run seed:demo`; "Demo" badges on accounts and server; removable with `--remove`. |

## Not built yet

- **Object storage (S3-compatible)**: uploads go to local disk behind access-checked routes. The
  `StorageDriver` interface is ready; no S3 driver is included.
- **Horizontal scaling**: one app instance. Multi-instance needs Redis (or Postgres LISTEN/NOTIFY)
  for gateway fan-out, rate limits and voice state.
- **SFU for large calls**: mesh only (see DEPLOYMENT.md).
- **Web push / mobile push notifications** (service worker + VAPID keys).
- **Link previews/embeds, GIF search, custom emoji, stickers**.
- **Friends list / friend requests** (not in the brief; DMs are open to anyone unless the user turns them off).
- **End-to-end encryption**: messages are stored in plain text in PostgreSQL.
- **Staff moderation UI** for direct-message reports (API exists).
- **Drag-and-drop reordering** of servers and channels (channels can be reordered through the API; roles have up/down controls).
- **Screen-reader audit**: semantic roles, labels and focus handling are in place, but the app hasn't been tested with assistive technology.

## Verified only partly in this environment

- `npm install` itself could not be run (no registry access); the app was built and tested with
  the exact versions listed in `package.json`.
- The SMTP client was tested against a fake SMTP server (AUTH PLAIN/LOGIN, MIME, errors), not
  against a real provider or with STARTTLS.
- The Dockerfile and docker-compose.yml were not built.
- Calls were tested between two browsers on one machine; NAT traversal across real networks
  depends on your STUN/TURN setup.
