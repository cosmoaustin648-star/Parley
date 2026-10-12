import { LuPhoneOff, LuVideo, LuVideoOff, LuMonitorUp, LuMonitorX, LuSignal } from 'react-icons/lu';
import { useStore } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import { voice, useVoice } from '../voice/engine.ts';
import { IconButton, cx } from '../components/ui.tsx';
import { dmTitle } from './DmSidebar.tsx';

export function VoiceStatusPanel() {
  const channelId = useVoice((v) => v.channelId);
  const status = useVoice((v) => v.status);
  const camera = useVoice((v) => v.camera);
  const screen = useVoice((v) => v.screen);
  const peers = useVoice((v) => v.peers);
  const channel = useStore((s) => (channelId ? s.channels[channelId] ?? s.dms[channelId] : undefined));
  const server = useStore((s) => (channel?.server_id ? s.servers[channel.server_id] : undefined));
  const meId = useStore((s) => s.me?.id);
  if (!channelId) return null;

  const failing = Object.values(peers).filter((p) => p.state === 'failed' || p.state === 'disconnected').length;
  const connecting = Object.values(peers).some((p) => p.state === 'connecting' || p.state === 'new');
  const label = status === 'reconnecting' ? 'Reconnecting…' : status === 'connecting' ? 'Connecting…'
    : failing ? `Can't reach ${failing} ${failing === 1 ? 'person' : 'people'}` : connecting ? 'Connecting to peers…' : 'Voice connected';
  const tone = status === 'connected' && !failing && !connecting ? 'text-ok' : failing ? 'text-danger' : 'text-warn';
  const where = channel ? (channel.server_id ? `${channel.name} in ${server?.name ?? ''}` : dmTitle(channel as any, meId)) : '';
  const open = () => { if (!channel) return; navigate(channel.server_id ? `/channels/${channel.server_id}/${channel.id}` : `/channels/@me/${channel.id}`); };

  return (
    <div className="px-2 pt-2 pb-1.5 border-t border-line bg-rail/40 shrink-0">
      <div className="flex items-center gap-1">
        <button className="flex-1 min-w-0 text-left px-1 rounded hover:bg-hover" onClick={open}
          data-tip={failing ? 'A TURN relay server may be needed for some networks. See the deployment guide.' : undefined}>
          <span className={cx('flex items-center gap-1.5 text-sm font-semibold', tone)}><LuSignal size={14} aria-hidden />{label}</span>
          <span className="block text-xs text-muted truncate">{where}</span>
        </button>
        <IconButton label="Disconnect" onClick={() => voice.leave()}><LuPhoneOff size={18} /></IconButton>
      </div>
      <div className="grid grid-cols-2 gap-1.5 mt-1.5">
        <button onClick={() => void voice.setCamera(!camera)} className={cx('h-8 rounded-md flex items-center justify-center gap-1.5 text-sm', camera ? 'bg-fg text-deck' : 'bg-hover hover:bg-active text-fg')} aria-pressed={camera}>
          {camera ? <LuVideoOff size={16} /> : <LuVideo size={16} />}<span className="truncate">{camera ? 'Stop video' : 'Video'}</span>
        </button>
        <button onClick={() => void voice.setScreen(!screen)} className={cx('h-8 rounded-md flex items-center justify-center gap-1.5 text-sm', screen ? 'bg-fg text-deck' : 'bg-hover hover:bg-active text-fg')} aria-pressed={screen}>
          {screen ? <LuMonitorX size={16} /> : <LuMonitorUp size={16} />}<span className="truncate">{screen ? 'Stop screen' : 'Screen'}</span>
        </button>
      </div>
    </div>
  );
}
