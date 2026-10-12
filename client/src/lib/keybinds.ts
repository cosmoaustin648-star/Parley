import { getState, openModal } from './store.ts';
import { voice } from '../voice/engine.ts';
import { ackChannel } from './actions.ts';

export const DEFAULT_KEYBINDS = {
  toggle_mute: 'Ctrl+Shift+M',
  toggle_deafen: 'Ctrl+Shift+D',
  push_to_talk: '`',
  quick_switcher: 'Ctrl+K',
  mark_read: 'Escape',
};
export type KeybindAction = keyof typeof DEFAULT_KEYBINDS;
export const KEYBIND_LABELS: Record<KeybindAction, string> = {
  toggle_mute: 'Toggle mute',
  toggle_deafen: 'Toggle deafen',
  push_to_talk: 'Push to talk (hold)',
  quick_switcher: 'Open quick switcher',
  mark_read: 'Mark channel as read',
};

export function comboFromEvent(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && e.key.length > 1) parts.push('Shift');
  else if (e.shiftKey && /^[a-z]$/i.test(e.key)) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(key);
  return parts.join('+');
}

export function bindings() {
  return { ...DEFAULT_KEYBINDS, ...(getState().me?.settings.keybinds ?? {}) } as Record<KeybindAction, string>;
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.tagName === 'SELECT');
};

let installed = false;
export function installKeybinds() {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    if (!getState().me || (e.target as HTMLElement)?.dataset?.capturing) return;
    const combo = comboFromEvent(e);
    if (!combo) return;
    const b = bindings();
    const ptt = getState().me?.settings.voice?.input_mode === 'ptt';
    if (ptt && combo === b.push_to_talk && !isTyping(e.target)) { e.preventDefault(); voice.ptt(true); return; }
    if (combo === b.toggle_mute) { e.preventDefault(); voice.toggleMute(); return; }
    if (combo === b.toggle_deafen) { e.preventDefault(); voice.toggleDeafen(); return; }
    if (combo === b.quick_switcher || (combo === 'Meta+K' && b.quick_switcher === 'Ctrl+K')) { e.preventDefault(); openModal({ kind: 'quickSwitcher' }); return; }
    if (combo === 'Ctrl+/' || combo === 'Meta+/') { e.preventDefault(); openModal({ kind: 'shortcuts' }); return; }
    if (combo === b.mark_read && !getState().modal) {
      const r = getState().route;
      const id = r.name === 'server' ? r.channelId : r.name === 'home' ? r.dmId : undefined;
      if (id) ackChannel(id);
    }
  });
  window.addEventListener('keyup', (e) => {
    if (getState().me?.settings.voice?.input_mode !== 'ptt') return;
    const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const ptt = bindings().push_to_talk;
    if (ptt.split('+').pop() === key) voice.ptt(false);
  });
  window.addEventListener('blur', () => voice.ptt(false));
}
