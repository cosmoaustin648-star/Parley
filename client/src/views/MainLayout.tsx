import { useEffect } from 'react';
import { useStore, setUi, getState, setState } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import { ServerRail } from './ServerRail.tsx';
import { ChannelSidebar } from './ChannelSidebar.tsx';
import { DmSidebar } from './DmSidebar.tsx';
import { UserPanel } from './UserPanel.tsx';
import { VoiceStatusPanel } from './VoiceStatusPanel.tsx';
import { ChannelView } from './ChannelView.tsx';
import { HomeView } from './HomeView.tsx';
import { DiscoverView } from './DiscoverView.tsx';
import { ModalHost } from './ModalHost.tsx';
import { IncomingCall } from './IncomingCall.tsx';
import { ConnectionBanner } from './ConnectionBanner.tsx';
import { cx } from '../components/ui.tsx';

function useRouteGuards() {
  const route = useStore((s) => s.route);
  const servers = useStore((s) => s.servers);
  const channels = useStore((s) => s.channels);
  const dms = useStore((s) => s.dms);
  useEffect(() => {
    if (route.name === 'server') {
      const server = servers[route.serverId];
      if (!server) { navigate('/channels/@me', true); return; }
      const ch = route.channelId ? channels[route.channelId] : undefined;
      if (!ch || ch.server_id !== route.serverId || ch.type === 'thread') {
        const remembered = getState().ui.lastChannelByServer[route.serverId];
        const list = Object.values(channels).filter((c) => c.server_id === route.serverId && c.type === 'text').sort((a, b) => a.position - b.position);
        const target = (remembered && channels[remembered]?.server_id === route.serverId && channels[remembered].type !== 'thread' ? remembered : null)
          ?? (server.system_channel_id && channels[server.system_channel_id] ? server.system_channel_id : list[0]?.id);
        if (target && target !== route.channelId) navigate(`/channels/${route.serverId}/${target}`, true);
        return;
      }
      const last = { ...getState().ui.lastChannelByServer, [route.serverId]: route.channelId! };
      setUi({ lastChannelByServer: last });
      try { localStorage.setItem('parley.lastChannels', JSON.stringify(last)); } catch { /* ignore */ }
    }
    if (route.name === 'home' && route.dmId && !dms[route.dmId]) {
      // Closed or unknown conversation: try to load it (e.g. from a link), else go home.
      import('../lib/api.ts').then(({ api }) => api.get(`/api/channels/${route.dmId}`)
        .then(() => import('../lib/api.ts').then(({ api: a }) => a.get('/api/users/@me/dms')).then((list: any[]) => {
          const found = list.find((d) => d.id === route.dmId);
          if (found) setState((s) => ({ dms: { ...s.dms, [found.id]: found } })); else navigate('/channels/@me', true);
        }))
        .catch(() => navigate('/channels/@me', true)));
    }
  }, [route, servers, channels, dms]);
}

/** Tab title shows how many mentions and DMs are waiting, e.g. "(3) Parley". */
function useTitleBadge() {
  const count = useStore((s) => Object.values(s.readStates).reduce((n, r) => n + (r.mention_count ?? 0), 0));
  useEffect(() => { document.title = count ? `(${count > 99 ? '99+' : count}) Parley` : 'Parley'; }, [count]);
}

export function MainLayout() {
  const route = useStore((s) => s.route);
  const mobileNav = useStore((s) => s.ui.mobileNav);
  useRouteGuards();
  useTitleBadge();

  let sidebar = null, main = null;
  if (route.name === 'server') { sidebar = <ChannelSidebar serverId={route.serverId} />; main = route.channelId ? <ChannelView key={route.channelId} channelId={route.channelId} /> : null; }
  else if (route.name === 'discover') { sidebar = <DmSidebar />; main = <DiscoverView />; }
  else { sidebar = <DmSidebar />; main = route.name === 'home' && route.dmId ? <ChannelView key={route.dmId} channelId={route.dmId} /> : <HomeView />; }

  return (
    <div className="h-full flex flex-col bg-deck text-fg overflow-hidden">
      <ConnectionBanner />
      <div className="flex-1 min-h-0 flex relative">
        {/* Navigation: always visible on desktop; a drawer on small screens */}
        <div className={cx('flex h-full z-40 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:shadow-2xl', mobileNav ? 'max-md:flex max-md:[animation:slide-in-left_160ms_ease-out]' : 'max-md:hidden')}>
          <ServerRail />
          <nav className="w-60 max-md:w-[min(17rem,calc(100vw-5.5rem))] bg-side flex flex-col min-h-0" aria-label="Channels">
            <div className="flex-1 min-h-0 flex flex-col">{sidebar}</div>
            <VoiceStatusPanel />
            <UserPanel />
          </nav>
        </div>
        {mobileNav && <div className="md:hidden fixed inset-0 z-30 bg-black/50 anim-fade" onClick={() => setUi({ mobileNav: false })} />}
        <main className="flex-1 min-w-0 flex flex-col min-h-0">{main}</main>
      </div>
      <ModalHost />
      <IncomingCall />
    </div>
  );
}
