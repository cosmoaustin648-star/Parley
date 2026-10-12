-- Parley initial schema
-- All ids are BIGINT identities, serialized to clients as strings.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ───────────────────────────── Users & auth ─────────────────────────────
CREATE TABLE users (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username          TEXT NOT NULL,
  display_name      TEXT,
  email             TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  avatar_key        TEXT,
  banner_key        TEXT,
  bio               TEXT NOT NULL DEFAULT '',
  accent_color      TEXT,
  custom_status     TEXT,
  status            TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','idle','dnd','invisible')),
  settings          JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_staff          BOOLEAN NOT NULL DEFAULT FALSE,
  is_demo           BOOLEAN NOT NULL DEFAULT FALSE,
  disabled_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT username_format CHECK (username ~ '^[a-z0-9_.]{2,32}$')
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE INDEX users_username_trgm ON users USING gin (username gin_trgm_ops);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,            -- sha256 of the session token
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('verify','reset')),
  email      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user ON email_tokens(user_id, kind);

CREATE TABLE blocks (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blocked_id),
  CHECK (user_id <> blocked_id)
);
CREATE INDEX blocks_blocked ON blocks(blocked_id);

-- ───────────────────────────── Servers ─────────────────────────────
CREATE TABLE servers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  owner_id    BIGINT NOT NULL REFERENCES users(id),
  icon_key    TEXT,
  description TEXT NOT NULL DEFAULT '',
  rules       TEXT NOT NULL DEFAULT '',
  is_public   BOOLEAN NOT NULL DEFAULT FALSE,
  is_demo     BOOLEAN NOT NULL DEFAULT FALSE,
  system_channel_id BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX servers_public ON servers(is_public) WHERE is_public;
CREATE INDEX servers_name_trgm ON servers USING gin (name gin_trgm_ops);

CREATE TABLE server_members (
  server_id     BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname      TEXT,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  timeout_until TIMESTAMPTZ,
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX server_members_user ON server_members(user_id);

CREATE TABLE roles (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  server_id   BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT,
  position    INT NOT NULL DEFAULT 0,          -- 0 is @everyone; higher = more senior
  permissions BIGINT NOT NULL DEFAULT 0,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,  -- the @everyone role
  hoist       BOOLEAN NOT NULL DEFAULT FALSE,  -- show separately in member list
  mentionable BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX roles_server ON roles(server_id);
CREATE UNIQUE INDEX roles_one_default ON roles(server_id) WHERE is_default;

CREATE TABLE member_roles (
  server_id BIGINT NOT NULL,
  user_id   BIGINT NOT NULL,
  role_id   BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id),
  FOREIGN KEY (server_id, user_id) REFERENCES server_members(server_id, user_id) ON DELETE CASCADE
);
CREATE INDEX member_roles_role ON member_roles(role_id);

CREATE TABLE categories (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  server_id BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  position  INT NOT NULL DEFAULT 0
);
CREATE INDEX categories_server ON categories(server_id);

-- Channels cover server text/voice channels, threads, DMs and group DMs.
CREATE TABLE channels (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  server_id         BIGINT REFERENCES servers(id) ON DELETE CASCADE,
  category_id       BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  parent_channel_id BIGINT REFERENCES channels(id) ON DELETE CASCADE, -- for threads
  type              TEXT NOT NULL CHECK (type IN ('text','voice','thread','dm','group_dm')),
  name              TEXT,
  topic             TEXT NOT NULL DEFAULT '',
  position          INT NOT NULL DEFAULT 0,
  owner_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,     -- group DM owner / thread creator
  icon_key          TEXT,
  slowmode_seconds  INT NOT NULL DEFAULT 0,
  archived          BOOLEAN NOT NULL DEFAULT FALSE,
  last_message_id   BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((type IN ('dm','group_dm')) = (server_id IS NULL))
);
CREATE INDEX channels_server ON channels(server_id);
CREATE INDEX channels_parent ON channels(parent_channel_id);
ALTER TABLE servers ADD CONSTRAINT servers_system_channel_fk
  FOREIGN KEY (system_channel_id) REFERENCES channels(id) ON DELETE SET NULL;

CREATE TABLE channel_overwrites (
  channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('role','member')),
  target_id   BIGINT NOT NULL,
  allow       BIGINT NOT NULL DEFAULT 0,
  deny        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_type, target_id)
);

CREATE TABLE dm_participants (
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden     BOOLEAN NOT NULL DEFAULT FALSE,   -- "closed" in the DM list; reopens on new message
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX dm_participants_user ON dm_participants(user_id);
-- One 1:1 DM per user pair (low id first).
CREATE TABLE dm_pairs (
  user_a     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);

-- ───────────────────────────── Messages ─────────────────────────────
CREATE TABLE messages (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id       BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  type             TEXT NOT NULL DEFAULT 'default' CHECK (type IN ('default','system','thread_created','call')),
  content          TEXT NOT NULL DEFAULT '',
  nonce            TEXT,
  reply_to_id      BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  thread_id        BIGINT REFERENCES channels(id) ON DELETE SET NULL,   -- thread started from this message
  mention_everyone BOOLEAN NOT NULL DEFAULT FALSE,
  mention_user_ids BIGINT[] NOT NULL DEFAULT '{}',
  mention_role_ids BIGINT[] NOT NULL DEFAULT '{}',
  mention_channel_ids BIGINT[] NOT NULL DEFAULT '{}',
  pinned           BOOLEAN NOT NULL DEFAULT FALSE,
  edited_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vector    TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE INDEX messages_channel_id ON messages(channel_id, id DESC);
CREATE INDEX messages_pinned ON messages(channel_id) WHERE pinned;
CREATE INDEX messages_search ON messages USING gin (search_vector);
CREATE INDEX messages_author ON messages(author_id, id DESC);
-- Idempotent sends: a client retry with the same nonce returns the original message.
CREATE UNIQUE INDEX messages_nonce ON messages(author_id, nonce) WHERE nonce IS NOT NULL;

ALTER TABLE channels ADD CONSTRAINT channels_last_message_fk
  FOREIGN KEY (last_message_id) REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE attachments (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id   BIGINT REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key  TEXT NOT NULL UNIQUE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         BIGINT NOT NULL,
  width        INT,
  height       INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message ON attachments(message_id);
CREATE INDEX attachments_orphans ON attachments(created_at) WHERE message_id IS NULL;

CREATE TABLE reactions (
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE read_states (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id           BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_message_id BIGINT,
  mention_count        INT NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);

-- ───────────────────────────── Invites & discovery ─────────────────────────────
CREATE TABLE invites (
  code        TEXT PRIMARY KEY,
  server_id   BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id  BIGINT REFERENCES channels(id) ON DELETE SET NULL,
  inviter_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  max_uses    INT,
  uses        INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invites_server ON invites(server_id);

-- ───────────────────────────── Moderation ─────────────────────────────
CREATE TABLE bans (
  server_id  BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     TEXT,
  banned_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  server_id   BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  actor_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- NULL = automod/system
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  reason      TEXT,
  changes     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_server ON audit_log(server_id, id DESC);

CREATE TABLE automod_rules (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  server_id     BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  trigger_type  TEXT NOT NULL CHECK (trigger_type IN ('keyword','mention_spam','links','invites')),
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  action        TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('block','block_and_timeout')),
  timeout_seconds INT NOT NULL DEFAULT 60,
  exempt_role_ids BIGINT[] NOT NULL DEFAULT '{}',
  created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX automod_rules_server ON automod_rules(server_id);

CREATE TABLE reports (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reporter_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  server_id      BIGINT REFERENCES servers(id) ON DELETE CASCADE,  -- NULL = DM report → platform staff
  channel_id     BIGINT REFERENCES channels(id) ON DELETE SET NULL,
  message_id     BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  message_snapshot TEXT,
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolved_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reports_server ON reports(server_id, status);

-- ───────────────────────────── Notifications ─────────────────────────────
CREATE TABLE notification_settings (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type  TEXT NOT NULL CHECK (scope_type IN ('server','channel')),
  scope_id    BIGINT NOT NULL,
  level       TEXT CHECK (level IN ('all','mentions','none')),  -- NULL = inherit
  muted       BOOLEAN NOT NULL DEFAULT FALSE,
  muted_until TIMESTAMPTZ,
  suppress_everyone BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, scope_type, scope_id)
);
