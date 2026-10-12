import { useMemo, useState } from 'react';
import { LuMenu, LuMessageCircle, LuPlus, LuCompass, LuMailWarning, LuLink } from 'react-icons/lu';
import { useStore, setUi, openModal, displayName, presenceOf, toast } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import { openDm } from '../lib/actions.ts';
import { api, errMsg } from '../lib/api.ts';
import type { User } from '../lib/types.ts';
import { Avatar, Button, IconButton, EmptyState, SignalFlag, statusLabel } from '../components/ui.tsx';

export function VerifyBanner() {
  const me = useStore((s) => s.me);
  const required = useStore((s) => s.meta?.require_email_verification);
  const devOutbox = useStore((s) => s.meta?.dev_outbox);
  const [sent, setSent] = useState(false);
  if (!me || me.email_verified) return null;
  return (
    <div className="m-4 mb-0 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
      <LuMailWarning className="text-warn shrink-0" size={20} />
      <span className="flex-1 min-w-48">
        Confirm <strong>{me.email}</strong> to secure your account{required ? ' — you need a verified email to send messages and join servers.' : '.'}
        {sent && devOutbox && <> Running locally? Find the link in <a className="text-link" href="/api/dev/outbox" target="_blank" rel="noreferrer">the dev outbox</a>.</>}
      </span>
      <Button size="sm" kind="secondary" disabled={sent} onClick={async () => {
        try { await api.post('/api/auth/resend-verification'); setSent(true); toast('Verification email sent.', 'ok'); } catch (e) { toast(errMsg(e), 'error'); }
      }}>{sent ? 'Email sent' : 'Resend email'}</Button>
    </div>
  );
}

export function HomeView() {
  const serverCount = useStore((s) => s.serverOrder.length);
  const members = useStore((s) => s.members);
  const users = useStore((s) => s.users);
  const presences = useStore((s) => s.presences);
  const meId = useStore((s) => s.me?.id);
  const [invite, setInvite] = useState('');

  const online = useMemo(() => {
    const seen = new Map<string, User>();
    for (const p of Object.values(presences)) if (p.status !== 'offline' && p.user_id !== meId && users[p.user_id]) seen.set(p.user_id, users[p.user_id]);
    return [...seen.values()].sort((a, b) => displayName(a).localeCompare(displayName(b))).slice(0, 50);
  }, [presences, users, meId, members]);

  const joinByInvite = (e: Event) => {
    e.preventDefault();
    const code = invite.trim().replace(/^.*\/invite\//, '').replace(/[^A-Za-z0-9]/g, '');
    if (code) navigate(`/invite/${code}`);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-line">
        <IconButton label="Open navigation" className="md:hidden" onClick={() => setUi({ mobileNav: true })}><LuMenu size={20} /></IconButton>
        <LuMessageCircle className="text-muted" />
        <h1 className="font-display font-bold">Home</h1>
        <div className="flex-1" />
        <Button size="sm" onClick={() => openModal({ kind: 'newDm' })}>New message</Button>
      </header>
      <div className="flex-1 min-h-0 scroll">
        <VerifyBanner />
        {serverCount === 0 ? (
          <div className="max-w-xl mx-auto px-6 py-14 flex flex-col items-center text-center gap-6">
            <div className="flex gap-2" aria-hidden>{['a', 'b', 'c'].map((x) => <SignalFlag key={x} id={`welcome-${x}${meId}`} size={56} className="rounded-[12px_12px_12px_4px]" />)}</div>
            <div>
              <h2 className="font-display text-[1.75rem] font-extrabold leading-tight">Find your people</h2>
              <p className="text-muted mt-2 leading-relaxed">Servers are where groups hang out, with text channels for topics and voice channels for talking. Start your own, or join one you've been invited to.</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="lg" onClick={() => openModal({ kind: 'createServer' })}><LuPlus /> Create a server</Button>
              <Button size="lg" kind="secondary" onClick={() => navigate('/discover')}><LuCompass /> Browse public servers</Button>
            </div>
            <form onSubmit={joinByInvite} className="w-full max-w-sm flex gap-2">
              <label className="sr-only" htmlFor="inv">Invite link</label>
              <input id="inv" value={invite} onChange={(e: any) => setInvite(e.target.value)} placeholder="Paste an invite link" className="flex-1 h-10 rounded-lg bg-field px-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
              <Button type="submit" kind="secondary" disabled={!invite.trim()}><LuLink /> Join</Button>
            </form>
          </div>
        ) : (
          <div className="max-w-3xl px-6 py-6">
            <h2 className="text-[0.8rem] font-semibold text-muted mb-2">Online now, {online.length}</h2>
            {online.length ? (
              <ul className="flex flex-col">
                {online.map((u) => {
                  const p = presenceOf(u.id);
                  return (
                    <li key={u.id} className="group flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-hover border-t border-line first:border-t-0">
                      <button onClick={() => openModal({ kind: 'profile', userId: u.id })}><Avatar user={u} size={36} status={p.status} ring="var(--c-deck)" /></button>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold truncate">{displayName(u)} <span className="font-normal text-muted text-sm">{u.username}</span></p>
                        <p className="text-xs text-muted truncate">{p.custom_status || statusLabel(p.status)}</p>
                      </div>
                      <IconButton label={`Message ${displayName(u)}`} onClick={() => void openDm(u.id)}><LuMessageCircle size={18} /></IconButton>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState title="It's quiet right now" body="No one from your servers is online. People show up here when they are." />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
