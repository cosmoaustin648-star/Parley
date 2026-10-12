import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LuX, LuLoaderCircle } from 'react-icons/lu';
import { hashColor, initials } from '../lib/format.ts';
import type { Status, User } from '../lib/types.ts';
import { closeModal } from '../lib/store.ts';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

/* ───────────── buttons ───────────── */
type BtnKind = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link';
export function Button({ kind = 'primary', size = 'md', loading, className, children, ...rest }: {
  kind?: BtnKind; size?: 'sm' | 'md' | 'lg'; loading?: boolean; className?: string; children: ReactNode; [k: string]: any;
}) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 select-none whitespace-nowrap';
  const sizes = { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4 text-[0.9rem]', lg: 'h-11 px-5 text-base' };
  const kinds: Record<BtnKind, string> = {
    primary: 'bg-accent text-accent-ink hover:brightness-110 active:brightness-95',
    secondary: 'bg-active text-fg hover:bg-[color-mix(in_srgb,var(--c-active)_160%,transparent)]',
    danger: 'bg-danger text-white hover:brightness-110',
    ghost: 'text-fg hover:bg-hover',
    link: 'text-link hover:underline px-0 h-auto',
  };
  return (
    <button className={cx(base, sizes[size], kinds[kind], className)} disabled={loading || rest.disabled} {...rest}>
      {loading && <LuLoaderCircle className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function IconButton({ label, active, danger, className, children, ...rest }: {
  label: string; active?: boolean; danger?: boolean; className?: string; children: ReactNode; [k: string]: any;
}) {
  return (
    <button aria-label={label} data-tip={label} aria-pressed={active}
      className={cx('grid place-items-center size-8 rounded-md text-muted hover:text-fg hover:bg-hover transition-colors shrink-0',
        active && 'text-fg bg-active', danger && 'text-danger hover:text-danger', className)} {...rest}>
      {children}
    </button>
  );
}

/* ───────────── form controls ───────────── */
export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[0.8rem] font-semibold text-muted">{label}</label>
      {children}
      {error ? <p className="text-[0.8rem] text-danger" role="alert">{error}</p> : hint ? <p className="text-[0.8rem] text-faint">{hint}</p> : null}
    </div>
  );
}

export const inputCls = 'w-full h-10 rounded-lg bg-field text-fg px-3 text-[0.95rem] placeholder:text-faint border border-transparent focus:border-accent focus:outline-none transition-colors';
export function Input(props: any) { return <input {...props} className={cx(inputCls, props.className)} />; }
export function TextArea(props: any) { return <textarea {...props} className={cx(inputCls, 'h-auto py-2 resize-y min-h-20', props.className)} />; }
export function Select({ value, onChange, options, className, ...rest }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string; [k: string]: any }) {
  return (
    <select value={value} onChange={(e: any) => onChange(e.target.value)} className={cx(inputCls, 'appearance-auto', className)} {...rest}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex items-start justify-between gap-4 py-2', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <span className="flex flex-col">
        <span className="text-[0.95rem] text-fg">{label}</span>
        {description && <span className="text-[0.8rem] text-muted mt-0.5">{description}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors', checked ? 'bg-ok' : 'bg-faint/60')}>
        <span className={cx('absolute left-0 top-0.5 size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
    </label>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LuLoaderCircle className={cx('animate-spin text-muted', className)} aria-label="Loading" />;
}

/* ───────────── avatar & status ───────────── */
const STATUS_LABEL: Record<Status, string> = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline' };
export const statusLabel = (s: Status) => STATUS_LABEL[s];

/** Status is encoded by shape as well as colour (dot, crescent, bar, ring). */
export function StatusDot({ status, size = 12, ring = 'var(--c-side)' }: { status: Status; size?: number; ring?: string }) {
  const s = size;
  return (
    <svg width={s + 6} height={s + 6} viewBox="-3 -3 18 18" role="img" aria-label={STATUS_LABEL[status]}>
      <circle cx="6" cy="6" r="8" fill={ring} />
      {status === 'online' && <circle cx="6" cy="6" r="5" fill="var(--c-ok)" />}
      {status === 'idle' && <><circle cx="6" cy="6" r="5" fill="var(--c-idle)" /><circle cx="3.6" cy="3.6" r="3.2" fill={ring} /></>}
      {status === 'dnd' && <><circle cx="6" cy="6" r="5" fill="var(--c-danger)" /><rect x="3" y="5" width="6" height="2" rx="1" fill={ring} /></>}
      {status === 'offline' && <><circle cx="6" cy="6" r="5" fill="var(--c-faint)" /><circle cx="6" cy="6" r="2.4" fill={ring} /></>}
    </svg>
  );
}

export function Avatar({ user, size = 40, status, ring, speaking, className }: {
  user: Pick<User, 'id' | 'username' | 'display_name' | 'avatar_url'> | null; size?: number; status?: Status; ring?: string; speaking?: boolean; className?: string;
}) {
  const name = user ? user.display_name || user.username : '?';
  const [broken, setBroken] = useState(false);
  const dot = Math.max(10, Math.round(size * 0.3));
  return (
    <span className={cx('relative inline-block shrink-0', className)} style={{ width: size, height: size }}>
      {user?.avatar_url && !broken ? (
        <img src={user.avatar_url} alt="" onError={() => setBroken(true)} className={cx('size-full rounded-full object-cover', speaking && 'speaking')} draggable={false} />
      ) : (
        <span className={cx('size-full rounded-full grid place-items-center font-semibold text-white select-none', speaking && 'speaking')}
          style={{ background: user ? hashColor(user.id) : 'var(--c-faint)', fontSize: size * 0.38 }} aria-hidden>
          {initials(name).slice(0, 2)}
        </span>
      )}
      {status && (
        <span className="absolute" style={{ right: -dot * 0.35, bottom: -dot * 0.35 }}>
          <StatusDot status={status} size={dot} ring={ring} />
        </span>
      )}
    </span>
  );
}

/* ───────────── signal flags (default server icons) ───────────── */
const FLAG = { y: '#F5C542', b: '#2F6FD6', r: '#D64541', w: '#F4F6FA', k: '#121721' };
const PAIRS: [string, string][] = [['b', 'w'], ['r', 'w'], ['y', 'b'], ['y', 'k'], ['r', 'y'], ['k', 'w'], ['w', 'r'], ['b', 'y'], ['w', 'b'], ['y', 'r']];
function seed(id: string) { let h = 2166136261; for (const c of id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

export function SignalFlag({ id, size = 48, className }: { id: string; size?: number; className?: string }) {
  const h = seed(id);
  const [a, b] = PAIRS[h % PAIRS.length].map((k) => FLAG[k as keyof typeof FLAG]);
  const pattern = (h >>> 8) % 12;
  const s = 48;
  const shapes: Record<number, ReactNode> = {
    0: <rect y="24" width="48" height="24" fill={b} />,
    1: <rect x="24" width="24" height="48" fill={b} />,
    2: <><rect width="24" height="24" fill={b} /><rect x="24" y="24" width="24" height="24" fill={b} /></>,
    3: <path d="M0 0L48 48M48 0L0 48" stroke={b} strokeWidth="10" />,
    4: <path d="M24 0V48M0 24H48" stroke={b} strokeWidth="11" />,
    5: <rect x="12" y="12" width="24" height="24" fill={b} />,
    6: <path d="M0 0H48V48Z" fill={b} />,
    7: <>{[0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) => ((r + c) % 2 ? <rect key={`${r}${c}`} x={c * 12} y={r * 12} width="12" height="12" fill={b} /> : null)))}</>,
    8: <rect y="16" width="48" height="16" fill={b} />,
    9: <>{[1, 3].map((i) => <rect key={i} x={i * 9.6} width="9.6" height="48" fill={b} />)}</>,
    10: <circle cx="24" cy="24" r="12" fill={b} />,
    11: <><rect width="48" height="12" fill={b} /><rect y="36" width="48" height="12" fill={b} /></>,
  };
  return (
    <svg viewBox={`0 0 ${s} ${s}`} width={size} height={size} className={className} aria-hidden>
      <rect width="48" height="48" fill={a} />
      {shapes[pattern]}
    </svg>
  );
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden>
      <path d="M14 10v44" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" opacity="0.7" />
      <path d="M17 12h34l-9.5 11.5L51 35H17z" fill="#F5C542" />
      <path d="M17 12h17v23H17z" fill="#2F6FD6" />
    </svg>
  );
}

export function ServerIcon({ server, size = 48, className }: { server: { id: string; name: string; icon_url: string | null }; size?: number; className?: string }) {
  return server.icon_url
    ? <img src={server.icon_url} alt="" width={size} height={size} className={cx('object-cover', className)} draggable={false} />
    : <SignalFlag id={server.id} size={size} className={className} />;
}

/* ───────────── modal shell ───────────── */
export function Modal({ title, subtitle, onClose = closeModal, children, footer, width = 'max-w-md', bare }: {
  title?: ReactNode; subtitle?: ReactNode; onClose?: () => void; children: ReactNode; footer?: ReactNode; width?: string; bare?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[autofocus], input, textarea, select, button:not([data-close])');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 anim-fade" onMouseDown={(e: MouseEvent) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}
        className={cx('w-full rounded-xl bg-raised text-fg anim-pop max-h-[90vh] flex flex-col', width)} style={{ boxShadow: 'var(--shadow-pop)' }}>
        {!bare && (title || subtitle) && (
          <header className="px-5 pt-5 pb-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              {title && <h2 className="font-display text-xl font-bold leading-tight">{title}</h2>}
              {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
            </div>
            <IconButton label="Close" onClick={onClose} data-close><LuX size={20} /></IconButton>
          </header>
        )}
        <div className={cx('scroll flex-1 min-h-0', !bare && 'px-5 pb-4')}>{children}</div>
        {footer && <footer className="px-5 py-3 bg-side/70 rounded-b-xl flex justify-end gap-2">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* ───────────── popover & menu ───────────── */
export function Popover({ anchor, onClose, children, placement = 'bottom-start', className }: {
  anchor: HTMLElement | DOMRect | { x: number; y: number }; onClose: () => void; children: ReactNode; placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'left-start'; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = 'getBoundingClientRect' in anchor ? (anchor as HTMLElement).getBoundingClientRect()
      : 'width' in anchor ? anchor as DOMRect : { left: (anchor as any).x, right: (anchor as any).x, top: (anchor as any).y, bottom: (anchor as any).y, width: 0, height: 0 } as DOMRect;
    const w = el.offsetWidth, h = el.offsetHeight, m = 8;
    let left = r.left, top = r.bottom + 6;
    if (placement === 'bottom-end') left = r.right - w;
    if (placement === 'top-start') top = r.top - h - 6;
    if (placement === 'top-end') { top = r.top - h - 6; left = r.right - w; }
    if (placement === 'right-start') { left = r.right + 8; top = r.top; }
    if (placement === 'left-start') { left = r.left - w - 8; top = r.top; }
    left = Math.max(m, Math.min(left, innerWidth - w - m));
    if (top + h > innerHeight - m) top = Math.max(m, (placement.startsWith('bottom') ? r.top - h - 6 : innerHeight - h - m));
    top = Math.max(m, top);
    setPos({ left, top });
  }, [anchor, placement]);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    setTimeout(() => window.addEventListener('mousedown', down), 0);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', onClose);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', onClose); };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className={cx('fixed z-[60] rounded-lg bg-raised text-fg anim-pop', className)}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, boxShadow: 'var(--shadow-pop)' }}>
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem { label: string; icon?: ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean; separator?: boolean; hint?: string; checked?: boolean }
export function Menu({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role=menuitem]:not([disabled])')?.focus(); }, []);
  const onKey = (e: KeyboardEvent) => {
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
  };
  return (
    <div ref={ref} role="menu" className="min-w-52 p-1.5 flex flex-col" onKeyDown={onKey}>
      {items.map((it, i) => it.separator ? <div key={i} className="my-1 h-px bg-line" /> : (
        <button key={i} role="menuitem" disabled={it.disabled}
          onClick={() => { onClose(); it.onSelect?.(); }}
          className={cx('flex items-center gap-2.5 px-2 h-8 rounded-md text-left text-[0.875rem] disabled:opacity-40 focus:outline-none',
            it.danger ? 'text-danger hover:bg-danger hover:text-white focus:bg-danger focus:text-white' : 'text-fg hover:bg-accent hover:text-accent-ink focus:bg-accent focus:text-accent-ink')}>
          <span className="flex-1 truncate">{it.label}</span>
          {it.checked !== undefined && <span aria-hidden>{it.checked ? '✓' : ''}</span>}
          {it.hint && <span className="text-xs opacity-70">{it.hint}</span>}
          {it.icon && <span className="opacity-90" aria-hidden>{it.icon}</span>}
        </button>
      ))}
    </div>
  );
}

/** Hook: right-click/long-press menu state. */
export function useMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return {
    at,
    open: (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); setAt({ x: e.clientX, y: e.clientY }); },
    openAt: (el: HTMLElement) => { const r = el.getBoundingClientRect(); setAt({ x: r.left, y: r.bottom }); },
    close: () => setAt(null),
  };
}

/* ───────────── tooltip layer (one element for every [data-tip]) ───────────── */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; side: 'top' | 'right' } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const over = (e: Event) => {
      const el = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null;
      clearTimeout(timer);
      if (!el) { setTip(null); return; }
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        const side = el.dataset.tipSide === 'right' ? 'right' : 'top';
        setTip({ text: el.dataset.tip!, x: side === 'right' ? r.right + 10 : r.left + r.width / 2, y: side === 'right' ? r.top + r.height / 2 : r.top - 8, side });
      }, 350);
    };
    const hide = () => { clearTimeout(timer); setTip(null); };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerdown', hide);
    document.addEventListener('scroll', hide, true);
    return () => { document.removeEventListener('pointerover', over); document.removeEventListener('pointerdown', hide); document.removeEventListener('scroll', hide, true); };
  }, []);
  if (!tip) return null;
  return createPortal(
    <div role="tooltip" className="fixed z-[70] pointer-events-none px-2.5 py-1.5 rounded-md bg-rail text-fg text-[0.8rem] font-medium anim-fade max-w-64"
      style={{ left: tip.x, top: tip.y, transform: tip.side === 'right' ? 'translateY(-50%)' : 'translate(-50%, -100%)', boxShadow: 'var(--shadow-pop)' }}>
      {tip.text}
    </div>,
    document.body,
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 p-8 text-muted max-w-sm mx-auto">
      {icon && <div className="text-faint">{icon}</div>}
      <h3 className="font-display text-lg font-bold text-fg">{title}</h3>
      {body && <p className="text-sm leading-relaxed">{body}</p>}
      {action}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex items-center h-5 px-1.5 rounded border border-line bg-field text-[0.7rem] font-mono text-muted">{children}</kbd>;
}

export function Badge({ count }: { count: number }) {
  if (!count) return null;
  return <span className="min-w-4 h-4 px-1 rounded-full bg-danger text-white text-[0.68rem] font-bold grid place-items-center leading-none" aria-label={`${count} unread mentions`}>{count > 99 ? '99+' : count}</span>;
}
