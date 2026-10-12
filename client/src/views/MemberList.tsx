import { useEffect, useMemo, useState } from 'react';
import { useStore, openModal, displayName, getState, confirmDialog, presenceOf } from '../lib/store.ts';
import { loadMembers, openDm, run } from '../lib/actions.ts';
import { api } from '../lib/api.ts';
import type { DmChannel, Member, Role, User } from '../lib/types.ts';
import { Avatar, Spinner, cx, Popover, Menu, useMenu, type MenuItem } from '../components/ui.tsx';
import { P, has, isTimedOut } from '../../../shared/permissions.ts';
import { LuCrown } from 'react-icons/lu';

export function memberMenuItems(user: User, serverId: string | null): MenuItem[] {
  const s = getState();
  const me = s.me!;
  const items: MenuItem[] = [{ label: 'Profile', onSelect: () => openModal({ kind: 'profile', userId: user.id, serverId }) }];
  if (user.id !== me.id) items.push({ label: 'Message', onSelect: () => void openDm(user.id) });
  if (!serverId) return items;
  const server = s.servers[serverId];
  if (!server) return items;
  const perms = server.my_permissions;
  const isOwner = server.owner_id === user.id;
  const vs = s.voice[user.id];
  const inVoiceHere = vs?.server_id === serverId;
  const mod: MenuItem[] = [];
  if (user.id !== me.id && !isOwner) {
    if (has(perms, P.MODERATE_MEMBERS)) {
      const m = s.members[serverId]?.[user.id];
      if (m && isTimedOut(m.timeout_until)) mod.push({ label: 'Remove timeout', onSelect: () => void run(() => api.del(`/api/servers/${serverId}/members/${user.id}/timeout`), 'Timeout removed.') });
      else mod.push({ label: `Timeout ${displayName(user, serverId)}`, danger: true, onSelect: () => openModal({ kind: 'moderate', action: 'timeout', serverId, user }) });
    }
    if (has(perms, P.KICK_MEMBERS)) mod.push({ label: `Kick ${displayName(user, serverId)}`, danger: true, onSelect: () => openModal({ kind: 'moderate', action: 'kick', serverId, user }) });
    if (has(perms, P.BAN_MEMBERS)) mod.push({ label: `Ban ${displayName(user, serverId)}`, danger: true, onSelect: () => openModal({ kind: 'moderate', action: 'ban', serverId, user }) });
  }
  if (inVoiceHere) {
    const voice: MenuItem[] = [];
    if (has(perms, P.MUTE_MEMBERS)) voice.push({ label: vs.server_mute ? 'Server unmute' : 'Server mute', onSelect: () => void run(() => api.patch(`/api/servers/${serverId}/members/${user.id}/voice`, { mute: !vs.server_mute })) });
    if (has(perms, P.DEAFEN_MEMBERS)) voice.push({ label: vs.server_deaf ? 'Server undeafen' : 'Server deafen', onSelect: () => void run(() => api.patch(`/api/servers/${serverId}/members/${user.id}/voice`, { deaf: !vs.server_deaf })) });
    if (has(perms, P.MOVE_MEMBERS)) {
      for (const c of Object.values(s.channels).filter((c) => c.server_id === serverId && c.type === 'voice' && c.id !== vs.channel_id)) {
        voice.push({ label: `Move to ${c.name}`, onSelect: () => void run(() => api.patch(`/api/servers/${serverId}/members/${user.id}/voice`, { channel_id: c.id })) });
      }
      voice.push({ label: 'Disconnect from voice', danger: true, onSelect: () => void run(() => api.patch(`/api/servers/${serverId}/members/${user.id}/voice`, { channel_id: null })) });
    }
    if (voice.length) items.push({ separator: true, label: '' }, ...voice);
  }
  if (mod.length) items.push({ separator: true, label: '' }, ...mod);
  if (user.id !== me.id) {
    items.push({ separator: true, label: '' });
    items.push(s.blocked[user.id]
      ? { label: 'Unblock', onSelect: () => void run(() => api.del(`/api/users/@me/blocks/${user.id}`), 'Unblocked.') }
      : { label: 'Block', danger: true, onSelect: () => confirmDialog({ title: `Block ${user.username}?`, body: "They won't be able to message you directly, and their messages will be hidden for you.", confirmLabel: 'Block', danger: true, onConfirm: async () => { await api.put(`/api/users/@me/blocks/${user.id}`); } }) });
    items.push({ label: 'Report', danger: true, onSelect: () => openModal({ kind: 'report', userId: user.id, serverId }) });
  }
  return items;
}

function topHoisted(roles: Role[], ids: string[]) {
  let best: Role | null = null;
  for (const r of roles) if (r.hoist && ids.includes(r.id) && (!best || r.position > best.position)) best = r;
  return best;
}
function topColor(roles: Role[], ids: string[]) {
  let best: Role | null = null;
  for (const r of roles) if (r.color && ids.includes(r.id) && (!best || r.position > best.position)) best = r;
  return best?.color ?? null;
}

export function MemberList({ serverId, channelId }: { serverId: string; channelId: string }) {
  const members = useStore((s) => s.members[serverId]);
  const loaded = useStore((s) => s.membersLoaded[serverId]);
  const server = useStore((s) => s.servers[serverId]);
  const presences = useStore((s) => s.presences);
  const meId = useStore((s) => s.me?.id);
  useEffect(() => { void loadMembers(serverId); }, [serverId]);
  void channelId;

  const groups = useMemo(() => {
    if (!members || !server) return [];
    const roles = [...server.roles].sort((a, b) => b.position - a.position);
    const online: Record<string, Member[]> = {};
    const offline: Member[] = [];
    for (const m of Object.values(members)) {
      const st = m.user.id === meId ? presenceOf(m.user.id).status : presences[m.user.id]?.status ?? 'offline';
      if (st === 'offline') { offline.push(m); continue; }
      const r = topHoisted(roles, m.role_ids);
      (online[r?.id ?? 'online'] ??= []).push(m);
    }
    const sort = (a: Member, b: Member) => displayName(a.user, serverId).localeCompare(displayName(b.user, serverId));
    const out: { id: string; label: string; items: Member[] }[] = [];
    for (const r of roles) if (online[r.id]?.length) out.push({ id: r.id, label: r.name, items: online[r.id].sort(sort) });
    if (online.online?.length) out.push({ id: 'online', label: 'Online', items: online.online.sort(sort) });
    if (offline.length) out.push({ id: 'offline', label: 'Offline', items: offline.sort(sort) });
    return out;
  }, [members, server, presences, meId, serverId]);

  if (loaded !== 'loaded' || !server) return <div className="p-4 flex justify-center"><Spinner /></div>;
  const roles = server.roles;
  return (
    <div className="flex-1 min-h-0 scroll px-2 pb-4" aria-label="Members">
      {groups.map((g) => (
        <section key={g.id} className="mt-5">
          <h3 className="px-2 mb-1 flex justify-between text-[0.75rem] font-semibold text-muted"><span className="truncate">{g.label}</span><span className="tabular-nums">{g.items.length}</span></h3>
          {g.items.map((m) => <MemberRow key={m.user.id} m={m} serverId={serverId} color={topColor(roles, m.role_ids)} owner={server.owner_id === m.user.id} offline={g.id === 'offline'} />)}
        </section>
      ))}
    </div>
  );
}

function MemberRow({ m, serverId, color, owner, offline }: { m: Member; serverId: string | null; color: string | null; owner: boolean; offline: boolean }) {
  const presence = useStore(() => presenceOf(m.user.id));
  const user = useStore((s) => s.users[m.user.id] ?? m.user);
  const menu = useMenu();
  const [items, setItems] = useState<MenuItem[]>([]);
  const timedOut = isTimedOut(m.timeout_until);
  return (
    <>
      <button onClick={() => openModal({ kind: 'profile', userId: m.user.id, serverId })}
        onContextMenu={(e: MouseEvent) => { setItems(memberMenuItems(user, serverId)); menu.open(e); }}
        className={cx('w-full flex items-center gap-3 h-11 px-2 rounded-md hover:bg-hover text-left', offline && 'opacity-45 hover:opacity-100')}>
        <Avatar user={user} size={32} status={presence.status} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-center gap-1">
            <span className="truncate text-[0.92rem] font-medium" style={color ? { color } : undefined}>{m.nickname || user.display_name || user.username}</span>
            {owner && <LuCrown size={13} className="text-accent shrink-0" aria-label="Server owner" data-tip="Server owner" />}
            {timedOut && <span className="text-[0.62rem] px-1 rounded bg-danger/20 text-danger shrink-0" data-tip={`Timed out until ${new Date(m.timeout_until!).toLocaleString()}`}>Timed out</span>}
            {user.is_demo && <span className="text-[0.62rem] px-1 rounded bg-warn/20 text-warn shrink-0">Demo</span>}
          </span>
          {presence.custom_status && !offline && <span className="block truncate text-xs text-muted">{presence.custom_status}</span>}
        </span>
      </button>
      {menu.at && <Popover anchor={menu.at} onClose={menu.close}><Menu items={items} onClose={menu.close} /></Popover>}
    </>
  );
}

export function DmMemberList({ dm }: { dm: DmChannel }) {
  return (
    <div className="flex-1 min-h-0 scroll px-2 pb-4">
      <h3 className="px-2 mt-5 mb-1 flex justify-between text-[0.75rem] font-semibold text-muted"><span>Members</span><span>{dm.recipients.length}</span></h3>
      {dm.recipients.map((u) => (
        <MemberRow key={u.id} m={{ user: u, nickname: null, role_ids: [], joined_at: '', timeout_until: null }} serverId={null} color={null} owner={dm.owner_id === u.id} offline={false} />
      ))}
    </div>
  );
}
