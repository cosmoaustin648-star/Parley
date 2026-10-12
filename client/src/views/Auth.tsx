import { useEffect, useMemo, useState } from 'react';
import { useStore, setState } from '../lib/store.ts';
import { api, errMsg, ApiError } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { connectGateway } from '../lib/gateway.ts';
import { applyAppearance } from '../lib/appearance.ts';
import type { Me } from '../lib/types.ts';
import { Button, Field, Input, Logo, SignalFlag, Spinner } from '../components/ui.tsx';

/** The one bold moment: a field of signal flags, each a stand-in for a community. */
function FlagField() {
  const ids = useMemo(() => Array.from({ length: 48 }, (_, i) => `flag-${i * 7919 + 13}`), []);
  return (
    <div className="hidden lg:flex relative flex-1 bg-rail overflow-hidden items-end p-12" aria-hidden>
      <div className="absolute inset-0 grid grid-cols-6 gap-3 p-8 opacity-90 content-start" style={{ transform: 'rotate(-8deg) scale(1.25) translate(-4%, -6%)' }}>
        {ids.map((id, i) => (
          <SignalFlag key={id} id={id} size={96} className="w-full h-auto rounded-[10px_10px_10px_3px]" />
        )).filter((_, i) => i % 5 !== 3)}
      </div>
      <div className="absolute inset-0 bg-gradient-to-t from-rail via-rail/70 to-transparent" />
      <div className="relative max-w-md">
        <p className="font-display text-[2.6rem] leading-[1.05] font-extrabold text-fg tracking-tight">Every group gets its own flag.</p>
        <p className="mt-3 text-muted text-[1.05rem] leading-relaxed">Servers, channels, voice rooms and direct messages for the people you actually talk to.</p>
      </div>
    </div>
  );
}

function Shell({ title, subtitle, children }: { title: string; subtitle?: string; children: any }) {
  return (
    <div className="min-h-full flex bg-deck">
      <FlagField />
      <main className="w-full lg:w-[30rem] shrink-0 flex flex-col justify-center px-6 sm:px-12 py-10 bg-side">
        <div className="flex items-center gap-2.5 text-fg mb-10">
          <Logo size={34} />
          <span className="font-display font-extrabold text-xl tracking-tight">Parley</span>
        </div>
        <h1 className="font-display text-[1.75rem] font-bold leading-tight">{title}</h1>
        {subtitle && <p className="text-muted mt-1.5 mb-6">{subtitle}</p>}
        {!subtitle && <div className="mb-6" />}
        {children}
      </main>
    </div>
  );
}

async function signedIn(user: Me, next?: string) {
  setState(() => ({ me: user, boot: 'loading' }));
  applyAppearance(user.settings);
  connectGateway();
  navigate(next && next.startsWith('/') ? next : '/channels/@me', true);
}

function Login({ next }: { next?: string }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { const r = await api.post<{ user: Me }>('/api/auth/login', { login, password }); await signedIn(r.user, next); }
    catch (e2) { setErr(errMsg(e2)); setBusy(false); }
  };
  return (
    <Shell title="Welcome back" subtitle="Sign in to pick up your conversations.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Email or username" htmlFor="login"><Input id="login" autoComplete="username" value={login} onChange={(e: any) => setLogin(e.target.value)} autoFocus required /></Field>
        <Field label="Password" htmlFor="password" error={err}>
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e: any) => setPassword(e.target.value)} required />
        </Field>
        <button type="button" className="text-link text-sm self-start hover:underline -mt-1" onClick={() => navigate('/forgot-password')}>Forgot your password?</button>
        <Button type="submit" size="lg" loading={busy} disabled={!login || !password}>Sign in</Button>
        <p className="text-sm text-muted">New here? <button type="button" className="text-link hover:underline" onClick={() => navigate(next ? `/register?next=${encodeURIComponent(next)}` : '/register')}>Create an account</button></p>
      </form>
    </Shell>
  );
}

function Register({ next }: { next?: string }) {
  const [f, setF] = useState({ email: '', display_name: '', username: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setErrors({});
    try {
      const r = await api.post<{ user: Me }>('/api/auth/register', { ...f, display_name: f.display_name || undefined });
      await signedIn(r.user, next);
    } catch (e2) {
      const er = e2 as ApiError;
      if (er.code === 'username_taken') setErrors({ username: er.message });
      else if (er.code === 'email_taken') setErrors({ email: er.message });
      else if (er.details?.[0]?.path) setErrors({ [er.details[0].path]: er.details[0].message });
      else setErrors({ password: errMsg(e2) });
      setBusy(false);
    }
  };
  return (
    <Shell title="Create your account" subtitle="It takes a minute. You can change everything later.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Email" htmlFor="email" error={errors.email}><Input id="email" type="email" autoComplete="email" value={f.email} onChange={set('email')} autoFocus /></Field>
        <Field label="Display name" htmlFor="dn" hint="What people see. Optional."><Input id="dn" value={f.display_name} onChange={set('display_name')} maxLength={32} /></Field>
        <Field label="Username" htmlFor="un" error={errors.username} hint="Lowercase letters, numbers, _ and . only.">
          <Input id="un" autoComplete="username" value={f.username} onChange={(e: any) => setF({ ...f, username: e.target.value.toLowerCase().replace(/\s/g, '') })} maxLength={32} />
        </Field>
        <Field label="Password" htmlFor="pw" error={errors.password} hint="At least 8 characters.">
          <Input id="pw" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} />
        </Field>
        <Button type="submit" size="lg" loading={busy} disabled={!f.email || !f.username || !f.password}>Create account</Button>
        <p className="text-sm text-muted">Already have an account? <button type="button" className="text-link hover:underline" onClick={() => navigate(next ? `/login?next=${encodeURIComponent(next)}` : '/login')}>Sign in</button></p>
      </form>
    </Shell>
  );
}

function Forgot() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const devOutbox = useStore((s) => s.meta?.dev_outbox);
  return (
    <Shell title="Reset your password" subtitle={sent ? undefined : "Enter your account's email and we'll send you a reset link."}>
      {sent ? (
        <div className="flex flex-col gap-4">
          <p className="text-fg leading-relaxed">If an account exists for <strong>{email}</strong>, a reset link is on its way. It expires in an hour.</p>
          {devOutbox && <p className="text-sm text-muted">Running locally without email? Open <a className="text-link" href="/api/dev/outbox" target="_blank" rel="noreferrer">the dev outbox</a> to find the link.</p>}
          <Button kind="secondary" onClick={() => navigate('/login')}>Back to sign in</Button>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={async (e: Event) => {
          e.preventDefault(); setBusy(true); setErr(null);
          try { await api.post('/api/auth/forgot-password', { email }); setSent(true); } catch (e2) { setErr(errMsg(e2)); }
          setBusy(false);
        }}>
          <Field label="Email" htmlFor="fe" error={err}><Input id="fe" type="email" value={email} onChange={(e: any) => setEmail(e.target.value)} autoFocus /></Field>
          <Button type="submit" size="lg" loading={busy} disabled={!email}>Send reset link</Button>
          <button type="button" className="text-link text-sm self-start hover:underline" onClick={() => navigate('/login')}>Back to sign in</button>
        </form>
      )}
    </Shell>
  );
}

function Reset({ token }: { token: string }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Shell title="Choose a new password" subtitle={done ? undefined : 'You’ll be signed out everywhere else.'}>
      {done ? (
        <div className="flex flex-col gap-4">
          <p>Your password has been changed.</p>
          <Button onClick={() => navigate('/login', true)}>Sign in</Button>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={async (e: Event) => {
          e.preventDefault();
          if (pw !== pw2) { setErr('Passwords don’t match.'); return; }
          setBusy(true); setErr(null);
          try { await api.post('/api/auth/reset-password', { token, password: pw }); setDone(true); } catch (e2) { setErr(errMsg(e2)); }
          setBusy(false);
        }}>
          <Field label="New password" htmlFor="np"><Input id="np" type="password" autoComplete="new-password" value={pw} onChange={(e: any) => setPw(e.target.value)} autoFocus /></Field>
          <Field label="Confirm new password" htmlFor="np2" error={err}><Input id="np2" type="password" autoComplete="new-password" value={pw2} onChange={(e: any) => setPw2(e.target.value)} /></Field>
          <Button type="submit" size="lg" loading={busy} disabled={!pw || !pw2 || !token}>Change password</Button>
        </form>
      )}
    </Shell>
  );
}

function Verify({ token }: { token: string }) {
  const [state, setStateV] = useState<'working' | 'ok' | 'error'>('working');
  const [err, setErr] = useState('');
  const me = useStore((s) => s.me);
  useEffect(() => {
    api.post<{ user: Me }>('/api/auth/verify-email', { token })
      .then((r) => { setStateV('ok'); setState((s) => (s.me ? { me: { ...s.me, email_verified: true } } : {})); void r; })
      .catch((e) => { setStateV('error'); setErr(errMsg(e)); });
  }, [token]);
  return (
    <Shell title={state === 'ok' ? 'Email verified' : state === 'error' ? 'That link didn’t work' : 'Verifying…'}>
      {state === 'working' && <Spinner className="size-6" />}
      {state === 'ok' && <div className="flex flex-col gap-4"><p>Thanks — your email address is confirmed.</p><Button onClick={() => navigate(me ? '/channels/@me' : '/login', true)}>{me ? 'Open Parley' : 'Sign in'}</Button></div>}
      {state === 'error' && <div className="flex flex-col gap-4"><p className="text-muted">{err} You can send a new link from Settings → My Account.</p><Button onClick={() => navigate('/channels/@me', true)}>Continue</Button></div>}
    </Shell>
  );
}

export function AuthScreen() {
  const route = useStore((s) => s.route);
  switch (route.name) {
    case 'register': return <Register next={route.next} />;
    case 'forgot': return <Forgot />;
    case 'reset': return <Reset token={route.token} />;
    case 'verify': return <Verify token={route.token} />;
    case 'login': return <Login next={route.next} />;
    default: return <Login next={location.pathname !== '/' ? location.pathname : undefined} />;
  }
}
