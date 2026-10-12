import { useState } from 'react';
import { LuMic, LuMicOff, LuHeadphones, LuHeadphoneOff, LuSettings, LuPencil, LuCopy, LuLogOut, LuSmile } from 'react-icons/lu';
import { useStore, openModal, toast, presenceOf } from '../lib/store.ts';
import { api, errMsg } from '../lib/api.ts';
import { logout } from '../lib/actions.ts';
import { voice, useVoice } from '../voice/engine.ts';
import type { StatusPref } from '../lib/types.ts';
import { Avatar, IconButton, Popover, StatusDot, Input, Button, cx } from '../components/ui.tsx';

const STATUSES: { value: StatusPref; label: string; hint?: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'idle', label: 'Idle' },
  { value: 'dnd', label: 'Do Not Disturb', hint: 'Mutes notification sounds and pop-ups' },
  { value: 'invisible', label: 'Invisible', hint: 'You appear offline, but can still use Parley' },
];

export function UserPanel() {
  const me = useStore((s) => s.me)!;
  const status = useStore(() => presenceOf(me.id).status);
  const selfMute = useVoice((v) => v.selfMute);
  const selfDeaf = useVoice((v) => v.selfDeaf);
  const speaking = useVoice((v) => !!v.speaking[me.id]);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [custom, setCustom] = useState(me.custom_status ?? '');

  const setStatus = async (s: StatusPref) => {
    try { await api.patch('/api/users/@me', { status: s }); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const saveCustom = async () => {
    try { await api.patch('/api/users/@me', { custom_status: custom.trim() || null }); setEditing(false); setAnchor(null); } catch (e) { toast(errMsg(e), 'error'); }
  };
  const shownStatus = me.status === 'invisible' ? 'offline' : status;

  return (
    <div className="h-[3.25rem] px-2 flex items-center gap-1 bg-rail/60 shrink-0">
      <button className="flex items-center gap-2 flex-1 min-w-0 h-10 pl-1 pr-2 rounded-md hover:bg-hover text-left" onClick={(e: MouseEvent) => setAnchor(e.currentTarget as HTMLElement)} aria-label="Set status and profile" aria-haspopup="dialog">
        <Avatar user={me} size={32} status={shownStatus} ring="var(--c-rail)" speaking={speaking} />
        <span className="min-w-0 leading-tight">
          <span className="block text-sm font-semibold truncate">{me.display_name || me.username}</span>
          <span className="block text-xs text-muted truncate">{me.custom_status || me.username}</span>
        </span>
      </button>
      <IconButton label={selfMute ? 'Unmute' : 'Mute'} onClick={() => voice.toggleMute()} danger={selfMute}>{selfMute ? <LuMicOff size={18} /> : <LuMic size={18} />}</IconButton>
      <IconButton label={selfDeaf ? 'Undeafen' : 'Deafen'} onClick={() => voice.toggleDeafen()} danger={selfDeaf}>{selfDeaf ? <LuHeadphoneOff size={18} /> : <LuHeadphones size={18} />}</IconButton>
      <IconButton label="User settings" onClick={() => openModal({ kind: 'userSettings' })}><LuSettings size={18} /></IconButton>

      {anchor && (
        <Popover anchor={anchor} onClose={() => { setAnchor(null); setEditing(false); }} placement="top-start" className="w-72 overflow-hidden">
          <div className="h-14" style={{ background: me.accent_color || 'var(--c-active)' }}>{me.banner_url && <img src={me.banner_url} alt="" className="size-full object-cover" />}</div>
          <div className="px-4 -mt-7">
            <Avatar user={me} size={64} status={shownStatus} ring="var(--c-raised)" className="ring-4 ring-raised rounded-full" />
            <p className="font-display font-bold text-lg mt-1">{me.display_name || me.username}</p>
            <p className="text-sm text-muted">{me.username}</p>
          </div>
          <div className="p-2 mt-2 border-t border-line">
            {editing ? (
              <form className="flex flex-col gap-2 p-1" onSubmit={(e: Event) => { e.preventDefault(); void saveCustom(); }}>
                <Input value={custom} onChange={(e: any) => setCustom(e.target.value)} placeholder="What are you up to?" maxLength={128} autoFocus />
                <div className="flex gap-2 justify-end">
                  {me.custom_status && <Button kind="ghost" size="sm" type="button" onClick={() => { setCustom(''); void api.patch('/api/users/@me', { custom_status: null }).then(() => setAnchor(null)); }}>Clear</Button>}
                  <Button size="sm" type="submit">Save</Button>
                </div>
              </form>
            ) : (
              <button className="w-full flex items-center gap-2.5 px-2 h-9 rounded-md hover:bg-hover text-sm text-left" onClick={() => setEditing(true)}>
                <LuSmile size={16} className="text-muted" /> <span className="truncate">{me.custom_status ? me.custom_status : 'Set a custom status'}</span>
              </button>
            )}
            <div className="h-px bg-line my-1.5" />
            {STATUSES.map((s) => (
              <button key={s.value} onClick={() => { void setStatus(s.value); setAnchor(null); }}
                className={cx('w-full flex items-start gap-2.5 px-2 py-1.5 rounded-md hover:bg-hover text-left', me.status === s.value && 'bg-active')}>
                <span className="mt-0.5"><StatusDot status={s.value === 'invisible' ? 'offline' : s.value} size={10} ring="var(--c-raised)" /></span>
                <span className="flex flex-col"><span className="text-sm">{s.label}</span>{s.hint && <span className="text-xs text-muted">{s.hint}</span>}</span>
              </button>
            ))}
            <div className="h-px bg-line my-1.5" />
            <button className="w-full flex items-center gap-2.5 px-2 h-9 rounded-md hover:bg-hover text-sm" onClick={() => { setAnchor(null); openModal({ kind: 'userSettings', tab: 'profile' }); }}><LuPencil size={15} className="text-muted" /> Edit profile</button>
            <button className="w-full flex items-center gap-2.5 px-2 h-9 rounded-md hover:bg-hover text-sm" onClick={() => { void navigator.clipboard?.writeText(me.username); toast('Username copied.', 'ok'); setAnchor(null); }}><LuCopy size={15} className="text-muted" /> Copy username</button>
            <button className="w-full flex items-center gap-2.5 px-2 h-9 rounded-md hover:bg-danger hover:text-white text-sm text-danger" onClick={() => void logout()}><LuLogOut size={15} /> Log out</button>
          </div>
        </Popover>
      )}
    </div>
  );
}
