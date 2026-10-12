/**
 * Voice/video rooms. Media flows peer-to-peer over WebRTC (full mesh); the
 * server tracks who is in which room and relays SDP/ICE signaling only between
 * members of the same room. Mesh suits small rooms (default cap 8); see
 * docs/DEPLOYMENT.md for moving to an SFU such as LiveKit for larger calls.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.ts';
import { db, one } from '../db/index.ts';
import { onOp, onDisconnect, toClient, toUser, channelAudience, type Client } from './gateway.ts';
import { channelPermissions, getChannel, isBlockedEitherWay, type ChannelRow } from '../services/access.ts';
import { P, has } from '../../shared/permissions.ts';
import { HttpError, forbidden, notFound } from '../http/router.ts';
import { hydrateMessages } from '../services/serialize.ts';

export interface VoiceState {
  user_id: string;
  channel_id: string;
  server_id: string | null;
  self_mute: boolean;
  self_deaf: boolean;
  server_mute: boolean;
  server_deaf: boolean;
  self_video: boolean;
  self_stream: boolean;
  suppress: boolean; // no SPEAK permission
  joined_at: number;
}
interface Internal extends VoiceState { clientId: number }

const states = new Map<string, Internal>();
const serverVoiceFlags = new Map<string, { mute: boolean; deaf: boolean }>(); // `${serverId}:${userId}`

const pub = (s: Internal): VoiceState => { const { clientId: _c, ...rest } = s; return rest; };
export const roomOf = (channelId: string) => [...states.values()].filter((s) => s.channel_id === channelId);
export const voiceStateOf = (userId: string) => { const s = states.get(userId); return s ? pub(s) : null; };

export function iceServers(userId: string) {
  const servers: any[] = [...config.rtc.iceServers];
  if (config.rtc.turnSecret && config.rtc.turnUrls.length) {
    // coturn REST API style ephemeral credentials (use-auth-secret).
    const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:${userId}`;
    const credential = crypto.createHmac('sha1', config.rtc.turnSecret).update(username).digest('base64');
    servers.push({ urls: config.rtc.turnUrls, username, credential });
  }
  return servers;
}

async function broadcast(ch: ChannelRow, t: string, d: unknown) {
  for (const id of await channelAudience(ch)) toUser(id, t, d);
}

async function leave(userId: string, reason: 'leave' | 'disconnect' | 'moved' = 'leave') {
  const s = states.get(userId);
  if (!s) return;
  states.delete(userId);
  const ch = await getChannel(s.channel_id);
  if (ch) await broadcast(ch, 'VOICE_STATE_UPDATE', { ...pub(s), channel_id: null, previous_channel_id: s.channel_id, reason });
  if (ch && (ch.type === 'dm' || ch.type === 'group_dm') && roomOf(ch.id).length === 0) {
    await broadcast(ch, 'CALL_ENDED', { channel_id: ch.id });
  }
}

async function join(c: { userId: string; clientId: number }, ch: ChannelRow, selfMute: boolean, selfDeaf: boolean, bypassCap = false) {
  const perms = await channelPermissions(c.userId, ch);
  const isDm = ch.type === 'dm' || ch.type === 'group_dm';
  if (!isDm && ch.type !== 'voice') throw new HttpError(400, 'not_voice', 'That is not a voice channel.');
  if (!has(perms, P.VIEW_CHANNEL)) throw notFound('Channel');
  if (!has(perms, P.CONNECT)) throw forbidden("You don't have permission to join this voice channel.");
  if (ch.type === 'dm') {
    const other = await one<{ user_id: string }>('SELECT user_id FROM dm_participants WHERE channel_id = $1 AND user_id <> $2', [ch.id, c.userId]);
    if (other && (await isBlockedEitherWay(c.userId, other.user_id))) throw forbidden("You can't call this user.");
  }
  const room = roomOf(ch.id).filter((s) => s.user_id !== c.userId);
  if (!bypassCap && room.length >= config.rtc.maxVoiceParticipants) throw new HttpError(409, 'voice_full', 'This voice channel is full.');

  const wasEmpty = room.length === 0;
  const prev = states.get(c.userId);
  if (prev && prev.channel_id !== ch.id) await leave(c.userId, 'moved');
  const flags = ch.server_id ? serverVoiceFlags.get(`${ch.server_id}:${c.userId}`) : undefined;
  const state: Internal = {
    user_id: c.userId, channel_id: ch.id, server_id: ch.server_id,
    self_mute: selfMute, self_deaf: selfDeaf,
    server_mute: flags?.mute ?? false, server_deaf: flags?.deaf ?? false,
    self_video: false, self_stream: false, suppress: !has(perms, P.SPEAK),
    joined_at: Date.now(), clientId: c.clientId,
  };
  states.set(c.userId, state);
  await broadcast(ch, 'VOICE_STATE_UPDATE', pub(state));
  toClient(c.userId, c.clientId, 'VOICE_READY', {
    channel_id: ch.id,
    peers: room.map((s) => s.user_id),
    ice_servers: iceServers(c.userId),
    can_video: has(perms, P.VIDEO),
  });

  if (isDm && wasEmpty) {
    // Ring the other participants and drop a call marker in the conversation.
    const r = await db.query(
      `INSERT INTO messages (channel_id, author_id, type, content) VALUES ($1,$2,'call','') RETURNING *`, [ch.id, c.userId]);
    await db.query('UPDATE channels SET last_message_id = $1 WHERE id = $2', [r.rows[0].id, ch.id]);
    await db.query('UPDATE dm_participants SET hidden = false WHERE channel_id = $1', [ch.id]);
    const [msg] = await hydrateMessages(r.rows);
    await broadcast(ch, 'MESSAGE_CREATE', msg);
    for (const id of await channelAudience(ch)) if (id !== c.userId) toUser(id, 'CALL_RING', { channel_id: ch.id, from_user_id: c.userId });
  }
}

const idSchema = z.string().regex(/^\d+$/);

onOp('voice_join', async (c: Client, d) => {
  const p = z.object({ channel_id: idSchema, self_mute: z.boolean().default(false), self_deaf: z.boolean().default(false) }).parse(d);
  const ch = await getChannel(p.channel_id);
  if (!ch) throw notFound('Channel');
  await join({ userId: c.userId, clientId: c.id }, ch, p.self_mute, p.self_deaf);
});

onOp('voice_leave', async (c: Client) => {
  const s = states.get(c.userId);
  if (s && s.clientId === c.id) await leave(c.userId);
});

onOp('voice_state', async (c: Client, d) => {
  const p = z.object({
    self_mute: z.boolean().optional(), self_deaf: z.boolean().optional(),
    self_video: z.boolean().optional(), self_stream: z.boolean().optional(),
  }).parse(d);
  const s = states.get(c.userId);
  if (!s || s.clientId !== c.id) return;
  const ch = await getChannel(s.channel_id);
  if (!ch) return;
  const perms = await channelPermissions(c.userId, ch);
  if ((p.self_video || p.self_stream) && !has(perms, P.VIDEO)) throw forbidden("You don't have permission to use video here.");
  Object.assign(s, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));
  s.suppress = !has(perms, P.SPEAK);
  await broadcast(ch, 'VOICE_STATE_UPDATE', pub(s));
});

onOp('voice_signal', (c: Client, d) => {
  const p = z.object({ to: idSchema, data: z.record(z.any()) }).parse(d);
  const me = states.get(c.userId);
  const peer = states.get(p.to);
  // Only relay between two members of the same room, from the connection that owns the voice session.
  if (!me || !peer || me.clientId !== c.id || me.channel_id !== peer.channel_id) return;
  if (JSON.stringify(p.data).length > 32_000) return;
  toClient(peer.user_id, peer.clientId, 'VOICE_SIGNAL', { from: c.userId, data: p.data });
});

onDisconnect((c) => {
  const s = states.get(c.userId);
  if (s && s.clientId === c.id) void leave(c.userId, 'disconnect');
});

/** Moderator actions: server mute/deafen, move, disconnect. Permission checks are done by the caller. */
export async function moderateVoice(serverId: string, targetId: string, change: { mute?: boolean; deaf?: boolean; channel_id?: string | null }) {
  const key = `${serverId}:${targetId}`;
  const flags = serverVoiceFlags.get(key) ?? { mute: false, deaf: false };
  if (change.mute !== undefined) flags.mute = change.mute;
  if (change.deaf !== undefined) flags.deaf = change.deaf;
  serverVoiceFlags.set(key, flags);

  const s = states.get(targetId);
  if (!s || s.server_id !== serverId) {
    if (change.channel_id !== undefined) throw new HttpError(400, 'not_in_voice', 'That member is not in a voice channel.');
    return null;
  }
  if (change.channel_id === null) {
    toClient(targetId, s.clientId, 'VOICE_DISCONNECTED', { reason: 'moderator' });
    await leave(targetId, 'disconnect');
    return null;
  }
  if (change.channel_id && change.channel_id !== s.channel_id) {
    const dest = await getChannel(change.channel_id);
    if (!dest || dest.server_id !== serverId || dest.type !== 'voice') throw notFound('Voice channel');
    if (!has(await channelPermissions(targetId, dest), P.VIEW_CHANNEL)) throw forbidden('That member cannot see the destination channel.');
    await join({ userId: targetId, clientId: s.clientId }, dest, s.self_mute, s.self_deaf, true);
    return voiceStateOf(targetId);
  }
  s.server_mute = flags.mute;
  s.server_deaf = flags.deaf;
  const ch = await getChannel(s.channel_id);
  if (ch) await broadcast(ch, 'VOICE_STATE_UPDATE', pub(s));
  return pub(s);
}

/** Kicked/banned/removed users must leave voice in that server. */
export async function evictFromServerVoice(serverId: string, userId: string) {
  const s = states.get(userId);
  if (s && s.server_id === serverId) {
    toClient(userId, s.clientId, 'VOICE_DISCONNECTED', { reason: 'removed' });
    await leave(userId, 'disconnect');
  }
}

/** Re-evaluate permissions for everyone in a channel (after role/overwrite changes). */
export async function recheckVoicePermissions(serverId: string) {
  for (const s of [...states.values()].filter((x) => x.server_id === serverId)) {
    const ch = await getChannel(s.channel_id);
    if (!ch) { await leave(s.user_id, 'disconnect'); continue; }
    const perms = await channelPermissions(s.user_id, ch);
    if (!has(perms, P.CONNECT)) {
      toClient(s.user_id, s.clientId, 'VOICE_DISCONNECTED', { reason: 'permissions' });
      await leave(s.user_id, 'disconnect');
    } else if (s.suppress !== !has(perms, P.SPEAK)) {
      s.suppress = !has(perms, P.SPEAK);
      await broadcast(ch, 'VOICE_STATE_UPDATE', pub(s));
    }
  }
}

/** Voice states visible to a user (for READY). */
export async function voiceStatesVisibleTo(userId: string): Promise<VoiceState[]> {
  const out: VoiceState[] = [];
  const cache = new Map<string, boolean>();
  for (const s of states.values()) {
    let ok = cache.get(s.channel_id);
    if (ok === undefined) {
      const ch = await getChannel(s.channel_id);
      ok = !!ch && has(await channelPermissions(userId, ch), P.VIEW_CHANNEL);
      cache.set(s.channel_id, ok);
    }
    if (ok) out.push(pub(s));
  }
  return out;
}

export function resetVoice() { states.clear(); serverVoiceFlags.clear(); }
