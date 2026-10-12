import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LuX, LuChevronLeft } from 'react-icons/lu';
import { closeModal } from '../../lib/store.ts';
import { cx, Button } from '../../components/ui.tsx';

export interface Section { title?: string; items: { id: string; label: string; danger?: boolean; hidden?: boolean }[] }

export function SettingsShell({ sections, tab, setTab, children, footer }: { sections: Section[]; tab: string; setTab: (t: string) => void; children: ReactNode; footer?: ReactNode }) {
  const [mobileList, setMobileList] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.dataset?.capturing) { e.stopPropagation(); closeModal(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  const label = sections.flatMap((s) => s.items).find((i) => i.id === tab)?.label;
  return createPortal(
    <div className="fixed inset-0 z-50 flex bg-deck text-fg anim-fade" role="dialog" aria-modal="true" aria-label="Settings">
      <nav className={cx('bg-side flex justify-end shrink-0 scroll md:w-[min(40%,20rem)] max-md:absolute max-md:inset-0 max-md:z-10', mobileList ? '' : 'max-md:hidden')}>
        <div className="w-56 py-14 px-2 flex flex-col gap-0.5 max-md:w-full max-md:px-4 max-md:py-6">
          {sections.map((s, i) => (
            <div key={i} className="flex flex-col gap-0.5 mb-3">
              {s.title && <h2 className="px-2.5 mb-1 text-[0.75rem] font-semibold text-muted truncate">{s.title}</h2>}
              {s.items.filter((it) => !it.hidden).map((it) => (
                <button key={it.id} onClick={() => { setTab(it.id); setMobileList(false); }} aria-current={tab === it.id ? 'page' : undefined}
                  className={cx('h-8 px-2.5 rounded-md text-left text-[0.93rem]', tab === it.id ? 'bg-active text-fg' : it.danger ? 'text-danger hover:bg-hover' : 'text-muted hover:bg-hover hover:text-fg')}>
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </nav>
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0 scroll">
          <div className="max-w-[46rem] px-6 md:px-10 py-6 md:py-14 relative">
            <button className="md:hidden flex items-center gap-1 text-muted mb-4" onClick={() => setMobileList(true)}><LuChevronLeft /> Settings</button>
            {label && <h1 className="font-display text-xl font-bold mb-6">{label}</h1>}
            {children}
          </div>
        </div>
        {footer}
      </main>
      <div className="max-md:absolute max-md:top-3 max-md:right-3 md:pt-14 md:pr-6 shrink-0 z-20">
        <button onClick={closeModal} aria-label="Close settings" className="size-9 rounded-full border-2 border-faint text-muted hover:text-fg hover:border-fg grid place-items-center"><LuX size={18} /></button>
        <p className="text-[0.7rem] text-faint text-center mt-1 max-md:hidden">Esc</p>
      </div>
    </div>,
    document.body,
  );
}

/** Sticky "unsaved changes" bar. */
export function SaveBar({ dirty, busy, onSave, onReset }: { dirty: boolean; busy?: boolean; onSave: () => void; onReset: () => void }) {
  if (!dirty) return null;
  return (
    <div className="sticky bottom-4 mx-6 md:mx-10 max-w-[44rem] mb-4 rounded-lg bg-rail px-4 py-3 flex items-center gap-3 anim-pop" style={{ boxShadow: 'var(--shadow-pop)' }}>
      <span className="flex-1 text-sm">You have unsaved changes.</span>
      <Button kind="ghost" size="sm" onClick={onReset}>Reset</Button>
      <Button size="sm" kind="primary" loading={busy} onClick={onSave}>Save changes</Button>
    </div>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mt-8 mb-3 first:mt-0">
      <h2 className="font-display text-base font-bold">{children}</h2>
      {hint && <p className="text-sm text-muted mt-0.5">{hint}</p>}
    </div>
  );
}
