import { db, type Queryable } from '../db/index.ts';

export type AuditAction =
  | 'server_update' | 'server_icon_update' | 'ownership_transfer'
  | 'channel_create' | 'channel_update' | 'channel_delete' | 'channel_overwrite_update' | 'channel_overwrite_delete'
  | 'category_create' | 'category_update' | 'category_delete'
  | 'role_create' | 'role_update' | 'role_delete' | 'role_reorder'
  | 'member_role_update' | 'member_nickname_update'
  | 'member_kick' | 'member_ban' | 'member_unban' | 'member_timeout' | 'member_timeout_remove'
  | 'member_voice_mute' | 'member_voice_deafen' | 'member_voice_move' | 'member_voice_disconnect'
  | 'message_delete' | 'message_bulk_delete' | 'message_pin' | 'message_unpin'
  | 'invite_create' | 'invite_delete'
  | 'automod_rule_create' | 'automod_rule_update' | 'automod_rule_delete' | 'automod_block' | 'automod_timeout'
  | 'report_resolve' | 'thread_create' | 'thread_update';

export async function audit(
  serverId: string, actorId: string | null, action: AuditAction,
  target?: { type: string; id: string | null }, reason?: string | null, changes: Record<string, unknown> = {}, q: Queryable = db,
) {
  await q.query(
    `INSERT INTO audit_log (server_id, actor_id, action, target_type, target_id, reason, changes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [serverId, actorId, action, target?.type ?? null, target?.id ?? null, reason ?? null, changes],
  );
}
