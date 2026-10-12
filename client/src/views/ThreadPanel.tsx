import { LuX, LuMessagesSquare, LuArchive, LuArchiveRestore } from 'react-icons/lu';
import { useEffect } from 'react';
import { useStore, setUi, setState } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { run } from '../lib/actions.ts';
import { IconButton } from '../components/ui.tsx';
import { MessageList } from './MessageList.tsx';
import { Composer } from './Composer.tsx';
import { P, has } from '../../../shared/permissions.ts';

export function ThreadPanel({ threadId }: { threadId: string }) {
  const thread = useStore((s) => s.channels[threadId]);
  const meId = useStore((s) => s.me?.id);
  useEffect(() => {
    // Archived threads aren't part of the server snapshot; fetch on demand.
    if (!thread) api.get(`/api/channels/${threadId}`).then((t) => setState((s) => ({ channels: { ...s.channels, [t.id]: t } }))).catch(() => setUi({ threadId: null }));
  }, [threadId, !!thread]);
  if (!thread) return null;
  const canManage = thread.owner_id === meId || has(thread.my_permissions ?? 0, P.MANAGE_MESSAGES);
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-deck">
      <header className="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-line">
        <LuMessagesSquare className="text-muted" />
        <h2 className="font-display font-bold truncate flex-1">{thread.name}</h2>
        {canManage && (
          <IconButton label={thread.archived ? 'Unarchive thread' : 'Archive thread'} onClick={() => void run(() => api.patch(`/api/channels/${threadId}`, { archived: !thread.archived }))}>
            {thread.archived ? <LuArchiveRestore size={18} /> : <LuArchive size={18} />}
          </IconButton>
        )}
        <IconButton label="Close thread" onClick={() => setUi({ threadId: null })}><LuX size={18} /></IconButton>
      </header>
      <MessageList channelId={threadId} />
      <Composer channelId={threadId} />
    </div>
  );
}
