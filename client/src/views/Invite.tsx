import { useEffect, useState } from 'react';
import { useStore, setState } from '../lib/store.ts';
import { api, errMsg } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import type { Server } from '../lib/types.ts';
import { Button, Logo, ServerIcon, Spinner } from '../components/ui.tsx';
import { applyServer } from '../lib/store.ts';

interface Preview { code: string; server: { id: string; name: string; icon_url: string | null; description: string; member_count: number }; joined: boolean }

export function InviteScreen({ code }: { code: string }) {
  const me = useStore((s) => s.me);
  const bootState = useStore((s) => s.boot);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Preview>(`/api/invites/${encodeURIComponent(code)}`).then(setPreview).catch((e) => setErr(errMsg(e)));
  }, [code, me?.id]);

  const accept = async () => {
    setBusy(true);
    try {
      const server = await api.post<Server>(`/api/invites/${encodeURIComponent(code)}/accept`);
      setState((s) => applyServer(s, server));
      navigate(`/channels/${server.id}/${server.system_channel_id ?? server.channels.find((c) => c.type === 'text')?.id ?? ''}`, true);
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };

  return (
    <div className="min-h-full grid place-items-center bg-rail p-6">
      <div className="w-full max-w-sm rounded-xl bg-side p-8 flex flex-col items-center text-center gap-4" style={{ boxShadow: 'var(--shadow-pop)' }}>
        <span className="text-fg flex items-center gap-2"><Logo size={26} /><span className="font-display font-extrabold">Parley</span></span>
        {!preview && !err && <Spinner className="size-6 my-8" />}
        {err && (
          <>
            <h1 className="font-display text-xl font-bold mt-2">This invite can’t be used</h1>
            <p className="text-muted text-sm">{err} Ask whoever sent it for a new link.</p>
            <Button kind="secondary" onClick={() => navigate(me ? '/channels/@me' : '/login')}>{me ? 'Go to Parley' : 'Sign in'}</Button>
          </>
        )}
        {preview && !err && (
          <>
            <ServerIcon server={preview.server} size={80} className="rounded-[18px_18px_18px_6px] mt-2" />
            <div>
              <p className="text-sm text-muted">You've been invited to join</p>
              <h1 className="font-display text-2xl font-bold mt-0.5">{preview.server.name}</h1>
              <p className="text-sm text-muted mt-1">{preview.server.member_count} {preview.server.member_count === 1 ? 'member' : 'members'}</p>
            </div>
            {preview.server.description && <p className="text-sm text-fg/90 leading-relaxed">{preview.server.description}</p>}
            {me ? (
              preview.joined
                ? <Button className="w-full" onClick={() => navigate(`/channels/${preview.server.id}`)}>You're already a member — open it</Button>
                : <Button className="w-full" size="lg" loading={busy || bootState === 'loading'} onClick={accept}>Accept invite</Button>
            ) : (
              <div className="w-full flex flex-col gap-2">
                <Button size="lg" className="w-full" onClick={() => navigate(`/register?next=${encodeURIComponent(`/invite/${code}`)}`)}>Create an account to join</Button>
                <Button kind="ghost" className="w-full" onClick={() => navigate(`/login?next=${encodeURIComponent(`/invite/${code}`)}`)}>I already have an account</Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
