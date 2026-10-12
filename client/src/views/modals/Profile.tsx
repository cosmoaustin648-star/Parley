import { useEffect, useState } from 'react';
import { LuMessageCircle, LuPhone, LuEllipsis, LuPlus, LuX, LuPencil } from 'react-icons/lu';
import { useStore, closeModal, openModal, presenceOf, displayName, getState, toast } from '../../lib/store.ts';
import { api, errMsg } from '../../lib/api.ts';
import { navigate } from '../../lib/router.ts';
import { openDm, run, loadMembers } from '../../lib/actions.ts';
import { Markdown } from '../../lib/markdown.tsx';
import { voice } from '../../voice/engine.ts';
import type { User, Presence } from '../../lib/types.ts';
import { Modal, Avatar, Button, Spinner, Popover, Menu, useMenu, statusLabel, cx } from '../../components/ui.tsx';
import { memberMenuItems } from '../MemberList.tsx';
import { P, has, highestPosition } from '../../../../shared/permissions.ts';

interface Profile extends User { mutual_servers: { id: string; name: string }[]; blocked: boolean; presence: Presence }

export function ProfileModal({ userId, serverId }: { userId: string; serverId: string | null }) {
  const [p, setP] = useState<Profile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const live = useStore((s) => s.users[userId]);
  const meId = useStore((s) => s.me?.id);
  const member = useStore((s) => (serverId ? s.members[serverId]?.[userId] : undefined));
  const server = useStore((s) => (serverId ? s.servers[serverId] : undefined));
  const presence = useStore(() => presenceOf(userId));
  const menu = useMenu();
  const [roleAnchor, setRoleAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => { api.get<Profile>(`/api/users/${userId}`).then(setP).catch((e) => setErr(errMsg(e))); }, [userId]);
  useEffect(() => { if (serverId) void loadMembers(serverId); }, [serverId]);

  const u = { ...(p ?? {}), ...(live ?? {}) } as Profile;
  const isMe = userId === meId;
  const canRoles = !!server && has(server.my_permissions, P.MANAGE_ROLES);
  const myTop = server ? highestPosition({ ownerId: server.owner_id, userId: meId!, roles: server.roles, memberRoleIds: server.member.role_ids }) : 0;
  const roles = server && member ? server.roles.filter((r) => member.role_ids.includes(r.id)).sort((a, b) => b.position - a.position) : [];
  const assignable = server && member ? server.roles.filter((r) => !r.is_default && !member.role_ids.includes(r.id) && r.position < myTop) : [];
  const setRoles = (ids: string[]) => void run(() => api.patch(`/api/servers/${serverId}/members/${userId}`, { role_ids: ids }));

  return (
    <Modal bare width="max-w-[26rem]">
      {!p && !err && <div className="p-10 flex justify-center"><Spinner /></div>}
      {err && <div className="p-6"><p className="text-danger">{err}</p><Button className="mt-4" kind="secondary" onClick={closeModal}>Close</Button></div>}
      {p && (
        <div className="relative">
          <div className="h-28 rounded-t-xl overflow-hidden" style={{ background: u.accent_color || 'var(--c-active)' }}>
            {u.banner_url && <img src={u.banner_url} alt="" className="size-full object-cover" />}
          </div>
          <button aria-label="Close" onClick={closeModal} className="absolute top-2 right-2 size-8 rounded-full bg-black/40 text-white grid place-items-center hover:bg-black/60"><LuX size={16} /></button>
          <div className="px-5 -mt-12 flex items-end justify-between">
            <Avatar user={u} size={92} status={presence.status} ring="var(--c-raised)" className="ring-[6px] ring-raised rounded-full" />
            <div className="flex gap-1.5 mb-1">
              {isMe ? <Button size="sm" kind="secondary" onClick={() => openModal({ kind: 'userSettings', tab: 'profile' })}><LuPencil /> Edit profile</Button> : (
                <>
                  <Button size="sm" onClick={() => { closeModal(); void openDm(userId); }}><LuMessageCircle /> Message</Button>
                  <Button size="sm" kind="secondary" aria-label="Call" data-tip="Voice call" onClick={async () => { closeModal(); const dm = await openDm(userId); if (dm) void voice.join(dm.id); }}><LuPhone /></Button>
                  <Button size="sm" kind="secondary" aria-label="More" onClick={(e: MouseEvent) => menu.openAt(e.currentTarget as HTMLElement)}><LuEllipsis /></Button>
                </>
              )}
            </div>
          </div>
          <div className="px-5 pb-5 pt-3 flex flex-col gap-4">
            <div>
              <h2 className="font-display text-[1.4rem] font-bold leading-tight">{member?.nickname || u.display_name || u.username}</h2>
              <p className="text-sm text-muted">{u.username}{member?.nickname && u.display_name ? `, also ${u.display_name}` : ''}</p>
              {u.is_demo && <p className="text-xs text-warn mt-1">Sample account used for demonstrations.</p>}
              <p className="text-sm mt-2 text-fg/90">{presence.custom_status || statusLabel(presence.status)}</p>
            </div>
            {u.bio && <section><h3 className="text-[0.75rem] font-semibold text-muted mb-1">About</h3><Markdown content={u.bio} serverId={serverId} /></section>}
            <section className="grid grid-cols-2 gap-3 text-sm">
              <div><h3 className="text-[0.75rem] font-semibold text-muted mb-0.5">Member of Parley since</h3><p>{new Date(u.created_at).toLocaleDateString([], { dateStyle: 'medium' })}</p></div>
              {member && server && <div><h3 className="text-[0.75rem] font-semibold text-muted mb-0.5">Joined {server.name}</h3><p>{new Date(member.joined_at).toLocaleDateString([], { dateStyle: 'medium' })}</p></div>}
            </section>
            {member && server && (
              <section>
                <h3 className="text-[0.75rem] font-semibold text-muted mb-1.5">Roles</h3>
                <div className="flex flex-wrap gap-1.5">
                  {roles.filter((r) => !r.is_default).map((r) => (
                    <span key={r.id} className="h-6 pl-1.5 pr-2 rounded-md bg-field text-xs flex items-center gap-1.5">
                      {canRoles && r.position < myTop ? (
                        <button aria-label={`Remove ${r.name}`} className="size-3 rounded-full grid place-items-center group" style={{ background: r.color ?? 'var(--c-faint)' }} onClick={() => setRoles(member.role_ids.filter((x) => x !== r.id))}>
                          <LuX size={9} className="text-white opacity-0 group-hover:opacity-100" />
                        </button>
                      ) : <span className="size-3 rounded-full" style={{ background: r.color ?? 'var(--c-faint)' }} />}
                      {r.name}
                    </span>
                  ))}
                  {!roles.some((r) => !r.is_default) && !canRoles && <span className="text-sm text-muted">No roles</span>}
                  {canRoles && assignable.length > 0 && (
                    <button aria-label="Add role" className="h-6 w-6 rounded-md bg-field grid place-items-center text-muted hover:text-fg" onClick={(e: MouseEvent) => setRoleAnchor(e.currentTarget as HTMLElement)}><LuPlus size={14} /></button>
                  )}
                </div>
              </section>
            )}
            {!isMe && p.mutual_servers.length > 0 && (
              <section>
                <h3 className="text-[0.75rem] font-semibold text-muted mb-1.5">Mutual servers, {p.mutual_servers.length}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {p.mutual_servers.slice(0, 8).map((s) => <button key={s.id} className="h-7 px-2.5 rounded-md bg-field text-sm hover:bg-active" onClick={() => { closeModal(); navigate(`/channels/${s.id}`); }}>{s.name}</button>)}
                </div>
              </section>
            )}
            {p.blocked && <p className="text-sm text-danger">You've blocked this user.</p>}
          </div>
          {menu.at && <Popover anchor={menu.at} onClose={menu.close}><Menu items={memberMenuItems(u, serverId).filter((i) => i.label !== 'Profile')} onClose={menu.close} /></Popover>}
          {roleAnchor && member && (
            <Popover anchor={roleAnchor} onClose={() => setRoleAnchor(null)}>
              <Menu onClose={() => setRoleAnchor(null)} items={assignable.sort((a, b) => b.position - a.position).map((r) => ({
                label: r.name, icon: <span className="size-3 rounded-full inline-block" style={{ background: r.color ?? 'var(--c-faint)' }} />, onSelect: () => setRoles([...member.role_ids, r.id]),
              }))} />
            </Popover>
          )}
        </div>
      )}
    </Modal>
  );
}

export { displayName, getState, toast, cx };
