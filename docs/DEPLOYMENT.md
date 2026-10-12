# Deploying Parley

## What you need

| Piece | Required? | Notes |
| --- | --- | --- |
| Node.js 22.5+ | Yes | One process per instance. |
| PostgreSQL 14+ | Yes | Any managed Postgres works; add `?sslmode=require` to `DATABASE_URL`. The `pg_trgm` extension is created by the migration (it is a trusted extension on PG 13+). |
| HTTPS | Yes, in practice | Browsers only allow microphone, camera and screen capture on HTTPS (or `localhost`). |
| SMTP provider | Yes for email flows | Verification and password reset. Postmark, SES, Mailgun, Resend, Gmail SMTP all work. |
| TURN server | Strongly recommended | Without it, calls fail between some networks (symmetric NAT, strict firewalls). |
| Persistent disk | Yes | `STORAGE_DIR` holds uploads. |

## Option A: a VM or bare server

```bash
git clone <your repo> parley && cd parley
npm ci            # or npm install
npm run build
cp .env.example .env   # set NODE_ENV=production, APP_URL, DATABASE_URL, SMTP_*, TURN_*
node dist/server.js    # run under systemd, pm2 or similar
```

Example systemd unit:

```ini
[Unit]
Description=Parley
After=network.target

[Service]
WorkingDirectory=/opt/parley
EnvironmentFile=/opt/parley/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
User=parley

[Install]
WantedBy=multi-user.target
```

### Reverse proxy

Terminate TLS in front of Parley and forward WebSockets. Set `TRUST_PROXY=true`.

Caddy:

```
chat.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name chat.example.com;
  client_max_body_size 30m;           # >= MAX_UPLOAD_MB
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 1h;            # keep the gateway open
  }
}
```

## Option B: Docker Compose

`docker compose up -d --build` starts Postgres and Parley with persistent volumes. Edit the
environment block first. The Dockerfile and compose file were written to the same commands that
were tested (`npm run build`, `node dist/server.js`), but the images themselves were not built in
the environment Parley was developed in.

## Option C: a PaaS (Render, Railway, Fly.io, Heroku-style)

- Build command `npm ci && npm run build`, start command `node dist/server.js`.
- Attach a Postgres add-on and set `DATABASE_URL`.
- Mount a persistent volume at `STORAGE_DIR` (ephemeral filesystems will lose uploads on deploy).
- Make sure the platform supports WebSockets and long-lived connections.
- Run a **single instance** (see Scaling).

## Production checklist

- `NODE_ENV=production`, `APP_URL=https://your.domain` (exact origin; it's used for the Origin check).
- `COOKIE_SECURE` defaults to true in production; serve over HTTPS.
- `SMTP_HOST` and friends set; send yourself a password reset to confirm delivery.
- `REQUIRE_EMAIL_VERIFICATION=true` once email works.
- TURN configured and tested from a phone on mobile data.
- `STAFF_EMAILS` set to the accounts that should review direct-message reports.
- Database backups (`pg_dump` on a schedule) and a backup of `STORAGE_DIR`.

## TURN (coturn)

Parley can mint short-lived TURN credentials per user from coturn's shared secret:

```
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=<long random string>
realm=chat.example.com
external-ip=<public IP>
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
```

```
TURN_SECRET=<same long random string>
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
```

Open UDP 3478, TCP 5349 and the relay port range (default 49152–65535 UDP).
Alternatively set `ICE_SERVERS` to a JSON array from a hosted TURN service.

## Email

Any SMTP server works. `SMTP_SECURE=true` for implicit TLS (usually 465); otherwise Parley
upgrades with STARTTLS when the server offers it (usually 587). Set `MAIL_FROM` to an address on
a domain with SPF/DKIM configured at your provider, or messages will land in spam.

## Scaling

The current design is **single-instance**:

- The WebSocket gateway, presence, voice rooms, permission caches and rate limiters live in process memory.
- One Node process comfortably handles hundreds of concurrent users and thousands of messages per
  minute on a small VM; Postgres is the main resource.

To run several instances you would need to add: a pub/sub bus for gateway fan-out (Redis or
Postgres `LISTEN/NOTIFY`), shared rate-limit counters (Redis), cache invalidation messages,
and sticky routing or shared voice-room state. None of that is implemented yet.

### Larger calls

Calls are peer-to-peer full mesh, so each participant uploads one stream per other participant.
That works well up to roughly 6–8 people (the default cap, `MAX_VOICE_PARTICIPANTS`). For bigger
rooms, or if you need server-enforced muting and recording, replace the mesh with an SFU such as
LiveKit, mediasoup or Janus. The voice signaling module (`server/realtime/voice.ts`) and engine
(`client/src/voice/engine.ts`) are where that change goes.

## File storage

Uploads are written to `STORAGE_DIR` and only ever served through routes that check access
(attachments require being able to view the channel). To use S3-compatible object storage,
implement the `StorageDriver` interface in `server/storage/index.ts` (`put`, `stream`, `stat`,
`remove`). An S3 driver is **not** included yet.

## Updating

Pull, `npm ci`, `npm run build`, restart. Migrations run automatically on start and are guarded
by an advisory lock.
