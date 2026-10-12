import type { BoardDoc, Pattern } from '../types';
import { Editor, KEY_ACTIONS, RESERVED_KEYS, keyLabel, normalizeKey, type KeyAction } from '../editor/editor';
import {
  closePopover, h, iconButton, segmented, sep, showModal, swatchRow, textButton, toast, togglePopover, type Placement,
} from './dom';
import { icon, type IconName } from './icons';
import type { ImageQuality } from '../image';
import { followAfterClick, type FollowMode } from '../editor/followView';
import { BACKGROUNDS } from '../palette';
import { FILE_EXT, boardFileBlob, saveBlob } from '../io';
import { isTypingTarget, safeFileName } from '../util';
import { createEditorTools } from './editorTools';
import { ViewerBoard, layoutChoice } from './viewerBoard';
import { serverForm } from './serverForm';
import { myServer } from '../sync/config';
import { boardAlmostFull, boardFull, storageFull } from './limitDialogs';
import { setupCollab, type Collab, type CollabOptions } from './collab';
import { saveGuestCache, saveYState } from '../db';

// Shortcuts that can't be changed. Tool keys are configurable in Settings.
const FIXED_SHORTCUTS: [string, string][] = [
  ['Shift + draw', 'Straight line (pen or highlighter); snaps while held, stays straight after release'],
  ['Double-click', 'Edit a note or text / add text'],
  ['Space + drag', 'Pan (or middle mouse, or two fingers)'],
  ['Ctrl + wheel', 'Zoom (or pinch)'],
  ['Ctrl + = / -', 'Zoom in / out'],
  ['Ctrl + 0', 'Zoom to 100%'],
  ['Shift + 1', 'Zoom to fit'],
  ['Ctrl + Z', 'Undo'],
  ['Ctrl + Y / Ctrl + Shift + Z', 'Redo'],
  ['Ctrl + A', 'Select all'],
  ['Ctrl + C / X / V', 'Copy / cut / paste (images too)'],
  ['Ctrl + D', 'Duplicate'],
  ['Delete', 'Delete selection'],
  ['Arrow keys', 'Nudge (Shift for bigger steps)'],
  ['Enter', 'Edit selected note or text'],
  ['Esc / Ctrl + Enter', 'Finish editing text'],
  ['?', 'Open settings'],
];

export interface BoardOptions extends CollabOptions {
  /** Saved Yjs document: for a shared board, or a guest's cached copy. */
  ystate?: Uint8Array;
}

export function mountBoard(root: HTMLElement, doc: BoardDoc, opts: BoardOptions = {}): () => Promise<void> {
  const host = h('div', { class: 'canvas-host' });
  const view = h('div', { class: 'board-view' }, host);
  root.append(view);
  const guest = opts.guest ?? null;
  let collab: Collab | null = null;
  // A viewer gets their own board beside the shared one (see viewerBoard.ts).
  let viewer: ViewerBoard | null = null;
  let wasViewer = false;
  const ed = new Editor(host, doc, {
    ystate: opts.ystate,
    guest: !!guest,
    // Beside the viewer's own board, keys and copy/paste belong to whichever board should answer.
    acceptKey: (e) => !viewer || viewer.ownsKey('shared', e),
    acceptClipboard: (kind) => !viewer || viewer.ownsClipboard('shared', kind),
    // Shared boards keep their Yjs document so changes made by others while away merge correctly.
    saveYState: guest
      ? (state) => saveGuestCache(guest.roomId, state)
      : (state) => (collab?.keepsYState() ? saveYState(doc.id, state) : Promise.resolve()),
  });
  if (guest) ed.setReadOnly(true);
  // Development builds only: lets automated tests reach the editor. Removed from the published app.
  if (import.meta.env.DEV) Object.assign(window, { __editor: ed });
  ed.onError = (message) => toast(message);
  ed.onLimit = (event) => {
    if (event.kind === 'boardFull') boardFull();
    else if (event.kind === 'boardAlmostFull') boardAlmostFull(event.bytes);
    else storageFull(event.usage);
  };
  document.title = `${doc.name} · Megahard Whiteboard`;
  const tools = createEditorTools(ed, view);

  const popoverButton = (anchor: () => HTMLElement, build: () => HTMLElement, placement: Placement = 'below') =>
    () => togglePopover(anchor(), build, placement);

  // ------------------------------------------------------------ top left: navigation
  const nameInput = h('input', { class: 'board-name', type: 'text', value: doc.name, 'aria-label': 'Board name', maxlength: 120, spellcheck: 'false', readonly: !!guest });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') nameInput.value = doc.name;
    if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur();
  });
  nameInput.addEventListener('change', () => {
    ed.rename(nameInput.value.trim() || 'Untitled board');
    nameInput.value = doc.name;
    document.title = `${doc.name} · Megahard Whiteboard`;
  });
  const undoBtn = iconButton('undo', 'Undo (Ctrl+Z)', () => ed.undo());
  const redoBtn = iconButton('redo', 'Redo (Ctrl+Y)', () => ed.redo());
  const undoSep = sep();
  const topLeft = h('div', { class: 'panel top-left' },
    iconButton('home', guest ? 'Leave board' : 'All boards', () => (location.hash = '#/')), nameInput, undoSep, undoBtn, redoBtn);

  // ------------------------------------------------------------ top right: export & menu
  async function exportPng() {
    closePopover();
    try {
      const blob = await ed.exportPNG();
      if (!blob) {
        toast('Nothing to export yet. Draw something first.');
        return;
      }
      await saveBlob(blob, `${safeFileName(doc.name)}.png`);
    } catch (err) {
      console.error(err);
      toast('Export failed');
    }
  }

  async function saveFile() {
    closePopover();
    await ed.flushSave(false);
    await saveBlob(boardFileBlob(doc), `${safeFileName(doc.name)}${FILE_EXT}`);
  }

  const menuItem = (name: IconName, label: string, run: () => void) =>
    h('button', { class: 'menu-item', type: 'button', onclick: () => { closePopover(); run(); } }, icon(name), label);

  // Guests can't change the owner's background, or save or export the board: only the owner keeps it.
  const menuBtn: HTMLButtonElement = iconButton('more', 'Menu', popoverButton(() => menuBtn, () =>
    h('div', { class: 'pop-section menu' },
      ...(guest ? [] : [
        h('div', { class: 'pop-label' }, 'Background'),
        swatchRow(BACKGROUNDS.map((b) => b.color), doc.background.color, (color) => ed.setBackground({ color }), BACKGROUNDS.map((b) => b.name)),
        segmented<Pattern>([['none', 'Plain'], ['grid', 'Grid'], ['dots', 'Dots'], ['gridDots', 'Grid + dots']], doc.background.pattern, (pattern) => ed.setBackground({ pattern })),
        h('hr'),
        menuItem('download', 'Export as image (PNG)', () => void exportPng()),
        menuItem('file', `Save board file (${FILE_EXT})`, () => void saveFile()),
      ]),
      menuItem('fit', 'Zoom to fit', () => ed.zoomToFit()),
      menuItem('settings', 'Settings', showSettings),
      menuItem('info', 'About Megahard Whiteboard', showAbout)), 'below-end'));
  // Viewers: follow the owner's view, and open a board of their own beside the shared one (only if they want to).
  let followNoticeShown = false;
  // The zoom buttons are hidden on screens this narrow (see styles.css), except beside a viewer's own board.
  const smallScreen = window.matchMedia('(max-width: 900px)');
  const onSmallScreen = () => update();
  smallScreen.addEventListener('change', onSmallScreen);
  // Click: follow, or match the owner's zoom again after zooming, or stop. Zooming keeps following their place (lighter);
  // moving around or picking something stops it.
  const followBtn = iconButton('eye', 'Follow the owner’s view', () => ed.setFollowMode(followAfterClick(ed.followMode)));
  followBtn.hidden = true;
  const FOLLOW_TITLES: Record<FollowMode, string> = {
    off: 'Follow the owner’s view',
    locked: 'Following the owner’s view. Click to stop.',
    position: 'Following where the owner is looking, at your zoom. Click to match their zoom too.',
  };
  const sideBtn = h('button', { class: 'btn side-btn', type: 'button', title: 'Open a board of your own beside the shared one', hidden: true },
    icon('splitSide'), h('span', {}, 'My board'));
  sideBtn.addEventListener('click', () => void viewer?.offer());
  sideBtn.addEventListener('mousedown', (e) => e.preventDefault());
  // Moving around or picking something means you're looking around on your own now.
  ed.onFollowEnd = () => {
    if (!followNoticeShown) {
      followNoticeShown = true;
      toast('You’re looking around on your own. Press the eye button to follow the owner again.', 5000);
    }
  };
  const topRight = h('div', { class: 'panel top-right' },
    guest ? null : iconButton('download', 'Export as image', () => void exportPng()), followBtn, sideBtn, iconButton('settings', 'Settings (?)', showSettings), menuBtn);
  if (guest) {
    viewer = new ViewerBoard({ view, shared: ed, topRight, roomId: guest.roomId });
    viewer.onLayout(() => update());
  }

  // ------------------------------------------------------------ dialogs
  function showSettings() {
    const dynamic = h('input', { type: 'checkbox', class: 'switch', checked: ed.dynamicInk });
    dynamic.addEventListener('change', () => ed.setDynamicInk(dynamic.checked));

    showModal('Settings', h('div', { class: 'settings' },
      viewer?.splitting ? h('h3', {}, 'Viewing') : null,
      viewer?.splitting ? h('div', { class: 'setting-row' },
        h('span', {}, h('strong', {}, 'Layout'), h('small', {}, 'Where your own board sits next to the shared one.')),
        layoutChoice(viewer)) : null,
      h('h3', {}, 'Drawing'),
      h('label', { class: 'setting-row' },
        h('span', {}, h('strong', {}, 'Dynamic line thickness'),
          h('small', {}, 'Lines get thinner when you draw fast with a mouse or finger, or press lightly with a stylus. Turn off for an even width.')),
        dynamic),
      h('h3', {}, 'Images'),
      h('div', { class: 'setting-row' },
        h('span', {}, h('strong', {}, 'Image quality'),
          h('small', {}, 'Standard shrinks pictures to save space, with a little less detail when zoomed in. High keeps every pixel exactly as it was, but uses much more space. Hidden camera and location details are removed either way. Applies to images you add from now on.')),
        segmented<ImageQuality>([['standard', 'Standard'], ['high', 'High (lossless)']], ed.imageQuality, (q) => ed.setImageQuality(q))),
      h('h3', {}, 'Sharing'),
      sharingServerSetting(),
      h('h3', {}, 'Keyboard'),
      h('div', { class: 'setting-row' },
        h('span', {}, h('strong', {}, 'Keyboard shortcuts'),
          h('small', {}, 'Change the keys for tools and see every shortcut.')),
        textButton('Edit', showShortcuts, 'btn', 'keyboard')),
    ));
  }

  /**
   * The person's own sharing server. Its address is private (anyone who has it could use their
   * server), so it stays out of sight until they open this, and isn't even put on the page before that.
   */
  function sharingServerSetting() {
    const status = h('small', {});
    const details = h('details', { class: 'secret-details' }, h('summary', {}, 'Show or change the server address'));
    const paintStatus = () => (status.textContent = myServer()
      ? 'Set up. Boards you share use your own server. The address is hidden until you open the section below.'
      : 'Not set up yet. You need a server of your own to share a board.');
    let filled = false;
    const fill = () => {
      details.querySelectorAll(':scope > :not(summary)').forEach((e) => e.remove());
      details.append(h('div', { class: 'secret-body' },
        h('p', { class: 'muted' }, 'Keep this address to yourself: anyone who has it could create boards on your server. Boards you’re already sharing keep using the server they started on.'),
        ...serverForm({
          current: myServer(),
          allowRemove: true,
          onChange: (address) => {
            paintStatus();
            toast(address ? 'Sharing server saved' : 'Sharing server forgotten');
            fill();
          },
        })));
    };
    // Built when it's opened, and thrown away when it's closed.
    details.addEventListener('toggle', () => {
      if (details.open && !filled) {
        filled = true;
        fill();
      } else if (!details.open) {
        filled = false;
        details.querySelectorAll(':scope > :not(summary)').forEach((e) => e.remove());
      }
    });
    paintStatus();
    return h('div', { class: 'setting-block' }, h('strong', {}, 'Your sharing server'), status, details);
  }

  // Opens on top of Settings.
  function showShortcuts() {
    // Tool key bindings: click a key, then press the new one.
    const rows = h('div', { class: 'keybinds' });
    let stopListening: (() => void) | null = null;
    const renderRows = (listening: KeyAction | null = null) => {
      rows.replaceChildren(...KEY_ACTIONS.map((a) => {
        const btn = h('button', { class: `key-btn${a.id === listening ? ' listening' : ''}`, type: 'button', 'aria-label': `Change key for ${a.label}` },
          a.id === listening ? 'Press a key…' : h('kbd', {}, keyLabel(ed.keys[a.id])));
        btn.addEventListener('click', () => listen(a.id));
        return h('div', { class: 'keybind-row' }, h('span', {}, a.label), btn);
      }));
    };
    const listen = (action: KeyAction) => {
      stopListening?.();
      renderRows(action);
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        stop();
        const k = normalizeKey(e.key);
        if (k === 'escape') return renderRows();
        if (e.ctrlKey || e.metaKey || e.altKey || RESERVED_KEYS.has(k)) {
          toast(`${keyLabel(e.key)} is already used for something else and can't be assigned`);
          return renderRows();
        }
        const previous = KEY_ACTIONS.find((x) => x.id !== action && ed.keys[x.id] === k);
        ed.setKeyBinding(action, k);
        if (previous) toast(`${keyLabel(k)} was used by "${previous.label}", which now has no key`);
        renderRows();
      };
      const stop = () => {
        window.removeEventListener('keydown', onKey, true);
        stopListening = null;
      };
      window.addEventListener('keydown', onKey, true);
      stopListening = stop;
    };
    renderRows();

    const fixed = h('dl', { class: 'shortcuts' });
    for (const [k, v] of FIXED_SHORTCUTS) fixed.append(h('dt', {}, h('kbd', {}, k)), h('dd', {}, v));

    showModal('Keyboard shortcuts', h('div', { class: 'settings' },
      h('h3', {}, 'Tool shortcuts'),
      h('p', { class: 'muted' }, 'Click a key, then press the key you want to use instead.'),
      rows,
      textButton('Reset to defaults', () => {
        stopListening?.();
        ed.resetKeyBindings();
        renderRows();
      }),
      h('h3', {}, 'Other shortcuts'),
      fixed,
    ), [], () => stopListening?.());
  }

  function showAbout() {
    showModal('About Megahard Whiteboard', h('div', { class: 'about' },
      h('p', {}, 'Megahard Whiteboard is a whiteboard that keeps your data with you. Your boards are stored in this browser on this device. Nothing is uploaded unless you share a board: then your own sharing server (a free Cloudflare account that you set up) keeps a copy while it’s shared, and deletes it at most 7 days after.'),
      h('p', {}, 'When you join someone’s board as a viewer, you get a board of your own beside it to write on. It stays on your device, and you can copy things from theirs into it.'),
      h('p', {}, `To move boards between devices or keep a backup, use "Save board file" here or "Back up all" on the home screen, then import the ${FILE_EXT} file wherever you need it.`),
      h('p', { class: 'muted' }, 'Megahard Whiteboard is an independent project. It is not affiliated with or endorsed by Microsoft.')));
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === '?' && !isTypingTarget(e.target) && !document.querySelector('.modal-backdrop')) {
      e.preventDefault();
      showSettings();
    }
  };
  window.addEventListener('keydown', onKey);

  // ------------------------------------------------------------ sync UI with editor
  function update() {
    // The name can change from elsewhere: undo, or someone else on a shared board.
    if (document.activeElement !== nameInput) nameInput.value = doc.name;
    document.title = `${doc.name} · Megahard Whiteboard`;
    undoSep.hidden = undoBtn.hidden = redoBtn.hidden = ed.readOnly;
    undoBtn.disabled = !ed.canUndo;
    redoBtn.disabled = !ed.canRedo;
    if (viewer && collab) {
      const isViewer = collab.isViewer();
      // The side board is the viewer's choice (the "My board" button). It goes away if they become an editor.
      if (!isViewer && viewer.splitting) void viewer.leave();
      sideBtn.hidden = !isViewer || viewer.splitting;
      followBtn.hidden = !isViewer;
      // The eye sits with the zoom buttons. Where those are hidden (small screens) it's in the top bar instead.
      const zoomShown = viewer.splitting ? !viewer.tabbed : !smallScreen.matches;
      const home = zoomShown ? tools.zoomBar : topRight;
      if (followBtn.parentElement !== home) {
        if (home === topRight) topRight.insertBefore(followBtn, sideBtn);
        else home.append(followBtn);
      }
      const mode = ed.followMode;
      followBtn.classList.toggle('active', mode === 'locked');
      followBtn.classList.toggle('loose', mode === 'position');
      followBtn.setAttribute('aria-pressed', mode === 'off' ? 'false' : mode === 'locked' ? 'true' : 'mixed');
      followBtn.title = FOLLOW_TITLES[mode];
      // Viewers start out following where the owner is looking.
      if (isViewer !== wasViewer) {
        wasViewer = isViewer;
        ed.setFollowMode(isViewer ? 'locked' : 'off', true);
      }
    }
  }

  collab = setupCollab(ed, doc, opts, () => update());
  if (collab.button) topRight.prepend(collab.button, sep());
  ed.onChange(update);

  view.append(topLeft, topRight, collab.banner, tools.dock, tools.zoomBar, tools.selBar, tools.imageInput);
  update();

  return async () => {
    closePopover();
    window.removeEventListener('keydown', onKey);
    smallScreen.removeEventListener('change', onSmallScreen);
    await viewer?.destroy();
    tools.destroy();
    await ed.destroy();
    collab?.destroy();
    view.remove();
  };
}
