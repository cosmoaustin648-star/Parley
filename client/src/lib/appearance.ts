import type { Settings } from './types.ts';
import { readableInk } from './format.ts';

const LEGACY: Record<string, string> = { dark: 'harbor', darker: 'deep', light: 'daylight' };

/** Apply appearance & accessibility settings to <html> (CSS variables and data attributes). */
export function applyAppearance(s: Settings) {
  const root = document.documentElement;
  const theme = LEGACY[s.theme ?? ''] ?? s.theme ?? 'harbor';
  root.dataset.theme = theme;
  root.dataset.font = s.font ?? 'default';
  root.dataset.compact = String(!!s.compact);
  root.dataset.motion = s.reduced_motion ? 'reduced' : 'full';
  root.dataset.contrast = s.high_contrast ? 'high' : 'normal';
  root.dataset.underlineLinks = String(!!s.underline_links);
  root.style.setProperty('--font-scale', `${s.font_scale ?? 16}px`);
  root.style.setProperty('--msg-gap', `${s.message_spacing ?? (s.compact ? 4 : 16)}px`);
  if (s.accent) {
    root.style.setProperty('--c-accent', s.accent);
    root.style.setProperty('--c-accent-ink', readableInk(s.accent));
  } else {
    root.style.removeProperty('--c-accent');
    root.style.removeProperty('--c-accent-ink');
  }
  const sat = s.saturation ?? 100;
  root.style.setProperty('--app-filter', sat < 100 ? `saturate(${sat / 100})` : 'none');
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', getComputedStyle(root).getPropertyValue('--c-rail').trim() || '#0E1420');
}
