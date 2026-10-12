// Preferences shared by every board on this device: pens, tools, shortcuts, the default background...
import type { Background, Pattern } from './types';

const KEY = 'megahard:prefs';
const PATTERNS: Pattern[] = ['none', 'grid', 'dots', 'gridDots'];
const FALLBACK_BACKGROUND: Background = { color: '#ffffff', pattern: 'dots' };

export function readPrefs(): Record<string, any> {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

/** Merge into the saved preferences, keeping anything not mentioned. */
export function writePrefs(patch: Record<string, unknown>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readPrefs(), ...patch }));
  } catch {
    /* storage unavailable */
  }
}

/** The background new boards start with: whatever was picked last. */
export function defaultBackground(): Background {
  const b = readPrefs().background;
  if (b && typeof b.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.color) && PATTERNS.includes(b.pattern)) {
    return { color: b.color, pattern: b.pattern };
  }
  return { ...FALLBACK_BACKGROUND };
}
