import { useStore } from '../lib/store.ts';
import { connectGateway } from '../lib/gateway.ts';

export function ConnectionBanner() {
  const conn = useStore((s) => s.conn);
  const me = useStore((s) => s.me);
  if (conn === 'connected') return null;
  if (conn === 'connecting') return null;
  return (
    <div role="status" className="shrink-0 h-8 flex items-center justify-center gap-3 text-sm bg-warn text-[#1A1405] font-medium">
      {conn === 'offline' ? "You're offline. Messages will load again when you reconnect." : 'Connection lost. Reconnecting…'}
      {conn === 'reconnecting' && me && <button className="underline" onClick={() => connectGateway()}>Retry now</button>}
    </div>
  );
}
