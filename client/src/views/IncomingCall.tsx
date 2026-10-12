import { createPortal } from 'react-dom';
import { LuPhone, LuPhoneOff } from 'react-icons/lu';
import { useStore, setState } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import { voice } from '../voice/engine.ts';
import { Avatar } from '../components/ui.tsx';
import { dmTitle } from './DmSidebar.tsx';

export function IncomingCall() {
  const call = useStore((s) => s.incomingCall);
  const dm = useStore((s) => (call ? s.dms[call.channel_id] : undefined));
  const caller = useStore((s) => (call ? s.users[call.from_user_id] : undefined));
  const meId = useStore((s) => s.me?.id);
  if (!call) return null;
  const dismiss = () => setState(() => ({ incomingCall: null }));
  const join = () => { dismiss(); void voice.join(call.channel_id); navigate(`/channels/@me/${call.channel_id}`); };
  return createPortal(
    <div role="alertdialog" aria-label="Incoming call" className="fixed top-4 right-4 z-[65] w-72 rounded-xl bg-raised p-4 anim-pop flex flex-col items-center gap-3 text-center" style={{ boxShadow: 'var(--shadow-pop)' }}>
      <span className="anim-ring"><Avatar user={caller ?? null} size={64} /></span>
      <div>
        <p className="font-display font-bold text-lg">{caller ? caller.display_name || caller.username : 'Someone'}</p>
        <p className="text-sm text-muted">{dm?.type === 'group_dm' ? `Calling ${dmTitle(dm, meId)}` : 'Incoming call…'}</p>
      </div>
      <div className="flex gap-6">
        <button aria-label="Decline" data-tip="Decline" onClick={dismiss} className="size-12 rounded-full bg-danger text-white grid place-items-center hover:brightness-110"><LuPhoneOff size={22} /></button>
        <button aria-label="Join call" data-tip="Join call" onClick={join} className="size-12 rounded-full bg-ok text-white grid place-items-center hover:brightness-110"><LuPhone size={22} /></button>
      </div>
    </div>,
    document.body,
  );
}
