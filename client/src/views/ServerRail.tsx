import { useMemo } from 'react';
import { LuPlus, LuCompass, LuMessageCircle } from 'react-icons/lu';
import { useStore, openModal, confirmDialog, type State } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import { isUnread, run } from '../lib/actions.ts';
import { isChannelMuted, isServerMuted } from '../lib/notify.ts';
import { api } from '../lib/api.ts';
import { Badge, ServerIcon, cx, Popover, Menu, useMenu, Logo } from '../components/ui.tsx';
import { P, has } from '../../../shared/permissions.ts';

function serverUnread(s: State, serverId: string) {
  let unread = false, mentions = 0;
  for (const c of Object.values(s.channels)) {
    if (c.server_id !== serverId || c.type === 'voice') continue;
    mentions += s.readStates[c.id]?.mention_count ?? 0;
    if (!unread && isUnread(c.id, s) && !isChannelMuted(c.id)) unread = true;
  }
  return { unread: unread && !isServerMuted(serverId), mentions };
}

function RailItem({ active, unread, mentions, label, onClick, onContextMenu, children, tone = 'default' }: {
  active?: boolean; unread?: boolean; mentions?: number; label: string; onClick: () => void; onContextMenu?: (e: MouseEvent) => void; children: any; tone?: 'default' | 'action';
}) {
  return (
    <div className="relative w-full flex justify-center group">
      {/* Halyard: the yellow line marks where you are; a short nub marks unread */}
      <span className={cx('absolute left-0 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-fg transition-all',
        active ? 'h-10 bg-accent' : unread ? 'h-2' : 'h-0 group-hover:h-5')} aria-hidden />
      <button aria-label={label} data-tip={label} data-tip-side="right" data-active={active} onClick={onClick} onContextMenu={onContextMenu}
        className={cx('tile size-12 overflow-hidden grid place-items-center relative',
          tone === 'action' ? (active ? 'bg-accent text-accent-ink' : 'bg-side text-ok hover:bg-ok hover:text-white') : 'bg-side text-fg',
        )}>
        {children}
      </button>
      {!!mentions && <span className="absolute -bottom-0.5 right-2.5 pointer-events-none ring-[3px] ring-rail rounded-full"><Badge count={mentions} /></span>}
    </div>
  );
}

function ServerItem({ id, active }: { id: string; active: boolean }) {
  const server = useStore((s) => s.servers[id]);
  const status = useStore((s) => { const r = serverUnread(s, id); return `${r.unread ? 1 : 0}:${r.mentions}`; });
  const lastChannel = useStore((s) => s.ui.lastChannelByServer[id]);
  const me = useStore((s) => s.me);
  const menu = useMenu();
  const [unread, mentions] = status.split(':').map(Number);
  if (!server) return null;
  const owner = server.owner_id === me?.id;
  return (
    <>
      <RailItem label={server.name} active={active} unread={!!unread} mentions={mentions}
        onClick={() => navigate(`/channels/${id}${lastChannel ? '/' + lastChannel : ''}`)} onContextMenu={menu.open}>
        <ServerIcon server={server} size={48} className="size-12" />
      </RailItem>
      {menu.at && (
        <Popover anchor={menu.at} onClose={menu.close}>
          <Menu onClose={menu.close} items={[
            { label: 'Mark as read', onSelect: () => void run(() => api.post(`/api/servers/${id}/ack`)) },
            { separator: true, label: '' },
            ...(has(server.my_permissions, P.CREATE_INVITE) ? [{ label: 'Invite people', onSelect: () => openModal({ kind: 'invite', serverId: id }) }] : []),
            { label: 'Notification settings', onSelect: () => openModal({ kind: 'serverSettings', serverId: id, tab: 'notifications' }) },
            ...(has(server.my_permissions, P.MANAGE_SERVER) || has(server.my_permissions, P.MANAGE_ROLES) || has(server.my_permissions, P.VIEW_AUDIT_LOG) || has(server.my_permissions, P.BAN_MEMBERS)
              ? [{ label: 'Server settings', onSelect: () => openModal({ kind: 'serverSettings', serverId: id }) }] : []),
            ...(!owner ? [{ separator: true, label: '' }, {
              label: 'Leave server', danger: true, onSelect: () => confirmDialog({
                title: `Leave ${server.name}?`, body: "You won't be able to rejoin unless you're invited again.", confirmLabel: 'Leave server', danger: true,
                onConfirm: async () => { await api.post(`/api/servers/${id}/leave`); },
              }),
            }] : []),
          ]} />
        </Popover>
      )}
    </>
  );
}

export function ServerRail() {
  const order = useStore((s) => s.serverOrder);
  const route = useStore((s) => s.route);
  const dmMentions = useStore((s) => Object.values(s.dms).reduce((n, d) => n + (s.readStates[d.id]?.mention_count ?? 0), 0));
  const unreadDms = useStore((s) => Object.values(s.dms).filter((d) => (s.readStates[d.id]?.mention_count ?? 0) > 0).map((d) => d.id).join(','));
  const dms = useStore((s) => s.dms);
  const meId = useStore((s) => s.me?.id);
  const unreadDmList = useMemo(() => unreadDms ? unreadDms.split(',').map((id) => dms[id]).filter(Boolean) : [], [unreadDms, dms]);

  return (
    <div className="w-[72px] shrink-0 bg-rail flex flex-col items-center py-3 gap-2 scroll scroll-none" aria-label="Servers">
      <RailItem label="Direct messages" active={route.name === 'home'} mentions={dmMentions} onClick={() => navigate('/channels/@me')}>
        <span className={cx('size-full grid place-items-center', route.name === 'home' ? 'bg-accent text-accent-ink' : 'text-fg')}>
          {route.name === 'home' ? <LuMessageCircle size={24} /> : <Logo size={30} />}
        </span>
      </RailItem>
      {unreadDmList.slice(0, 5).map((d) => {
        const other = d.recipients.find((r) => r.id !== meId) ?? d.recipients[0];
        const name = d.type === 'group_dm' ? d.name || d.recipients.map((r) => r.display_name || r.username).join(', ') : other?.display_name || other?.username;
        return (
          <RailItem key={d.id} label={name ?? 'Conversation'} mentions={0} unread onClick={() => navigate(`/channels/@me/${d.id}`)}>
            {other?.avatar_url ? <img src={other.avatar_url} alt="" className="size-12 object-cover" /> : <span className="size-12 grid place-items-center bg-active font-semibold">{(name ?? '?').slice(0, 1).toUpperCase()}</span>}
          </RailItem>
        );
      })}
      <div className="w-8 h-0.5 rounded-full bg-line my-1 shrink-0" aria-hidden />
      {order.map((id) => <ServerItem key={id} id={id} active={route.name === 'server' && route.serverId === id} />)}
      <RailItem label="Add a server" tone="action" onClick={() => openModal({ kind: 'createServer' })}><LuPlus size={24} /></RailItem>
      <RailItem label="Discover public servers" tone="action" active={route.name === 'discover'} onClick={() => navigate('/discover')}><LuCompass size={22} /></RailItem>
    </div>
  );
}

