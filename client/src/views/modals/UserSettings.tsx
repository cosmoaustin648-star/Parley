import { useEffect, useRef, useState } from 'react';
import { LuCheck, LuMonitor, LuSmartphone, LuBellRing } from 'react-icons/lu';
import { useStore, setState, getState, toast, confirmDialog, closeModal, presenceOf } from '../../lib/store.ts';
import { api, errMsg, upload, ApiError } from '../../lib/api.ts';
import { logout, run } from '../../lib/actions.ts';
import { relative } from '../../lib/format.ts';
import { requestNotificationPermission, playTone } from '../../lib/notify.ts';
import { DEFAULT_KEYBINDS, KEYBIND_LABELS, comboFromEvent, type KeybindAction } from '../../lib/keybinds.ts';
import { voice, useVoice } from '../../voice/engine.ts';
import type { Me, Settings, User } from '../../lib/types.ts';
import { Button, Field, Input, TextArea, Select, Switch, Avatar, Spinner, Kbd, cx, EmptyState } from '../../components/ui.tsx';
import { SettingsShell, SectionTitle } from './SettingsShell.tsx';
import { Markdown } from '../../lib/markdown.tsx';

/** Stable empty object for unset settings (selectors must not allocate). */
const NONE: any = Object.freeze({});

/** Optimistically update settings, then persist (debounced for sliders). */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: Settings = {};
function deepMerge(a: any, b: any): any {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a?.[k] ?? {}, v) : v;
  return out;
}
export function updateSettings(patch: Settings, delay = 0) {
  setState((s) => (s.me ? { me: { ...s.me, settings: deepMerge(s.me.settings, patch) } } : {}));
  pending = deepMerge(pending, patch);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body = pending; pending = {};
    api.patch('/api/users/@me', { settings: body }).catch((e) => toast(errMsg(e), 'error'));
  }, delay);
}

export function UserSettings({ initialTab }: { initialTab?: string }) {
  const [tab, setTab] = useState(initialTab ?? 'account');
  return (
    <SettingsShell tab={tab} setTab={(t) => (t === 'logout' ? void logout().then(closeModal) : setTab(t))} sections={[
      { title: 'User settings', items: [
        { id: 'account', label: 'My account' }, { id: 'profile', label: 'Profile' }, { id: 'privacy', label: 'Privacy & safety' },
        { id: 'blocked', label: 'Blocked users' }, { id: 'sessions', label: 'Devices' },
      ] },
      { title: 'App settings', items: [
        { id: 'appearance', label: 'Appearance' }, { id: 'accessibility', label: 'Accessibility' }, { id: 'voice', label: 'Voice & video' },
        { id: 'notifications', label: 'Notifications' }, { id: 'keybinds', label: 'Keybinds' },
      ] },
      { items: [{ id: 'logout', label: 'Log out', danger: true }] },
    ]}>
      {tab === 'account' && <Account />}
      {tab === 'profile' && <Profile />}
      {tab === 'privacy' && <Privacy />}
      {tab === 'blocked' && <Blocked />}
      {tab === 'sessions' && <Sessions />}
      {tab === 'appearance' && <Appearance />}
      {tab === 'accessibility' && <Accessibility />}
      {tab === 'voice' && <VoiceVideo />}
      {tab === 'notifications' && <Notifications />}
      {tab === 'keybinds' && <Keybinds />}
    </SettingsShell>
  );
}

/* ───────────── account ───────────── */
function Account() {
  const me = useStore((s) => s.me)!;
  const [edit, setEdit] = useState<null | 'username' | 'email' | 'password'>(null);
  const [value, setValue] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [delPw, setDelPw] = useState('');
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const body: any = { current_password: current };
      body[edit === 'password' ? 'new_password' : edit!] = value;
      const r = await api.patch<{ user: Me }>('/api/users/@me/account', body);
      setState(() => ({ me: r.user }));
      toast(edit === 'email' ? 'Email changed. Check your inbox to verify it.' : edit === 'password' ? 'Password changed. Other devices were signed out.' : 'Username changed.', 'ok');
      setEdit(null); setValue(''); setCurrent('');
    } catch (e) { setErr(errMsg(e)); }
    setBusy(false);
  };
  const row = (label: string, val: string, k: 'username' | 'email' | 'password', extra?: any) => (
    <div className="flex items-center gap-4 py-3">
      <div className="flex-1 min-w-0"><p className="text-[0.75rem] font-semibold text-muted">{label}</p><p className="truncate">{val} {extra}</p></div>
      <Button size="sm" kind="secondary" onClick={() => { setEdit(k); setValue(k === 'password' ? '' : k === 'username' ? me.username : me.email); setErr(null); }}>Change</Button>
    </div>
  );
  return (
    <div className="flex flex-col">
      <div className="rounded-xl bg-side p-4 flex flex-col divide-y divide-line">
        {row('Username', me.username, 'username')}
        {row('Email', me.email, 'email', me.email_verified ? <span className="text-xs text-ok ml-1">Verified</span> : <button className="text-xs text-link ml-1" onClick={() => void run(() => api.post('/api/auth/resend-verification'), 'Verification email sent.')}>Not verified, resend email</button>)}
        {row('Password', '••••••••••', 'password')}
      </div>
      {edit && (
        <form className="mt-4 rounded-xl border border-line p-4 flex flex-col gap-3" onSubmit={(e: Event) => { e.preventDefault(); void submit(); }}>
          <h3 className="font-semibold">Change {edit}</h3>
          <Field label={edit === 'password' ? 'New password' : `New ${edit}`}><Input type={edit === 'password' ? 'password' : edit === 'email' ? 'email' : 'text'} value={value} onChange={(e: any) => setValue(e.target.value)} autoFocus autoComplete={edit === 'password' ? 'new-password' : 'off'} /></Field>
          <Field label="Current password" error={err}><Input type="password" value={current} onChange={(e: any) => setCurrent(e.target.value)} autoComplete="current-password" /></Field>
          <div className="flex gap-2 justify-end"><Button kind="ghost" type="button" onClick={() => setEdit(null)}>Cancel</Button><Button type="submit" loading={busy} disabled={!value || !current}>Save</Button></div>
        </form>
      )}
      <SectionTitle hint="Deletes your account. Your messages remain but show as from a deleted user. You must transfer or delete servers you own first.">Delete account</SectionTitle>
      <div className="flex gap-2 max-w-md">
        <Input type="password" placeholder="Your password" value={delPw} onChange={(e: any) => setDelPw(e.target.value)} aria-label="Password to delete account" />
        <Button kind="danger" disabled={!delPw} onClick={() => confirmDialog({
          title: 'Delete your account?', body: 'This is permanent. You will be signed out everywhere.', confirmLabel: 'Delete account', danger: true,
          onConfirm: async () => { await api.del('/api/users/@me', { password: delPw }); location.href = '/login'; },
        })}>Delete account</Button>
      </div>
    </div>
  );
}

/* ───────────── profile ───────────── */
function Profile() {
  const me = useStore((s) => s.me)!;
  const initial = { display_name: me.display_name ?? '', bio: me.bio, accent_color: me.accent_color ?? '#2F6FD6', custom_status: me.custom_status ?? '' };
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.patch<{ user: Me }>('/api/users/@me', { display_name: f.display_name || null, bio: f.bio, accent_color: f.accent_color, custom_status: f.custom_status || null });
      setState(() => ({ me: r.user })); toast('Profile saved.', 'ok');
    } catch (e) { toast(errMsg(e), 'error'); }
    setBusy(false);
  };
  const uploadImg = (kind: 'avatar' | 'banner') => (e: any) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (file) void run(async () => { const r = await upload<{ user: Me }>('PUT', `/api/users/@me/${kind}`, file); setState(() => ({ me: r.user })); }, kind === 'avatar' ? 'Avatar updated.' : 'Banner updated.');
  };
  const preview: User = { ...me, display_name: f.display_name || null, bio: f.bio, accent_color: f.accent_color };
  return (
    <div className="flex flex-col lg:flex-row gap-8">
      <div className="flex-1 flex flex-col gap-4">
        <Field label="Display name"><Input value={f.display_name} onChange={(e: any) => setF({ ...f, display_name: e.target.value })} maxLength={32} placeholder={me.username} /></Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.8rem] font-semibold text-muted">Avatar</span>
          <div className="flex gap-2">
            <label><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={uploadImg('avatar')} /><span role="button" tabIndex={0} className="h-8 px-3 rounded-lg bg-accent text-accent-ink text-sm font-medium inline-grid place-items-center cursor-pointer">Change avatar</span></label>
            {me.avatar_url && <Button size="sm" kind="ghost" onClick={() => void run(async () => { const r = await api.del<{ user: Me }>('/api/users/@me/avatar'); setState(() => ({ me: r.user })); })}>Remove</Button>}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.8rem] font-semibold text-muted">Banner</span>
          <div className="flex gap-2">
            <label><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={uploadImg('banner')} /><span role="button" tabIndex={0} className="h-8 px-3 rounded-lg bg-active text-sm font-medium inline-grid place-items-center cursor-pointer">Change banner</span></label>
            {me.banner_url && <Button size="sm" kind="ghost" onClick={() => void run(async () => { const r = await api.del<{ user: Me }>('/api/users/@me/banner'); setState(() => ({ me: r.user })); })}>Remove</Button>}
          </div>
        </div>
        <Field label="Profile colour" hint="Used behind your banner and on your call tile."><input type="color" value={f.accent_color} onChange={(e: any) => setF({ ...f, accent_color: e.target.value })} className="h-10 w-20 rounded-lg bg-field cursor-pointer" aria-label="Profile colour" /></Field>
        <Field label="Custom status"><Input value={f.custom_status} onChange={(e: any) => setF({ ...f, custom_status: e.target.value })} maxLength={128} placeholder="What are you up to?" /></Field>
        <Field label="About me" hint={`${190 - f.bio.length} characters left. Markdown works.`}><TextArea value={f.bio} onChange={(e: any) => setF({ ...f, bio: e.target.value })} maxLength={190} /></Field>
        <div className="flex gap-2"><Button disabled={!dirty} loading={busy} onClick={save}>Save profile</Button>{dirty && <Button kind="ghost" onClick={() => setF(initial)}>Reset</Button>}</div>
      </div>
      <div className="lg:w-72 shrink-0">
        <p className="text-[0.75rem] font-semibold text-muted mb-2">Preview</p>
        <div className="rounded-xl bg-side overflow-hidden">
          <div className="h-20" style={{ background: f.accent_color }}>{me.banner_url && <img src={me.banner_url} alt="" className="size-full object-cover" />}</div>
          <div className="px-4 pb-4 -mt-9">
            <Avatar user={preview} size={72} status={presenceOf(me.id).status} ring="var(--c-side)" className="ring-[5px] ring-side rounded-full" />
            <p className="font-display font-bold text-lg mt-1">{f.display_name || me.username}</p>
            <p className="text-sm text-muted">{me.username}</p>
            {f.custom_status && <p className="text-sm mt-1">{f.custom_status}</p>}
            {f.bio && <div className="mt-3 pt-3 border-t border-line text-sm"><Markdown content={f.bio} serverId={null} /></div>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────── privacy, blocked, sessions ───────────── */
function Privacy() {
  const p = useStore((s) => s.me!.settings.privacy ?? NONE);
  return (
    <div className="flex flex-col divide-y divide-line">
      <Switch checked={p.allow_dms_from_server_members !== false} onChange={(v) => updateSettings({ privacy: { allow_dms_from_server_members: v } })}
        label="Allow new direct messages" description="When off, people can't start new conversations with you. Existing conversations keep working." />
      <Switch checked={p.read_receipts !== false} onChange={(v) => updateSettings({ privacy: { read_receipts: v } })}
        label="Send read receipts" description="Let people in your direct messages see when you've read their messages." />
      <Switch checked={p.show_typing !== false} onChange={(v) => updateSettings({ privacy: { show_typing: v } })}
        label="Show when I'm typing" />
      <p className="text-sm text-muted pt-4">Want to disappear for a while? Set your status to Invisible from the panel in the bottom-left.</p>
    </div>
  );
}

function Blocked() {
  const blocked = useStore((s) => s.blocked);
  const list = Object.values(blocked);
  if (!list.length) return <EmptyState title="You haven't blocked anyone" body="Blocked people can't message you directly or call you, and their messages are hidden for you. Block someone from their profile." />;
  return (
    <div className="flex flex-col divide-y divide-line">
      {list.map((u) => (
        <div key={u.id} className="flex items-center gap-3 py-2.5">
          <Avatar user={u} size={32} /><span className="flex-1">{u.display_name || u.username} <span className="text-muted text-sm">{u.username}</span></span>
          <Button size="sm" kind="secondary" onClick={() => void run(() => api.del(`/api/users/@me/blocks/${u.id}`), 'Unblocked.')}>Unblock</Button>
        </div>
      ))}
    </div>
  );
}

function Sessions() {
  const [list, setList] = useState<any[] | null>(null);
  const load = () => api.get('/api/auth/sessions').then(setList).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { void load(); }, []);
  if (!list) return <Spinner />;
  const device = (ua: string) => /Mobile|Android|iPhone/i.test(ua) ? 'Phone' : 'Computer';
  const browser = (ua: string) => /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">Places you're signed in. Sign out anything you don't recognise and change your password.</p>
      {list.map((s) => (
        <div key={s.id} className="flex items-center gap-3 rounded-lg bg-side p-3">
          {device(s.user_agent ?? '') === 'Phone' ? <LuSmartphone size={22} className="text-muted" /> : <LuMonitor size={22} className="text-muted" />}
          <div className="flex-1 min-w-0">
            <p className="font-medium">{browser(s.user_agent ?? '')} on {device(s.user_agent ?? '').toLowerCase()} {s.current && <span className="text-xs text-ok ml-1">This device</span>}</p>
            <p className="text-xs text-muted">{s.ip ?? 'Unknown IP'}, last active {relative(s.last_seen_at)}</p>
          </div>
          {!s.current && <Button size="sm" kind="ghost" onClick={() => void run(async () => { await api.del(`/api/auth/sessions/${s.id}`); await load(); }, 'Signed out.')}>Sign out</Button>}
        </div>
      ))}
      {list.length > 1 && <Button kind="danger" className="self-start" onClick={() => void run(async () => { await api.post('/api/auth/logout-others'); await load(); }, 'Signed out of all other devices.')}>Sign out all other devices</Button>}
    </div>
  );
}

/* ───────────── appearance & accessibility ───────────── */
const THEMES = [
  { id: 'harbor', name: 'Harbor', colors: ['#0E1420', '#141C29', '#1A2331'] },
  { id: 'deep', name: 'Deep water', colors: ['#090D15', '#0F151F', '#131A26'] },
  { id: 'midnight', name: 'Midnight', colors: ['#000000', '#05070B', '#000000'] },
  { id: 'daylight', name: 'Daylight', colors: ['#DCE2EA', '#EBEFF4', '#F7F9FB'] },
] as const;
const ACCENTS = ['#F5C542', '#5B9BF0', '#E5534B', '#3DBE8B', '#B48CF2', '#F08A4B', '#4FC1D6', '#F2F4F7'];

function Appearance() {
  const s = useStore((st) => st.me!.settings);
  const theme = s.theme === 'dark' ? 'harbor' : s.theme === 'darker' ? 'deep' : s.theme === 'light' ? 'daylight' : s.theme ?? 'harbor';
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>Theme</SectionTitle>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {THEMES.map((t) => (
          <button key={t.id} onClick={() => updateSettings({ theme: t.id })} aria-pressed={theme === t.id}
            className={cx('rounded-xl overflow-hidden border-2 text-left', theme === t.id ? 'border-accent' : 'border-line hover:border-muted')}>
            <div className="h-16 flex">{t.colors.map((c, i) => <span key={i} className={i === 0 ? 'w-4' : i === 1 ? 'w-10' : 'flex-1'} style={{ background: c }} />)}</div>
            <div className="px-2.5 py-1.5 text-sm flex items-center justify-between">{t.name}{theme === t.id && <LuCheck className="text-accent" />}</div>
          </button>
        ))}
      </div>
      <SectionTitle hint="Buttons, the active channel marker and highlights.">Accent colour</SectionTitle>
      <div className="flex flex-wrap items-center gap-2">
        {ACCENTS.map((c) => (
          <button key={c} aria-label={`Accent ${c}`} aria-pressed={(s.accent ?? '#F5C542') === c} onClick={() => updateSettings({ accent: c })}
            className={cx('size-9 rounded-full grid place-items-center ring-offset-2 ring-offset-deck', (s.accent ?? '#F5C542').toLowerCase() === c.toLowerCase() && 'ring-2 ring-fg')} style={{ background: c }} />
        ))}
        <label className="h-9 px-3 rounded-full border border-line flex items-center gap-2 text-sm cursor-pointer">Custom
          <input type="color" value={s.accent ?? '#F5C542'} onChange={(e: any) => updateSettings({ accent: e.target.value }, 300)} className="size-5 rounded-full bg-transparent" aria-label="Custom accent colour" />
        </label>
      </div>
      <SectionTitle>Font</SectionTitle>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {([['default', 'Inter', '"Inter"'], ['readable', 'Readable', '"DejaVu Sans"'], ['rounded', 'Rounded', '"Poppins"'], ['serif', 'Serif', '"Lora"'], ['mono', 'Mono', '"DejaVu Sans Mono"']] as const).map(([id, label, family]) => (
          <button key={id} onClick={() => updateSettings({ font: id })} aria-pressed={(s.font ?? 'default') === id}
            className={cx('rounded-lg border-2 px-3 py-2.5 text-left', (s.font ?? 'default') === id ? 'border-accent' : 'border-line hover:border-muted')}>
            <span className="block text-lg" style={{ fontFamily: family }}>Ag</span><span className="text-xs text-muted">{label}</span>
          </button>
        ))}
      </div>
      <SectionTitle>Size and spacing</SectionTitle>
      <Slider label="Text size" min={12} max={22} value={s.font_scale ?? 16} unit="px" onChange={(v) => updateSettings({ font_scale: v }, 300)} />
      <Slider label="Space between message groups" min={0} max={24} value={s.message_spacing ?? (s.compact ? 4 : 16)} unit="px" onChange={(v) => updateSettings({ message_spacing: v }, 300)} />
      <Switch checked={!!s.compact} onChange={(v) => updateSettings({ compact: v })} label="Compact mode" description="Fit more messages on screen." />
      <Switch checked={!!s.show_timestamps_24h} onChange={(v) => updateSettings({ show_timestamps_24h: v })} label="Use 24-hour time" />
    </div>
  );
}

function Slider({ label, min, max, value, unit, onChange }: { label: string; min: number; max: number; value: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1.5 py-2">
      <span className="flex justify-between text-[0.95rem]">{label}<span className="text-muted tabular-nums">{value}{unit}</span></span>
      <input type="range" min={min} max={max} value={value} onChange={(e: any) => onChange(Number(e.target.value))} className="accent-[var(--c-accent)]" />
    </label>
  );
}

function Accessibility() {
  const s = useStore((st) => st.me!.settings);
  return (
    <div className="flex flex-col divide-y divide-line">
      <Switch checked={!!s.reduced_motion} onChange={(v) => updateSettings({ reduced_motion: v })} label="Reduce motion" description="Turns off animations. Parley also follows your system's reduced-motion setting." />
      <Switch checked={!!s.high_contrast} onChange={(v) => updateSettings({ high_contrast: v })} label="Higher contrast" description="Makes secondary text and dividers stronger." />
      <Switch checked={!!s.underline_links} onChange={(v) => updateSettings({ underline_links: v })} label="Always underline links" />
      <div className="pt-2"><Slider label="Colour saturation" min={0} max={100} value={s.saturation ?? 100} unit="%" onChange={(v) => updateSettings({ saturation: v }, 300)} /></div>
      <p className="text-sm text-muted pt-4">Status is shown by shape as well as colour: a filled dot for online, a crescent for idle, a bar for do not disturb and a ring for offline.</p>
    </div>
  );
}

/* ───────────── notifications ───────────── */
function Notifications() {
  const n = useStore((s) => s.me!.settings.notifications ?? NONE);
  const status = useStore((s) => s.me!.status);
  const [perm, setPerm] = useState<string>(() => ('Notification' in window ? Notification.permission : 'unsupported'));
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg bg-side p-4 flex items-center gap-3">
        <LuBellRing className="text-accent shrink-0" size={22} />
        <p className="flex-1 text-sm">
          {perm === 'granted' ? 'Desktop notifications are allowed in this browser.' : perm === 'denied' ? 'Notifications are blocked for this site in your browser settings.' : perm === 'unsupported' ? "This browser doesn't support desktop notifications." : 'Allow desktop notifications to hear about mentions and messages when Parley is in the background.'}
        </p>
        {perm === 'default' && <Button size="sm" onClick={async () => setPerm(String(await requestNotificationPermission()))}>Allow</Button>}
        {perm === 'granted' && <Button size="sm" kind="secondary" onClick={() => { playTone('mention'); new Notification('Parley', { body: 'Notifications are working.', icon: '/favicon.svg' }); }}>Send a test</Button>}
      </div>
      {status === 'dnd' && <p className="text-sm text-warn">You're on Do Not Disturb, so sounds and pop-ups are paused. Badges still update.</p>}
      <div className="flex flex-col divide-y divide-line">
        <Switch checked={n.desktop !== false} onChange={(v) => updateSettings({ notifications: { desktop: v } })} label="Desktop notifications" />
        <Switch checked={n.sounds !== false} onChange={(v) => updateSettings({ notifications: { sounds: v } })} label="Sounds" description="Message, mention, call and voice join sounds." />
        <Switch checked={n.dm !== false} onChange={(v) => updateSettings({ notifications: { dm: v } })} label="Direct message notifications" />
      </div>
      <p className="text-sm text-muted">Per-server and per-channel settings live in each server's menu and each channel's right-click menu.</p>
    </div>
  );
}

/* ───────────── voice & video ───────────── */
function VoiceVideo() {
  const v = useStore((s) => s.me!.settings.voice ?? NONE);
  const level = useVoice((x) => x.inputLevel);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [cam, setCam] = useState<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const refresh = () => navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {});
  useEffect(() => { void refresh(); navigator.mediaDevices?.addEventListener?.('devicechange', refresh); return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh); }, []);
  useEffect(() => () => { voice.stopTest(); }, []);
  useEffect(() => () => { cam?.getTracks().forEach((t) => t.stop()); }, [cam]);
  useEffect(() => { if (video.current) video.current.srcObject = cam; }, [cam]);
  const set = (patch: any, reopen = false) => { updateSettings({ voice: patch }, 200); if (reopen) setTimeout(() => void voice.applyDeviceSettings(), 50); };
  const opts = (kind: MediaDeviceKind) => [{ value: '', label: 'System default' }, ...devices.filter((d) => d.kind === kind && d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Microphone' : kind === 'audiooutput' ? 'Speaker' : 'Camera'} ${i + 1}` }))];
  const labelsHidden = devices.length > 0 && devices.every((d) => !d.label);
  const threshold = v.vad_threshold ?? 40;
  return (
    <div className="flex flex-col gap-4">
      {labelsHidden && <p className="text-sm text-muted">Device names appear once you've allowed microphone or camera access. Press “Test microphone” to allow it.</p>}
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Microphone"><Select value={v.input_device ?? ''} onChange={(x) => set({ input_device: x || null }, true)} options={opts('audioinput')} /></Field>
        <Field label="Speaker" hint={!('setSinkId' in HTMLMediaElement.prototype) ? "This browser can't pick an output device." : undefined}>
          <Select value={v.output_device ?? ''} onChange={(x) => set({ output_device: x || null }, true)} options={opts('audiooutput')} disabled={!('setSinkId' in HTMLMediaElement.prototype)} />
        </Field>
      </div>
      <Slider label="Input volume" min={0} max={200} value={v.input_volume ?? 100} unit="%" onChange={(x) => { set({ input_volume: x }); voice.setInputVolume(x); }} />
      <Slider label="Output volume" min={0} max={100} value={v.output_volume ?? 100} unit="%" onChange={(x) => set({ output_volume: x }, true)} />
      <SectionTitle>Input mode</SectionTitle>
      <div className="flex gap-2">
        {([['voice', 'Voice activity'], ['ptt', 'Push to talk']] as const).map(([id, l]) => (
          <button key={id} aria-pressed={(v.input_mode ?? 'voice') === id} onClick={() => set({ input_mode: id })} className={cx('h-10 px-4 rounded-lg border-2 text-sm', (v.input_mode ?? 'voice') === id ? 'border-accent' : 'border-line')}>{l}</button>
        ))}
      </div>
      {(v.input_mode ?? 'voice') === 'ptt'
        ? <p className="text-sm text-muted">Hold the push-to-talk key (change it in Keybinds) to transmit.</p>
        : (
          <div className="flex flex-col gap-2">
            <span className="text-[0.95rem]">Input sensitivity</span>
            <div className="relative h-3 rounded-full bg-field overflow-hidden" aria-hidden>
              <div className={cx('absolute inset-y-0 left-0 transition-[width] duration-75', level >= threshold ? 'bg-ok' : 'bg-warn')} style={{ width: `${level}%` }} />
              <div className="absolute inset-y-0 w-0.5 bg-fg" style={{ left: `${threshold}%` }} />
            </div>
            <input type="range" min={0} max={100} value={threshold} onChange={(e: any) => set({ vad_threshold: Number(e.target.value) })} className="accent-[var(--c-accent)]" aria-label="Input sensitivity" />
            <p className="text-xs text-muted">Your mic opens when the bar passes the marker.{!testing ? ' Start a test to see your level.' : ''}</p>
          </div>
        )}
      <Button kind="secondary" className="self-start" onClick={async () => { if (testing) { voice.stopTest(); setTesting(false); } else { await voice.startTest(); setTesting(true); void refresh(); } }}>{testing ? 'Stop test' : 'Test microphone'}</Button>
      <SectionTitle>Voice processing</SectionTitle>
      <div className="flex flex-col divide-y divide-line">
        <Switch checked={v.noise_suppression !== false} onChange={(x) => set({ noise_suppression: x }, true)} label="Noise suppression" />
        <Switch checked={v.echo_cancellation !== false} onChange={(x) => set({ echo_cancellation: x }, true)} label="Echo cancellation" />
        <Switch checked={v.auto_gain !== false} onChange={(x) => set({ auto_gain: x }, true)} label="Automatic gain control" />
      </div>
      <SectionTitle>Video</SectionTitle>
      <Field label="Camera"><Select value={v.video_device ?? ''} onChange={(x) => set({ video_device: x || null })} options={opts('videoinput')} /></Field>
      <div className="rounded-xl bg-rail aspect-video max-w-md grid place-items-center overflow-hidden relative">
        {cam ? <video ref={video} autoPlay playsInline muted className="absolute inset-0 size-full object-cover -scale-x-100" /> : (
          <Button kind="secondary" onClick={async () => {
            try { setCam(await navigator.mediaDevices.getUserMedia({ video: { deviceId: v.video_device ? { ideal: v.video_device } : undefined } })); void refresh(); }
            catch (e: any) { toast(e?.name === 'NotAllowedError' ? 'Camera access is blocked for this site.' : `Couldn't open the camera: ${e?.message ?? e}`, 'error'); }
          }}>Test video</Button>
        )}
      </div>
      {cam && <Button kind="ghost" className="self-start" onClick={() => setCam(null)}>Stop video test</Button>}
    </div>
  );
}

/* ───────────── keybinds ───────────── */
function Keybinds() {
  const kb = useStore((s) => s.me!.settings.keybinds ?? NONE);
  const [recording, setRecording] = useState<KeybindAction | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted mb-2">Click a shortcut, then press the keys you want.</p>
      {(Object.keys(DEFAULT_KEYBINDS) as KeybindAction[]).map((k) => {
        const val: string = kb[k] ?? DEFAULT_KEYBINDS[k];
        return (
          <div key={k} className="flex items-center gap-4 py-2 border-b border-line">
            <span className="flex-1">{KEYBIND_LABELS[k]}</span>
            <button data-capturing={recording === k ? 'true' : undefined}
              onClick={() => setRecording(recording === k ? null : k)}
              onKeyDown={(e: KeyboardEvent) => {
                if (recording !== k) return;
                e.preventDefault(); e.stopPropagation();
                if (e.key === 'Escape') { setRecording(null); return; }
                const combo = comboFromEvent(e);
                if (combo) { updateSettings({ keybinds: { [k]: combo } }); setRecording(null); }
              }}
              onBlur={() => setRecording(null)}
              className={cx('min-w-40 h-9 px-3 rounded-lg border-2 flex items-center justify-center gap-1', recording === k ? 'border-accent text-accent' : 'border-line')}>
              {recording === k ? 'Press keys…' : val.split('+').map((p) => <Kbd key={p}>{p}</Kbd>)}
            </button>
            {kb[k] && kb[k] !== DEFAULT_KEYBINDS[k] && <Button size="sm" kind="ghost" onClick={() => updateSettings({ keybinds: { [k]: DEFAULT_KEYBINDS[k] } })}>Reset</Button>}
          </div>
        );
      })}
    </div>
  );
}

export { getState, ApiError };
