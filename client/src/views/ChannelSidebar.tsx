import { useMemo, useState } from 'react';
import {
  LuHash, LuVolume2, LuChevronDown, LuChevronRight, LuPlus, LuSettings, LuUserPlus, LuMicOff, LuHeadphoneOff, LuVideo, LuMonitorUp,
  LuLock, LuBellOff, LuLogOut, LuFolderPlus, LuBell, LuMessagesSquare, LuCornerDownRight, LuInfo,
} from 'react-icons/lu';
import { useStore, openModal, confirmDialog, setUi, displayName, getState } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import { isUnread, run, ackChannel } from '../lib/actions.ts';
import { isChannelMuted } from '../lib/notify.ts';
import { api } from '../lib/api.ts';
import { voice, useVoice } from '../voice/engine.ts';
import type { Channel, VoiceState } from '../lib/types.ts';
import { Avatar, Badge, cx, Popover, Menu, useMenu, IconButton } from '../components/ui.tsx';
import { P, has } from '../../../shared/permissions.ts';

const COLLAPSE_KEY = 'parley.collapsedCategories';
function loadCollapsed(): Record<string, boolean> { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); } catch { return {}; } }

export function ChannelSidebar({ serverId }: { serverId: string }) {
  const server = useStore((s) => s.servers[serverId]);
  const channelsMap = useStore((s) => s.channels);
  const route = useStore((s) => s.route);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [headerAnchor, setHeaderAnchor] = useState<HTMLElement | null>(null);

  const { top, groups, threadsByParent } = useMemo(() => {
    const all = Object.values(channelsMap).filter((c) => c.server_id === serverId);
    const chans = all.filter((c) => c.type !== 'thread').sort((a, b) => (a.type === b.type ? 0 : a.type === 'voice' ? 1 : -1) || a.position - b.position || a.id.localeCompare(b.id));
    const threads = new Map<string, Channel[]>();
    for (const t of all.filter((c) => c.type === 'thread' && !c.archived)) threads.set(t.parent_channel_id!, [...(threads.get(t.parent_channel_id!) ?? []), t]);
    const cats = [...(server?.categories ?? [])].sort((a, b) => a.position - b.position);
    return {
      top: chans.filter((c) => !c.category_id || !cats.some((k) => k.id === c.category_id)),
      groups: cats.map((cat) => ({ cat, items: chans.filter((c) => c.category_id === cat.id) })),
      threadsByParent: threads,
    };
  }, [channelsMap, serverId, server?.categories]);

  if (!server) return null;
  const perms = server.my_permissions;
  const canManage = has(perms, P.MANAGE_CHANNELS);
  const activeId = route.name === 'server' ? route.channelId : undefined;
  const toggle = (id: string) => {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const canSettings = has(perms, P.MANAGE_SERVER) || has(perms, P.MANAGE_ROLES) || has(perms, P.VIEW_AUDIT_LOG) || has(perms, P.BAN_MEMBERS) || has(perms, P.KICK_MEMBERS);
  const isOwner = server.owner_id === getState().me?.id;

  return (
    <>
      <button className="h-12 px-4 flex items-center gap-2 border-b border-line hover:bg-hover transition-colors text-left shrink-0"
        onClick={(e: MouseEvent) => setHeaderAnchor(e.currentTarget as HTMLElement)} aria-haspopup="menu">
        <span className="flex-1 font-display font-bold truncate">{server.name}</span>
        {server.is_demo && <span className="text-[0.65rem] font-semibold px-1.5 py-0.5 rounded bg-warn/20 text-warn" data-tip="Sample data for demonstrations">Demo</span>}
        <LuChevronDown className="text-muted shrink-0" />
      </button>
      {headerAnchor && (
        <Popover anchor={headerAnchor} onClose={() => setHeaderAnchor(null)} placement="bottom-start" className="w-56">
          <Menu onClose={() => setHeaderAnchor(null)} items={[
            ...(has(perms, P.CREATE_INVITE) ? [{ label: 'Invite people', icon: <LuUserPlus />, onSelect: () => openModal({ kind: 'invite', serverId }) }] : []),
            ...(canSettings ? [{ label: 'Server settings', icon: <LuSettings />, onSelect: () => openModal({ kind: 'serverSettings', serverId }) }] : []),
            ...(canManage ? [
              { label: 'Create channel', icon: <LuPlus />, onSelect: () => openModal({ kind: 'createChannel', serverId }) },
              { label: 'Create category', icon: <LuFolderPlus />, onSelect: () => openModal({ kind: 'createCategory', serverId }) },
            ] : []),
            { label: 'Server info and rules', icon: <LuInfo />, onSelect: () => openModal({ kind: 'serverInfo', serverId }) },
            { label: 'Notification settings', icon: <LuBell />, onSelect: () => openModal({ kind: 'serverSettings', serverId, tab: 'notifications' }) },
            { label: 'Edit server profile', icon: <LuSettings />, onSelect: () => openModal({ kind: 'serverSettings', serverId, tab: 'profile' }) },
            ...(!isOwner ? [{ separator: true, label: '' }, {
              label: 'Leave server', icon: <LuLogOut />, danger: true, onSelect: () => confirmDialog({
                title: `Leave ${server.name}?`, body: "You won't be able to rejoin unless you're invited again.", confirmLabel: 'Leave server', danger: true,
                onConfirm: async () => { await api.post(`/api/servers/${serverId}/leave`); },
              }),
            }] : []),
          ]} />
        </Popover>
      )}
      <div className="flex-1 min-h-0 scroll px-2 py-3 flex flex-col gap-0.5">
        {top.map((c) => <ChannelRow key={c.id} channel={c} active={c.id === activeId} threads={threadsByParent.get(c.id)} activeId={activeId} />)}
        {groups.map(({ cat, items }) => (
          <div key={cat.id} className="mt-3 first:mt-0">
            <div className="group flex items-center pr-1">
              <button className="flex-1 flex items-center gap-0.5 h-6 text-[0.78rem] font-semibold text-muted hover:text-fg text-left" onClick={() => toggle(cat.id)} aria-expanded={!collapsed[cat.id]}>
                {collapsed[cat.id] ? <LuChevronRight size={12} /> : <LuChevronDown size={12} />}
                <span className="truncate">{cat.name}</span>
              </button>
              {canManage && (
                <button aria-label={`Create channel in ${cat.name}`} data-tip="Create channel" className="text-muted hover:text-fg opacity-0 group-hover:opacity-100 focus:opacity-100"
                  onClick={() => openModal({ kind: 'createChannel', serverId, categoryId: cat.id })}><LuPlus size={16} /></button>
              )}
            </div>
            {items.filter((c) => !collapsed[cat.id] || c.id === activeId || (isUnread(c.id) && c.type === 'text')).map((c) => (
              <ChannelRow key={c.id} channel={c} active={c.id === activeId} threads={threadsByParent.get(c.id)} activeId={activeId} />
            ))}
          </div>
        ))}
        {!top.length && !groups.some((g) => g.items.length) && (
          <p className="text-sm text-muted px-2 py-4">No channels you can see yet.{canManage ? ' Create one from the server menu.' : ''}</p>
        )}
      </div>
    </>
  );
}

function ChannelRow({ channel: c, active, threads, activeId }: { channel: Channel; active: boolean; threads?: Channel[]; activeId?: string }) {
  const unread = useStore((s) => c.type !== 'voice' && isUnread(c.id, s));
  const mentions = useStore((s) => s.readStates[c.id]?.mention_count ?? 0);
  const muted = useStore(() => isChannelMuted(c.id));
  const threadId = useStore((s) => s.ui.threadId);
  const menu = useMenu();
  const perms = c.my_permissions ?? 0;
  const isPrivate = !!c.is_private;
  const isVoice = c.type === 'voice';
  const Icon = isVoice ? LuVolume2 : LuHash;
  const open = () => {
    if (isVoice) {
      if (voice.get().channelId !== c.id) {
        if (!has(perms, P.CONNECT)) { navigate(`/channels/${c.server_id}/${c.id}`); return; }
        void voice.join(c.id);
      }
    }
    navigate(`/channels/${c.server_id}/${c.id}`);
  };
  const visibleThreads = (threads ?? []).filter((t) => t.id === threadId || isUnread(t.id) || true).slice(0, 5);

  return (
    <>
      <div className="group relative">
        <button onClick={open} onContextMenu={menu.open}
          className={cx('w-full flex items-center gap-1.5 h-8 px-2 rounded-md text-left transition-colors',
            active ? 'bg-active text-fg' : unread && !muted ? 'text-fg hover:bg-hover' : 'text-muted hover:bg-hover hover:text-fg',
            muted && !active && 'opacity-50')}
          aria-current={active ? 'page' : undefined}>
          {unread && !muted && !active && <span className="absolute -left-2 top-1/2 -translate-y-1/2 w-1 h-2 rounded-r-full bg-fg" aria-hidden />}
          <Icon size={18} className="shrink-0 opacity-70" aria-hidden />
          <span className={cx('flex-1 truncate text-[0.95rem]', unread && !muted && 'font-semibold')}>{c.name}</span>
          {isPrivate && <LuLock size={12} className="opacity-60" />}
          {muted && <LuBellOff size={13} className="opacity-60" aria-label="Muted" />}
          {mentions > 0 && <Badge count={mentions} />}
          <span className="hidden group-hover:flex group-focus-within:flex items-center gap-0.5">
            {has(perms, P.CREATE_INVITE) && (
              <span role="button" tabIndex={0} aria-label="Invite people" data-tip="Invite people" className="p-0.5 text-muted hover:text-fg"
                onClick={(e: MouseEvent) => { e.stopPropagation(); openModal({ kind: 'invite', serverId: c.server_id! }); }}><LuUserPlus size={15} /></span>
            )}
            {has(perms, P.MANAGE_CHANNELS) && (
              <span role="button" tabIndex={0} aria-label="Edit channel" data-tip="Edit channel" className="p-0.5 text-muted hover:text-fg"
                onClick={(e: MouseEvent) => { e.stopPropagation(); openModal({ kind: 'channelSettings', channelId: c.id }); }}><LuSettings size={15} /></span>
            )}
          </span>
        </button>
        {menu.at && (
          <Popover anchor={menu.at} onClose={menu.close}>
            <ChannelMenu channel={c} onClose={menu.close} />
          </Popover>
        )}
      </div>
      {isVoice && <VoiceMembers channelId={c.id} />}
      {visibleThreads.map((t) => (
        <ThreadRow key={t.id} thread={t} active={threadId === t.id} parentActive={activeId === c.id} />
      ))}
    </>
  );
}

function ThreadRow({ thread: t, active }: { thread: Channel; active: boolean; parentActive: boolean }) {
  const unread = useStore((s) => isUnread(t.id, s));
  return (
    <button onClick={() => { navigate(`/channels/${t.server_id}/${t.parent_channel_id}`); setUi({ threadId: t.id }); }}
      className={cx('ml-4 flex items-center gap-1.5 h-7 px-2 rounded-md text-left text-[0.85rem]', active ? 'bg-active text-fg' : unread ? 'text-fg font-semibold hover:bg-hover' : 'text-muted hover:bg-hover hover:text-fg')}>
      <LuCornerDownRight size={13} className="opacity-60 shrink-0" />
      <LuMessagesSquare size={14} className="opacity-60 shrink-0" />
      <span className="truncate">{t.name}</span>
    </button>
  );
}

export function ChannelMenu({ channel: c, onClose }: { channel: Channel; onClose: () => void }) {
  const notif = useStore((s) => s.notif[`channel:${c.id}`]);
  const perms = c.my_permissions ?? 0;
  const setNotif = (patch: any) => run(() => api.put('/api/notification-settings', { scope_type: 'channel', scope_id: c.id, ...patch }));
  return (
    <Menu onClose={onClose} items={[
      { label: 'Mark as read', onSelect: () => ackChannel(c.id) },
      { label: notif?.muted ? 'Unmute channel' : 'Mute channel', onSelect: () => void setNotif({ muted: !notif?.muted, muted_until: null }) },
      { separator: true, label: '' },
      { label: 'Notify: server default', checked: !notif?.level, onSelect: () => void setNotif({ level: null }) },
      { label: 'Notify: all messages', checked: notif?.level === 'all', onSelect: () => void setNotif({ level: 'all' }) },
      { label: 'Notify: only @mentions', checked: notif?.level === 'mentions', onSelect: () => void setNotif({ level: 'mentions' }) },
      { label: 'Notify: nothing', checked: notif?.level === 'none', onSelect: () => void setNotif({ level: 'none' }) },
      ...(has(perms, P.MANAGE_CHANNELS) ? [
        { separator: true, label: '' },
        { label: 'Edit channel', onSelect: () => openModal({ kind: 'channelSettings', channelId: c.id }) },
        { label: 'Delete channel', danger: true, onSelect: () => confirmDialog({
          title: `Delete #${c.name}?`, body: 'This permanently deletes the channel and all of its messages.', confirmLabel: 'Delete channel', danger: true,
          onConfirm: async () => { await api.del(`/api/channels/${c.id}`); },
        }) },
      ] : []),
      { separator: true, label: '' },
      { label: 'Copy link', onSelect: () => { void navigator.clipboard?.writeText(`${location.origin}/channels/${c.server_id}/${c.id}`); } },
    ]} />
  );
}

export function VoiceMembers({ channelId, compact }: { channelId: string; compact?: boolean }) {
  const states = useStore((s) => s.voice);
  const users = useStore((s) => s.users);
  const myChannel = useVoice((v) => v.channelId);
  const speaking = useVoice((v) => v.speaking);
  const list = useMemo(() => Object.values(states).filter((v) => v.channel_id === channelId).sort((a, b) => a.joined_at - b.joined_at), [states, channelId]);
  if (!list.length) return null;
  return (
    <div className={cx('flex flex-col gap-0.5 pb-1', compact ? '' : 'pl-7')}>
      {list.map((v) => <VoiceUser key={v.user_id} vs={v} user={users[v.user_id]} speaking={myChannel === channelId && !!speaking[v.user_id]} />)}
    </div>
  );
}

function VoiceUser({ vs, user, speaking }: { vs: VoiceState; user: any; speaking: boolean }) {
  const name = user ? displayName(user, vs.server_id) : 'Someone';
  return (
    <button className="flex items-center gap-2 h-7 px-1.5 rounded-md hover:bg-hover text-left" onClick={() => user && openModal({ kind: 'profile', userId: vs.user_id, serverId: vs.server_id })}>
      <Avatar user={user ?? { id: vs.user_id, username: '?', display_name: null, avatar_url: null }} size={22} speaking={speaking} />
      <span className={cx('flex-1 truncate text-[0.85rem]', speaking ? 'text-fg' : 'text-muted')}>{name}</span>
      {vs.self_stream && <span className="text-[0.6rem] font-bold px-1 rounded bg-danger text-white" aria-label="Sharing screen">Live</span>}
      {vs.self_video && <LuVideo size={13} className="text-muted" aria-label="Camera on" />}
      {(vs.server_mute || vs.self_mute || vs.suppress) && <LuMicOff size={13} className={vs.server_mute ? 'text-danger' : 'text-muted'} aria-label={vs.server_mute ? 'Server muted' : 'Muted'} />}
      {(vs.server_deaf || vs.self_deaf) && <LuHeadphoneOff size={13} className={vs.server_deaf ? 'text-danger' : 'text-muted'} aria-label={vs.server_deaf ? 'Server deafened' : 'Deafened'} />}
    </button>
  );
}

export { LuMonitorUp, IconButton };
