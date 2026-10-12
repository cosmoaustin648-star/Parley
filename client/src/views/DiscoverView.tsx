import { useEffect, useState } from 'react';
import { LuMenu, LuCompass, LuSearch, LuUsers } from 'react-icons/lu';
import { setUi, setState, applyServer, openModal } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import { api, errMsg } from '../lib/api.ts';
import { run } from '../lib/actions.ts';
import type { Server } from '../lib/types.ts';
import { Button, IconButton, ServerIcon, Spinner, EmptyState, inputCls, cx } from '../components/ui.tsx';

interface Listing { id: string; name: string; description: string; icon_url: string | null; member_count: number; joined: boolean; is_demo: boolean }

export function DiscoverView() {
  const [q, setQ] = useState('');
  const [list, setList] = useState<Listing[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api.get<Listing[]>(`/api/discover?q=${encodeURIComponent(q)}`).then((r) => { setList(r); setErr(null); }).catch((e) => setErr(errMsg(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const join = async (s: Listing) => {
    const server = await run(() => api.post<Server>(`/api/servers/${s.id}/join`));
    if (server) { setState((st) => applyServer(st, server)); navigate(`/channels/${server.id}`); }
  };
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-line">
        <IconButton label="Open navigation" className="md:hidden" onClick={() => setUi({ mobileNav: true })}><LuMenu size={20} /></IconButton>
        <LuCompass className="text-muted" /><h1 className="font-display font-bold">Discover</h1>
      </header>
      <div className="flex-1 min-h-0 scroll">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <h2 className="font-display text-[1.75rem] font-extrabold leading-tight">Public servers</h2>
          <p className="text-muted mt-1 mb-5">Communities that chose to be listed here. Anyone can join them without an invite.</p>
          <div className="relative max-w-md mb-6">
            <LuSearch className="absolute left-3 top-3 text-muted" />
            <input aria-label="Search public servers" className={cx(inputCls, 'pl-9')} placeholder="Search by name or description" value={q} onChange={(e: any) => setQ(e.target.value)} />
          </div>
          {!list && !err && <Spinner className="size-6" />}
          {err && <p className="text-danger">{err}</p>}
          {list && !list.length && (
            <EmptyState title={q ? `Nothing matches “${q}”` : 'No public servers yet'} body="Server owners can list their server here from Server settings → Overview."
              action={<Button onClick={() => openModal({ kind: 'createServer' })}>Create a server</Button>} />
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list?.map((s) => (
              <article key={s.id} className="rounded-xl bg-side border border-line overflow-hidden flex flex-col">
                <div className="h-20 relative overflow-hidden"><ServerIcon server={s} size={320} className="absolute inset-0 w-full h-auto opacity-60 -translate-y-1/3" /></div>
                <div className="p-4 pt-0 flex flex-col gap-2 flex-1">
                  <ServerIcon server={s} size={56} className="-mt-7 rounded-[14px_14px_14px_4px] ring-4 ring-side relative" />
                  <h3 className="font-display font-bold text-lg leading-tight flex items-center gap-2">{s.name}{s.is_demo && <span className="text-[0.62rem] font-semibold px-1.5 py-0.5 rounded bg-warn/20 text-warn">Demo</span>}</h3>
                  <p className="text-sm text-muted line-clamp-3 flex-1">{s.description || 'No description yet.'}</p>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-muted flex items-center gap-1"><LuUsers size={13} /> {s.member_count} {s.member_count === 1 ? 'member' : 'members'}</span>
                    {s.joined ? <Button size="sm" kind="secondary" onClick={() => navigate(`/channels/${s.id}`)}>Open</Button> : <Button size="sm" onClick={() => void join(s)}>Join</Button>}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
