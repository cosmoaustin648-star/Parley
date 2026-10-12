import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  LuSmilePlus, LuReply, LuPencil, LuTrash2, LuPin, LuPinOff, LuEllipsis, LuMessagesSquare, LuFlag, LuCopy, LuArrowRight,
  LuFile, LuDownload, LuRotateCw, LuX, LuHash, LuPhone, LuArrowDown, LuCheckCheck,
} from 'react-icons/lu';
import {
  useStore, getState, setState, setUi, openModal, confirmDialog, displayName, roleColor, getChannel, cmpId, toast,
} from '../lib/store.ts';
import { loadMessages, ackChannel, retryMessage, discardMessage, run } from '../lib/actions.ts';
import { api, errMsg } from '../lib/api.ts';
import { Markdown } from '../lib/markdown.tsx';
import { timeShort, timeLong, fullDate, dayLabel, bytes } from '../lib/format.ts';
import { mentionsMe } from '../lib/notify.ts';
import { QUICK_REACTIONS } from '../lib/emoji.ts';
import type { Message, Channel, Attachment, DmChannel } from '../lib/types.ts';
import { Avatar, cx, Popover, Menu, Spinner, useMenu, EmptyState } from '../components/ui.tsx';
import { EmojiPicker } from '../components/EmojiPicker.tsx';
import { P, has } from '../../../shared/permissions.ts';
import { toEditable, fromEditable } from './Composer.tsx';
import { dmTitle } from './DmSidebar.tsx';

const GROUP_MS = 7 * 60_000;

let pendingJump: { channelId: string; id: string } | null = null;
/** Scroll to a message, loading the surrounding history if needed. */
export function jumpToMessage(channelId: string, id: string) {
  const cm = getState().messages[channelId];
  pendingJump = { channelId, id };
  if (cm?.items.some((m) => m.id === id)) setState((s) => ({ messages: { ...s.messages, [channelId]: { ...s.messages[channelId], jumpTo: id } } }));
  else void loadMessages(channelId, { around: id });
}

export function MessageList({ channelId }: { channelId: string }) {
  const cm = useStore((s) => s.messages[channelId]);
  const channel = useStore((s) => s.channels[channelId] ?? s.dms[channelId]);
  const meId = useStore((s) => s.me?.id);
  const [unreadMarker] = useState(() => getState().readStates[channelId]?.last_read_message_id ?? null);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevFirst = useRef<string | undefined>(undefined);
  const prevHeight = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);

  useEffect(() => { if (!cm?.loaded && !cm?.loading) void loadMessages(channelId); }, [channelId, cm?.loaded]);

  // DMs: fetch who has read what.
  useEffect(() => {
    if (channel?.type !== 'dm' && channel?.type !== 'group_dm') return;
    api.get<{ user_id: string; message_id: string }[]>(`/api/channels/${channelId}/read-receipts`)
      .then((rows) => setState((s) => ({ readReceipts: { ...s.readReceipts, [channelId]: Object.fromEntries(rows.map((r) => [r.user_id, r.message_id])) } })))
      .catch(() => {});
  }, [channelId, channel?.type]);

  const items = cm?.items ?? [];

  const maybeAck = useCallback(() => {
    if (atBottom.current && document.visibilityState === 'visible' && document.hasFocus()) ackChannel(channelId);
  }, [channelId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = items[0]?.id;
    if (prevFirst.current && first !== prevFirst.current && prevHeight.current && !cm?.jumpTo && items.some((m) => m.id === prevFirst.current)) {
      el.scrollTop += el.scrollHeight - prevHeight.current; // older messages were prepended
    } else if (atBottom.current && !cm?.jumpTo) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [items, cm?.jumpTo]);

  // Keep pinned to the bottom while images/embeds finish loading.
  useEffect(() => {
    const el = scroller.current, content = inner.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; prevHeight.current = el.scrollHeight; });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { maybeAck(); }, [channel?.last_message_id, maybeAck]);
  useEffect(() => {
    const f = () => maybeAck();
    window.addEventListener('focus', f);
    document.addEventListener('visibilitychange', f);
    return () => { window.removeEventListener('focus', f); document.removeEventListener('visibilitychange', f); };
  }, [maybeAck]);

  // Jump-to-message handling (search results, replies, pins).
  useEffect(() => {
    const target = cm?.jumpTo ?? (pendingJump?.channelId === channelId ? pendingJump.id : null);
    if (!target || !cm?.loaded) return;
    const el = scroller.current?.querySelector(`[data-mid="${target}"]`) as HTMLElement | null;
    if (el) {
      atBottom.current = false;
      el.scrollIntoView({ block: 'center' });
      setFlashId(target);
      setTimeout(() => setFlashId(null), 1700);
      pendingJump = null;
      setState((s) => ({ messages: { ...s.messages, [channelId]: { ...s.messages[channelId], jumpTo: undefined } } }));
    }
  }, [cm?.jumpTo, cm?.loaded, items, channelId]);

  const onScroll = () => {
    const el = scroller.current!;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < 60;
    setShowJump(distance > 900);
    if (el.scrollTop < 500 && cm?.hasMoreBefore && !cm.loading && items.length) {
      const oldest = items.find((m) => !m.pending);
      if (oldest) void loadMessages(channelId, { before: oldest.id });
    }
    if (atBottom.current) maybeAck();
  };

  const jumpToPresent = () => {
    const el = scroller.current;
    if (!cm?.hasMoreBefore || items.length < 100) { el?.scrollTo({ top: el.scrollHeight }); atBottom.current = true; return; }
    atBottom.current = true;
    setState((s) => ({ messages: { ...s.messages, [channelId]: { ...s.messages[channelId], loaded: false, items: [] } } }));
  };

  const perms = channel?.my_permissions ?? (channel?.server_id ? 0 : 0xffffffff);
  const receipts = useStore((s) => s.readReceipts[channelId]);
  const seenId = useMemo(() => {
    if (!receipts || channel?.type !== 'dm') return null;
    const theirRead = Object.values(receipts)[0];
    if (!theirRead) return null;
    const mine = items.filter((m) => m.author?.id === meId && !m.pending && cmpId(m.id, theirRead) <= 0);
    return mine.at(-1)?.id ?? null;
  }, [receipts, items, meId, channel?.type]);

  if (!channel) return null;

  const rows: any[] = [];
  let prev: Message | null = null;
  let dividerShown = false;
  for (const m of items) {
    const d = new Date(m.created_at);
    if (!prev || new Date(prev.created_at).toDateString() !== d.toDateString()) {
      rows.push(<DayDivider key={`day-${m.id}`} iso={m.created_at} />);
      prev = null;
    }
    const isNew = !dividerShown && unreadMarker && !m.pending && cmpId(m.id, unreadMarker) > 0 && m.author?.id !== meId;
    if (isNew) { rows.push(<NewDivider key="new" />); dividerShown = true; }
    const grouped = !!prev && !isNew && prev.author?.id === m.author?.id && m.type === 'default' && prev.type === 'default' && !m.reply_to
      && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_MS && !prev.pending;
    rows.push(<MessageItem key={m.nonce && m.pending ? m.id : m.id} m={m} grouped={grouped} channel={channel} perms={perms} meId={meId!} flash={flashId === m.id} seen={seenId === m.id} />);
    prev = m;
  }

  return (
    <div className="flex-1 min-h-0 relative">
      <div ref={scroller} onScroll={onScroll} className="absolute inset-0 scroll" role="log" aria-live="polite" aria-relevant="additions">
        <div ref={inner} className="min-h-full flex flex-col justify-end pb-4">
          {cm?.loaded && !cm.hasMoreBefore && <ChannelWelcome channel={channel} />}
          {(cm?.loading || !cm?.loaded) && <div className="flex justify-center py-6"><Spinner className="size-5" /></div>}
          {cm?.error && !items.length && <EmptyState title="Messages didn't load" body={cm.error} />}
          {rows}
        </div>
      </div>
      {showJump && (
        <button onClick={jumpToPresent} className="absolute bottom-3 left-1/2 -translate-x-1/2 h-8 px-3 rounded-full bg-accent text-accent-ink text-sm font-medium flex items-center gap-1.5 anim-pop" style={{ boxShadow: 'var(--shadow-pop)' }}>
          <LuArrowDown size={15} /> Jump to present
        </button>
      )}
    </div>
  );
}

function DayDivider({ iso }: { iso: string }) {
  return (
    <div className="flex items-center gap-2 mx-4 mt-5 mb-1" role="separator">
      <span className="flex-1 h-px bg-line" />
      <span className="text-[0.72rem] font-semibold text-faint">{dayLabel(iso)}</span>
      <span className="flex-1 h-px bg-line" />
    </div>
  );
}
function NewDivider() {
  return (
    <div className="flex items-center gap-2 mx-4 my-1" role="separator" aria-label="New messages">
      <span className="flex-1 h-px bg-danger" />
      <span className="text-[0.7rem] font-bold text-white bg-danger rounded px-1.5">New</span>
    </div>
  );
}

function ChannelWelcome({ channel }: { channel: Channel | DmChannel }) {
  const meId = useStore((s) => s.me?.id);
  if (channel.type === 'dm' || channel.type === 'group_dm') {
    const dm = channel as DmChannel;
    const other = dm.recipients.find((r) => r.id !== meId);
    return (
      <div className="px-4 pt-8 pb-4">
        {dm.type === 'dm' && other ? <Avatar user={other} size={80} /> : null}
        <h2 className="font-display text-[1.9rem] font-extrabold mt-3 leading-tight">{dmTitle(dm, meId)}</h2>
        {dm.type === 'dm' && other && <p className="text-lg text-muted">{other.username}</p>}
        <p className="text-muted mt-2">{dm.type === 'dm' ? <>This is the beginning of your conversation with <strong className="text-fg">{other?.display_name || other?.username}</strong>.</> : 'Welcome to the beginning of this group.'}</p>
      </div>
    );
  }
  if (channel.type === 'thread') return <div className="px-4 pt-6 pb-2"><h2 className="font-display text-xl font-bold">{channel.name}</h2><p className="text-sm text-muted">The start of this thread.</p></div>;
  return (
    <div className="px-4 pt-8 pb-4">
      <span className="size-16 rounded-full bg-active grid place-items-center"><LuHash size={36} /></span>
      <h2 className="font-display text-[1.9rem] font-extrabold mt-3 leading-tight">Welcome to #{channel.name}</h2>
      <p className="text-muted mt-1">This is the start of the #{channel.name} channel.{channel.topic ? ` ${channel.topic}` : ''}</p>
    </div>
  );
}

/* ───────────── a single message ───────────── */

interface ItemProps { m: Message; grouped: boolean; channel: Channel | DmChannel; perms: number; meId: string; flash: boolean; seen: boolean }

const MessageItem = memo(function MessageItem({ m, grouped, channel, perms, meId, flash, seen }: ItemProps) {
  const serverId = channel.server_id;
  const author = useStore((s) => (m.author ? s.users[m.author.id] ?? m.author : null));
  const editing = useStore((s) => s.ui.editing === m.id);
  const blocked = useStore((s) => !!(m.author && s.blocked[m.author.id]));
  const [revealBlocked, setRevealBlocked] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);
  const menu = useMenu();
  const color = useStore(() => roleColor(serverId, author?.id));
  const isDm = !serverId;

  if (m.type !== 'default') return <SystemMessage m={m} channel={channel} flash={flash} />;
  if (blocked && !revealBlocked) {
    return (
      <div className="pl-[4.5rem] pr-4 py-1 text-sm text-faint" data-mid={m.id}>
        Blocked message. <button className="text-link hover:underline" onClick={() => setRevealBlocked(true)}>Show</button>
      </div>
    );
  }

  const mine = author?.id === meId;
  const mentioned = !mine && mentionsMe(m);
  const canManage = has(perms, P.MANAGE_MESSAGES);
  const canDelete = mine || (!isDm && canManage);
  const canPin = isDm || canManage;
  const canReact = has(perms, P.ADD_REACTIONS) || isDm;
  const canThread = !isDm && channel.type === 'text' && has(perms, P.CREATE_THREADS) && !m.thread;
  const canReply = has(perms, P.SEND_MESSAGES) || isDm;

  const react = (emoji: string) => {
    const r = m.reactions.find((x) => x.emoji === emoji);
    const on = r?.user_ids.includes(meId);
    void run(() => (on ? api.del(`/api/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`) : api.put(`/api/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`)));
  };
  const del = (skipConfirm: boolean) => {
    const go = async () => { await api.del(`/api/messages/${m.id}`); };
    if (skipConfirm) void run(go);
    else confirmDialog({ title: 'Delete message?', body: 'This can’t be undone. Tip: hold Shift when clicking delete to skip this.', confirmLabel: 'Delete', danger: true, onConfirm: go });
  };
  const reply = () => {
    setUi({ replyTo: { ...getState().ui.replyTo, [m.channel_id]: m } });
    document.querySelector<HTMLTextAreaElement>(`[data-composer="${m.channel_id}"]`)?.focus();
  };
  const startThread = () => {
    const name = m.content.replace(/\s+/g, ' ').slice(0, 60) || 'New thread';
    void run(async () => {
      const t = await api.post<Channel>(`/api/channels/${m.channel_id}/threads`, { name, message_id: m.id });
      setUi({ threadId: t.id, searchOpen: false });
    });
  };

  const name = displayName(author, serverId);
  const openProfile = () => author && openModal({ kind: 'profile', userId: author.id, serverId });

  return (
    <div data-mid={m.id} onContextMenu={m.pending ? undefined : menu.open}
      className={cx('group relative pr-12 pl-[4.5rem] hover:bg-hover/60', grouped ? 'py-0.5' : 'pt-[calc(var(--msg-gap)*0.5)] pb-0.5 mt-[calc(var(--msg-gap)*0.5)]',
        mentioned && 'bg-mention before:absolute before:left-0 before:inset-y-0 before:w-0.5 before:bg-accent',
        flash && 'anim-flash', m.pending === 'sending' && 'opacity-60')}>
      {m.reply_to && <ReplyPreview m={m} serverId={serverId} />}
      {grouped ? (
        <span className="absolute left-0 w-[4.5rem] text-right pr-3 text-[0.68rem] text-faint opacity-0 group-hover:opacity-100 leading-[1.375rem] select-none" title={fullDate(m.created_at)}>
          {timeShort(m.created_at)}
        </span>
      ) : (
        <>
          <button className="absolute left-4 mt-0.5" onClick={openProfile} aria-label={`${name}'s profile`}><Avatar user={author} size={40} /></button>
          <div className="flex items-baseline gap-2 min-w-0">
            <button className="font-semibold hover:underline truncate text-[0.95rem]" style={color ? { color } : undefined} onClick={openProfile}>{name}</button>
            {author?.is_demo && <span className="text-[0.62rem] font-semibold px-1 rounded bg-warn/20 text-warn" data-tip="Sample account used for demonstrations">Demo</span>}
            <time className="text-[0.72rem] text-faint shrink-0" dateTime={m.created_at} title={fullDate(m.created_at)}>{timeLong(m.created_at)}</time>
          </div>
        </>
      )}
      {editing ? <EditBox m={m} serverId={serverId} /> : (
        <>
          {m.content && (
            <div className="relative">
              <Markdown content={m.content} serverId={serverId} />
              {m.edited_at && <span className="text-[0.68rem] text-faint ml-1" title={`Edited ${fullDate(m.edited_at)}`}>(edited)</span>}
            </div>
          )}
        </>
      )}
      {m.localFiles?.length ? (
        <div className="flex flex-col gap-1 mt-1">
          {m.localFiles.map((f, i) => (
            <div key={i} className="w-72 max-w-full rounded-lg border border-line bg-side p-2 text-sm">
              <div className="flex justify-between gap-2"><span className="truncate">{f.name}</span><span className="text-muted">{Math.round(f.progress * 100)}%</span></div>
              <div className="h-1 mt-1.5 rounded bg-field overflow-hidden"><div className="h-full bg-accent transition-[width]" style={{ width: `${f.progress * 100}%` }} /></div>
            </div>
          ))}
        </div>
      ) : null}
      {m.attachments.length > 0 && <Attachments list={m.attachments} />}
      {m.thread && (
        <button onClick={() => setUi({ threadId: m.thread!.id, searchOpen: false })}
          className="mt-1.5 flex items-center gap-2.5 rounded-lg border border-line bg-side hover:bg-active px-3 py-2 text-left max-w-sm">
          <LuMessagesSquare className="text-muted shrink-0" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold truncate">{m.thread.name}</span>
            <span className="block text-xs text-link">{m.thread.message_count} {m.thread.message_count === 1 ? 'message' : 'messages'} <LuArrowRight className="inline" size={11} /></span>
          </span>
        </button>
      )}
      {m.reactions.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {m.reactions.map((r) => <ReactionChip key={r.emoji} r={r} meId={meId} serverId={serverId} onClick={() => react(r.emoji)} />)}
          {canReact && (
            <button aria-label="Add reaction" className="h-7 px-1.5 rounded-lg border border-transparent hover:border-line text-muted opacity-0 group-hover:opacity-100" onClick={(e: MouseEvent) => setPickerAnchor(e.currentTarget as HTMLElement)}><LuSmilePlus size={16} /></button>
          )}
        </div>
      )}
      {m.pending === 'failed' && (
        <div className="flex items-center gap-2 text-sm text-danger mt-0.5">
          <span>{m.error ?? 'Not sent.'}</span>
          <button className="flex items-center gap-1 text-link hover:underline" onClick={() => retryMessage(m)}><LuRotateCw size={13} /> Retry</button>
          <button className="flex items-center gap-1 text-muted hover:underline" onClick={() => discardMessage(m)}><LuX size={13} /> Discard</button>
        </div>
      )}
      {seen && <div className="text-[0.68rem] text-faint flex items-center gap-1 mt-0.5"><LuCheckCheck size={12} /> Seen</div>}

      {/* hover toolbar */}
      {!m.pending && !editing && (
        <div className="absolute -top-4 right-4 hidden group-hover:flex group-focus-within:flex items-center rounded-lg bg-raised border border-line p-0.5 z-10" style={{ boxShadow: 'var(--shadow-pop)' }}>
          {canReact && QUICK_REACTIONS.slice(0, 3).map((e) => (
            <button key={e} aria-label={`React with ${e}`} className="size-8 rounded-md hover:bg-hover text-lg grid place-items-center" onClick={() => react(e)}>{e}</button>
          ))}
          {canReact && <ToolBtn label="Add reaction" onClick={(e) => setPickerAnchor(e.currentTarget as HTMLElement)}><LuSmilePlus size={17} /></ToolBtn>}
          {canReply && <ToolBtn label="Reply" onClick={reply}><LuReply size={17} /></ToolBtn>}
          {canThread && <ToolBtn label="Create thread" onClick={startThread}><LuMessagesSquare size={17} /></ToolBtn>}
          {mine && <ToolBtn label="Edit" onClick={() => setUi({ editing: m.id })}><LuPencil size={16} /></ToolBtn>}
          {canDelete && <ToolBtn label="Delete" danger onClick={(e) => del(e.shiftKey)}><LuTrash2 size={16} /></ToolBtn>}
          <ToolBtn label="More" onClick={(e) => menu.openAt(e.currentTarget as HTMLElement)}><LuEllipsis size={17} /></ToolBtn>
        </div>
      )}
      {pickerAnchor && <Popover anchor={pickerAnchor} onClose={() => setPickerAnchor(null)} placement="left-start"><EmojiPicker onPick={react} onClose={() => setPickerAnchor(null)} /></Popover>}
      {menu.at && (
        <Popover anchor={menu.at} onClose={menu.close}>
          <Menu onClose={menu.close} items={[
            ...(canReact ? [{ label: 'Add reaction', icon: <LuSmilePlus />, onSelect: () => setTimeout(() => setPickerAnchor(document.querySelector(`[data-mid="${m.id}"]`) as HTMLElement), 0) }] : []),
            ...(mine ? [{ label: 'Edit message', icon: <LuPencil />, onSelect: () => setUi({ editing: m.id }) }] : []),
            ...(canReply ? [{ label: 'Reply', icon: <LuReply />, onSelect: reply }] : []),
            ...(canThread ? [{ label: 'Create thread', icon: <LuMessagesSquare />, onSelect: startThread }] : []),
            ...(canPin ? [{ label: m.pinned ? 'Unpin message' : 'Pin message', icon: m.pinned ? <LuPinOff /> : <LuPin />, onSelect: () => void run(() => (m.pinned ? api.del(`/api/messages/${m.id}/pin`) : api.put(`/api/messages/${m.id}/pin`)), m.pinned ? 'Message unpinned.' : 'Message pinned.') }] : []),
            { label: 'Copy text', icon: <LuCopy />, onSelect: () => { void navigator.clipboard?.writeText(m.content); toast('Copied.', 'ok'); } },
            { label: 'Copy message ID', icon: <LuCopy />, onSelect: () => { void navigator.clipboard?.writeText(m.id); } },
            ...(!mine ? [{ separator: true, label: '' }, { label: 'Report message', icon: <LuFlag />, danger: true, onSelect: () => openModal({ kind: 'report', messageId: m.id }) }] : []),
            ...(canDelete ? [{ label: 'Delete message', icon: <LuTrash2 />, danger: true, onSelect: () => del(false) }] : []),
          ]} />
        </Popover>
      )}
    </div>
  );
});

function ToolBtn({ label, onClick, children, danger }: { label: string; onClick: (e: MouseEvent) => void; children: any; danger?: boolean }) {
  return (
    <button aria-label={label} data-tip={label} onClick={onClick}
      className={cx('size-8 rounded-md grid place-items-center hover:bg-hover', danger ? 'text-danger' : 'text-muted hover:text-fg')}>{children}</button>
  );
}

function ReactionChip({ r, meId, serverId, onClick }: { r: Message['reactions'][number]; meId: string; serverId: string | null; onClick: () => void }) {
  const users = useStore((s) => s.users);
  const on = r.user_ids.includes(meId);
  const names = r.user_ids.slice(0, 6).map((id) => (users[id] ? displayName(users[id], serverId) : 'someone'));
  const tip = `${names.join(', ')}${r.count > names.length ? ` and ${r.count - names.length} more` : ''} reacted with ${r.emoji}`;
  return (
    <button onClick={onClick} data-tip={tip} aria-pressed={on} aria-label={`${r.emoji} ${r.count}`}
      className={cx('h-7 px-2 rounded-lg flex items-center gap-1.5 border text-sm transition-colors',
        on ? 'border-accent bg-[color-mix(in_srgb,var(--c-accent)_14%,transparent)]' : 'border-transparent bg-field hover:border-line')}>
      <span className="text-[1.05rem] leading-none">{r.emoji}</span>
      <span className={cx('font-semibold tabular-nums text-[0.8rem]', on ? 'text-fg' : 'text-muted')}>{r.count}</span>
    </button>
  );
}

function ReplyPreview({ m, serverId }: { m: Message; serverId: string | null }) {
  const r = m.reply_to!;
  const color = useStore(() => roleColor(serverId, r.author?.id));
  return (
    <div className="relative flex items-center gap-1.5 text-[0.82rem] text-muted mb-0.5 min-w-0">
      <span className="absolute -left-[2.15rem] top-2 w-8 h-3 border-l-2 border-t-2 border-faint/60 rounded-tl-md" aria-hidden />
      {r.deleted || !r.author ? <span className="italic">Original message was deleted</span> : (
        <>
          <Avatar user={r.author} size={16} />
          <span className="font-semibold shrink-0" style={color ? { color } : undefined}>{displayName(r.author, serverId)}</span>
          <button className="truncate hover:text-fg text-left" onClick={() => jumpToMessage(m.channel_id, r.id)}>{r.content || 'Click to see attachment'}</button>
        </>
      )}
    </div>
  );
}

function Attachments({ list }: { list: Attachment[] }) {
  return (
    <div className="flex flex-col gap-1.5 mt-1 items-start">
      {list.map((a) => {
        if (a.content_type.startsWith('image/')) {
          const w = a.width ?? 400, h = a.height ?? 300;
          const scale = Math.min(1, 400 / w, 320 / h);
          return (
            <button key={a.id} onClick={() => openModal({ kind: 'image', url: a.url, name: a.filename })} className="rounded-lg overflow-hidden bg-field max-w-full" aria-label={`Open image ${a.filename}`}>
              <img src={a.url} alt={a.filename} loading="lazy" width={Math.round(w * scale)} height={Math.round(h * scale)} className="block max-w-full h-auto object-contain" />
            </button>
          );
        }
        if (a.content_type.startsWith('video/')) return <video key={a.id} src={a.url} controls preload="metadata" className="rounded-lg max-w-[min(100%,28rem)] max-h-80 bg-black" />;
        if (a.content_type.startsWith('audio/')) return <div key={a.id} className="rounded-lg border border-line bg-side p-2 w-80 max-w-full"><p className="text-sm truncate mb-1">{a.filename}</p><audio src={a.url} controls preload="metadata" className="w-full" /></div>;
        return (
          <div key={a.id} className="flex items-center gap-3 rounded-lg border border-line bg-side px-3 py-2.5 w-80 max-w-full">
            <LuFile size={28} className="text-link shrink-0" />
            <div className="min-w-0 flex-1">
              <a href={a.url} className="block text-link truncate hover:underline" download={a.filename}>{a.filename}</a>
              <span className="text-xs text-muted">{bytes(a.size)}</span>
            </div>
            <a href={a.url} download={a.filename} aria-label={`Download ${a.filename}`} className="text-muted hover:text-fg"><LuDownload size={20} /></a>
          </div>
        );
      })}
    </div>
  );
}

function SystemMessage({ m, channel, flash }: { m: Message; channel: Channel | DmChannel; flash: boolean }) {
  const author = useStore((s) => (m.author ? s.users[m.author.id] ?? m.author : null));
  const name = displayName(author, channel.server_id);
  let icon = <LuArrowRight className="text-ok" />;
  let body: any = null;
  if (m.type === 'call') { icon = <LuPhone className="text-ok" />; body = <><strong className="text-fg">{name}</strong> started a call.</>; }
  else if (m.type === 'thread_created') {
    icon = <LuMessagesSquare className="text-muted" />;
    body = <><strong className="text-fg">{name}</strong> started a thread: <button className="font-semibold text-fg hover:underline" onClick={() => m.thread && setUi({ threadId: m.thread.id })}>{m.content}</button></>;
  } else if (m.content === 'joined') body = <><strong className="text-fg">{name}</strong> joined the server. Say hello!</>;
  else if (m.content === 'pinned') {
    icon = <LuPin className="text-muted" />;
    body = <><strong className="text-fg">{name}</strong> pinned <button className="font-semibold text-fg hover:underline" onClick={() => m.reply_to_id && jumpToMessage(m.channel_id, m.reply_to_id)}>a message</button> to this channel.</>;
  } else {
    icon = <LuArrowRight className={m.content.startsWith('left') || m.content.startsWith('removed') ? 'text-danger rotate-180' : 'text-ok'} />;
    body = <><strong className="text-fg">{name}</strong> <SystemText text={m.content} serverId={channel.server_id} /></>;
  }
  return (
    <div data-mid={m.id} className={cx('flex items-center gap-3 pl-[1.6rem] pr-4 py-1 mt-1 text-[0.9rem] text-muted', flash && 'anim-flash')}>
      <span className="w-8 grid place-items-center" aria-hidden>{icon}</span>
      <span className="flex-1">{body}</span>
      <time className="text-[0.7rem] text-faint" title={fullDate(m.created_at)}>{timeLong(m.created_at)}</time>
    </div>
  );
}
function SystemText({ text, serverId }: { text: string; serverId: string | null }) {
  return <span className="inline [&_.msg]:inline"><Markdown content={text + '.'} serverId={serverId} /></span>;
}

function EditBox({ m, serverId }: { m: Message; serverId: string | null }) {
  const [text, setText] = useState(() => toEditable(m.content, serverId));
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.style.height = `${el.scrollHeight}px`; } }, []);
  const cancel = () => setUi({ editing: null });
  const save = async () => {
    const content = fromEditable(text.trim(), serverId, getChannel(m.channel_id));
    if (content === m.content) { cancel(); return; }
    if (!content && !m.attachments.length) {
      confirmDialog({ title: 'Delete message?', body: 'An empty message will be deleted.', confirmLabel: 'Delete', danger: true, onConfirm: async () => { await api.del(`/api/messages/${m.id}`); } });
      return;
    }
    setBusy(true);
    try { await api.patch(`/api/messages/${m.id}`, { content }); cancel(); }
    catch (e) { toast(errMsg(e), 'error'); setBusy(false); }
  };
  return (
    <div className="mt-1">
      <textarea ref={ref} value={text} disabled={busy} aria-label="Edit message"
        onChange={(e: any) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }}
        onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save(); } }}
        className="w-full rounded-lg bg-field px-3 py-2 text-[0.95rem] resize-none focus:outline-none max-h-80" rows={1} />
      <p className="text-xs text-muted mt-1">Escape to <button className="text-link" onClick={cancel}>cancel</button>, Enter to <button className="text-link" onClick={() => void save()}>save</button></p>
    </div>
  );
}
