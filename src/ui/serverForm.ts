// The form for a person's own sharing server address: paste it, check it, save it. Used when
// someone first shares a board, and in Settings, where the address stays hidden until asked for.
import { DEPLOY_URL, SETUP_GUIDE_URL, checkServer, saveMyServer } from '../sync/config';
import { normalizeServer } from '../sync/serverAddress';
import { h, textButton } from './dom';

export interface ServerFormOptions {
  /** The address saved now, if any. */
  current: string | null;
  /** Called once an address has been checked and saved (or removed: null). */
  onChange: (server: string | null) => void;
  /** Show a Cancel button (when changing an address rather than setting one up). */
  onCancel?: () => void;
  /** Show a button that forgets the saved address. */
  allowRemove?: boolean;
}

const link = (href: string, label: string) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'text-link' }, label);

/** The pieces of the form, ready to put in a dialog. */
export function serverForm(opts: ServerFormOptions): HTMLElement[] {
  const input = h('input', {
    class: 'text-input', type: 'text', value: opts.current ?? '', placeholder: 'https://megahard-collab.yourname.workers.dev',
    'aria-label': 'Your sharing server address', autocomplete: 'off', spellcheck: 'false',
  });
  const message = h('p', { class: 'server-message', role: 'status' });
  const save = textButton('Save address', () => void check(), 'btn primary');
  const say = (text: string, warn: boolean) => {
    message.textContent = text;
    message.className = `server-message${warn ? ' warn' : ''}`;
  };

  async function check() {
    const address = normalizeServer(input.value);
    if (!address) return say('That doesn’t look like a server address. It looks like https://something.workers.dev', true);
    save.disabled = true;
    say('Checking…', false);
    const result = await checkServer(address);
    save.disabled = false;
    if (result === 'not_ours') return say('That address answered, but it isn’t a Megahard Whiteboard server.', true);
    if (result === 'unreachable') {
      return say('Couldn’t reach that address. Check it’s right and the deploy has finished. If it is, your server may not allow this website yet: see the setup guide.', true);
    }
    saveMyServer(address);
    say('Saved.', false);
    opts.onChange(address);
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void check();
  });

  const buttons: HTMLElement[] = [];
  if (opts.onCancel) buttons.push(textButton('Cancel', opts.onCancel));
  if (opts.allowRemove && opts.current) {
    buttons.push(textButton('Forget this address', () => {
      saveMyServer(null);
      input.value = '';
      say('Forgotten. Boards you’re already sharing keep using the server they started on.', false);
      opts.onChange(null);
    }));
  }
  buttons.push(save);
  return [
    h('div', { class: 'dialog-buttons start' }, h('a', { href: DEPLOY_URL, target: '_blank', rel: 'noopener noreferrer', class: 'btn' }, 'Deploy my server')),
    h('label', { class: 'name-field' }, h('span', { class: 'field-label' }, 'Your server’s address'), input),
    message,
    h('p', { class: 'muted limit-note' }, 'Boards stay on your device. Your server holds a shared board only while it’s shared. ', link(SETUP_GUIDE_URL, 'Setup guide')),
    h('div', { class: 'dialog-buttons' }, ...buttons),
  ];
}

/** Where to type focus once the form is on screen. */
export const focusServerInput = (root: ParentNode) => root.querySelector<HTMLInputElement>('input[aria-label="Your sharing server address"]')?.focus();
