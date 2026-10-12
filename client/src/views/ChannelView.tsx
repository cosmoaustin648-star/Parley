import { useEffect, useState } from 'react';
import {
  LuHash, LuVolume2, LuMenu, LuUsers, LuPin, LuBell, LuBellOff, LuSearch, LuPhone, LuVideo, LuUserPlus, LuMessagesSquare, LuAtSign, LuX,
} from 'react-icons/lu';
import { useStore, setUi, openModal, getChannel } from '../lib/store.ts';
import { voice, useVoice } from '../voice/engine.ts';
import { api } from '../lib/api.ts';
import { run } from '../lib/actions.ts';
import { isChannelMuted } from '../lib/notify.ts';
import type { DmChannel } from '../lib/types.ts';
import { IconButton, Popover, Avatar, cx, inputCls } from '../components/ui.tsx';
import { MessageList } from './MessageList.tsx';
import { Composer } from './Composer.tsx';
import { MemberList, DmMemberList } from './MemberList.tsx';
import { VoiceStage } from './VoiceStage.tsx';
import { ThreadPanel } from './ThreadPanel.tsx';
import { SearchPanel } from './SearchPanel.tsx';
import { PinsPanel } from './PinsPanel.tsx';
import { ThreadsList } from './ThreadsList.tsx';
import { ChannelMenu } from './ChannelSidebar.tsx';
import { dmTitle } from './DmSidebar.tsx';
import { Markdown } from '../lib/markdown.tsx';

export function ChannelView({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels[channelId] ?? s.dms[channelId]);
  const ui = useStore((s) => s.ui);
  const meId = useStore((s) => s.me?.id);
  const presence = useStore((s) => {
    const ch = s.dms[channelId];
    const other = ch?.type === 'dm' ? ch.recipients.find((r) => r.id !== meId) : undefined;
    return other ? s.presences[other.id]?.status ?? 'offline' : undefined;
  });
  const muted = useStore(() => isChannelMuted(channelId));
  const inThisCall = useVoice((v) => v.channelId === channelId);
  const callActive = useStore((s) => Object.values(s.voice).some((v) => v.channel_id === channelId));
  const [pinsAnchor, setPinsAnchor] = useState<HTMLElement | null>(null);
  const [threadsAnchor, setThreadsAnchor] = useState<HTMLElement | null>(null);
  const [bellAnchor, setBellAnchor] = useState<HTMLElement | null>(null);
  const [topicOpen, setTopicOpen] = useState(false);

  useEffect(() => { setUi({ searchOpen: false, pinsOpen: false }); }, [channelId]);
  useEffect(() => {
    // Close a thread panel that belongs to another channel.
    const t = ui.threadId ? getChannel(ui.threadId) : undefined;
    if (ui.threadId && t?.parent_channel_id !== channelId) setUi({ threadId: null });
  }, [channelId]);

  if (!channel) return null;
  const isDm = channel.type === 'dm' || channel.type === 'group_dm';
  const isVoice = channel.type === 'voice';
  const dm = isDm ? (channel as DmChannel) : null;
  const other = dm?.type === 'dm' ? dm.recipients.find((r) => r.id !== meId) : undefined;
  const title = isDm ? dmTitle(dm!, meId) : channel.name;

  const right = ui.searchOpen ? <SearchPanel channel={channel} />
    : ui.threadId ? <ThreadPanel threadId={ui.threadId} />
    : isDm ? (dm!.type === 'group_dm' && ui.membersOpen ? <DmMemberList dm={dm!} /> : null)
    : ui.membersOpen ? <MemberList serverId={channel.server_id!} channelId={channel.id} /> : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-line bg-deck">
        <IconButton label="Open navigation" className="md:hidden" onClick={() => setUi({ mobileNav: true })}><LuMenu size={20} /></IconButton>
        {isDm ? (other ? <Avatar user={other} size={24} status={presence as any} ring="var(--c-deck)" /> : <LuUsers className="text-muted" />)
          : isVoice ? <LuVolume2 className="text-muted shrink-0" size={20} /> : <LuHash className="text-muted shrink-0" size={20} />}
        <h1 className="font-display font-bold truncate min-w-0 max-w-[40%]">{title}</h1>
        {channel.topic && !isDm && (
          <>
            <span className="w-px h-6 bg-line mx-1 max-md:hidden" aria-hidden />
            <button className="text-sm text-muted truncate min-w-0 flex-1 text-left hover:text-fg max-md:hidden" onClick={() => setTopicOpen(true)} title={channel.topic}>{channel.topic}</button>
          </>
        )}
        <div className="flex-1" />
        {isDm && (
          <>
            <IconButton label={inThisCall ? 'In call' : callActive ? 'Join call' : 'Start voice call'} active={inThisCall} onClick={() => void voice.join(channelId)}><LuPhone size={19} /></IconButton>
            <IconButton label="Start video call" onClick={async () => { await voice.join(channelId); setTimeout(() => void voice.setCamera(true), 600); }}><LuVideo size={19} /></IconButton>
            {dm!.type === 'group_dm'
              ? <IconButton label="Edit group" onClick={() => openModal({ kind: 'editGroup', channelId })}><LuUserPlus size={19} /></IconButton>
              : null}
          </>
        )}
        {!isDm && !isVoice && (
          <IconButton label="Threads" onClick={(e: MouseEvent) => setThreadsAnchor(e.currentTarget as HTMLElement)}><LuMessagesSquare size={19} /></IconButton>
        )}
        {!isVoice && (
          <IconButton label={muted ? 'Notifications muted' : 'Notification settings'} active={muted} onClick={(e: MouseEvent) => setBellAnchor(e.currentTarget as HTMLElement)}>
            {muted ? <LuBellOff size={19} /> : <LuBell size={19} />}
          </IconButton>
        )}
        {!isVoice && <IconButton label="Pinned messages" onClick={(e: MouseEvent) => setPinsAnchor(e.currentTarget as HTMLElement)}><LuPin size={19} /></IconButton>}
        {(channel.server_id || dm?.type === 'group_dm') && (
          <IconButton label={ui.membersOpen ? 'Hide member list' : 'Show member list'} active={ui.membersOpen && !ui.threadId && !ui.searchOpen}
            className="max-lg:hidden" onClick={() => setUi({ membersOpen: !ui.membersOpen, threadId: null, searchOpen: false })}><LuUsers size={19} /></IconButton>
        )}
        {channel.server_id && (
          <IconButton label="Members" className="lg:hidden" onClick={() => setUi({ mobileMembers: true })}><LuUsers size={19} /></IconButton>
        )}
        {!isVoice && (
          <form className="relative max-md:hidden" onSubmit={(e: Event) => { e.preventDefault(); setUi({ searchOpen: true, threadId: null }); }}>
            <input aria-label="Search messages" placeholder="Search" value={ui.searchQuery} onChange={(e: any) => setUi({ searchQuery: e.target.value })}
              onFocus={(e: any) => e.target.select()} className={cx(inputCls, 'h-7 w-40 focus:w-56 text-sm pl-2 pr-7 bg-rail transition-[width]')} />
            {ui.searchOpen
              ? <button type="button" aria-label="Close search" className="absolute right-1.5 top-1.5 text-muted hover:text-fg" onClick={() => setUi({ searchOpen: false, searchQuery: '' })}><LuX size={15} /></button>
              : <LuSearch size={15} className="absolute right-2 top-1.5 text-muted pointer-events-none" />}
          </form>
        )}
        {!isVoice && <IconButton label="Search messages" className="md:hidden" onClick={() => setUi({ searchOpen: true, threadId: null })}><LuSearch size={19} /></IconButton>}
      </header>

      <div className="flex-1 min-h-0 flex relative">
        <section className="flex-1 min-w-0 flex flex-col" aria-label={`${title} messages`}>
          {isVoice ? <VoiceStage channelId={channelId} /> : (
            <>
              {isDm && (inThisCall || callActive) && <VoiceStage channelId={channelId} compact />}
              <MessageList channelId={channelId} />
              <Composer channelId={channelId} />
            </>
          )}
        </section>
        {right && <aside className="w-60 xl:w-64 max-lg:hidden border-l border-line flex flex-col min-h-0 bg-side shrink-0 data-[wide=true]:w-[26rem]" data-wide={!!(ui.searchOpen || ui.threadId)}>{right}</aside>}
        {/* Mobile overlays for right panels */}
        {(ui.searchOpen || ui.threadId) && <aside className="lg:hidden absolute inset-0 z-20 bg-side flex flex-col">{right}</aside>}
        {ui.mobileMembers && channel.server_id && (
          <>
            <div className="lg:hidden fixed inset-0 z-30 bg-black/50" onClick={() => setUi({ mobileMembers: false })} />
            <aside className="lg:hidden fixed right-0 inset-y-0 z-40 w-72 max-w-[85vw] bg-side flex flex-col [animation:slide-in-right_160ms_ease-out]">
              <MemberList serverId={channel.server_id} channelId={channel.id} />
            </aside>
          </>
        )}
      </div>

      {pinsAnchor && <Popover anchor={pinsAnchor} onClose={() => setPinsAnchor(null)} placement="bottom-end" className="w-[26rem] max-w-[92vw]"><PinsPanel channelId={channelId} onClose={() => setPinsAnchor(null)} /></Popover>}
      {threadsAnchor && <Popover anchor={threadsAnchor} onClose={() => setThreadsAnchor(null)} placement="bottom-end" className="w-[22rem] max-w-[92vw]"><ThreadsList channelId={channelId} onClose={() => setThreadsAnchor(null)} /></Popover>}
      {bellAnchor && (
        <Popover anchor={bellAnchor} onClose={() => setBellAnchor(null)} placement="bottom-end">
          {isDm
            ? <DmNotifMenu channelId={channelId} onClose={() => setBellAnchor(null)} />
            : <ChannelMenu channel={channel} onClose={() => setBellAnchor(null)} />}
        </Popover>
      )}
      {topicOpen && (
        <Popover anchor={{ x: innerWidth / 2 - 200, y: 60 }} onClose={() => setTopicOpen(false)} className="w-[28rem] max-w-[92vw] p-4">
          <h2 className="font-display font-bold mb-2">#{channel.name}</h2>
          <Markdown content={channel.topic} serverId={channel.server_id} />
        </Popover>
      )}
    </div>
  );
}

function DmNotifMenu({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const notif = useStore((s) => s.notif[`channel:${channelId}`]);
  const set = (muted: boolean, hours?: number) => {
    onClose();
    void run(() => api.put('/api/notification-settings', { scope_type: 'channel', scope_id: channelId, muted, muted_until: hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null }));
  };
  return (
    <div className="p-1.5 flex flex-col min-w-52" role="menu">
      {notif?.muted
        ? <button role="menuitem" className="text-left px-2 h-8 rounded-md hover:bg-accent hover:text-accent-ink text-sm" onClick={() => set(false)}>Unmute conversation</button>
        : [[1, 'For 1 hour'], [8, 'For 8 hours'], [24, 'For 24 hours'], [0, 'Until I turn it back on']].map(([h, l]) => (
          <button key={String(h)} role="menuitem" className="text-left px-2 h-8 rounded-md hover:bg-accent hover:text-accent-ink text-sm" onClick={() => set(true, h as number)}>Mute {String(l).toLowerCase()}</button>
        ))}
      <span className="sr-only"><LuAtSign /></span>
    </div>
  );
}
