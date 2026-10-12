import { useEffect, useState } from 'react';
import { LuMessagesSquare } from 'react-icons/lu';
import { setUi, setState } from '../lib/store.ts';
import { api, errMsg } from '../lib/api.ts';
import type { Channel } from '../lib/types.ts';
import { Spinner, cx } from '../components/ui.tsx';

export function ThreadsList({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const [list, setList] = useState<Channel[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.get<Channel[]>(`/api/channels/${channelId}/threads`).then(setList).catch((e) => setErr(errMsg(e))); }, [channelId]);
  return (
    <div className="flex flex-col max-h-[70vh]">
      <h2 className="font-display font-bold px-4 h-12 flex items-center border-b border-line">Threads</h2>
      <div className="scroll p-2 flex flex-col gap-1">
        {!list && !err && <div className="flex justify-center py-6"><Spinner /></div>}
        {err && <p className="text-danger text-sm p-2">{err}</p>}
        {list && !list.length && <p className="text-sm text-muted text-center py-8 px-4">No threads yet. Hover a message and choose “Create thread” to start one.</p>}
        {list?.map((t) => (
          <button key={t.id} onClick={() => { setState((s) => ({ channels: { ...s.channels, [t.id]: { ...t } } })); setUi({ threadId: t.id, searchOpen: false }); onClose(); }}
            className={cx('flex items-center gap-3 px-3 py-2 rounded-md hover:bg-hover text-left', t.archived && 'opacity-60')}>
            <LuMessagesSquare className="text-muted shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium truncate">{t.name}</span>
              <span className="block text-xs text-muted">{t.message_count ?? 0} messages{t.archived ? ', archived' : ''}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
