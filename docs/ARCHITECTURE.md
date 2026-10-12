# Architecture

## Overview

```
Browser (React SPA)                         Node.js process                         PostgreSQL
┌─────────────────────────┐   HTTPS JSON    ┌──────────────────────────────┐   wire protocol   ┌──────────┐
│ store ← gateway client  │ ──────────────▶ │ router → routes → services   │ ────────────────▶ │ 24 tables│
│ views, settings, modals │   WebSocket     │ gateway (presence, typing,   │                   └──────────┘
│ voice engine (WebRTC)   │ ◀────────────▶  │   fan-out, voice signaling)  │   disk (uploads)
└───────────┬─────────────┘                 └──────────────────────────────┘ ────────────────▶ STORAGE_DIR
            │  SRTP media (peer-to-peer, via STUN / optional TURN)
            └──────────────────────────────▶ other participants' browsers
```

One Node.js process serves the API (`/api/*`), the WebSocket gateway (`/gateway`), uploaded
files (through access-checked routes) and the built client. Media for calls never touches the
server; it only relays signaling.

### Why so few dependencies

Runtime dependencies are `ws` and `zod`; the client uses React and `react-icons`. HTTP routing,
cookies, rate limiting, SMTP, multipart-free uploads, password hashing (scrypt) and the
PostgreSQL client (`server/db/pg.ts`: SCRAM-SHA-256, TLS, extended query protocol, pool,
transactions) are implemented in-repo. The environment Parley was written in had no package
registry access, so everything had to run on what was installed; the upside is a small,
auditable surface. `pg.ts` mirrors `node-postgres`' `query()` shape, so swapping it for `pg` is a
one-file change if you prefer.

## Data model (server/db/migrations/001_init.sql)

- `users`, `sessions` (hashed tokens, sliding expiry), `email_tokens` (verify/reset, hashed, single use), `blocks`
- `servers`, `server_members` (nickname, `timeout_until`), `roles` (position, permission bitfield), `member_roles`
- `categories`, `channels` (one table for text, voice, threads, DMs and group DMs), `channel_overwrites`
- `dm_participants`, `dm_pairs` (one 1:1 DM per pair)
- `messages` (mentions as arrays, `nonce` for idempotency, generated `tsvector` for search), `attachments`, `reactions`, `read_states`
- `invites`, `bans`, `audit_log`, `automod_rules`, `reports`, `notification_settings`

IDs are `BIGINT` identities sent to clients as strings.

## Permissions (shared/permissions.ts)

A 26-bit bitfield. Resolution follows the familiar model:

1. Owner has everything. `ADMINISTRATOR` grants everything and bypasses overrides.
2. Base = `@everyone` permissions OR the member's role permissions.
3. In a channel: apply the `@everyone` override, then all role overrides (deny, then allow), then the member override.
4. Without `VIEW_CHANNEL`, every other channel permission is void.
5. A timed-out member loses send/react/speak/video/thread/attach.

Hierarchy: you can only act on members whose highest role is strictly below yours, only assign
roles below your highest, and can't grant permissions you don't hold. The server computes
`my_permissions` for each channel a user can see and sends it to the client, which uses it only
to hide controls. **Every check happens on the server** in `server/services/access.ts`;
unauthorized reads return 404 so private channels and servers don't leak their existence.

Role, overwrite and membership data are cached in memory and invalidated on writes.

## Real-time gateway (server/realtime/gateway.ts)

- The browser connects to `/gateway` with its session cookie; the `Origin` header is checked to
  prevent cross-site WebSocket hijacking.
- First message is `READY`: the user, every server (with only the channels they can see and
  computed permissions), DMs, read states, notification settings, blocks, presences of related
  users and current voice states.
- Server → client events (`{t, d}`): `MESSAGE_CREATE/UPDATE/DELETE`, `REACTION_ADD/REMOVE`,
  `TYPING_START`, `PRESENCE_UPDATE`, `SERVER_SYNC` (after permission changes), `CHANNEL_*`,
  `THREAD_*`, `MEMBER_*`, `VOICE_STATE_UPDATE`, `READ_STATE_UPDATE`, `READ_RECEIPT`, `DM_CHANNEL_*`,
  `CALL_RING`, `NOTIFICATION_SETTINGS_UPDATE`, `BLOCK_*`, `REPORT_CREATE`.
- Client → server ops (`{op, d}`): `ping`, `presence` (idle), `typing`, `voice_join`,
  `voice_leave`, `voice_state`, `voice_signal`.
- Channel events go only to online users who can view that channel; permission checks run per
  recipient. Writes go through REST so validation and rate limiting live in one place.
- Reconnects use exponential backoff; a fresh `READY` replaces state, and the open channel
  fetches anything it missed.

## Messaging details

- Sends carry a client `nonce`; a unique index on `(author_id, nonce)` makes retries and double
  clicks return the original message rather than a duplicate.
- The client inserts an optimistic message immediately and reconciles it by nonce; failures can
  be retried or discarded.
- Mentions are stored as `<@id>`, `<@&id>`, `<#id>` tokens. The composer lets people type
  `@username`, `@Role` or `#channel` and converts on send. `@everyone` only counts with the
  `MENTION_EVERYONE` permission.
- Mention badges come from `read_states.mention_count`, incremented server-side for recipients
  who can see the channel. Unread state compares `channels.last_message_id` with the user's
  `last_read_message_id`.
- Uploads are sent as raw bodies with an `X-Filename` header, sniffed by magic bytes (the
  declared type is never trusted), stored under random keys and served with a sandbox CSP;
  anything that isn't a known image/video/audio/PDF downloads as an attachment.

## Voice and video (client/src/voice/engine.ts, server/realtime/voice.ts)

- Full mesh: each pair of participants has one `RTCPeerConnection`. The newcomer receives the
  list of peers in `VOICE_READY` and starts negotiation; renegotiation (camera or screen on/off)
  uses the "perfect negotiation" pattern so either side can initiate.
- The server only relays signaling between members of the same room, from the connection that
  owns the voice session, and enforces `CONNECT`, `SPEAK` (as `suppress`), `VIDEO`, the room cap
  and blocks for DM calls.
- Outgoing audio goes through WebAudio: microphone → input gain → gate → destination track. The
  gate implements voice-activity detection (threshold from settings) or push-to-talk. Analysers
  drive speaking indicators locally.
- Camera and screen are separate streams; the sender announces which stream id is which, so the
  receiver can show them as separate tiles.
- Server mute/deafen is applied by the muted user's client (track disabled) and by every other
  client (playback muted). In a peer-to-peer design the server can't physically stop media; see
  the SFU note in DEPLOYMENT.md if you need that guarantee.

## Client

- A small external store (`useSyncExternalStore`) holds normalized state; the gateway reducer
  is the single place that applies server events.
- Routing is a tiny history-based router (`/channels/@me/:dm`, `/channels/:server/:channel`,
  `/invite/:code`, `/discover`, auth pages).
- Markdown is parsed into React elements; message content never touches `innerHTML`.
- Tailwind CSS v4 is compiled through its JS API at build time; themes are CSS variables.

## Security summary

- scrypt password hashing (N=2^15), constant-time comparison, dummy hashing for unknown accounts.
- Session tokens are random 256-bit values; only their SHA-256 is stored. Cookies are
  `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- CSRF: `SameSite` cookies plus an `Origin` check on every state-changing request and WebSocket upgrade.
- Rate limits per IP and per user for auth, email, messages, uploads, search and other writes.
- Strict input validation with zod on every route; unknown fields rejected where it matters.
- Content Security Policy, `X-Frame-Options: DENY`, `nosniff`, sandboxed uploads.
- Password changes and resets sign out other sessions; staff can suspend accounts.
