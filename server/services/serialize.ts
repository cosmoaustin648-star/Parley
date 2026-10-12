import { many, type Queryable, db } from '../db/index.ts';

export const mediaUrl = (key: string | null | undefined) => (key ? `/api/media/${key}` : null);

export interface PublicUser {
  id: string; username: string; display_name: string | null; avatar_url: string | null; banner_url: string | null;
  accent_color: string | null; bio: string; custom_status: string | null; created_at: string; is_demo?: boolean;
}

export const USER_COLS = 'u.id, u.username, u.display_name, u.avatar_key, u.banner_key, u.accent_color, u.bio, u.custom_status, u.created_at, u.is_demo';

export function publicUser(r: any): PublicUser {
  return {
    id: r.id, username: r.username, display_name: r.display_name, avatar_url: mediaUrl(r.avatar_key),
    banner_url: mediaUrl(r.banner_key), accent_color: r.accent_color, bio: r.bio ?? '',
    custom_status: r.custom_status, created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    ...(r.is_demo ? { is_demo: true } : {}),
  };
}

export function privateUser(r: any) {
  return {
    ...publicUser(r),
    email: r.email,
    email_verified: !!r.email_verified_at,
    status: r.status,
    settings: r.settings ?? {},
    is_staff: r.is_staff,
  };
}

export function attachmentJson(a: any) {
  return {
    id: a.id, filename: a.filename, content_type: a.content_type, size: Number(a.size),
    width: a.width, height: a.height, url: `/api/attachments/${a.id}/${encodeURIComponent(a.filename)}`,
  };
}

export interface MessageJson {
  id: string; channel_id: string; type: string; content: string; nonce: string | null;
  author: PublicUser | null; created_at: string; edited_at: string | null; pinned: boolean;
  reply_to: { id: string; content: string; author: PublicUser | null; deleted?: boolean } | null;
  reply_to_id: string | null;
  attachments: ReturnType<typeof attachmentJson>[];
  reactions: { emoji: string; count: number; user_ids: string[] }[];
  mention_everyone: boolean; mention_user_ids: string[]; mention_role_ids: string[]; mention_channel_ids: string[];
  thread: { id: string; name: string | null; message_count: number; archived: boolean } | null;
}

/** Hydrate message rows (authors, attachments, reactions, reply previews, thread info). */
export async function hydrateMessages(rows: any[], q: Queryable = db): Promise<MessageJson[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter(Boolean))];
  const threadIds = [...new Set(rows.map((r) => r.thread_id).filter(Boolean))];
  const authorIds = [...new Set(rows.map((r) => r.author_id).filter(Boolean))];

  const [authors, atts, reacts, replies, threads] = await Promise.all([
    authorIds.length ? many(`SELECT ${USER_COLS} FROM users u WHERE u.id = ANY($1::bigint[])`, [authorIds], q) : [],
    many('SELECT * FROM attachments WHERE message_id = ANY($1::bigint[]) ORDER BY id', [ids], q),
    many(
      `SELECT message_id, emoji, count(*)::int AS count, (array_agg(user_id ORDER BY created_at))[1:50] AS user_ids, min(created_at) AS first
         FROM reactions WHERE message_id = ANY($1::bigint[]) GROUP BY message_id, emoji ORDER BY first`, [ids], q),
    replyIds.length
      ? many(`SELECT ${USER_COLS}, m.id AS reply_id, m.content AS reply_content, m.author_id FROM messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.id = ANY($1::bigint[])`, [replyIds], q)
      : [],
    threadIds.length
      ? many(`SELECT c.id, c.name, c.archived, (SELECT count(*)::int FROM messages WHERE channel_id = c.id) AS message_count FROM channels c WHERE c.id = ANY($1::bigint[])`, [threadIds], q)
      : [],
  ]);
  const authorMap = new Map(authors.map((a: any) => [a.id, publicUser(a)]));
  const replyMap = new Map(replies.map((r: any) => [r.reply_id, r]));
  const threadMap = new Map(threads.map((t: any) => [t.id, t]));

  return rows.map((r) => {
    const rep = r.reply_to_id ? replyMap.get(r.reply_to_id) : null;
    const th = r.thread_id ? threadMap.get(r.thread_id) : null;
    return {
      id: r.id, channel_id: r.channel_id, type: r.type, content: r.content, nonce: r.nonce ?? null,
      author: r.author_id ? authorMap.get(r.author_id) ?? null : null,
      created_at: r.created_at.toISOString(), edited_at: r.edited_at ? r.edited_at.toISOString() : null,
      pinned: r.pinned,
      reply_to_id: r.reply_to_id,
      reply_to: r.reply_to_id
        ? rep
          ? { id: rep.reply_id, content: String(rep.reply_content).slice(0, 200), author: rep.author_id ? publicUser({ ...rep, id: rep.author_id }) : null }
          : { id: r.reply_to_id, content: '', author: null, deleted: true }
        : null,
      attachments: atts.filter((a: any) => a.message_id === r.id).map(attachmentJson),
      reactions: reacts.filter((x: any) => x.message_id === r.id).map((x: any) => ({ emoji: x.emoji, count: x.count, user_ids: x.user_ids })),
      mention_everyone: r.mention_everyone, mention_user_ids: r.mention_user_ids ?? [], mention_role_ids: r.mention_role_ids ?? [],
      mention_channel_ids: r.mention_channel_ids ?? [],
      thread: th ? { id: th.id, name: th.name, message_count: th.message_count, archived: th.archived } : null,
    };
  });
}

export function channelJson(c: any, myPermissions?: number) {
  return {
    id: c.id, server_id: c.server_id, category_id: c.category_id, parent_channel_id: c.parent_channel_id,
    type: c.type, name: c.name, topic: c.topic, position: c.position, owner_id: c.owner_id,
    slowmode_seconds: c.slowmode_seconds, archived: c.archived, last_message_id: c.last_message_id,
    icon_url: mediaUrl(c.icon_key),
    created_at: c.created_at instanceof Date ? c.created_at.toISOString() : c.created_at,
    ...(myPermissions !== undefined ? { my_permissions: myPermissions } : {}),
  };
}

export function roleJson(r: any) {
  return {
    id: r.id, server_id: r.server_id, name: r.name, color: r.color, position: r.position,
    permissions: Number(r.permissions), is_default: r.is_default, hoist: r.hoist, mentionable: r.mentionable,
  };
}
