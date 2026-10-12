export interface User {
  id: string; username: string; display_name: string | null; avatar_url: string | null; banner_url: string | null;
  accent_color: string | null; bio: string; custom_status: string | null; created_at: string; is_demo?: boolean;
}
export type StatusPref = 'online' | 'idle' | 'dnd' | 'invisible';
export type Status = 'online' | 'idle' | 'dnd' | 'offline';

export interface Settings {
  theme?: 'harbor' | 'deep' | 'midnight' | 'daylight' | 'dark' | 'darker' | 'light';
  accent?: string; font?: 'default' | 'rounded' | 'serif' | 'mono' | 'readable';
  font_scale?: number; message_spacing?: number; compact?: boolean; reduced_motion?: boolean; high_contrast?: boolean;
  saturation?: number; underline_links?: boolean; show_timestamps_24h?: boolean;
  notifications?: { desktop?: boolean; sounds?: boolean; dm?: boolean; mentions_only_when_unfocused?: boolean };
  privacy?: { allow_dms_from_server_members?: boolean; read_receipts?: boolean; show_typing?: boolean };
  voice?: {
    input_device?: string | null; output_device?: string | null; video_device?: string | null;
    input_volume?: number; output_volume?: number; noise_suppression?: boolean; echo_cancellation?: boolean; auto_gain?: boolean;
    input_mode?: 'voice' | 'ptt'; vad_threshold?: number;
  };
  keybinds?: { toggle_mute?: string; toggle_deafen?: string; push_to_talk?: string; quick_switcher?: string; mark_read?: string };
}

export interface Me extends User { email: string; email_verified: boolean; status: StatusPref; settings: Settings; is_staff: boolean }

export interface Role { id: string; server_id: string; name: string; color: string | null; position: number; permissions: number; is_default: boolean; hoist: boolean; mentionable: boolean }
export interface Category { id: string; server_id: string; name: string; position: number }
export type ChannelType = 'text' | 'voice' | 'thread' | 'dm' | 'group_dm';
export interface Channel {
  id: string; server_id: string | null; category_id: string | null; parent_channel_id: string | null; type: ChannelType;
  name: string | null; topic: string; position: number; owner_id: string | null; slowmode_seconds: number; archived: boolean;
  last_message_id: string | null; icon_url: string | null; created_at: string; my_permissions?: number; message_count?: number; is_private?: boolean;
}
export interface DmChannel extends Channel { recipients: User[] }
export interface MemberSelf { user_id: string; nickname: string | null; role_ids: string[]; timeout_until: string | null; joined_at: string }
export interface Server {
  id: string; name: string; owner_id: string; icon_url: string | null; description: string; rules: string; is_public: boolean; is_demo?: boolean;
  system_channel_id: string | null; member_count: number; created_at: string; roles: Role[]; categories: Category[]; channels: Channel[];
  my_permissions: number; member: MemberSelf;
}
export interface Presence { user_id: string; status: Status; custom_status: string | null }
export interface Member { user: User; nickname: string | null; role_ids: string[]; joined_at: string; timeout_until: string | null; presence?: Presence }
export interface Attachment { id: string; filename: string; content_type: string; size: number; width: number | null; height: number | null; url: string }
export interface Reaction { emoji: string; count: number; user_ids: string[] }
export interface Message {
  id: string; channel_id: string; type: 'default' | 'system' | 'thread_created' | 'call'; content: string; nonce: string | null;
  author: User | null; created_at: string; edited_at: string | null; pinned: boolean;
  reply_to_id: string | null; reply_to: { id: string; content: string; author: User | null; deleted?: boolean } | null;
  attachments: Attachment[]; reactions: Reaction[];
  mention_everyone: boolean; mention_user_ids: string[]; mention_role_ids: string[]; mention_channel_ids: string[];
  thread: { id: string; name: string | null; message_count: number; archived: boolean } | null;
  mentioned_user_ids?: string[];
  // client-only
  pending?: 'sending' | 'failed'; error?: string; localFiles?: { name: string; progress: number }[];
}
export interface ReadState { channel_id: string; last_read_message_id: string | null; mention_count: number }
export interface NotifSetting { scope_type: 'server' | 'channel'; scope_id: string; level: 'all' | 'mentions' | 'none' | null; muted: boolean; muted_until: string | null; suppress_everyone: boolean }
export interface VoiceState {
  user_id: string; channel_id: string; server_id: string | null; self_mute: boolean; self_deaf: boolean; server_mute: boolean; server_deaf: boolean;
  self_video: boolean; self_stream: boolean; suppress: boolean; joined_at: number;
}
export interface Invite { code: string; server_id: string; inviter: User | null; max_uses: number | null; uses: number; expires_at: string | null; created_at: string; url: string }
