import { useEffect } from 'react';
import { useStore, setState, getState, toast } from './lib/store.ts';
import { api } from './lib/api.ts';
import { connectGateway } from './lib/gateway.ts';
import { navigate } from './lib/router.ts';
import { applyAppearance } from './lib/appearance.ts';
import { installKeybinds } from './lib/keybinds.ts';
import type { Me } from './lib/types.ts';
import { AuthScreen } from './views/Auth.tsx';
import { InviteScreen } from './views/Invite.tsx';
import { MainLayout } from './views/MainLayout.tsx';
import { TooltipLayer, Logo, Spinner } from './components/ui.tsx';
import { Toasts } from './components/Toasts.tsx';

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  api.get('/api/meta').then((meta) => setState(() => ({ meta }))).catch(() => {});
  try {
    const { user } = await api.get<{ user: Me }>('/api/auth/me');
    setState(() => ({ me: user }));
    applyAppearance(user.settings);
    connectGateway();
  } catch {
    setState(() => ({ boot: 'anon' }));
    const r = getState().route;
    if (r.name === 'home' || r.name === 'server' || r.name === 'discover') {
      navigate(`/login?next=${encodeURIComponent(location.pathname)}`, true);
    }
  }
}

export function App() {
  const bootState = useStore((s) => s.boot);
  const route = useStore((s) => s.route);
  const settings = useStore((s) => s.me?.settings);
  const conn = useStore((s) => s.conn);

  useEffect(() => { void boot(); installKeybinds(); }, []);
  useEffect(() => { if (settings) applyAppearance(settings); }, [settings]);
  useEffect(() => {
    // Signed-in users visiting auth pages go to the app.
    if (bootState === 'ready' && ['login', 'register', 'forgot'].includes(route.name)) {
      const next = (route as any).next;
      navigate(next && next.startsWith('/') ? next : '/channels/@me', true);
    }
  }, [bootState, route]);

  let body;
  if (route.name === 'invite') body = <InviteScreen code={route.code} />;
  else if (['login', 'register', 'forgot', 'reset', 'verify'].includes(route.name)) body = <AuthScreen />;
  else if (bootState === 'ready') body = <MainLayout />;
  else if (bootState === 'anon') body = <AuthScreen />;
  else body = <Splash failed={conn === 'offline'} />;

  return (
    <>
      {body}
      <TooltipLayer />
      <Toasts />
    </>
  );
}

function Splash({ failed }: { failed: boolean }) {
  useEffect(() => {
    const t = setTimeout(() => { if (getState().boot === 'loading') toast('Still connecting… check your network.', 'info'); }, 8000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="h-full grid place-items-center bg-rail text-muted">
      <div className="flex flex-col items-center gap-4">
        <span className="text-fg"><Logo size={56} /></span>
        {failed ? <p className="text-sm">You're offline. Parley will reconnect when your network is back.</p> : <Spinner className="size-5" />}
      </div>
    </div>
  );
}
