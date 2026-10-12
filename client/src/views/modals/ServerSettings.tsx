import { useEffect, useMemo, useState } from 'react';
import { LuChevronUp, LuChevronDown, LuPlus, LuTrash2, LuShieldCheck, LuSearch, LuBot, LuFlag } from 'react-icons/lu';
import { useStore, closeModal, confirmDialog, toast, displayName, openModal, presenceOf } from '../../lib/store.ts';
import { api, errMsg, upload } from '../../lib/api.ts';
import { run, loadMembers } from '../../lib/actions.ts';
import { navigate } from '../../lib/router.ts';
import { relative, duration } from '../../lib/format.ts';
import type { Role, Invite, User, Member } from '../../lib/types.ts';
import { Button, Field, Input, TextArea, Select, Switch, Avatar, Spinner, ServerIcon, EmptyState, cx, inputCls, Popover, Menu, useMenu } from '../../components/ui.tsx';
import { SettingsShell, SaveBar, SectionTitle, type Section } from './SettingsShell.tsx';
import { memberMenuItems } from '../MemberList.tsx';
import { Markdown } from '../../lib/markdown.tsx';
import { P, has, PERMISSION_INFO, highestPosition, isTimedOut } from '../../../../shared/permissions.ts';

export function ServerSettings({ serverId, initialTab }: { serverId: string; initialTab?: string }) {
  const server = useStore((s) => s.servers[serverId]);
  const meId = useStore((s) => s.me?.id);
  const perms = server?.my_permissions ?? 0;
  const owner = server?.owner_id === meId;
  const first = has(perms, P.MANAGE_SERVER) ? 'overview' : has(perms, P.MANAGE_ROLES) ? 'roles' : 'notifications';
  const [tab, setTab] = useState(initialTab ?? first);
  useEffect(() => { if (!server) closeModal(); }, [server]);
  if (!server) return null;
  const sections: Section[] = [
    { title: server.name, items: [
      { id: 'overview', label: 'Overview', hidden: !has(perms, P.MANAGE_SERVER) },
      { id: 'roles', label: 'Roles', hidden: !has(perms, P.MANAGE_ROLES) },
      { id: 'notifications', label: 'Notifications' },
      { id: 'profile', label: 'Your server profile' },
    ] },
    { title: 'People', items: [
      { id: 'members', label: 'Members' },
      { id: 'invites', label: 'Invites' },
      { id: 'bans', label: 'Bans', hidden: !has(perms, P.BAN_MEMBERS) },
    ] },
    { title: 'Moderation', items: [
      { id: 'automod', label: 'AutoMod', hidden: !has(perms, P.MANAGE_SERVER) },
      { id: 'reports', label: 'Reports', hidden: !has(perms, P.KICK_MEMBERS) },
      { id: 'audit', label: 'Audit log', hidden: !has(perms, P.VIEW_AUDIT_LOG) },
    ] },
    { items: [
      { id: 'ownership', label: 'Transfer ownership', hidden: !owner },
      { id: 'delete', label: 'Delete server', danger: true, hidden: !owner },
    ] },
  ];
  return (
    <SettingsShell sections={sections} tab={tab} setTab={setTab}>
      {tab === 'overview' && <Overview serverId={serverId} />}
      {tab === 'roles' && <Roles serverId={serverId} />}
      {tab === 'notifications' && <ServerNotifications serverId={serverId} />}
      {tab === 'profile' && <ServerProfile serverId={serverId} />}
      {tab === 'members' && <Members serverId={serverId} />}
      {tab === 'invites' && <Invites serverId={serverId} />}
      {tab === 'bans' && <Bans serverId={serverId} />}
      {tab === 'automod' && <AutoMod serverId={serverId} />}
      {tab === 'reports' && <Reports serverId={serverId} />}
      {tab === 'audit' && <AuditLog serverId={serverId} />}
      {tab === 'ownership' && <Transfer serverId={serverId} />}
      {tab === 'delete' && <DeleteServer serverId={serverId} />}
    </SettingsShell>
  );
}

/* ───────────── overview ───────────── */
function Overview({ serverId }: { serverId: string }) {
  const server = useStore((s) => s.servers[serverId])!;
  const channels = useStore((s) => s.channels);
  const initial = { name: server.name, description: server.description, rules: server.rules, is_public: server.is_public, system_channel_id: server.system_channel_id ?? '' };
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const textChannels = Object.values(channels).filter((c) => c.server_id === serverId && c.type === 'text');
  const save = async () => {
    setBusy(true);
    try { await api.patch(`/api/servers/${serverId}`, { ...f, system_channel_id: f.system_channel_id || null }); toast('Server updated.', 'ok'); }
    catch (e) { toast(errMsg(e), 'error'); }
    setBusy(false);
  };
  return (
    <>
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-5">
          <ServerIcon server={server} size={96} className="rounded-[20px_20px_20px_6px] shrink-0" />
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted">Square images look best, at least 256×256. PNG, JPEG, GIF or WebP up to 8 MB.</p>
            <div className="flex gap-2">
              <label className="inline-flex"><span className="sr-only">Upload icon</span>
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e: any) => {
                  const file = e.target.files?.[0]; e.target.value = '';
                  if (file) void run(() => upload('PUT', `/api/servers/${serverId}/icon`, file), 'Icon updated.');
                }} />
                <span role="button" tabIndex={0} className="h-8 px-3 rounded-lg bg-accent text-accent-ink text-sm font-medium grid place-items-center cursor-pointer">Upload icon</span>
              </label>
              {server.icon_url && <Button size="sm" kind="ghost" onClick={() => void run(() => api.del(`/api/servers/${serverId}/icon`), 'Icon removed.')}>Remove</Button>}
            </div>
          </div>
        </div>
        <Field label="Server name"><Input value={f.name} onChange={(e: any) => setF({ ...f, name: e.target.value })} maxLength={100} /></Field>
        <Field label="Description" hint="Shown on invites and in Discover."><TextArea value={f.description} onChange={(e: any) => setF({ ...f, description: e.target.value })} maxLength={500} /></Field>
        <Field label="Rules" hint={<>Markdown works here. <button className="text-link" onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button></>}>
          {preview ? <div className="rounded-lg bg-field p-3 min-h-28"><Markdown content={f.rules || '*No rules yet.*'} serverId={serverId} /></div>
            : <TextArea value={f.rules} onChange={(e: any) => setF({ ...f, rules: e.target.value })} maxLength={4000} rows={6} placeholder={'1. Be kind.\n2. No spam.'} />}
        </Field>
        <Field label="System messages channel" hint="Where we post when someone joins.">
          <Select value={f.system_channel_id} onChange={(v) => setF({ ...f, system_channel_id: v })} options={[{ value: '', label: 'No system messages' }, ...textChannels.map((c) => ({ value: c.id, label: `#${c.name}` }))]} />
        </Field>
        <Switch checked={f.is_public} onChange={(v) => setF({ ...f, is_public: v })} label="Public server" description="List this server in Discover so anyone can join without an invite. Private channels stay private." />
      </div>
      <div className="h-20" />
      <div className="fixed bottom-0 left-0 right-0 md:left-[min(40%,20rem)]"><SaveBar dirty={dirty} busy={busy} onSave={save} onReset={() => setF(initial)} /></div>
    </>
  );
}

/* ───────────── roles ───────────── */
function Roles({ serverId }: { serverId: string }) {
  const server = useStore((s) => s.servers[serverId])!;
  const members = useStore((s) => s.members[serverId]);
  const meId = useStore((s) => s.me?.id)!;
  const roles = useMemo(() => [...server.roles].sort((a, b) => b.position - a.position), [server.roles]);
  const [selected, setSelected] = useState<string>(roles.find((r) => !r.is_default)?.id ?? roles[0].id);
  useEffect(() => { void loadMembers(serverId); }, [serverId]);
  const myTop = highestPosition({ ownerId: server.owner_id, userId: meId, roles: server.roles, memberRoleIds: server.member.role_ids });
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of Object.values(members ?? {})) for (const r of m.role_ids) c[r] = (c[r] ?? 0) + 1;
    return c;
  }, [members]);
  const nonDefault = roles.filter((r) => !r.is_default);
  const move = (id: string, dir: -1 | 1) => {
    const ids = nonDefault.map((r) => r.id);
    const i = ids.indexOf(id), j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void run(() => api.put(`/api/servers/${serverId}/roles-order`, { role_ids: ids }));
  };
  const create = async () => {
    const r = await run(() => api.post<Role>(`/api/servers/${serverId}/roles`, { name: 'new role', color: '#93A0B4' }));
    if (r) setSelected(r.id);
  };
  const role = roles.find((r) => r.id === selected) ?? roles[0];
  return (
    <div className="flex flex-col lg:flex-row gap-6">
      <div className="lg:w-56 shrink-0 flex flex-col gap-1">
        <Button size="sm" onClick={create} className="mb-2"><LuPlus /> Create role</Button>
        <p className="text-xs text-muted mb-1">Higher roles outrank lower ones. Members get the combined permissions of all their roles.</p>
        {roles.map((r) => (
          <div key={r.id} className={cx('group flex items-center gap-2 h-9 px-2 rounded-md cursor-pointer', selected === r.id ? 'bg-active' : 'hover:bg-hover')} onClick={() => setSelected(r.id)}>
            <span className="size-3 rounded-full shrink-0" style={{ background: r.color ?? 'var(--c-faint)' }} />
            <span className="flex-1 truncate text-sm">{r.name}</span>
            {!r.is_default && <span className="text-xs text-muted tabular-nums">{counts[r.id] ?? 0}</span>}
            {!r.is_default && r.position < myTop && (
              <span className="flex opacity-0 group-hover:opacity-100">
                <button aria-label={`Move ${r.name} up`} onClick={(e: MouseEvent) => { e.stopPropagation(); move(r.id, -1); }} className="text-muted hover:text-fg"><LuChevronUp size={15} /></button>
                <button aria-label={`Move ${r.name} down`} onClick={(e: MouseEvent) => { e.stopPropagation(); move(r.id, 1); }} className="text-muted hover:text-fg"><LuChevronDown size={15} /></button>
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="flex-1 min-w-0">{role && <RoleEditor key={role.id} serverId={serverId} role={role} editable={server.owner_id === meId || role.position < myTop} />}</div>
    </div>
  );
}

function RoleEditor({ serverId, role, editable }: { serverId: string; role: Role; editable: boolean }) {
  const server = useStore((s) => s.servers[serverId])!;
  const meId = useStore((s) => s.me?.id);
  const initial = { name: role.name, color: role.color ?? '#93A0B4', hoist: role.hoist, mentionable: role.mentionable, permissions: role.permissions };
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const iAmAdmin = server.owner_id === meId || has(server.my_permissions, P.ADMINISTRATOR);
  const save = async () => {
    setBusy(true);
    try { await api.patch(`/api/servers/${serverId}/roles/${role.id}`, role.is_default ? { permissions: f.permissions } : f); toast('Role saved.', 'ok'); }
    catch (e) { toast(errMsg(e), 'error'); }
    setBusy(false);
  };
  const groups = ['General', 'Membership', 'Text', 'Voice', 'Advanced'] as const;
  return (
    <div className="flex flex-col gap-4">
      {!editable && <p className="text-sm rounded-lg bg-warn/10 border border-warn/30 px-3 py-2">This role is at or above your highest role, so you can view it but not change it.</p>}
      {!role.is_default && (
        <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
          <Field label="Role name"><Input value={f.name} disabled={!editable} onChange={(e: any) => setF({ ...f, name: e.target.value })} maxLength={100} /></Field>
          <Field label="Colour"><input type="color" value={f.color} disabled={!editable} onChange={(e: any) => setF({ ...f, color: e.target.value })} className="h-10 w-16 rounded-lg bg-field cursor-pointer" aria-label="Role colour" /></Field>
        </div>
      )}
      {role.is_default && <p className="text-sm text-muted">Everyone in the server has these permissions. Other roles add to them.</p>}
      {!role.is_default && (
        <>
          <Switch checked={f.hoist} disabled={!editable} onChange={(v) => setF({ ...f, hoist: v })} label="Show separately in the member list" />
          <Switch checked={f.mentionable} disabled={!editable} onChange={(v) => setF({ ...f, mentionable: v })} label="Anyone can @mention this role" description="Members with “Mention @everyone” can always mention it." />
        </>
      )}
      {groups.map((g) => (
        <section key={g}>
          <SectionTitle>{g === 'Text' ? 'Text channels' : g === 'Voice' ? 'Voice channels' : g}</SectionTitle>
          <div className="flex flex-col divide-y divide-line">
            {PERMISSION_INFO.filter((p) => p.group === g).map((p) => {
              const flag = P[p.key];
              const lacks = !iAmAdmin && !has(server.my_permissions, flag);
              return (
                <Switch key={p.key} label={p.label} description={lacks ? `${p.description} (You don't have this permission, so you can't change it.)` : p.description}
                  checked={has(f.permissions, flag)} disabled={!editable || lacks}
                  onChange={(v) => setF({ ...f, permissions: v ? f.permissions | flag : f.permissions & ~flag })} />
              );
            })}
          </div>
        </section>
      ))}
      {!role.is_default && editable && (
        <Button kind="danger" className="self-start mt-4" onClick={() => confirmDialog({
          title: `Delete the ${role.name} role?`, body: 'Members lose this role and its permissions. This can’t be undone.', confirmLabel: 'Delete role', danger: true,
          onConfirm: async () => { await api.del(`/api/servers/${serverId}/roles/${role.id}`); },
        })}><LuTrash2 /> Delete role</Button>
      )}
      <div className="h-16" />
      <div className="fixed bottom-0 left-0 right-0 md:left-[min(40%,20rem)]"><SaveBar dirty={dirty} busy={busy} onSave={save} onReset={() => setF(initial)} /></div>
    </div>
  );
}

/* ───────────── notifications & profile ───────────── */
function ServerNotifications({ serverId }: { serverId: string }) {
  const n = useStore((s) => s.notif[`server:${serverId}`]);
  const set = (patch: any) => void run(() => api.put('/api/notification-settings', { scope_type: 'server', scope_id: serverId, ...patch }));
  const muted = !!n?.muted && (!n.muted_until || new Date(n.muted_until) > new Date());
  return (
    <div className="flex flex-col gap-4">
      <Field label="Notify me about">
        <div className="flex flex-col gap-1">
          {([['all', 'All messages'], ['mentions', 'Only @mentions (default)'], ['none', 'Nothing']] as const).map(([v, l]) => (
            <label key={v} className="flex items-center gap-2.5 py-1.5 cursor-pointer"><input type="radio" name="lvl" checked={(n?.level ?? 'mentions') === v} onChange={() => set({ level: v })} className="accent-[var(--c-accent)]" />{l}</label>
          ))}
        </div>
      </Field>
      <Switch checked={muted} onChange={(v) => set({ muted: v, muted_until: null })} label="Mute this server" description="Hides unread dots and silences notifications. You'll still see mention badges." />
      {!muted && (
        <div className="flex flex-wrap gap-2">
          {[[1, '1 hour'], [8, '8 hours'], [24, '24 hours']].map(([h, l]) => (
            <Button key={String(h)} size="sm" kind="secondary" onClick={() => set({ muted: true, muted_until: new Date(Date.now() + Number(h) * 3600_000).toISOString() })}>Mute for {l}</Button>
          ))}
        </div>
      )}
      {muted && n?.muted_until && <p className="text-sm text-muted">Muted until {new Date(n.muted_until).toLocaleString()}.</p>}
      <Switch checked={!!n?.suppress_everyone} onChange={(v) => set({ suppress_everyone: v })} label="Ignore @everyone and @here" />
      <p className="text-sm text-muted">Individual channels can override this from their right-click menu.</p>
    </div>
  );
}

function ServerProfile({ serverId }: { serverId: string }) {
  const server = useStore((s) => s.servers[serverId])!;
  const [nick, setNick] = useState(server.member.nickname ?? '');
  const can = has(server.my_permissions, P.CHANGE_NICKNAME);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">Your nickname only shows in {server.name}.</p>
      <Field label="Nickname" hint={can ? undefined : "You don't have permission to change your nickname here."}>
        <div className="flex gap-2"><Input value={nick} disabled={!can} onChange={(e: any) => setNick(e.target.value)} maxLength={32} placeholder="Use my display name" />
          <Button disabled={!can} onClick={() => void run(() => api.patch(`/api/servers/${serverId}/members/@me`, { nickname: nick || null }), 'Nickname saved.')}>Save</Button></div>
      </Field>
    </div>
  );
}

/* ───────────── members ───────────── */
function Members({ serverId }: { serverId: string }) {
  const members = useStore((s) => s.members[serverId]);
  const server = useStore((s) => s.servers[serverId])!;
  const [q, setQ] = useState('');
  useEffect(() => { void loadMembers(serverId, true); }, [serverId]);
  const list = useMemo(() => Object.values(members ?? {}).filter((m) => {
    const ql = q.toLowerCase();
    return !ql || m.user.username.includes(ql) || (m.user.display_name ?? '').toLowerCase().includes(ql) || (m.nickname ?? '').toLowerCase().includes(ql);
  }).sort((a, b) => a.joined_at.localeCompare(b.joined_at)), [members, q]);
  if (!members) return <Spinner />;
  return (
    <div className="flex flex-col gap-3">
      <div className="relative"><LuSearch className="absolute left-3 top-3 text-muted" /><input className={cx(inputCls, 'pl-9')} placeholder="Search members" value={q} onChange={(e: any) => setQ(e.target.value)} aria-label="Search members" /></div>
      <p className="text-sm text-muted">{list.length} of {Object.keys(members).length} members</p>
      <div className="flex flex-col divide-y divide-line">
        {list.map((m) => <MemberRowAdmin key={m.user.id} m={m} serverId={serverId} roles={server.roles} />)}
      </div>
    </div>
  );
}
function MemberRowAdmin({ m, serverId, roles }: { m: Member; serverId: string; roles: Role[] }) {
  const menu = useMenu();
  const user = useStore((s) => s.users[m.user.id] ?? m.user);
  return (
    <div className="flex items-center gap-3 py-2.5">
      <Avatar user={user} size={36} status={presenceOf(user.id).status} ring="var(--c-deck)" />
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{displayName(user, serverId)} <span className="text-muted text-sm font-normal">{user.username}</span></p>
        <p className="text-xs text-muted truncate">Joined {relative(m.joined_at)}{isTimedOut(m.timeout_until) ? `, timed out until ${new Date(m.timeout_until!).toLocaleString()}` : ''}
          {m.role_ids.length ? `, ${roles.filter((r) => m.role_ids.includes(r.id)).map((r) => r.name).join(', ')}` : ''}</p>
      </div>
      <Button size="sm" kind="ghost" onClick={(e: MouseEvent) => menu.openAt(e.currentTarget as HTMLElement)}>Manage</Button>
      {menu.at && <Popover anchor={menu.at} onClose={menu.close}><Menu items={memberMenuItems(user, serverId)} onClose={menu.close} /></Popover>}
    </div>
  );
}

/* ───────────── invites ───────────── */
function Invites({ serverId }: { serverId: string }) {
  const [list, setList] = useState<Invite[] | null>(null);
  const load = () => api.get<Invite[]>(`/api/servers/${serverId}/invites`).then(setList).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { void load(); }, [serverId]);
  if (!list) return <Spinner />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center"><p className="text-sm text-muted">Active invite links. You see everyone's if you can manage invites, otherwise only your own.</p>
        <Button size="sm" onClick={() => openModal({ kind: 'invite', serverId })}>Create invite</Button></div>
      {!list.length && <EmptyState title="No active invites" body="Create one to bring people in." />}
      <div className="flex flex-col divide-y divide-line">
        {list.map((i) => (
          <div key={i.code} className="flex items-center gap-3 py-2.5">
            <Avatar user={i.inviter} size={28} />
            <div className="flex-1 min-w-0">
              <p className="font-mono text-sm">{i.code}</p>
              <p className="text-xs text-muted">{i.inviter?.username ?? 'unknown'}, {i.uses}{i.max_uses ? `/${i.max_uses}` : ''} uses, {i.expires_at ? `expires ${new Date(i.expires_at).toLocaleString()}` : 'never expires'}</p>
            </div>
            <Button size="sm" kind="ghost" onClick={() => { void navigator.clipboard?.writeText(`${location.origin}/invite/${i.code}`); toast('Link copied.', 'ok'); }}>Copy</Button>
            <Button size="sm" kind="danger" onClick={() => void run(async () => { await api.del(`/api/invites/${i.code}`); await load(); }, 'Invite revoked.')}>Revoke</Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────── bans ───────────── */
function Bans({ serverId }: { serverId: string }) {
  const [list, setList] = useState<{ user: User; reason: string | null; banned_at: string }[] | null>(null);
  const load = () => api.get(`/api/servers/${serverId}/bans`).then(setList).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { void load(); }, [serverId]);
  if (!list) return <Spinner />;
  if (!list.length) return <EmptyState icon={<LuShieldCheck size={36} />} title="No bans" body="Banned people show up here. You can ban someone from their profile or the member list." />;
  return (
    <div className="flex flex-col divide-y divide-line">
      {list.map((b) => (
        <div key={b.user.id} className="flex items-center gap-3 py-2.5">
          <Avatar user={b.user} size={32} />
          <div className="flex-1 min-w-0"><p className="font-medium">{b.user.username}</p><p className="text-xs text-muted truncate">{b.reason || 'No reason given'}, {relative(b.banned_at)}</p></div>
          <Button size="sm" kind="secondary" onClick={() => void run(async () => { await api.del(`/api/servers/${serverId}/bans/${b.user.id}`); await load(); }, 'Unbanned.')}>Unban</Button>
        </div>
      ))}
    </div>
  );
}

/* ───────────── AutoMod ───────────── */
interface Rule { id: string; name: string; enabled: boolean; trigger_type: 'keyword' | 'mention_spam' | 'links' | 'invites'; config: any; action: 'block' | 'block_and_timeout'; timeout_seconds: number; exempt_role_ids: string[] }
const TRIGGERS = { keyword: 'Block words', mention_spam: 'Block mention spam', links: 'Block links', invites: 'Block invites to other servers' } as const;

function AutoMod({ serverId }: { serverId: string }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const load = () => api.get<Rule[]>(`/api/servers/${serverId}/automod-rules`).then(setRules).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { void load(); }, [serverId]);
  if (!rules) return <Spinner />;
  if (editing) return <RuleForm serverId={serverId} rule={editing} onDone={() => { setEditing(null); void load(); }} />;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">AutoMod checks messages before they're posted. Members with Manage Server are always exempt. Every block is written to the audit log.</p>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(TRIGGERS) as Rule['trigger_type'][]).map((t) => (
          <Button key={t} size="sm" kind="secondary" onClick={() => setEditing({ trigger_type: t, name: TRIGGERS[t], enabled: true, action: 'block', timeout_seconds: 60, config: t === 'mention_spam' ? { limit: 5 } : {}, exempt_role_ids: [] })}><LuPlus /> {TRIGGERS[t]}</Button>
        ))}
      </div>
      {!rules.length && <EmptyState icon={<LuBot size={36} />} title="No rules yet" body="Add a rule above to start filtering messages." />}
      {rules.map((r) => (
        <div key={r.id} className="rounded-lg border border-line bg-side p-4 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="font-semibold">{r.name}</p>
            <p className="text-sm text-muted">{TRIGGERS[r.trigger_type]}{r.trigger_type === 'keyword' ? `: ${(r.config.keywords ?? []).slice(0, 6).join(', ')}${(r.config.keywords ?? []).length > 6 ? '…' : ''}` : r.trigger_type === 'mention_spam' ? `: more than ${r.config.limit ?? 5} mentions` : ''}</p>
            <p className="text-xs text-muted mt-1">{r.action === 'block' ? 'Blocks the message' : `Blocks the message and times out for ${duration(r.timeout_seconds)}`}</p>
          </div>
          <Switch checked={r.enabled} label={r.enabled ? 'On' : 'Off'} onChange={(v) => void run(async () => { await api.patch(`/api/servers/${serverId}/automod-rules/${r.id}`, { enabled: v }); await load(); })} />
          <Button size="sm" kind="ghost" onClick={() => setEditing(r)}>Edit</Button>
        </div>
      ))}
    </div>
  );
}

function RuleForm({ serverId, rule, onDone }: { serverId: string; rule: Partial<Rule>; onDone: () => void }) {
  const server = useStore((s) => s.servers[serverId])!;
  const [f, setF] = useState<Partial<Rule>>(rule);
  const [words, setWords] = useState((rule.config?.keywords ?? []).join('\n'));
  const [domains, setDomains] = useState((rule.config?.allowed_domains ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const config = f.trigger_type === 'keyword' ? { keywords: words.split(/[\n,]/).map((w: string) => w.trim()).filter(Boolean) }
      : f.trigger_type === 'links' ? { allowed_domains: domains.split(/[\n,\s]/).map((w: string) => w.trim().toLowerCase()).filter(Boolean) }
      : f.trigger_type === 'mention_spam' ? { limit: Number(f.config?.limit ?? 5) } : {};
    const body = { name: f.name, enabled: f.enabled, trigger_type: f.trigger_type, config, action: f.action, timeout_seconds: f.timeout_seconds, exempt_role_ids: f.exempt_role_ids };
    try {
      if (f.id) await api.patch(`/api/servers/${serverId}/automod-rules/${f.id}`, body); else await api.post(`/api/servers/${serverId}/automod-rules`, body);
      toast('Rule saved.', 'ok'); onDone();
    } catch (e) { toast(errMsg(e), 'error'); setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-4">
      <Field label="Rule name"><Input value={f.name ?? ''} onChange={(e: any) => setF({ ...f, name: e.target.value })} maxLength={100} /></Field>
      {f.trigger_type === 'keyword' && <Field label="Blocked words" hint="One per line. Matches whole words, ignoring case. Use * for partial matches, like spoil*"><TextArea rows={6} value={words} onChange={(e: any) => setWords(e.target.value)} /></Field>}
      {f.trigger_type === 'mention_spam' && <Field label="Maximum mentions per message"><Input type="number" min={1} max={50} value={f.config?.limit ?? 5} onChange={(e: any) => setF({ ...f, config: { limit: Number(e.target.value) } })} /></Field>}
      {f.trigger_type === 'links' && <Field label="Allowed domains" hint="Links to these sites are fine; everything else is blocked. One per line."><TextArea rows={4} value={domains} onChange={(e: any) => setDomains(e.target.value)} placeholder={'youtube.com\ngithub.com'} /></Field>}
      <Field label="When it matches"><Select value={f.action ?? 'block'} onChange={(v) => setF({ ...f, action: v as any })} options={[{ value: 'block', label: 'Block the message' }, { value: 'block_and_timeout', label: 'Block the message and time out the sender' }]} /></Field>
      {f.action === 'block_and_timeout' && <Field label="Timeout length"><Select value={String(f.timeout_seconds ?? 60)} onChange={(v) => setF({ ...f, timeout_seconds: Number(v) })} options={[60, 300, 600, 3600, 86400].map((s) => ({ value: String(s), label: duration(s) }))} /></Field>}
      <Field label="Exempt roles">
        <div className="flex flex-wrap gap-2">
          {server.roles.filter((r) => !r.is_default).map((r) => {
            const on = f.exempt_role_ids?.includes(r.id);
            return <button key={r.id} aria-pressed={on} onClick={() => setF({ ...f, exempt_role_ids: on ? f.exempt_role_ids!.filter((x) => x !== r.id) : [...(f.exempt_role_ids ?? []), r.id] })}
              className={cx('h-7 px-2.5 rounded-md text-sm border', on ? 'border-accent bg-active' : 'border-line hover:bg-hover')}>{r.name}</button>;
          })}
        </div>
      </Field>
      <div className="flex gap-2 justify-between">
        {f.id ? <Button kind="danger" onClick={() => void run(async () => { await api.del(`/api/servers/${serverId}/automod-rules/${f.id}`); onDone(); }, 'Rule deleted.')}><LuTrash2 /> Delete rule</Button> : <span />}
        <div className="flex gap-2"><Button kind="ghost" onClick={onDone}>Cancel</Button><Button loading={busy} onClick={save}>Save rule</Button></div>
      </div>
    </div>
  );
}

/* ───────────── reports ───────────── */
function Reports({ serverId }: { serverId: string }) {
  const [list, setList] = useState<any[] | null>(null);
  const load = () => api.get(`/api/servers/${serverId}/reports`).then(setList).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { void load(); }, [serverId]);
  if (!list) return <Spinner />;
  if (!list.length) return <EmptyState icon={<LuFlag size={34} />} title="No reports" body="When members report messages or people in this server, they'll appear here for moderators." />;
  return (
    <div className="flex flex-col gap-3">
      {list.map((r) => (
        <div key={r.id} className={cx('rounded-lg border border-line p-4 flex flex-col gap-2', r.status !== 'open' && 'opacity-60')}>
          <div className="flex items-center gap-2 text-sm">
            <span className={cx('px-1.5 rounded text-xs font-semibold', r.status === 'open' ? 'bg-danger/20 text-danger' : 'bg-ok/20 text-ok')}>{r.status === 'open' ? 'Open' : r.status === 'resolved' ? 'Resolved' : 'Dismissed'}</span>
            <span className="text-muted">Reported by {r.reporter?.username ?? 'unknown'}, {relative(r.created_at)}</span>
          </div>
          <p><strong>{r.target?.username ?? 'Unknown user'}</strong>: {r.reason}</p>
          {r.message_snapshot && <blockquote className="border-l-2 border-faint pl-3 text-sm text-muted whitespace-pre-wrap">{r.message_snapshot}</blockquote>}
          <div className="flex flex-wrap gap-2">
            {r.status === 'open' ? (
              <>
                <Button size="sm" onClick={() => void run(async () => { await api.patch(`/api/reports/${r.id}`, { status: 'resolved' }); await load(); })}>Mark resolved</Button>
                <Button size="sm" kind="ghost" onClick={() => void run(async () => { await api.patch(`/api/reports/${r.id}`, { status: 'dismissed' }); await load(); })}>Dismiss</Button>
              </>
            ) : <Button size="sm" kind="ghost" onClick={() => void run(async () => { await api.patch(`/api/reports/${r.id}`, { status: 'open' }); await load(); })}>Reopen</Button>}
            {r.message_id && r.channel_id && <Button size="sm" kind="ghost" onClick={() => { closeModal(); navigate(`/channels/${serverId}/${r.channel_id}`); }}>Go to channel</Button>}
            {r.message_id && <Button size="sm" kind="danger" onClick={() => void run(() => api.del(`/api/messages/${r.message_id}`), 'Message deleted.')}>Delete message</Button>}
            {r.target && <Button size="sm" kind="ghost" onClick={() => openModal({ kind: 'profile', userId: r.target.id, serverId })}>View profile</Button>}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───────────── audit log ───────────── */
const ACTION_LABELS: Record<string, string> = {
  server_update: 'updated the server', server_icon_update: 'changed the server icon', ownership_transfer: 'transferred ownership to',
  channel_create: 'created a channel', channel_update: 'updated a channel', channel_delete: 'deleted a channel',
  channel_overwrite_update: 'changed channel permissions', channel_overwrite_delete: 'removed a channel permission override',
  category_create: 'created a category', category_update: 'updated a category', category_delete: 'deleted a category',
  role_create: 'created a role', role_update: 'updated a role', role_delete: 'deleted a role', role_reorder: 'reordered roles',
  member_role_update: 'changed roles for', member_nickname_update: 'changed the nickname of',
  member_kick: 'kicked', member_ban: 'banned', member_unban: 'unbanned', member_timeout: 'timed out', member_timeout_remove: 'removed the timeout for',
  member_voice_mute: 'changed server mute for', member_voice_deafen: 'changed server deafen for', member_voice_move: 'moved', member_voice_disconnect: 'disconnected from voice',
  message_delete: 'deleted a message by', message_bulk_delete: 'bulk-deleted messages', message_pin: 'pinned a message', message_unpin: 'unpinned a message',
  invite_create: 'created an invite', invite_delete: 'revoked an invite', automod_rule_create: 'created an AutoMod rule', automod_rule_update: 'updated an AutoMod rule',
  automod_rule_delete: 'deleted an AutoMod rule', automod_block: 'blocked a message from', automod_timeout: 'timed out', report_resolve: 'updated a report',
  thread_create: 'started a thread', thread_update: 'updated a thread',
};

function AuditLog({ serverId }: { serverId: string }) {
  const [entries, setEntries] = useState<any[]>([]);
  const [action, setAction] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async (reset: boolean) => {
    setBusy(true);
    const before = !reset && entries.length ? `&before=${entries[entries.length - 1].id}` : '';
    try {
      const rows = await api.get<any[]>(`/api/servers/${serverId}/audit-log?${action ? `action=${action}` : ''}${before}`);
      setEntries(reset ? rows : [...entries, ...rows]);
      setDone(rows.length < 50);
    } catch (e) { toast(errMsg(e), 'error'); }
    setBusy(false);
  };
  useEffect(() => { void load(true); }, [action, serverId]);
  return (
    <div className="flex flex-col gap-3">
      <Select value={action} onChange={setAction} className="max-w-xs" aria-label="Filter by action" options={[{ value: '', label: 'All actions' }, ...Object.entries(ACTION_LABELS).map(([v, l]) => ({ value: v, label: l[0].toUpperCase() + l.slice(1) }))]} />
      {!entries.length && !busy && <EmptyState title="Nothing logged yet" body="Moderation actions and changes to the server are recorded here with who made them and when." />}
      <ol className="flex flex-col divide-y divide-line">
        {entries.map((e) => (
          <li key={e.id} className="py-3 flex gap-3">
            {e.actor ? <Avatar user={e.actor} size={32} /> : <span className="size-8 rounded-full bg-flag-blue text-white grid place-items-center shrink-0" aria-label="AutoMod"><LuBot size={16} /></span>}
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <strong>{e.actor ? e.actor.username : 'AutoMod'}</strong> {ACTION_LABELS[e.action] ?? e.action}{' '}
                {e.target_user && <strong>{e.target_user.username}</strong>}
              </p>
              {e.reason && <p className="text-xs text-muted">Reason: {e.reason}</p>}
              {e.changes && Object.keys(e.changes).length > 0 && <AuditChanges changes={e.changes} />}
              <time className="text-xs text-faint" dateTime={e.created_at} title={new Date(e.created_at).toLocaleString()}>{new Date(e.created_at).toLocaleString()}</time>
            </div>
          </li>
        ))}
      </ol>
      {busy && <Spinner />}
      {!done && !busy && entries.length > 0 && <Button kind="secondary" onClick={() => void load(false)}>Load older entries</Button>}
    </div>
  );
}
function AuditChanges({ changes }: { changes: Record<string, any> }) {
  const parts = Object.entries(changes).slice(0, 6).map(([k, v]) => {
    if (v && typeof v === 'object' && 'from' in v) return `${k}: ${fmt(v.from)} → ${fmt(v.to)}`;
    return `${k}: ${fmt(v)}`;
  });
  return <p className="text-xs text-muted break-words">{parts.join('; ')}</p>;
}
const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? 'none' : Array.isArray(v) ? (v.length ? `${v.length} item(s)` : 'none') : typeof v === 'object' ? 'changed' : String(v).slice(0, 80));

/* ───────────── ownership & deletion ───────────── */
function Transfer({ serverId }: { serverId: string }) {
  const members = useStore((s) => s.members[serverId]);
  const meId = useStore((s) => s.me?.id);
  const [to, setTo] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void loadMembers(serverId); }, [serverId]);
  return (
    <div className="flex flex-col gap-4 max-w-md">
      <p className="text-sm text-muted">The new owner gets every permission and can remove you. You'll stay in the server as a regular member.</p>
      <Field label="New owner"><Select value={to} onChange={setTo} options={[{ value: '', label: 'Choose a member' }, ...Object.values(members ?? {}).filter((m) => m.user.id !== meId).map((m) => ({ value: m.user.id, label: `${displayName(m.user, serverId)} (${m.user.username})` }))]} /></Field>
      <Field label="Your password"><Input type="password" value={pw} onChange={(e: any) => setPw(e.target.value)} autoComplete="current-password" /></Field>
      <Button kind="danger" disabled={!to || !pw} loading={busy} className="self-start" onClick={async () => {
        setBusy(true);
        try { await api.post(`/api/servers/${serverId}/transfer`, { user_id: to, password: pw }); toast('Ownership transferred.', 'ok'); closeModal(); }
        catch (e) { toast(errMsg(e), 'error'); setBusy(false); }
      }}>Transfer ownership</Button>
    </div>
  );
}

function DeleteServer({ serverId }: { serverId: string }) {
  const server = useStore((s) => s.servers[serverId])!;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-4 max-w-md">
      <p>Deleting <strong>{server.name}</strong> removes every channel, message and file in it for everyone. This can't be undone.</p>
      <Field label="Type the server name to confirm"><Input value={name} onChange={(e: any) => setName(e.target.value)} /></Field>
      <Button kind="danger" className="self-start" disabled={name !== server.name} loading={busy} onClick={async () => {
        setBusy(true);
        try { await api.del(`/api/servers/${serverId}`); closeModal(); navigate('/channels/@me'); toast('Server deleted.', 'ok'); }
        catch (e) { toast(errMsg(e), 'error'); setBusy(false); }
      }}>Delete server</Button>
    </div>
  );
}
