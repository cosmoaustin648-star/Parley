import { useEffect, useMemo, useRef, useState } from 'react';
import { LuCirclePlus, LuSmile, LuSendHorizontal, LuX, LuFile, LuHash, LuAtSign, LuTimer } from 'react-icons/lu';
import { useStore, getState, setUi, displayName, toast, getChannel, presenceOf } from '../lib/store.ts';
import { sendMessage, loadMembers, type OutgoingFile } from '../lib/actions.ts';
import { send } from '../lib/gateway.ts';
import { searchEmoji, byShortcode } from '../lib/emoji.ts';
import { bytes } from '../lib/format.ts';
import type { Channel, DmChannel, Role, User } from '../lib/types.ts';
import { Avatar, cx, Popover } from '../components/ui.tsx';
import { EmojiPicker } from '../components/EmojiPicker.tsx';
import { P, has, isTimedOut } from '../../../shared/permissions.ts';

/* ───────────── mention token conversion ───────────── */
/** Stored form (<@id>, <#id>, <@&id>) → what the user sees and types (@name, #name, @Role). */
export function toEditable(content: string, serverId: string | null) {
  const s = getState();
  return content
    .replace(/<@(\d+)>/g, (_, id) => `@${s.users[id]?.username ?? 'unknown'}`)
    .replace(/<#(\d+)>/g, (_, id) => `#${s.channels[id]?.name ?? 'unknown'}`)
    .replace(/<@&(\d+)>/g, (_, id) => `@${(serverId && s.servers[serverId]?.roles.find((r) => r.id === id)?.name) || 'deleted-role'}`);
}

/** Typed form → stored tokens. Only resolves names that are unambiguous in this context. */
export function fromEditable(text: string, serverId: string | null, channel?: Channel | DmChannel) {
  const s = getState();
  // Leave code untouched.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  const users = new Map<string, string>();
  if (serverId) for (const m of Object.values(s.members[serverId] ?? {})) users.set(m.user.username.toLowerCase(), m.user.id);
  if (channel && 'recipients' in channel) for (const u of channel.recipients) users.set(u.username.toLowerCase(), u.id);
  for (const u of Object.values(s.users)) if (!users.has(u.username.toLowerCase())) users.set(u.username.toLowerCase(), u.id);
  const roles = serverId ? [...(s.servers[serverId]?.roles ?? [])].filter((r) => !r.is_default).sort((a, b) => b.name.length - a.name.length) : [];
  const chans = serverId ? Object.values(s.channels).filter((c) => c.server_id === serverId && c.type !== 'thread') : [];
  return parts.map((p, i) => {
    if (i % 2 === 1) return p;
    let out = p;
    for (const r of roles) {
      const re = new RegExp(`(^|[^\\w<])@${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'gi');
      out = out.replace(re, (_, pre) => `${pre}<@&${r.id}>`);
    }
    out = out.replace(/(^|[^\w<])@([a-z0-9_.]{2,32})/gi, (all, pre, name) => (users.has(name.toLowerCase()) && !['everyone', 'here'].includes(name.toLowerCase()) ? `${pre}<@${users.get(name.toLowerCase())}>` : all));
    out = out.replace(/(^|[^\w<&])#([\p{L}\p{N}_-]{1,100})/gu, (all, pre, name) => { const c = chans.find((x) => x.name === name.toLowerCase()); return c ? `${pre}<#${c.id}>` : all; });
    out = out.replace(/:([a-z0-9_+-]{2,40}):/g, (all, code) => byShortcode.get(code) ?? all);
    return out;
  }).join('');
}

/* ───────────── autocomplete ───────────── */
type Suggestion = { key: string; label: string; detail?: string; insert: string; icon: any };

function useSuggestions(text: string, caret: number, channel: Channel | DmChannel | undefined): { items: Suggestion[]; start: number } {
  const members = useStore((s) => (channel?.server_id ? s.members[channel.server_id] : undefined));
  const servers = useStore((s) => s.servers);
  const channels = useStore((s) => s.channels);
  return useMemo(() => {
    const before = text.slice(0, caret);
    const m = before.match(/(^|\s)([@#:])([^\s@#:]{0,32})$/);
    if (!m || !channel) return { items: [], start: -1 };
    const [, , trigger, q] = m;
    const start = caret - q.length - 1;
    const ql = q.toLowerCase();
    if (trigger === ':') {
      if (q.length < 2) return { items: [], start };
      return { start, items: searchEmoji(q, 8).map((e) => ({ key: e.name, label: `:${e.name}:`, insert: e.e + ' ', icon: <span className="text-lg">{e.e}</span> })) };
    }
    if (trigger === '#') {
      if (!channel.server_id) return { items: [], start };
      const list = Object.values(channels).filter((c) => c.server_id === channel.server_id && c.type === 'text' && c.name!.includes(ql)).slice(0, 8);
      return { start, items: list.map((c) => ({ key: c.id, label: c.name!, insert: `#${c.name} `, icon: <LuHash /> })) };
    }
    const users: User[] = channel.server_id ? Object.values(members ?? {}).map((x) => x.user) : (channel as DmChannel).recipients ?? [];
    const matches = users.filter((u) => u.username.includes(ql) || (u.display_name ?? '').toLowerCase().includes(ql) || (channel.server_id && (members?.[u.id]?.nickname ?? '').toLowerCase().includes(ql)))
      .sort((a, b) => Number(!a.username.startsWith(ql)) - Number(!b.username.startsWith(ql)) || a.username.localeCompare(b.username)).slice(0, 8);
    const items: Suggestion[] = matches.map((u) => ({ key: u.id, label: displayName(u, channel.server_id), detail: u.username, insert: `@${u.username} `, icon: <Avatar user={u} size={22} /> }));
    if (channel.server_id) {
      const server = servers[channel.server_id];
      const canAll = has(channel.my_permissions ?? 0, P.MENTION_EVERYONE);
      const roles = (server?.roles ?? []).filter((r: Role) => !r.is_default && (r.mentionable || canAll) && r.name.toLowerCase().includes(ql)).slice(0, 4);
      items.push(...roles.map((r) => ({ key: 'r' + r.id, label: `@${r.name}`, detail: 'Role', insert: `@${r.name} `, icon: <LuAtSign style={{ color: r.color ?? undefined }} /> })));
      if (canAll) for (const x of ['everyone', 'here']) if (x.startsWith(ql)) items.push({ key: x, label: `@${x}`, detail: x === 'everyone' ? 'Notify everyone in this channel' : 'Notify everyone online', insert: `@${x} `, icon: <LuAtSign /> });
    }
    return { start, items: items.slice(0, 10) };
  }, [text, caret, channel, members, servers, channels]);
}

/* ───────────── composer ───────────── */
export function Composer({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels[channelId] ?? s.dms[channelId]);
  const server = useStore((s) => (channel?.server_id ? s.servers[channel.server_id] : undefined));
  const replyTo = useStore((s) => s.ui.replyTo[channelId] ?? null);
  const draft = useStore((s) => s.ui.drafts[channelId]);
  const maxMb = useStore((s) => s.meta?.max_upload_mb ?? 25);
  const blocked = useStore((s) => {
    const ch = s.dms[channelId];
    if (ch?.type !== 'dm') return false;
    const other = ch.recipients.find((r) => r.id !== s.me?.id);
    return !!other && !!s.blocked[other.id];
  });
  const [text, setText] = useState(draft ?? '');
  const [files, setFiles] = useState<OutgoingFile[]>([]);
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [dragging, setDragging] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);
  const { items: suggestions, start } = useSuggestions(text, caret, channel);

  useEffect(() => { if (channel?.server_id) void loadMembers(channel.server_id); }, [channel?.server_id]);
  useEffect(() => { setSel(0); }, [suggestions.length, start]);
  useEffect(() => { if (draft !== undefined && draft !== text) setText(draft); }, [draft]);
  useEffect(() => { autosize(); }, [text]);
  useEffect(() => () => { setUi({ drafts: { ...getState().ui.drafts, [channelId]: ta.current?.value ?? '' } }); }, [channelId]);
  useEffect(() => {
    if (!cooldown) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown > 0]);
  useEffect(() => { if (window.matchMedia('(pointer: fine)').matches) ta.current?.focus(); }, [channelId]);

  if (!channel) return null;
  const isDm = !channel.server_id;
  const perms = channel.my_permissions ?? 0;
  const timedOut = !isDm && isTimedOut(server?.member.timeout_until);
  const canSend = isDm ? !blocked : has(perms, P.SEND_MESSAGES) && !channel.archived;
  const canAttach = isDm || has(perms, P.ATTACH_FILES);
  const isModerator = has(perms, P.MANAGE_MESSAGES) || has(perms, P.MANAGE_CHANNELS);
  const placeholder = isDm
    ? `Message ${channel.type === 'dm' ? '@' + ((channel as DmChannel).recipients.find((r) => r.id !== getState().me?.id)?.username ?? '') : (channel.name || 'the group')}`
    : channel.type === 'thread' ? `Message ${channel.name}` : `Message #${channel.name}`;

  function autosize() { const el = ta.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 320)}px`; }

  const addFiles = (list: FileList | File[]) => {
    if (!canAttach) { toast("You can't attach files in this channel.", 'error'); return; }
    const next: OutgoingFile[] = [];
    for (const f of Array.from(list)) {
      if (f.size > maxMb * 1024 * 1024) { toast(`${f.name} is larger than ${maxMb} MB.`, 'error'); continue; }
      next.push({ file: f, name: f.name || 'pasted-image.png' });
    }
    setFiles((cur) => [...cur, ...next].slice(0, 10));
  };

  const pick = (s: Suggestion) => {
    const before = text.slice(0, start), after = text.slice(caret);
    const next = before + s.insert + after;
    setText(next);
    const pos = (before + s.insert).length;
    requestAnimationFrame(() => { ta.current?.setSelectionRange(pos, pos); setCaret(pos); });
  };

  const submit = () => {
    const raw = text.trim();
    if ((!raw && !files.length) || !canSend) return;
    if (cooldown && !isModerator) return;
    const content = fromEditable(raw, channel.server_id, channel);
    void sendMessage(channelId, content, files, replyTo);
    setText(''); setFiles([]); setCaret(0);
    setUi({ replyTo: { ...getState().ui.replyTo, [channelId]: null }, drafts: { ...getState().ui.drafts, [channelId]: '' } });
    if (channel.slowmode_seconds && !isModerator) setCooldown(channel.slowmode_seconds);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((sel + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((sel - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(suggestions[sel]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setCaret(-1); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !(e as any).isComposing) { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape' && replyTo) { e.preventDefault(); e.stopPropagation(); setUi({ replyTo: { ...getState().ui.replyTo, [channelId]: null } }); return; }
    if (e.key === 'ArrowUp' && !text) {
      const mine = [...(getState().messages[channelId]?.items ?? [])].reverse().find((m) => m.author?.id === getState().me?.id && m.type === 'default' && !m.pending);
      if (mine) { e.preventDefault(); setUi({ editing: mine.id }); }
    }
  };

  const onChange = (e: any) => {
    setText(e.target.value);
    setCaret(e.target.selectionStart);
    const now = Date.now();
    if (e.target.value && now - lastTyping.current > 6000 && getState().me?.settings.privacy?.show_typing !== false) {
      lastTyping.current = now;
      send('typing', { channel_id: channelId });
    }
  };

  if (!canSend) {
    const msg = blocked ? "You can't send messages to a user you've blocked." : timedOut ? `You're timed out until ${new Date(server!.member.timeout_until!).toLocaleString()}.`
      : channel.archived ? 'This thread is archived.' : "You don't have permission to send messages in this channel.";
    return <div className="px-4 pb-6 pt-1"><div className="h-11 rounded-lg bg-field/60 text-muted text-sm flex items-center px-4">{msg}</div></div>;
  }

  return (
    <div className={cx('px-4 pb-1 pt-1 shrink-0 relative', dragging && 'after:absolute after:inset-0 after:rounded-lg after:border-2 after:border-dashed after:border-accent after:bg-accent/10')}
      onDragOver={(e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e: DragEvent) => { e.preventDefault(); setDragging(false); if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files); }}>
      {suggestions.length > 0 && caret >= 0 && (
        <div className="absolute bottom-full left-4 right-4 mb-1 rounded-lg bg-raised p-1.5 z-20 anim-pop" style={{ boxShadow: 'var(--shadow-pop)' }} role="listbox">
          {suggestions.map((s, i) => (
            <button key={s.key} role="option" aria-selected={i === sel} onMouseDown={(e: MouseEvent) => { e.preventDefault(); pick(s); }} onMouseEnter={() => setSel(i)}
              className={cx('w-full flex items-center gap-2.5 h-9 px-2 rounded-md text-left', i === sel && 'bg-active')}>
              <span className="w-6 grid place-items-center text-muted">{s.icon}</span>
              <span className="text-sm">{s.label}</span>
              {s.detail && <span className="ml-auto text-xs text-muted">{s.detail}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="rounded-lg bg-field">
        {replyTo && (
          <div className="flex items-center gap-2 px-4 h-9 text-sm text-muted border-b border-line">
            <span className="flex-1 truncate">Replying to <strong className="text-fg">{displayName(replyTo.author, channel.server_id)}</strong></span>
            <button aria-label="Cancel reply" className="hover:text-fg" onClick={() => setUi({ replyTo: { ...getState().ui.replyTo, [channelId]: null } })}><LuX /></button>
          </div>
        )}
        {files.length > 0 && (
          <div className="flex gap-2 p-3 overflow-x-auto border-b border-line">
            {files.map((f, i) => <FileChip key={i} f={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} onRename={(name) => setFiles(files.map((x, j) => (j === i ? { ...x, name } : x)))} />)}
          </div>
        )}
        <div className="flex items-end gap-1 px-2">
          {canAttach && (
            <>
              <button aria-label="Attach files" data-tip="Attach files" className="size-11 grid place-items-center text-muted hover:text-fg shrink-0" onClick={() => fileInput.current?.click()}><LuCirclePlus size={22} /></button>
              <input ref={fileInput} type="file" multiple hidden onChange={(e: any) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            </>
          )}
          <textarea ref={ta} data-composer={channelId} rows={1} value={text} onChange={onChange} onKeyDown={onKeyDown}
            onSelect={(e: any) => setCaret(e.target.selectionStart)} onBlur={() => setTimeout(() => setCaret(-1), 150)} onFocus={(e: any) => setCaret(e.target.selectionStart)}
            onPaste={(e: ClipboardEvent) => { const f = e.clipboardData?.files; if (f && f.length) { e.preventDefault(); addFiles(f); } }}
            placeholder={placeholder} aria-label={placeholder} maxLength={4000}
            className="flex-1 bg-transparent resize-none py-[0.7rem] px-1 text-[0.95rem] leading-[1.375rem] placeholder:text-faint focus:outline-none min-h-11 max-h-80 scroll" />
          <button aria-label="Emoji" data-tip="Emoji" className="size-11 grid place-items-center text-muted hover:text-fg shrink-0" onClick={(e: MouseEvent) => setEmojiAnchor(e.currentTarget as HTMLElement)}><LuSmile size={22} /></button>
          <button aria-label="Send message" data-tip="Send" disabled={(!text.trim() && !files.length) || (!!cooldown && !isModerator)}
            className="size-11 grid place-items-center text-muted hover:text-accent disabled:opacity-40 shrink-0 md:hidden" onClick={submit}><LuSendHorizontal size={20} /></button>
        </div>
      </div>
      <TypingLine channelId={channelId} serverId={channel.server_id} cooldown={!isModerator ? cooldown : 0} slowmode={channel.slowmode_seconds} length={text.length} />
      {emojiAnchor && (
        <Popover anchor={emojiAnchor} onClose={() => setEmojiAnchor(null)} placement="top-end">
          <EmojiPicker onClose={() => setEmojiAnchor(null)} onPick={(e) => {
            const el = ta.current; const pos = el?.selectionStart ?? text.length;
            setText(text.slice(0, pos) + e + text.slice(pos));
            requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos + e.length, pos + e.length); });
          }} />
        </Popover>
      )}
    </div>
  );
}

function FileChip({ f, onRemove, onRename }: { f: OutgoingFile; onRemove: () => void; onRename: (n: string) => void }) {
  const url = useMemo(() => (f.file.type.startsWith('image/') ? URL.createObjectURL(f.file) : null), [f.file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return (
    <div className="relative w-40 shrink-0 rounded-lg bg-side p-2 flex flex-col gap-1.5">
      <div className="h-24 rounded-md bg-field grid place-items-center overflow-hidden">
        {url ? <img src={url} alt="" className="max-h-full object-contain" /> : <LuFile size={36} className="text-link" />}
      </div>
      <input aria-label="File name" className="bg-transparent text-xs truncate focus:outline-none focus:bg-field rounded px-1" value={f.name} onChange={(e: any) => onRename(e.target.value)} />
      <span className="text-[0.68rem] text-muted px-1">{bytes(f.file.size)}</span>
      <button aria-label={`Remove ${f.name}`} onClick={onRemove} className="absolute -top-2 -right-2 size-6 rounded-full bg-danger text-white grid place-items-center"><LuX size={14} /></button>
    </div>
  );
}

function TypingLine({ channelId, serverId, cooldown, slowmode, length }: { channelId: string; serverId: string | null; cooldown: number; slowmode: number; length: number }) {
  const typing = useStore((s) => s.typing[channelId]);
  const users = useStore((s) => s.users);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1500); return () => clearInterval(t); }, []);
  const ids = Object.entries(typing ?? {}).filter(([, exp]) => exp > now).map(([id]) => id);
  const names = ids.map((id) => (users[id] ? displayName(users[id], serverId) : 'Someone'));
  const text = !names.length ? '' : names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
    : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]} are typing…` : 'Several people are typing…';
  return (
    <div className="h-6 flex items-center gap-2 text-[0.78rem] text-muted px-1" aria-live="polite">
      {text && (<><span className="flex gap-0.5" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className="typing-dot size-1.5 rounded-full bg-muted" style={{ animationDelay: `${i * 0.15}s` }} />)}</span><span className="truncate">{text}</span></>)}
      <span className="flex-1" />
      {length > 3500 && <span className={length >= 4000 ? 'text-danger' : ''}>{4000 - length}</span>}
      {slowmode > 0 && <span className="flex items-center gap-1" data-tip={`Slowmode: one message every ${slowmode}s`}><LuTimer size={13} />{cooldown > 0 ? `${cooldown}s` : 'Slowmode'}</span>}
    </div>
  );
}

export { getChannel, presenceOf };
