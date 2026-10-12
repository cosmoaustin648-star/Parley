import { useEffect, useMemo, useRef, useState } from 'react';
import { LuHash, LuVolume2, LuCopy, LuCheck, LuLock, LuX, LuSearch, LuDownload, LuExternalLink, LuUsers } from 'react-icons/lu';
import {
  useStore, closeModal, getState, setState, applyServer, toast, displayName, setUi, presenceOf, cmpId,
} from '../../lib/store.ts';
import { api, errMsg, upload } from '../../lib/api.ts';
import { navigate } from '../../lib/router.ts';
import { run, openDm } from '../../lib/actions.ts';
import { duration, relative } from '../../lib/format.ts';
import { bindings, KEYBIND_LABELS } from '../../lib/keybinds.ts';
import type { Server, Invite, User, DmChannel } from '../../lib/types.ts';
import { Modal, Button, Field, Input, TextArea, Select, Switch, Avatar, Kbd, Spinner, cx, inputCls, ServerIcon } from '../../components/ui.tsx';
import { dmTitle } from '../DmSidebar.tsx';
import { Markdown } from '../../lib/markdown.tsx';

/* ───────────── create / join server ───────────── */
export function CreateServerModal() {
  const me = useStore((s) => s.me)!;
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState(`${me.display_name || me.username}'s server`);
  const [isPublic, setPublic] = useState(false);
  const [icon, setIcon] = useState<File | null>(null);
  const [link, setLink] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => (icon ? URL.createObjectURL(icon) : null), [icon]);

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const server = await api.post<Server>('/api/servers', { name, is_public: isPublic });
      if (icon) await upload('PUT', `/api/servers/${server.id}/icon`, icon).catch((e) => toast(`Server created, but the icon didn't upload: ${errMsg(e)}`, 'error'));
      setState((s) => applyServer(s, server));
      closeModal();
      navigate(`/channels/${server.id}/${server.system_channel_id ?? ''}`);
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  const join = () => {
    const code = link.trim().replace(/^.*\/invite\//, '').replace(/[^A-Za-z0-9]/g, '');
    if (!code) { setErr('Paste an invite link or code.'); return; }
    closeModal();
    navigate(`/invite/${code}`);
  };

  return (
    <Modal title={mode === 'create' ? 'Create a server' : 'Join a server'} subtitle={mode === 'create' ? 'Your server is where you and your people hang out. You can change all of this later.' : 'Enter an invite to join an existing server.'}
      footer={<>
        <Button kind="ghost" onClick={() => { setMode(mode === 'create' ? 'join' : 'create'); setErr(null); }}>{mode === 'create' ? 'I have an invite' : 'Create my own instead'}</Button>
        {mode === 'create' ? <Button onClick={create} loading={busy} disabled={name.trim().length < 2}>Create server</Button> : <Button onClick={join} disabled={!link.trim()}>Join server</Button>}
      </>}>
      {mode === 'create' ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <label className="size-20 shrink-0 rounded-[18px_18px_18px_6px] overflow-hidden border-2 border-dashed border-line grid place-items-center cursor-pointer text-xs text-muted text-center hover:border-accent" data-tip="Upload an icon">
              {preview ? <img src={preview} alt="" className="size-full object-cover" /> : <span>Add icon</span>}
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e: any) => setIcon(e.target.files?.[0] ?? null)} />
            </label>
            <p className="text-sm text-muted">No icon? You'll get a signal flag that's unique to your server.</p>
          </div>
          <Field label="Server name" htmlFor="sname" error={err}><Input id="sname" value={name} onChange={(e: any) => setName(e.target.value)} maxLength={100} autoFocus /></Field>
          <Switch checked={isPublic} onChange={setPublic} label="List in Discover" description="Anyone can find and join a public server without an invite." />
        </div>
      ) : (
        <Field label="Invite link" htmlFor="ilink" error={err} hint="Looks like https://your-parley/invite/aB3dEf9h or just aB3dEf9h">
          <Input id="ilink" value={link} onChange={(e: any) => setLink(e.target.value)} autoFocus />
        </Field>
      )}
    </Modal>
  );
}

/* ───────────── invite ───────────── */
export function InviteModal({ serverId }: { serverId: string }) {
  const server = useStore((s) => s.servers[serverId]);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [age, setAge] = useState('604800');
  const [uses, setUses] = useState('0');
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setErr(null); setInvite(null);
    try { setInvite(await api.post<Invite>(`/api/servers/${serverId}/invites`, { max_age_seconds: Number(age), max_uses: Number(uses) || null })); }
    catch (e) { setErr(errMsg(e)); }
  };
  useEffect(() => { void create(); }, [age, uses]);
  const url = invite ? `${location.origin}/invite/${invite.code}` : '';
  return (
    <Modal title={`Invite people to ${server?.name ?? 'this server'}`} subtitle="Share this link. Anyone with it can join while it's valid.">
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          <input readOnly value={url || 'Creating link…'} className={cx(inputCls, 'font-mono text-sm')} aria-label="Invite link" onFocus={(e: any) => e.target.select()} />
          <Button disabled={!url} onClick={() => { void navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? <LuCheck /> : <LuCopy />}{copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {err && <p className="text-sm text-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Expires after"><Select value={age} onChange={setAge} options={[
            { value: '1800', label: '30 minutes' }, { value: '3600', label: '1 hour' }, { value: '21600', label: '6 hours' },
            { value: '86400', label: '1 day' }, { value: '604800', label: '7 days' }, { value: '0', label: 'Never' },
          ]} /></Field>
          <Field label="Max uses"><Select value={uses} onChange={setUses} options={[
            { value: '0', label: 'No limit' }, { value: '1', label: '1 use' }, { value: '5', label: '5 uses' }, { value: '10', label: '10 uses' }, { value: '25', label: '25 uses' }, { value: '100', label: '100 uses' },
          ]} /></Field>
        </div>
        {invite && <p className="text-xs text-muted">{invite.expires_at ? `Expires ${new Date(invite.expires_at).toLocaleString()}.` : 'Never expires.'} {invite.max_uses ? `Works for ${invite.max_uses} ${invite.max_uses === 1 ? 'person' : 'people'}.` : ''}</p>}
      </div>
    </Modal>
  );
}

/* ───────────── channels & categories ───────────── */
export function CreateChannelModal({ serverId, categoryId, type: initialType }: { serverId: string; categoryId: string | null; type?: 'text' | 'voice' }) {
  const server = useStore((s) => s.servers[serverId]);
  const [type, setType] = useState<'text' | 'voice'>(initialType ?? 'text');
  const [name, setName] = useState('');
  const [cat, setCat] = useState(categoryId ?? '');
  const [priv, setPriv] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = type === 'text' ? name.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '') : name;
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const ch = await api.post(`/api/servers/${serverId}/channels`, { name, type, category_id: cat || null, private: priv });
      closeModal();
      if (type === 'text') navigate(`/channels/${serverId}/${ch.id}`);
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  return (
    <Modal title="Create channel" footer={<><Button kind="ghost" onClick={closeModal}>Cancel</Button><Button onClick={create} loading={busy} disabled={!shown.trim()}>Create channel</Button></>}>
      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="text-[0.8rem] font-semibold text-muted mb-1.5">Channel type</legend>
          {([['text', LuHash, 'Text', 'Messages, images, links and threads'], ['voice', LuVolume2, 'Voice', 'Talk, share video and screens']] as const).map(([v, Icon, label, desc]) => (
            <label key={v} className={cx('flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer border', type === v ? 'border-accent bg-active' : 'border-transparent bg-field hover:bg-active')}>
              <Icon size={22} className="text-muted" />
              <span className="flex-1"><span className="block font-medium">{label}</span><span className="block text-xs text-muted">{desc}</span></span>
              <input type="radio" name="ctype" checked={type === v} onChange={() => setType(v)} className="accent-[var(--c-accent)]" />
            </label>
          ))}
        </fieldset>
        <Field label="Channel name" htmlFor="cname" error={err} hint={type === 'text' && name && shown !== name ? `Will be created as #${shown}` : undefined}>
          <Input id="cname" value={name} onChange={(e: any) => setName(e.target.value)} placeholder={type === 'text' ? 'new-channel' : 'Lounge'} maxLength={100} autoFocus />
        </Field>
        <Field label="Category"><Select value={cat} onChange={setCat} options={[{ value: '', label: 'No category' }, ...(server?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))]} /></Field>
        <Switch checked={priv} onChange={setPriv} label="Private channel" description="Only you (and admins) can see it until you grant access to roles or members in its permissions." />
      </div>
    </Modal>
  );
}

export function CreateCategoryModal({ serverId }: { serverId: string }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="Create category" footer={<><Button kind="ghost" onClick={closeModal}>Cancel</Button><Button loading={busy} disabled={!name.trim()} onClick={async () => {
      setBusy(true);
      try { await api.post(`/api/servers/${serverId}/categories`, { name }); closeModal(); } catch (e) { setErr(errMsg(e)); setBusy(false); }
    }}>Create category</Button></>}>
      <Field label="Category name" htmlFor="catn" error={err}><Input id="catn" value={name} onChange={(e: any) => setName(e.target.value)} maxLength={100} autoFocus /></Field>
    </Modal>
  );
}

/* ───────────── confirm ───────────── */
export function ConfirmModal({ title, body, confirmLabel, danger, onConfirm }: { title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} footer={<>
      <Button kind="ghost" onClick={closeModal}>Cancel</Button>
      <Button kind={danger ? 'danger' : 'primary'} loading={busy} onClick={async () => {
        setBusy(true);
        try { await onConfirm(); closeModal(); } catch (e) { toast(errMsg(e), 'error'); setBusy(false); }
      }}>{confirmLabel}</Button>
    </>}>
      <p className="text-fg/90 leading-relaxed">{body}</p>
    </Modal>
  );
}

/* ───────────── report ───────────── */
const REPORT_REASONS = ['Harassment or bullying', 'Spam or scam', 'Hate speech', 'Threats of violence', 'Sexual content', 'Self-harm concern', 'Something else'];
export function ReportModal({ messageId, userId, serverId }: { messageId?: string; userId?: string; serverId?: string | null }) {
  const [reason, setReason] = useState(REPORT_REASONS[0]);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/api/reports', { message_id: messageId, user_id: messageId ? undefined : userId, server_id: messageId ? undefined : serverId ?? undefined, reason: details ? `${reason}: ${details}` : reason });
      setDone(true);
    } catch (e) { toast(errMsg(e), 'error'); }
    setBusy(false);
  };
  return (
    <Modal title={done ? 'Report sent' : messageId ? 'Report message' : 'Report user'}
      subtitle={done ? undefined : serverId || messageId ? "Reports go to this server's moderators. In direct messages they go to the Parley staff for this instance." : undefined}
      footer={done ? <Button onClick={closeModal}>Done</Button> : <><Button kind="ghost" onClick={closeModal}>Cancel</Button><Button kind="danger" loading={busy} onClick={submit}>Send report</Button></>}>
      {done ? <p>Thanks. The people who look after this space can now review it. You can also block this person from their profile.</p> : (
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-1">
            <legend className="text-[0.8rem] font-semibold text-muted mb-1">What's wrong?</legend>
            {REPORT_REASONS.map((r) => (
              <label key={r} className="flex items-center gap-2.5 py-1.5 cursor-pointer"><input type="radio" name="reason" checked={reason === r} onChange={() => setReason(r)} className="accent-[var(--c-accent)]" />{r}</label>
            ))}
          </fieldset>
          <Field label="Details (optional)"><TextArea value={details} onChange={(e: any) => setDetails(e.target.value)} maxLength={800} /></Field>
        </div>
      )}
    </Modal>
  );
}

/* ───────────── moderation actions ───────────── */
const TIMEOUTS = [[60, '60 seconds'], [300, '5 minutes'], [600, '10 minutes'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week']] as const;
export function ModerateModal({ action, serverId, user }: { action: 'kick' | 'ban' | 'timeout'; serverId: string; user: User }) {
  const [reason, setReason] = useState('');
  const [secs, setSecs] = useState('600');
  const [purge, setPurge] = useState('0');
  const [busy, setBusy] = useState(false);
  const name = displayName(user, serverId);
  const label = action === 'kick' ? 'Kick' : action === 'ban' ? 'Ban' : 'Time out';
  const go = async () => {
    setBusy(true);
    try {
      if (action === 'kick') await api.post(`/api/servers/${serverId}/members/${user.id}/kick`, { reason: reason || undefined });
      if (action === 'ban') await api.put(`/api/servers/${serverId}/bans/${user.id}`, { reason: reason || undefined, delete_message_seconds: Number(purge) });
      if (action === 'timeout') await api.put(`/api/servers/${serverId}/members/${user.id}/timeout`, { duration_seconds: Number(secs), reason: reason || undefined });
      toast(action === 'kick' ? `${name} was kicked.` : action === 'ban' ? `${name} was banned.` : `${name} is timed out for ${duration(Number(secs))}.`, 'ok');
      closeModal();
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false); }
  };
  return (
    <Modal title={`${label} ${name}?`}
      subtitle={action === 'kick' ? 'They can rejoin with a new invite.' : action === 'ban' ? "They'll be removed and can't rejoin until unbanned." : "They can still read, but can't send messages, react or speak until the timeout ends."}
      footer={<><Button kind="ghost" onClick={closeModal}>Cancel</Button><Button kind="danger" loading={busy} onClick={go}>{label}</Button></>}>
      <div className="flex flex-col gap-4">
        {action === 'timeout' && <Field label="Duration"><Select value={secs} onChange={setSecs} options={TIMEOUTS.map(([v, l]) => ({ value: String(v), label: l }))} /></Field>}
        {action === 'ban' && <Field label="Delete their recent messages"><Select value={purge} onChange={setPurge} options={[
          { value: '0', label: "Don't delete any" }, { value: '3600', label: 'Previous hour' }, { value: '86400', label: 'Previous 24 hours' }, { value: '604800', label: 'Previous 7 days' },
        ]} /></Field>}
        <Field label="Reason" hint="Recorded in the audit log."><Input value={reason} onChange={(e: any) => setReason(e.target.value)} maxLength={512} /></Field>
      </div>
    </Modal>
  );
}

/* ───────────── image viewer ───────────── */
export function ImageModal({ url, name }: { url: string; name: string }) {
  return (
    <Modal bare width="max-w-[min(92vw,1200px)] bg-transparent shadow-none" title={name}>
      <div className="flex flex-col items-center gap-2">
        <img src={url} alt={name} className="max-h-[80vh] max-w-full object-contain rounded-lg" />
        <div className="flex gap-4 text-sm">
          <a href={url} target="_blank" rel="noreferrer" className="text-white/80 hover:text-white flex items-center gap-1"><LuExternalLink /> Open original</a>
          <a href={url} download={name} className="text-white/80 hover:text-white flex items-center gap-1"><LuDownload /> Download</a>
          <button className="text-white/80 hover:text-white flex items-center gap-1" onClick={closeModal}><LuX /> Close</button>
        </div>
      </div>
    </Modal>
  );
}

/* ───────────── new DM / group DM ───────────── */
export function NewDmModal() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<(User & { presence?: any })[]>([]);
  const [picked, setPicked] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const known = useStore((s) => s.users);
  const meId = useStore((s) => s.me?.id);
  useEffect(() => {
    if (!q.trim()) {
      // Suggest people you share servers or conversations with.
      setResults(Object.values(known).filter((u) => u.id !== meId).sort((a, b) => (presenceOf(b.id).status !== 'offline' ? 1 : 0) - (presenceOf(a.id).status !== 'offline' ? 1 : 0)).slice(0, 12));
      return;
    }
    setSearching(true);
    const t = setTimeout(() => api.get<User[]>(`/api/users/search?q=${encodeURIComponent(q.trim())}`).then(setResults).catch(() => setResults([])).finally(() => setSearching(false)), 200);
    return () => clearTimeout(t);
  }, [q]);
  const toggle = (u: User) => setPicked(picked.some((p) => p.id === u.id) ? picked.filter((p) => p.id !== u.id) : [...picked, u].slice(0, 9));
  const go = async () => {
    if (!picked.length) return;
    setBusy(true);
    if (picked.length === 1) { await openDm(picked[0].id); closeModal(); return; }
    try {
      const dm = await api.post<DmChannel>('/api/dms/group', { user_ids: picked.map((p) => p.id) });
      setState((s) => ({ dms: { ...s.dms, [dm.id]: dm } }));
      closeModal(); navigate(`/channels/@me/${dm.id}`);
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false); }
  };
  return (
    <Modal title="New message" subtitle="Pick one person for a direct message, or up to nine for a group."
      footer={<><Button kind="ghost" onClick={closeModal}>Cancel</Button><Button disabled={!picked.length} loading={busy} onClick={go}>{picked.length > 1 ? 'Create group' : 'Open conversation'}</Button></>}>
      <div className="flex flex-col gap-3">
        <div className={cx(inputCls, 'h-auto min-h-10 flex flex-wrap gap-1 items-center py-1.5')}>
          {picked.map((p) => <span key={p.id} className="h-6 px-2 rounded bg-active text-sm flex items-center gap-1">{p.display_name || p.username}<button aria-label={`Remove ${p.username}`} onClick={() => toggle(p)}><LuX size={12} /></button></span>)}
          <input autoFocus value={q} onChange={(e: any) => setQ(e.target.value)} placeholder={picked.length ? '' : 'Type a username'} className="flex-1 min-w-24 bg-transparent focus:outline-none" aria-label="Search people" />
        </div>
        <div className="flex flex-col max-h-72 scroll -mx-1">
          {searching && <Spinner className="m-3" />}
          {!searching && results.map((u) => {
            const on = picked.some((p) => p.id === u.id);
            return (
              <button key={u.id} onClick={() => toggle(u)} className={cx('flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-hover text-left mx-1', on && 'bg-active')} aria-pressed={on}>
                <Avatar user={u} size={32} status={presenceOf(u.id).status} ring="var(--c-raised)" />
                <span className="flex-1 min-w-0"><span className="block truncate">{u.display_name || u.username}</span><span className="block text-xs text-muted truncate">{u.username}</span></span>
                <span className={cx('size-5 rounded border grid place-items-center', on ? 'bg-accent border-accent text-accent-ink' : 'border-line')}>{on && <LuCheck size={13} />}</span>
              </button>
            );
          })}
          {!searching && q && !results.length && <p className="text-sm text-muted p-3">No one found with that username.</p>}
        </div>
      </div>
    </Modal>
  );
}

export function EditGroupModal({ channelId }: { channelId: string }) {
  const dm = useStore((s) => s.dms[channelId]);
  const meId = useStore((s) => s.me?.id);
  const [name, setName] = useState(dm?.name ?? '');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<User[]>([]);
  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(() => api.get<User[]>(`/api/users/search?q=${encodeURIComponent(q.trim())}`).then(setResults).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [q]);
  if (!dm) return null;
  return (
    <Modal title="Group settings" footer={<Button onClick={closeModal}>Done</Button>}>
      <div className="flex flex-col gap-4">
        <Field label="Group name"><div className="flex gap-2"><Input value={name} onChange={(e: any) => setName(e.target.value)} placeholder={dmTitle(dm, meId)} maxLength={100} />
          <Button kind="secondary" onClick={() => void run(() => api.patch(`/api/channels/${channelId}`, { name }), 'Group renamed.')}>Save</Button></div></Field>
        <div>
          <p className="text-[0.8rem] font-semibold text-muted mb-1.5">Members, {dm.recipients.length}</p>
          {dm.recipients.map((u) => (
            <div key={u.id} className="flex items-center gap-3 py-1.5">
              <Avatar user={u} size={28} /><span className="flex-1">{u.display_name || u.username}{dm.owner_id === u.id && <span className="text-xs text-muted"> (owner)</span>}</span>
              {dm.owner_id === meId && u.id !== meId && <Button size="sm" kind="ghost" onClick={() => void run(() => api.del(`/api/dms/${channelId}/recipients/${u.id}`))}>Remove</Button>}
            </div>
          ))}
        </div>
        <Field label="Add people"><Input value={q} onChange={(e: any) => setQ(e.target.value)} placeholder="Search by username" /></Field>
        {results.filter((u) => !dm.recipients.some((r) => r.id === u.id)).map((u) => (
          <button key={u.id} className="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-hover text-left" onClick={() => { void run(() => api.put(`/api/dms/${channelId}/recipients/${u.id}`), 'Added.'); setQ(''); }}>
            <Avatar user={u} size={28} /><span>{u.display_name || u.username} <span className="text-muted text-sm">{u.username}</span></span>
          </button>
        ))}
        <Button kind="danger" onClick={() => { void api.del(`/api/dms/${channelId}`); closeModal(); navigate('/channels/@me'); }}>Leave group</Button>
      </div>
    </Modal>
  );
}

/* ───────────── quick switcher ───────────── */
export function QuickSwitcher() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const channels = useStore((s) => s.channels);
  const servers = useStore((s) => s.servers);
  const dms = useStore((s) => s.dms);
  const meId = useStore((s) => s.me?.id);
  const items = useMemo(() => {
    const ql = q.toLowerCase().replace(/^[#@*]/, '');
    const mode = q[0];
    const out: { key: string; label: string; detail: string; icon: any; go: () => void }[] = [];
    if (mode !== '@' && mode !== '*') for (const c of Object.values(channels)) {
      if (c.type === 'thread' || !c.name?.toLowerCase().includes(ql)) continue;
      out.push({ key: c.id, label: c.name, detail: servers[c.server_id!]?.name ?? '', icon: c.type === 'voice' ? <LuVolume2 /> : <LuHash />, go: () => navigate(`/channels/${c.server_id}/${c.id}`) });
    }
    if (mode !== '#' && mode !== '*') for (const d of Object.values(dms)) {
      const t = dmTitle(d, meId);
      if (t.toLowerCase().includes(ql)) out.push({ key: d.id, label: t, detail: 'Direct message', icon: d.type === 'dm' ? <Avatar user={d.recipients.find((r) => r.id !== meId) ?? null} size={18} /> : <LuUsers />, go: () => navigate(`/channels/@me/${d.id}`) });
    }
    if (mode !== '#' && mode !== '@') for (const s of Object.values(servers)) {
      if (s.name.toLowerCase().includes(ql)) out.push({ key: 's' + s.id, label: s.name, detail: 'Server', icon: <ServerIcon server={s} size={18} className="rounded" />, go: () => navigate(`/channels/${s.id}`) });
    }
    const rank = (x: { label: string }) => (x.label.toLowerCase().startsWith(ql) ? 0 : 1);
    const unreadFirst = (a: any, b: any) => rank(a) - rank(b) || cmpId(channels[b.key]?.last_message_id ?? '0', channels[a.key]?.last_message_id ?? '0');
    return out.sort(unreadFirst).slice(0, 12);
  }, [q, channels, servers, dms, meId]);
  useEffect(() => setSel(0), [q]);
  const pick = (i: number) => { const it = items[i]; if (it) { closeModal(); it.go(); } };
  return (
    <Modal width="max-w-lg" title="Jump to" subtitle={<>Type to find channels, conversations or servers. Start with <Kbd>#</Kbd> <Kbd>@</Kbd> or <Kbd>*</Kbd> to narrow it down.</>}>
      <div className="flex flex-col gap-2" onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSel((sel + 1) % Math.max(1, items.length)); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSel((sel - 1 + items.length) % Math.max(1, items.length)); }
        if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
      }}>
        <div className="relative"><LuSearch className="absolute left-3 top-3 text-muted" /><input autoFocus className={cx(inputCls, 'pl-9 h-11')} value={q} onChange={(e: any) => setQ(e.target.value)} aria-label="Where would you like to go?" placeholder="Where would you like to go?" /></div>
        <div className="flex flex-col" role="listbox">
          {items.map((it, i) => (
            <button key={it.key} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => pick(i)}
              className={cx('flex items-center gap-3 h-10 px-3 rounded-md text-left', i === sel ? 'bg-active' : '')}>
              <span className="text-muted w-5 grid place-items-center">{it.icon}</span><span className="truncate">{it.label}</span><span className="ml-auto text-xs text-muted truncate">{it.detail}</span>
            </button>
          ))}
          {!items.length && <p className="text-sm text-muted p-3">Nothing matches.</p>}
        </div>
      </div>
    </Modal>
  );
}

export function ShortcutsModal() {
  const b = bindings();
  const rows: [string, string][] = [
    ...Object.entries(KEYBIND_LABELS).map(([k, label]) => [label, b[k as keyof typeof b]] as [string, string]),
    ['Send message', 'Enter'], ['New line', 'Shift+Enter'], ['Edit your last message', 'ArrowUp'], ['Cancel reply or edit', 'Escape'], ['Show shortcuts', 'Ctrl+/'],
  ];
  return (
    <Modal title="Keyboard shortcuts" subtitle="Change these in Settings → Keybinds.">
      <dl className="flex flex-col">
        {rows.map(([label, key]) => (
          <div key={label} className="flex items-center justify-between py-2 border-t border-line first:border-0"><dt>{label}</dt><dd className="flex gap-1">{key.split('+').map((k) => <Kbd key={k}>{k}</Kbd>)}</dd></div>
        ))}
      </dl>
    </Modal>
  );
}

export function ServerInfoModal({ serverId }: { serverId: string }) {
  const server = useStore((s) => s.servers[serverId]);
  if (!server) return null;
  return (
    <Modal title={server.name} subtitle={`${server.member_count} ${server.member_count === 1 ? 'member' : 'members'}, created ${new Date(server.created_at).toLocaleDateString([], { dateStyle: 'medium' })}`}>
      <div className="flex flex-col gap-4">
        <ServerIcon server={server} size={72} className="rounded-[16px_16px_16px_5px]" />
        {server.description && <p className="leading-relaxed">{server.description}</p>}
        <section>
          <h3 className="text-[0.8rem] font-semibold text-muted mb-1.5">Rules</h3>
          {server.rules ? <div className="rounded-lg bg-field p-3"><Markdown content={server.rules} serverId={serverId} /></div> : <p className="text-sm text-muted">This server hasn't written any rules yet.</p>}
        </section>
      </div>
    </Modal>
  );
}

export function ThreadRedirect({ channelId }: { channelId: string }) {
  useEffect(() => { setUi({ threadId: channelId }); closeModal(); }, []);
  return null;
}

export { LuLock, relative, getState };
