import { useMemo } from 'react';
import { LuPlus, LuX, LuUsers, LuHouse, LuSearch } from 'react-icons/lu';
import { useStore, openModal, presenceOf, cmpId } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import { isUnread } from '../lib/actions.ts';
import { api } from '../lib/api.ts';
import type { DmChannel } from '../lib/types.ts';
import { Avatar, Badge, cx } from '../components/ui.tsx';

export function dmTitle(d: DmChannel, meId?: string) {
  if (d.type === 'group_dm') return d.name || d.recipients.filter((r) => r.id !== meId).map((r) => r.display_name || r.username).join(', ') || 'Empty group';
  const other = d.recipients.find((r) => r.id !== meId) ?? d.recipients[0];
  return other ? other.display_name || other.username : 'Conversation';
}

export function DmSidebar() {
  const dms = useStore((s) => s.dms);
  const meId = useStore((s) => s.me?.id);
  const route = useStore((s) => s.route);
  const list = useMemo(() => Object.values(dms).sort((a, b) => cmpId(b.last_message_id ?? b.id, a.last_message_id ?? a.id)), [dms]);
  const activeId = route.name === 'home' ? route.dmId : undefined;

  return (
    <>
      <div className="h-12 px-2.5 flex items-center border-b border-line shrink-0">
        <button className="w-full h-7 rounded-md bg-rail text-muted text-[0.82rem] text-left px-2 flex items-center gap-1.5 hover:text-fg" onClick={() => openModal({ kind: 'newDm' })}>
          <LuSearch size={13} /> Find or start a conversation
        </button>
      </div>
      <div className="flex-1 min-h-0 scroll px-2 py-2 flex flex-col gap-0.5">
        <button onClick={() => navigate('/channels/@me')}
          className={cx('flex items-center gap-3 h-10 px-2 rounded-md text-left', route.name === 'home' && !activeId ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg')}>
          <LuHouse size={20} /> <span className="font-medium">Home</span>
        </button>
        <button onClick={() => navigate('/discover')}
          className={cx('flex items-center gap-3 h-10 px-2 rounded-md text-left', route.name === 'discover' ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg')}>
          <LuUsers size={20} /> <span className="font-medium">Discover servers</span>
        </button>
        <div className="flex items-center justify-between mt-4 mb-1 px-2">
          <h2 className="text-[0.78rem] font-semibold text-muted">Direct messages</h2>
          <button aria-label="New message" data-tip="New message" className="text-muted hover:text-fg" onClick={() => openModal({ kind: 'newDm' })}><LuPlus size={16} /></button>
        </div>
        {list.map((d) => <DmRow key={d.id} dm={d} meId={meId} active={d.id === activeId} />)}
        {!list.length && <p className="px-2 py-3 text-sm text-muted leading-relaxed">No conversations yet. Start one with someone from a server you share, or search by username.</p>}
      </div>
    </>
  );
}

function DmRow({ dm, meId, active }: { dm: DmChannel; meId?: string; active: boolean }) {
  const unread = useStore((s) => isUnread(dm.id, s));
  const mentions = useStore((s) => s.readStates[dm.id]?.mention_count ?? 0);
  const other = dm.type === 'dm' ? dm.recipients.find((r) => r.id !== meId) ?? null : null;
  const status = useStore(() => (other ? presenceOf(other.id).status : undefined));
  const custom = useStore((s) => (other ? s.presences[other.id]?.custom_status : null));
  const inCall = useStore((s) => Object.values(s.voice).some((v) => v.channel_id === dm.id));
  const title = dmTitle(dm, meId);
  return (
    <div className="group relative">
      <button onClick={() => navigate(`/channels/@me/${dm.id}`)}
        className={cx('w-full flex items-center gap-3 h-11 px-2 rounded-md text-left',
          active ? 'bg-active text-fg' : unread ? 'text-fg hover:bg-hover' : 'text-muted hover:bg-hover hover:text-fg')}>
        {other ? <Avatar user={other} size={32} status={status} /> : (
          <span className="size-8 rounded-full bg-flag-blue grid place-items-center text-white shrink-0"><LuUsers size={16} /></span>
        )}
        <span className="flex-1 min-w-0">
          <span className={cx('block truncate text-[0.95rem]', unread && 'font-semibold')}>{title}</span>
          {dm.type === 'group_dm'
            ? <span className="block truncate text-xs text-muted">{dm.recipients.length} members</span>
            : custom ? <span className="block truncate text-xs text-muted">{custom}</span> : null}
        </span>
        {inCall && <span className="size-2 rounded-full bg-ok" data-tip="Call in progress" aria-label="Call in progress" />}
        <Badge count={mentions} />
      </button>
      <button aria-label={dm.type === 'group_dm' ? 'Leave group' : 'Close conversation'} data-tip={dm.type === 'group_dm' ? 'Leave group' : 'Close'}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-fg opacity-0 group-hover:opacity-100 focus:opacity-100"
        onClick={() => { void api.del(`/api/dms/${dm.id}`); if (active) navigate('/channels/@me'); }}>
        <LuX size={15} />
      </button>
    </div>
  );
}
