import { useEffect, useState } from 'react';
import { LuPinOff, LuPin } from 'react-icons/lu';
import { useStore, displayName, getChannel } from '../lib/store.ts';
import { api, errMsg } from '../lib/api.ts';
import { run } from '../lib/actions.ts';
import { onGateway } from '../lib/gateway.ts';
import { Markdown } from '../lib/markdown.tsx';
import { timeLong } from '../lib/format.ts';
import type { Message } from '../lib/types.ts';
import { Avatar, Spinner, IconButton } from '../components/ui.tsx';
import { jumpToMessage } from './MessageList.tsx';
import { P, has } from '../../../shared/permissions.ts';

export function PinsPanel({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const [pins, setPins] = useState<Message[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const channel = useStore((s) => s.channels[channelId] ?? s.dms[channelId]);
  const load = () => api.get<Message[]>(`/api/channels/${channelId}/pins`).then(setPins).catch((e) => setErr(errMsg(e)));
  useEffect(() => { void load(); return onGateway('PINS_UPDATE', (d) => { if (d.channel_id === channelId) void load(); }); }, [channelId]);
  const canUnpin = !channel?.server_id || has(channel?.my_permissions ?? 0, P.MANAGE_MESSAGES);
  return (
    <div className="flex flex-col max-h-[70vh]">
      <h2 className="font-display font-bold px-4 h-12 flex items-center border-b border-line">Pinned messages</h2>
      <div className="scroll p-3 flex flex-col gap-2">
        {!pins && !err && <div className="flex justify-center py-6"><Spinner /></div>}
        {err && <p className="text-danger text-sm">{err}</p>}
        {pins && !pins.length && (
          <div className="text-center py-8 px-4 text-muted">
            <LuPin className="mx-auto mb-2" size={28} />
            <p className="text-sm">No pinned messages yet. {getChannel(channelId)?.server_id ? 'Moderators can pin important messages from the message menu.' : 'Pin important messages from the message menu.'}</p>
          </div>
        )}
        {pins?.map((m) => (
          <div key={m.id} className="group rounded-lg bg-deck border border-line p-3 flex gap-3">
            <Avatar user={m.author} size={32} />
            <button className="min-w-0 flex-1 text-left" onClick={() => { onClose(); jumpToMessage(channelId, m.id); }}>
              <div className="flex items-baseline gap-2"><span className="font-semibold text-sm">{displayName(m.author, channel?.server_id)}</span><span className="text-[0.7rem] text-faint">{timeLong(m.created_at)}</span></div>
              <div className="text-sm line-clamp-5"><Markdown content={m.content || '📎 Attachment'} serverId={channel?.server_id ?? null} /></div>
            </button>
            {canUnpin && <IconButton label="Unpin" className="opacity-0 group-hover:opacity-100" onClick={() => void run(() => api.del(`/api/messages/${m.id}/pin`))}><LuPinOff size={16} /></IconButton>}
          </div>
        ))}
      </div>
    </div>
  );
}
