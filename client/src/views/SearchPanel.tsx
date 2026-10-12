import { useEffect, useState } from 'react';
import { LuX, LuSearch } from 'react-icons/lu';
import { useStore, setUi, displayName } from '../lib/store.ts';
import { api, errMsg } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { Markdown } from '../lib/markdown.tsx';
import { timeLong } from '../lib/format.ts';
import type { Channel, Message } from '../lib/types.ts';
import { Avatar, IconButton, Spinner, Select, cx, inputCls } from '../components/ui.tsx';
import { jumpToMessage } from './MessageList.tsx';

export function SearchPanel({ channel }: { channel: Channel }) {
  const query = useStore((s) => s.ui.searchQuery);
  const members = useStore((s) => (channel.server_id ? s.members[channel.server_id] : undefined));
  const channels = useStore((s) => s.channels);
  const [scope, setScope] = useState<'server' | 'channel'>(channel.server_id ? 'server' : 'channel');
  const [hasF, setHasF] = useState('');
  const [author, setAuthor] = useState('');
  const [offset, setOffset] = useState(0);
  const [res, setRes] = useState<{ total: number; messages: Message[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q && !hasF && !author) { setRes(null); return; }
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (hasF) params.set('has', hasF);
    if (author) params.set('author_id', author);
    if (scope === 'server' && channel.server_id) params.set('server_id', channel.server_id); else params.set('channel_id', channel.id);
    params.set('offset', String(offset));
    setBusy(true); setErr(null);
    const t = setTimeout(() => {
      api.get(`/api/search/messages?${params}`).then(setRes).catch((e) => setErr(errMsg(e))).finally(() => setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query, hasF, author, scope, offset, channel.id]);
  useEffect(() => setOffset(0), [query, hasF, author, scope]);

  const open = (m: Message) => {
    const ch = channels[m.channel_id];
    if (ch?.type === 'thread') { navigate(`/channels/${ch.server_id}/${ch.parent_channel_id}`); setUi({ threadId: ch.id, searchOpen: false }); setTimeout(() => jumpToMessage(m.channel_id, m.id), 50); return; }
    if (ch && ch.id !== channel.id) navigate(`/channels/${ch.server_id}/${ch.id}`);
    setTimeout(() => jumpToMessage(m.channel_id, m.id), 50);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-side">
      <header className="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-line">
        <LuSearch className="text-muted" />
        <input autoFocus aria-label="Search messages" className={cx(inputCls, 'h-8 text-sm flex-1')} placeholder="Search messages" value={query} onChange={(e: any) => setUi({ searchQuery: e.target.value })} />
        <IconButton label="Close search" onClick={() => setUi({ searchOpen: false })}><LuX size={18} /></IconButton>
      </header>
      <div className="px-3 py-2 grid grid-cols-3 gap-2 border-b border-line text-sm">
        {channel.server_id ? (
          <Select aria-label="Where" className="h-8 text-sm" value={scope} onChange={(v) => setScope(v as any)} options={[{ value: 'server', label: 'This server' }, { value: 'channel', label: 'This channel' }]} />
        ) : <span />}
        <Select aria-label="From" className="h-8 text-sm" value={author} onChange={setAuthor}
          options={[{ value: '', label: 'Anyone' }, ...Object.values(members ?? {}).map((m) => ({ value: m.user.id, label: displayName(m.user, channel.server_id) }))]} />
        <Select aria-label="Has" className="h-8 text-sm" value={hasF} onChange={setHasF}
          options={[{ value: '', label: 'Any content' }, { value: 'file', label: 'Has file' }, { value: 'image', label: 'Has image' }, { value: 'link', label: 'Has link' }]} />
      </div>
      <div className="flex-1 min-h-0 scroll p-3 flex flex-col gap-2">
        {busy && <div className="flex justify-center py-6"><Spinner /></div>}
        {err && <p className="text-sm text-danger">{err}</p>}
        {!busy && !res && !err && <p className="text-sm text-muted text-center py-8">Type to search messages you can see. Filter by person or content type above.</p>}
        {!busy && res && (
          <>
            <p className="text-xs font-semibold text-muted">{res.total} {res.total === 1 ? 'result' : 'results'}</p>
            {res.messages.map((m) => (
              <button key={m.id} onClick={() => open(m)} className="text-left rounded-lg bg-deck hover:bg-raised p-3 flex gap-3 border border-line">
                <Avatar user={m.author} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold text-sm truncate">{displayName(m.author, channel.server_id)}</span>
                    <span className="text-[0.7rem] text-faint shrink-0">{timeLong(m.created_at)}</span>
                  </div>
                  {channels[m.channel_id] && channel.server_id && <p className="text-[0.7rem] text-muted">#{channels[m.channel_id].name}</p>}
                  <div className="line-clamp-4 text-sm"><Markdown content={m.content || (m.attachments.length ? `📎 ${m.attachments.map((a) => a.filename).join(', ')}` : '')} serverId={channel.server_id} /></div>
                </div>
              </button>
            ))}
            {res.total > offset + 25 && <button className="text-link text-sm py-2" onClick={() => setOffset(offset + 25)}>Show older results</button>}
            {offset > 0 && <button className="text-link text-sm py-2" onClick={() => setOffset(Math.max(0, offset - 25))}>Show newer results</button>}
          </>
        )}
      </div>
    </div>
  );
}
