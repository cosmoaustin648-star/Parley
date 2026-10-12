import { useEffect, useMemo, useState } from 'react';
import { LuCheck, LuX, LuSlash, LuPlus, LuTrash2 } from 'react-icons/lu';
import { useStore, closeModal, confirmDialog, toast, displayName } from '../../lib/store.ts';
import { api, errMsg } from '../../lib/api.ts';
import { run, loadMembers } from '../../lib/actions.ts';
import { navigate } from '../../lib/router.ts';
import { Button, Field, Input, TextArea, Select, Spinner, cx, Popover, Menu, Avatar } from '../../components/ui.tsx';
import { SettingsShell, SaveBar, SectionTitle } from './SettingsShell.tsx';
import { P, has, PERMISSION_INFO, type PermName } from '../../../../shared/permissions.ts';

const TEXT_ONLY = ['SEND_MESSAGES', 'MANAGE_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'MENTION_EVERYONE', 'READ_HISTORY', 'CREATE_THREADS'];
const VOICE_ONLY = ['CONNECT', 'SPEAK', 'VIDEO', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS'];
const SERVER_ONLY = ['ADMINISTRATOR', 'MANAGE_SERVER', 'VIEW_AUDIT_LOG', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MODERATE_MEMBERS', 'MANAGE_NICKNAMES', 'CHANGE_NICKNAME'];
const SLOWMODE = [0, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 21600];

export function ChannelSettings({ channelId, initialTab }: { channelId: string; initialTab?: string }) {
  const channel = useStore((s) => s.channels[channelId]);
  const [tab, setTab] = useState(initialTab ?? 'overview');
  useEffect(() => { if (!channel) closeModal(); }, [channel]);
  if (!channel) return null;
  const perms = channel.my_permissions ?? 0;
  return (
    <SettingsShell tab={tab} setTab={setTab} sections={[
      { title: `${channel.type === 'voice' ? '' : '#'}${channel.name}`, items: [
        { id: 'overview', label: 'Overview' },
        { id: 'permissions', label: 'Permissions', hidden: !has(perms, P.MANAGE_ROLES) },
      ] },
      { items: [{ id: 'delete', label: 'Delete channel', danger: true }] },
    ]}>
      {tab === 'overview' && <ChannelOverview channelId={channelId} />}
      {tab === 'permissions' && <Overwrites channelId={channelId} />}
      {tab === 'delete' && (
        <div className="flex flex-col gap-4 max-w-md">
          <p>Deleting <strong>{channel.name}</strong> removes all of its messages and threads. This can't be undone.</p>
          <Button kind="danger" className="self-start" onClick={() => confirmDialog({
            title: `Delete ${channel.name}?`, body: 'This permanently deletes the channel and everything in it.', confirmLabel: 'Delete channel', danger: true,
            onConfirm: async () => { await api.del(`/api/channels/${channelId}`); navigate(`/channels/${channel.server_id}`); },
          })}><LuTrash2 /> Delete channel</Button>
        </div>
      )}
    </SettingsShell>
  );
}

function ChannelOverview({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels[channelId])!;
  const server = useStore((s) => s.servers[channel.server_id!]);
  const initial = { name: channel.name ?? '', topic: channel.topic, slowmode_seconds: channel.slowmode_seconds, category_id: channel.category_id ?? '' };
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const save = async () => {
    setBusy(true);
    try { await api.patch(`/api/channels/${channelId}`, { ...f, category_id: f.category_id || null }); toast('Channel saved.', 'ok'); }
    catch (e) { toast(errMsg(e), 'error'); }
    setBusy(false);
  };
  return (
    <div className="flex flex-col gap-5">
      <Field label="Channel name"><Input value={f.name} onChange={(e: any) => setF({ ...f, name: e.target.value })} maxLength={100} /></Field>
      {channel.type === 'text' && (
        <>
          <Field label="Topic" hint="Shown in the channel header. Markdown works."><TextArea value={f.topic} onChange={(e: any) => setF({ ...f, topic: e.target.value })} maxLength={1024} /></Field>
          <Field label="Slowmode" hint="How long members wait between messages. Moderators are exempt.">
            <Select value={String(f.slowmode_seconds)} onChange={(v) => setF({ ...f, slowmode_seconds: Number(v) })}
              options={SLOWMODE.map((s) => ({ value: String(s), label: s === 0 ? 'Off' : s < 60 ? `${s} seconds` : s < 3600 ? `${s / 60} minutes` : `${s / 3600} hours` }))} />
          </Field>
        </>
      )}
      <Field label="Category"><Select value={f.category_id} onChange={(v) => setF({ ...f, category_id: v })} options={[{ value: '', label: 'No category' }, ...(server?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))]} /></Field>
      <div className="h-16" />
      <div className="fixed bottom-0 left-0 right-0 md:left-[min(40%,20rem)]"><SaveBar dirty={dirty} busy={busy} onSave={save} onReset={() => setF(initial)} /></div>
    </div>
  );
}

interface Ow { target_type: 'role' | 'member'; target_id: string; allow: number; deny: number; role: { id: string; name: string; color: string | null } | null; user: any }

function Overwrites({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels[channelId])!;
  const server = useStore((s) => s.servers[channel.server_id!])!;
  const members = useStore((s) => s.members[channel.server_id!]);
  const [list, setList] = useState<Ow[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ allow: number; deny: number } | null>(null);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<Ow[]>(`/api/channels/${channelId}/overwrites`).then((l) => {
    const everyone = server.roles.find((r) => r.is_default)!;
    if (!l.some((o) => o.target_type === 'role' && o.target_id === everyone.id)) l.unshift({ target_type: 'role', target_id: everyone.id, allow: 0, deny: 0, role: { id: everyone.id, name: '@everyone', color: null }, user: null });
    setList(l);
    if (!sel) setSel(`role:${everyone.id}`);
  }).catch((e) => toast(errMsg(e), 'error'));
  useEffect(() => { void load(); void loadMembers(channel.server_id!); }, [channelId]);
  const current = list?.find((o) => `${o.target_type}:${o.target_id}` === sel) ?? null;
  useEffect(() => { setDraft(current ? { allow: current.allow, deny: current.deny } : null); }, [sel, list]);
  const relevant = useMemo(() => {
    const skip = new Set<string>([...SERVER_ONLY, ...(channel.type === 'voice' ? TEXT_ONLY : VOICE_ONLY)]);
    return PERMISSION_INFO.filter((p) => !skip.has(p.key));
  }, [channel.type]);

  if (!list) return <Spinner />;
  const dirty = !!current && !!draft && (draft.allow !== current.allow || draft.deny !== current.deny);
  const set = (flag: number, state: 'allow' | 'inherit' | 'deny') => {
    if (!draft) return;
    setDraft({ allow: state === 'allow' ? draft.allow | flag : draft.allow & ~flag, deny: state === 'deny' ? draft.deny | flag : draft.deny & ~flag });
  };
  const save = async () => {
    if (!current || !draft) return;
    setBusy(true);
    try { await api.put(`/api/channels/${channelId}/overwrites/${current.target_type}/${current.target_id}`, draft); await load(); toast('Permissions saved.', 'ok'); }
    catch (e) { toast(errMsg(e), 'error'); }
    setBusy(false);
  };
  const addTarget = (type: 'role' | 'member', id: string, label: string) => {
    const key = `${type}:${id}`;
    if (!list.some((o) => `${o.target_type}:${o.target_id}` === key)) {
      setList([...list, { target_type: type, target_id: id, allow: 0, deny: 0, role: type === 'role' ? { id, name: label, color: null } : null, user: type === 'member' ? members?.[id]?.user : null }]);
    }
    setSel(key);
  };
  const isPrivate = !!list.find((o) => o.role?.name === '@everyone' && (o.deny & P.VIEW_CHANNEL));
  const everyone = server.roles.find((r) => r.is_default)!;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-line p-4 flex items-center gap-4">
        <div className="flex-1"><p className="font-semibold">Private channel</p><p className="text-sm text-muted">Only roles and members you allow below can see it.</p></div>
        <Button size="sm" kind={isPrivate ? 'secondary' : 'primary'} onClick={() => void run(async () => {
          const ow = list.find((o) => o.target_type === 'role' && o.target_id === everyone.id)!;
          await api.put(`/api/channels/${channelId}/overwrites/role/${everyone.id}`, isPrivate ? { allow: ow.allow, deny: ow.deny & ~P.VIEW_CHANNEL } : { allow: ow.allow & ~P.VIEW_CHANNEL, deny: ow.deny | P.VIEW_CHANNEL });
          await load();
        })}>{isPrivate ? 'Make public' : 'Make private'}</Button>
      </div>
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="lg:w-52 shrink-0 flex flex-col gap-1">
          <div className="flex items-center justify-between mb-1"><span className="text-[0.75rem] font-semibold text-muted">Roles and members</span>
            <button aria-label="Add role or member" className="text-muted hover:text-fg" onClick={(e: MouseEvent) => setAddAnchor(e.currentTarget as HTMLElement)}><LuPlus /></button></div>
          {list.map((o) => {
            const key = `${o.target_type}:${o.target_id}`;
            return (
              <button key={key} onClick={() => setSel(key)} className={cx('h-9 px-2 rounded-md flex items-center gap-2 text-left text-sm', sel === key ? 'bg-active' : 'hover:bg-hover')}>
                {o.target_type === 'role' ? <span className="size-3 rounded-full" style={{ background: o.role?.color ?? 'var(--c-faint)' }} /> : <Avatar user={o.user} size={18} />}
                <span className="truncate">{o.target_type === 'role' ? o.role?.name : o.user ? displayName(o.user, channel.server_id) : o.target_id}</span>
              </button>
            );
          })}
        </div>
        {current && draft && (
          <div className="flex-1 min-w-0">
            <SectionTitle hint="Green allows, red denies, the middle inherits from server roles. Member overrides beat role overrides.">
              Permissions for {current.target_type === 'role' ? current.role?.name : displayName(current.user, channel.server_id)}
            </SectionTitle>
            <div className="flex flex-col divide-y divide-line">
              {relevant.map((p) => {
                const flag = P[p.key as PermName];
                const state = has(draft.allow, flag) ? 'allow' : has(draft.deny, flag) ? 'deny' : 'inherit';
                return (
                  <div key={p.key} className="py-2.5 flex items-center gap-4">
                    <div className="flex-1 min-w-0"><p className="text-[0.95rem]">{p.label}</p><p className="text-xs text-muted">{p.description}</p></div>
                    <div className="flex rounded-md overflow-hidden border border-line shrink-0" role="radiogroup" aria-label={p.label}>
                      {([['deny', <LuX key="d" />, 'bg-danger text-white'], ['inherit', <LuSlash key="i" />, 'bg-active text-fg'], ['allow', <LuCheck key="a" />, 'bg-ok text-white']] as const).map(([v, icon, on]) => (
                        <button key={v} role="radio" aria-checked={state === v} aria-label={v === 'inherit' ? 'Inherit' : v === 'allow' ? 'Allow' : 'Deny'}
                          onClick={() => set(flag, v)} className={cx('size-8 grid place-items-center', state === v ? on : 'text-muted hover:bg-hover')}>{icon}</button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {!(current.role?.name === '@everyone') && (
              <Button kind="ghost" className="mt-4 text-danger" onClick={() => void run(async () => {
                await api.del(`/api/channels/${channelId}/overwrites/${current.target_type}/${current.target_id}`).catch(() => {});
                setSel(null); await load();
              })}>Remove override</Button>
            )}
          </div>
        )}
      </div>
      <div className="h-16" />
      <div className="fixed bottom-0 left-0 right-0 md:left-[min(40%,20rem)]"><SaveBar dirty={dirty} busy={busy} onSave={save} onReset={() => current && setDraft({ allow: current.allow, deny: current.deny })} /></div>
      {addAnchor && (
        <Popover anchor={addAnchor} onClose={() => setAddAnchor(null)} className="max-h-80 overflow-y-auto">
          <Menu onClose={() => setAddAnchor(null)} items={[
            ...server.roles.filter((r) => !r.is_default).sort((a, b) => b.position - a.position).map((r) => ({ label: `Role: ${r.name}`, onSelect: () => addTarget('role', r.id, r.name) })),
            { separator: true, label: '' },
            ...Object.values(members ?? {}).slice(0, 50).map((m) => ({ label: `Member: ${displayName(m.user, channel.server_id)}`, onSelect: () => addTarget('member', m.user.id, m.user.username) })),
          ]} />
        </Popover>
      )}
    </div>
  );
}
