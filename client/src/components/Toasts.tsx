import { useStore, setState } from '../lib/store.ts';
import { cx } from './ui.tsx';
import { LuCircleCheck, LuCircleAlert, LuInfo, LuX } from 'react-icons/lu';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[80] flex flex-col gap-2 items-center pointer-events-none w-[min(92vw,28rem)]" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
          className={cx('pointer-events-auto flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 text-sm bg-raised text-fg anim-pop w-full',
            t.tone === 'error' && 'border-l-4 border-danger', t.tone === 'ok' && 'border-l-4 border-ok')}
          style={{ boxShadow: 'var(--shadow-pop)' }}>
          <span className="mt-0.5 shrink-0">
            {t.tone === 'error' ? <LuCircleAlert className="text-danger" /> : t.tone === 'ok' ? <LuCircleCheck className="text-ok" /> : <LuInfo className="text-link" />}
          </span>
          <span className="flex-1 leading-snug">{t.text}</span>
          {t.action && <button className="text-link font-medium" onClick={t.action.run}>{t.action.label}</button>}
          <button aria-label="Dismiss" className="text-muted hover:text-fg" onClick={() => setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}><LuX /></button>
        </div>
      ))}
    </div>
  );
}
