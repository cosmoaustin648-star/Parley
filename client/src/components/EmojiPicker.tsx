import { useMemo, useRef, useState } from 'react';
import { EMOJI, CATEGORIES, recentEmoji, pushRecent, searchEmoji } from '../lib/emoji.ts';
import { cx, inputCls } from './ui.tsx';

export function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hover, setHover] = useState<string | null>(null);
  const recent = useMemo(recentEmoji, []);
  const scroller = useRef<HTMLDivElement>(null);
  const results = q ? searchEmoji(q, 200) : null;
  const pick = (e: string, keepOpen = false) => { pushRecent(e); onPick(e); if (!keepOpen) onClose(); };
  const sections = results ? [{ cat: 'Results', items: results }] : [
    ...(recent.length ? [{ cat: 'Recently used', items: recent.map((e) => EMOJI.find((x) => x.e === e) ?? { e, name: '', words: '', cat: '' }) }] : []),
    ...CATEGORIES.map((cat) => ({ cat, items: EMOJI.filter((x) => x.cat === cat) })),
  ];
  return (
    <div className="w-[21rem] max-w-[92vw] flex flex-col h-96" onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' && results?.[0]) pick(results[0].e, e.shiftKey); }}>
      <div className="p-2 border-b border-line">
        <input autoFocus className={cx(inputCls, 'h-8 text-sm')} placeholder="Find an emoji" value={q} onChange={(e: any) => setQ(e.target.value)} aria-label="Search emoji" />
      </div>
      {!q && (
        <div className="flex gap-0.5 px-2 pt-1.5" role="tablist">
          {CATEGORIES.map((c) => (
            <button key={c} className="flex-1 h-7 rounded hover:bg-hover text-base" data-tip={c} aria-label={c}
              onClick={() => scroller.current?.querySelector(`[data-cat="${c}"]`)?.scrollIntoView({ block: 'start' })}>
              {EMOJI.find((x) => x.cat === c)?.e}
            </button>
          ))}
        </div>
      )}
      <div ref={scroller} className="flex-1 scroll p-2">
        {sections.map((s) => s.items.length > 0 && (
          <div key={s.cat} data-cat={s.cat}>
            <h3 className="text-xs font-semibold text-muted px-1 pt-2 pb-1 sticky top-0 bg-raised">{s.cat}</h3>
            <div className="grid grid-cols-8 gap-0.5">
              {s.items.map((x) => (
                <button key={s.cat + x.e} aria-label={x.name || x.e} onMouseEnter={() => setHover(x.name)} onFocus={() => setHover(x.name)}
                  onClick={(e: MouseEvent) => pick(x.e, e.shiftKey)} className="size-9 rounded-md hover:bg-hover text-[1.4rem] leading-none grid place-items-center">
                  {x.e}
                </button>
              ))}
            </div>
          </div>
        ))}
        {results && !results.length && <p className="text-sm text-muted p-4 text-center">No emoji match “{q}”.</p>}
      </div>
      <div className="h-9 px-3 border-t border-line text-xs text-muted flex items-center">{hover ? `:${hover}:` : 'Shift-click to pick several'}</div>
    </div>
  );
}
