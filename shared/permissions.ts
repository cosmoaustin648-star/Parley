/**
 * Permission bitfield shared by server (enforcement) and client (UI hints).
 * The server is always the source of truth; the client only uses this to hide
 * controls a user can't use.
 */
export const P = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  MANAGE_MESSAGES: 1 << 2, // delete others' messages, pin
  MANAGE_CHANNELS: 1 << 3,
  MANAGE_ROLES: 1 << 4,
  MANAGE_SERVER: 1 << 5,
  CREATE_INVITE: 1 << 6,
  MANAGE_INVITES: 1 << 7, // view & revoke all invites
  KICK_MEMBERS: 1 << 8,
  BAN_MEMBERS: 1 << 9,
  MODERATE_MEMBERS: 1 << 10, // timeouts
  CONNECT: 1 << 11,
  SPEAK: 1 << 12,
  VIDEO: 1 << 13, // camera + screen share
  MUTE_MEMBERS: 1 << 14,
  DEAFEN_MEMBERS: 1 << 15,
  MOVE_MEMBERS: 1 << 16,
  ATTACH_FILES: 1 << 17,
  ADD_REACTIONS: 1 << 18,
  MENTION_EVERYONE: 1 << 19,
  READ_HISTORY: 1 << 20,
  VIEW_AUDIT_LOG: 1 << 21,
  ADMINISTRATOR: 1 << 22,
  CREATE_THREADS: 1 << 23,
  CHANGE_NICKNAME: 1 << 24,
  MANAGE_NICKNAMES: 1 << 25,
} as const;
export type PermName = keyof typeof P;

export const ALL_PERMISSIONS = Object.values(P).reduce((a, b) => a | b, 0);

export const PERMISSION_INFO: { key: PermName; label: string; description: string; group: 'General' | 'Membership' | 'Text' | 'Voice' | 'Advanced' }[] = [
  { key: 'VIEW_CHANNEL', label: 'View Channels', description: 'See channels and read messages.', group: 'General' },
  { key: 'MANAGE_CHANNELS', label: 'Manage Channels', description: 'Create, edit and delete channels and categories.', group: 'General' },
  { key: 'MANAGE_ROLES', label: 'Manage Roles', description: 'Create and edit roles below their highest role, and assign them.', group: 'General' },
  { key: 'MANAGE_SERVER', label: 'Manage Server', description: 'Change server name, icon, description, rules and AutoMod.', group: 'General' },
  { key: 'VIEW_AUDIT_LOG', label: 'View Audit Log', description: 'See the moderation and change history.', group: 'General' },
  { key: 'CREATE_INVITE', label: 'Create Invite', description: 'Invite new people to the server.', group: 'Membership' },
  { key: 'MANAGE_INVITES', label: 'Manage Invites', description: 'View and revoke every invite.', group: 'Membership' },
  { key: 'CHANGE_NICKNAME', label: 'Change Nickname', description: 'Change their own nickname in this server.', group: 'Membership' },
  { key: 'MANAGE_NICKNAMES', label: 'Manage Nicknames', description: "Change other members' nicknames.", group: 'Membership' },
  { key: 'KICK_MEMBERS', label: 'Kick Members', description: 'Remove members (they can rejoin with an invite).', group: 'Membership' },
  { key: 'BAN_MEMBERS', label: 'Ban Members', description: 'Permanently remove members and block rejoining.', group: 'Membership' },
  { key: 'MODERATE_MEMBERS', label: 'Timeout Members', description: 'Temporarily stop members from chatting or speaking.', group: 'Membership' },
  { key: 'SEND_MESSAGES', label: 'Send Messages', description: 'Send messages in text channels.', group: 'Text' },
  { key: 'CREATE_THREADS', label: 'Create Threads', description: 'Start threads from messages.', group: 'Text' },
  { key: 'ATTACH_FILES', label: 'Attach Files', description: 'Upload images, video and files.', group: 'Text' },
  { key: 'ADD_REACTIONS', label: 'Add Reactions', description: 'React to messages with emoji.', group: 'Text' },
  { key: 'MENTION_EVERYONE', label: 'Mention @everyone', description: 'Ping everyone, and mention roles that are not mentionable.', group: 'Text' },
  { key: 'MANAGE_MESSAGES', label: 'Manage Messages', description: "Delete others' messages and pin messages.", group: 'Text' },
  { key: 'READ_HISTORY', label: 'Read Message History', description: 'Read messages sent before they opened the channel.', group: 'Text' },
  { key: 'CONNECT', label: 'Connect', description: 'Join voice channels.', group: 'Voice' },
  { key: 'SPEAK', label: 'Speak', description: 'Talk in voice channels.', group: 'Voice' },
  { key: 'VIDEO', label: 'Video & Screen Share', description: 'Turn on camera or share screen.', group: 'Voice' },
  { key: 'MUTE_MEMBERS', label: 'Mute Members', description: 'Server-mute others in voice.', group: 'Voice' },
  { key: 'DEAFEN_MEMBERS', label: 'Deafen Members', description: 'Server-deafen others in voice.', group: 'Voice' },
  { key: 'MOVE_MEMBERS', label: 'Move Members', description: 'Move or disconnect others between voice channels.', group: 'Voice' },
  { key: 'ADMINISTRATOR', label: 'Administrator', description: 'Every permission, and bypasses channel overrides. Grant with care.', group: 'Advanced' },
];

export const DEFAULT_EVERYONE =
  P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_HISTORY | P.ADD_REACTIONS | P.ATTACH_FILES | P.CREATE_INVITE |
  P.CONNECT | P.SPEAK | P.VIDEO | P.CREATE_THREADS | P.CHANGE_NICKNAME;

export const DEFAULT_MODERATOR =
  P.MANAGE_MESSAGES | P.KICK_MEMBERS | P.BAN_MEMBERS | P.MODERATE_MEMBERS | P.MUTE_MEMBERS |
  P.DEAFEN_MEMBERS | P.MOVE_MEMBERS | P.VIEW_AUDIT_LOG | P.MANAGE_NICKNAMES | P.MANAGE_INVITES;

/** Permissions stripped while a member is timed out. */
export const TIMEOUT_DENY = P.SEND_MESSAGES | P.ADD_REACTIONS | P.SPEAK | P.VIDEO | P.CREATE_THREADS | P.ATTACH_FILES;

export const has = (perms: number, flag: number) => (perms & flag) === flag;

export interface RoleLike { id: string; permissions: number; position: number; is_default: boolean }
export interface OverwriteLike { target_type: 'role' | 'member'; target_id: string; allow: number; deny: number }

export interface PermissionInput {
  ownerId: string;
  userId: string;
  roles: RoleLike[];           // all server roles
  memberRoleIds: string[];     // role ids assigned to the member
  timedOutUntil?: string | Date | null;
}

/** Server-level permissions (no channel context). */
export function computeBasePermissions(i: PermissionInput): number {
  if (i.userId === i.ownerId) return ALL_PERMISSIONS;
  const everyone = i.roles.find((r) => r.is_default);
  let perms = everyone ? everyone.permissions : 0;
  const assigned = new Set(i.memberRoleIds);
  for (const r of i.roles) if (assigned.has(r.id)) perms |= r.permissions;
  if (has(perms, P.ADMINISTRATOR)) return ALL_PERMISSIONS;
  if (isTimedOut(i.timedOutUntil)) perms &= ~TIMEOUT_DENY;
  return perms;
}

export function isTimedOut(until?: string | Date | null) {
  return !!until && new Date(until).getTime() > Date.now();
}

/**
 * Channel permissions, Discord-style:
 * base → @everyone overwrite → combined role overwrites (deny, then allow) → member overwrite.
 */
export function computeChannelPermissions(i: PermissionInput, overwrites: OverwriteLike[]): number {
  const base = computeBasePermissions(i);
  if (has(base, P.ADMINISTRATOR)) return ALL_PERMISSIONS;
  let perms = base;
  const everyone = i.roles.find((r) => r.is_default);
  const ow = (type: 'role' | 'member', id: string) => overwrites.find((o) => o.target_type === type && o.target_id === id);
  if (everyone) {
    const e = ow('role', everyone.id);
    if (e) perms = (perms & ~e.deny) | e.allow;
  }
  let allow = 0, deny = 0;
  for (const rid of i.memberRoleIds) {
    const o = ow('role', rid);
    if (o) { allow |= o.allow; deny |= o.deny; }
  }
  perms = (perms & ~deny) | allow;
  const m = ow('member', i.userId);
  if (m) perms = (perms & ~m.deny) | m.allow;
  if (isTimedOut(i.timedOutUntil)) perms &= ~TIMEOUT_DENY;
  // Without VIEW_CHANNEL nothing else in the channel applies.
  if (!has(perms, P.VIEW_CHANNEL)) return 0;
  return perms;
}

/** Highest role position for hierarchy checks (owner = Infinity). */
export function highestPosition(i: Pick<PermissionInput, 'ownerId' | 'userId' | 'roles' | 'memberRoleIds'>): number {
  if (i.userId === i.ownerId) return Number.POSITIVE_INFINITY;
  const assigned = new Set(i.memberRoleIds);
  let max = 0;
  for (const r of i.roles) if (assigned.has(r.id) && r.position > max) max = r.position;
  return max;
}
