import { icon, type IconName } from './icons';

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

/** Tiny element builder: h('button', { class: 'x', onclick: fn }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value' || k === 'checked' || k === 'hidden' || k === 'disabled' || k === 'multiple') (el as unknown as Props)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

export function iconButton(name: IconName, label: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: `icon-btn ${cls}`.trim(), type: 'button', title: label, 'aria-label': label }, icon(name));
  b.addEventListener('click', onClick);
  // Keep keyboard focus where it was when clicking with a mouse, so shortcuts keep working.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  return b;
}

export function textButton(label: string, onClick: () => void, cls = 'btn', iconName?: IconName): HTMLButtonElement {
  return h('button', { class: cls, type: 'button', onclick: onClick }, iconName ? icon(iconName) : null, label);
}

export const sep = () => h('div', { class: 'sep', role: 'separator' });

// ---------------------------------------------------------------- popovers

export type Placement = 'below' | 'below-end' | 'above' | 'right';

let current: { anchor: HTMLElement; close: () => void } | null = null;

export function closePopover() {
  const c = current;
  current = null;
  c?.close();
}

export function isPopoverFor(anchor: HTMLElement) {
  return current?.anchor === anchor;
}

export function openPopover(anchor: HTMLElement, content: HTMLElement, placement: Placement = 'below') {
  closePopover();
  const pop = h('div', { class: 'popover', role: 'dialog' }, content);
  document.body.append(pop);

  const a = anchor.getBoundingClientRect();
  const p = pop.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left: number, top: number;
  if (placement === 'right') {
    left = a.right + 10;
    top = a.top + a.height / 2 - p.height / 2;
  } else if (placement === 'above') {
    left = a.left + a.width / 2 - p.width / 2;
    top = a.top - p.height - 10;
  } else {
    left = placement === 'below-end' ? a.right - p.width : a.left + a.width / 2 - p.width / 2;
    top = a.bottom + 10;
    if (top + p.height > vh - 8) top = a.top - p.height - 10;
  }
  pop.style.left = `${Math.max(8, Math.min(left, vw - p.width - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(top, vh - p.height - 8))}px`;

  const onDown = (e: Event) => {
    const t = e.target as Node;
    if (!pop.contains(t) && !anchor.contains(t)) closePopover();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePopover();
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey);
  current = {
    anchor,
    close: () => {
      pop.remove();
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    },
  };
}

export function togglePopover(anchor: HTMLElement, build: () => HTMLElement, placement: Placement = 'below') {
  if (isPopoverFor(anchor)) closePopover();
  else openPopover(anchor, build(), placement);
}

// ---------------------------------------------------------------- pickers

export function swatchRow(colors: string[], active: string | null, onPick: (c: string) => void, names?: string[]): HTMLElement {
  const row = h('div', { class: 'swatches', role: 'radiogroup' });
  colors.forEach((c, i) => {
    const b = h('button', {
      class: `swatch${c.toLowerCase() === active?.toLowerCase() ? ' active' : ''}`,
      type: 'button',
      role: 'radio',
      'aria-checked': String(c.toLowerCase() === active?.toLowerCase()),
      'aria-label': names?.[i] ?? c,
      title: names?.[i] ?? c,
      style: { background: c },
    });
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      row.querySelectorAll('.swatch').forEach((s) => {
        s.classList.toggle('active', s === b);
        s.setAttribute('aria-checked', String(s === b));
      });
      onPick(c);
    });
    row.append(b);
  });
  return row;
}

export function segmented<T extends string>(options: [T, string][], active: T, onPick: (v: T) => void): HTMLElement {
  const row = h('div', { class: 'segmented', role: 'radiogroup' });
  for (const [value, label] of options) {
    const b = h('button', { class: value === active ? 'active' : '', type: 'button', role: 'radio', 'aria-checked': String(value === active) }, label);
    b.addEventListener('click', () => {
      row.querySelectorAll('button').forEach((x) => {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
      onPick(value);
    });
    row.append(b);
  }
  return row;
}

// ---------------------------------------------------------------- modal & toast

const openModals = new Set<() => void>();

/** Close every open dialog, e.g. when moving to another page of the app. */
export function closeAllModals() {
  [...openModals].reverse().forEach((close) => close());
}

export function showModal(title: string, body: Node, actions: HTMLElement[] = [], onClose?: () => void): () => void {
  closePopover();
  const previous = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openModals.delete(close);
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
    previous?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    // With dialogs stacked (e.g. Keyboard shortcuts over Settings), Escape closes only the top one.
    if (e.key === 'Escape' && isTopModal()) {
      e.stopImmediatePropagation();
      close();
    }
  };
  const card = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', {}, title), iconButton('close', 'Close', close)),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-actions' }, ...actions) : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop' }, card);
  const isTopModal = () => {
    const all = document.querySelectorAll('.modal-backdrop');
    return all[all.length - 1] === backdrop;
  };
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);
  openModals.add(close);
  document.addEventListener('keydown', onKey, true);
  (actions[actions.length - 1] ?? card.querySelector('button'))?.focus();
  return close;
}

export function confirmDialog(title: string, message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const cancelBtn = textButton('Cancel', () => close());
    const okBtn = textButton(okLabel, () => {
      ok = true;
      close();
    }, danger ? 'btn danger' : 'btn primary');
    const close = showModal(title, h('p', {}, message), [cancelBtn, okBtn], () => resolve(ok));
  });
}

export function toast(message: string, ms = 2800) {
  let wrap = document.querySelector<HTMLElement>('.toasts');
  if (!wrap) {
    wrap = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(wrap);
  }
  const t = h('div', { class: 'toast' }, message);
  wrap.append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 250);
  }, ms);
}
