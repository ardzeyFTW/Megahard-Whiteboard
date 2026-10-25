// A viewer's own board beside the shared one. While someone is a viewer of a shared board, the
// screen splits in two: the shared board (look, pick things out, copy) and a board of their own to
// write on. Their own board is an ordinary board on this device, never sent anywhere.
import type { BoardDoc } from '../types';
import { Editor } from '../editor/editor';
import { clipboardOwner, keyOwner, type Pane } from '../editor/paneRouting';
import { createEditorTools, type EditorTools } from './editorTools';
import { h, iconButton, segmented, showModal, sep, textButton, toast } from './dom';
import { boardLimitReached, boardFull, boardAlmostFull, storageFull } from './limitDialogs';
import { listBoards, listShares, loadBoard, loadGuestNotes, saveGuestNotes } from '../db';
import { getUsage, LIMITS } from '../limits';
import { isElectron } from '../version';
import { referencedAssets } from '../model';
import { defaultBackground, readPrefs, writePrefs } from '../prefs';
import { uid } from '../util';

export type ViewerLayout = 'side' | 'stacked';

/** The shared pane takes this share of the screen, within these bounds. */
const MIN_SPLIT = 25;
const MAX_SPLIT = 75;
/** Below this width there's no room for two boards: one shows at a time, with tabs. */
const NARROW = '(max-width: 700px)';
const NOTES_NAME = 'Notes';

export interface ViewerBoardOptions {
  /** The screen the boards are laid out in. */
  view: HTMLElement;
  /** The shared board's editor, view only. */
  shared: Editor;
  /** The settings bar: it stays in the screen's top right corner, not the shared pane's. */
  topRight: HTMLElement;
  roomId: string;
}

const readLayout = (): ViewerLayout => (readPrefs().viewerLayout === 'stacked' ? 'stacked' : 'side');
const readSplit = (): number => {
  const v = readPrefs().viewerSplit;
  return typeof v === 'number' && v >= MIN_SPLIT && v <= MAX_SPLIT ? v : 50;
};

interface Notes {
  doc: BoardDoc;
  ed: Editor;
  tools: EditorTools;
  host: HTMLElement;
  head: HTMLElement;
  /** Remove its buttons' listeners. */
  off: () => void;
}

export class ViewerBoard {
  private readonly view: HTMLElement;
  private readonly shared: Editor;
  private readonly topRight: HTMLElement;
  private readonly roomId: string;
  private original: Element[] = [];
  private paneShared: HTMLElement | null = null;
  private paneNotes: HTMLElement | null = null;
  private divider: HTMLElement | null = null;
  private tabs: HTMLElement | null = null;
  private lookBar: HTMLElement | null = null;
  private notes: Notes | null = null;
  private active: Pane = 'notes';
  private layout: ViewerLayout = readLayout();
  private split = readSplit();
  private narrow = window.matchMedia(NARROW);
  /** Which pane shows when the screen is too narrow for both. */
  private tab: Pane = 'shared';
  private cleanup: (() => void)[] = [];
  private opening: Promise<void> = Promise.resolve();
  /** The shared editor's tool before the split took it over, put back when the split closes. */
  private toolBefore: Editor['tool'] = 'pen';
  private listeners = new Set<() => void>();

  constructor(opts: ViewerBoardOptions) {
    this.view = opts.view;
    this.shared = opts.shared;
    this.topRight = opts.topRight;
    this.roomId = opts.roomId;
  }

  get splitting(): boolean {
    return this.paneShared !== null;
  }

  /** One board at a time, with tabs: the screen is too narrow for both. */
  get tabbed(): boolean {
    return this.splitting && this.narrow.matches;
  }

  get currentLayout(): ViewerLayout {
    return this.layout;
  }

  /** The viewer's own board's editor (for tests and tools), while split. */
  get notesEditor(): Editor | null {
    return this.notes?.ed ?? null;
  }

  onLayout(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  // ------------------------------------------------------------ who answers keys and copy/paste

  ownsKey(pane: Pane, e: KeyboardEvent): boolean {
    return !this.splitting || keyOwner(this.active, e) === pane;
  }

  ownsClipboard(pane: Pane, kind: 'copy' | 'cut' | 'paste'): boolean {
    return !this.splitting || clipboardOwner(this.active, kind, this.shared.selection.size > 0) === pane;
  }

  // ------------------------------------------------------------ enter and leave

  /**
   * Ask what to write on, then split the screen. Nothing changes until the viewer chooses, and
   * closing the question leaves things as they were.
   */
  async offer() {
    if (this.splitting) return;
    const remembered = await this.rememberedBoard();
    this.showPicker({ remembered, start: true, run: (open) => this.enterWith(open) });
  }

  /** Split the screen: the shared board stays as it is and the chosen board opens beside it. */
  private enterWith(open: () => Promise<void>) {
    if (this.splitting) return;
    this.enter();
    this.opening = open();
  }

  private enter() {
    this.original = [...this.view.children];
    const paneShared = h('div', { class: 'pane pane-shared' }, ...this.original.filter((el) => el !== this.topRight));
    const paneNotes = h('div', { class: 'pane pane-notes' });
    const divider = h('div', {
      class: 'split-divider', role: 'separator', tabindex: '0', title: 'Drag to resize. Double-click to reset.',
    });
    const tabs = h('div', { class: 'pane-tabs panel', role: 'tablist' });
    this.paneShared = paneShared;
    this.paneNotes = paneNotes;
    this.divider = divider;
    this.tabs = tabs;
    this.view.replaceChildren(tabs, paneShared, divider, paneNotes);
    this.view.classList.add('split');

    // The shared board can be looked at and picked from, never changed.
    this.toolBefore = this.shared.tool;
    this.shared.setCopyOnly(true);
    this.shared.setTool('hand');
    this.lookBar = this.buildLookBar();
    paneShared.append(this.lookBar);

    const mark = (pane: Pane) => () => {
      this.active = pane;
      this.paintActive();
    };
    for (const [el, pane] of [[paneShared, 'shared'], [paneNotes, 'notes']] as const) {
      el.addEventListener('pointerdown', mark(pane), true);
      el.addEventListener('focusin', mark(pane));
    }
    this.wireDivider(divider);
    const onNarrow = () => this.applyLayout();
    this.narrow.addEventListener('change', onNarrow);
    this.cleanup.push(() => this.narrow.removeEventListener('change', onNarrow));
    this.cleanup.push(this.shared.onChange(this.updateLookBar));
    this.applyLayout();
    this.paintActive();
    // The shared board has less room now: measure it, and fit what's on it into that room.
    this.shared.relayout();
    this.shared.zoomToFit(false);
  }

  /** Back to one board (the viewer became an editor): their own board is saved and put away. */
  async leave() {
    if (!this.splitting) return;
    await this.opening;
    this.shared.setCopyOnly(false);
    this.shared.clearSelection();
    this.shared.setTool(this.toolBefore);
    await this.closeNotes();
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    this.view.classList.remove('split', 'tabbed');
    this.view.removeAttribute('data-layout');
    this.view.style.removeProperty('--split');
    this.view.replaceChildren(...this.original);
    this.paneShared = this.paneNotes = this.divider = this.tabs = this.lookBar = null;
    this.listeners.forEach((fn) => fn());
  }

  async destroy() {
    await this.leave();
    this.listeners.clear();
  }

  // ------------------------------------------------------------ layout

  setLayout(layout: ViewerLayout) {
    if (layout === this.layout) return;
    this.layout = layout;
    writePrefs({ viewerLayout: layout });
    this.applyLayout();
  }

  private applyLayout() {
    const view = this.view;
    const tabbed = this.narrow.matches;
    view.classList.toggle('tabbed', tabbed);
    view.dataset.layout = this.layout;
    view.style.setProperty('--split', `${this.split}%`);
    // The settings bar sits in the screen's corner, over whichever board is there. With tabs it's
    // part of the shared board instead, so it goes away with it rather than covering the other tab.
    const home = tabbed ? this.paneShared : view;
    if (home && this.topRight.parentElement !== home) home.append(this.topRight);
    if (this.paneShared) this.paneShared.hidden = tabbed && this.tab !== 'shared';
    if (this.paneNotes) this.paneNotes.hidden = tabbed && this.tab !== 'notes';
    if (this.divider) {
      this.divider.hidden = tabbed;
      this.divider.setAttribute('aria-orientation', this.layout === 'side' ? 'vertical' : 'horizontal');
      this.divider.setAttribute('aria-valuenow', String(Math.round(this.split)));
    }
    this.paintTabs();
    this.updateLookBar();
    // Both boards have new room: measure it now rather than on the next frame.
    this.shared.relayout();
    this.notes?.ed.relayout();
    this.listeners.forEach((fn) => fn());
  }

  private paintActive() {
    this.paneShared?.classList.toggle('active', this.active === 'shared');
    this.paneNotes?.classList.toggle('active', this.active === 'notes');
  }

  private paintTabs() {
    const tabs = this.tabs;
    if (!tabs) return;
    tabs.replaceChildren(...([['shared', 'Lecture'], ['notes', 'My board']] as const).map(([pane, label]) => {
      const b = h('button', { class: `tab${this.tab === pane ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(this.tab === pane) }, label);
      b.addEventListener('click', () => this.showTab(pane));
      return b;
    }));
  }

  private showTab(pane: Pane) {
    this.tab = pane;
    this.active = pane;
    this.applyLayout();
    this.paintActive();
  }

  private wireDivider(divider: HTMLElement) {
    const set = (percent: number, save: boolean) => {
      this.split = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, percent));
      this.view.style.setProperty('--split', `${this.split}%`);
      divider.setAttribute('aria-valuenow', String(Math.round(this.split)));
      if (save) writePrefs({ viewerSplit: this.split });
    };
    const at = (e: PointerEvent) => {
      const r = this.view.getBoundingClientRect();
      return this.layout === 'side' ? ((e.clientX - r.left) / r.width) * 100 : ((e.clientY - r.top) / r.height) * 100;
    };
    divider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        divider.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
      this.view.classList.add('resizing');
      const move = (ev: PointerEvent) => set(at(ev), false);
      const up = () => {
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', up);
        divider.removeEventListener('pointercancel', up);
        this.view.classList.remove('resizing');
        set(this.split, true);
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up);
      divider.addEventListener('pointercancel', up);
    });
    divider.addEventListener('dblclick', () => set(50, true));
    divider.addEventListener('keydown', (e) => {
      const back = this.layout === 'side' ? 'ArrowLeft' : 'ArrowUp';
      const forward = this.layout === 'side' ? 'ArrowRight' : 'ArrowDown';
      if (e.key !== back && e.key !== forward) return;
      e.preventDefault();
      set(this.split + (e.key === forward ? 2 : -2), true);
    });
  }

  // ------------------------------------------------------------ the shared pane's own tools

  private updateLookBar = () => {
    const bar = this.lookBar;
    if (!bar) return;
    const selecting = this.shared.tool === 'select';
    bar.querySelector('[data-look="hand"]')?.classList.toggle('active', !selecting);
    bar.querySelector('[data-look="select"]')?.classList.toggle('active', selecting);
    const copy = bar.querySelector<HTMLButtonElement>('[data-look="copy"]');
    if (copy) {
      const n = this.shared.selection.size;
      copy.disabled = n === 0;
      copy.lastChild!.textContent = n > 1 ? `Copy ${n} items to my board` : 'Copy to my board';
    }
  };

  private buildLookBar(): HTMLElement {
    const hand = iconButton('hand', 'Move around (hold Space to move around while selecting)', () => this.shared.setTool('hand'));
    hand.dataset.look = 'hand';
    const select = iconButton('pointer', 'Select things to copy: click, or drag a box', () => this.shared.setTool('select'));
    select.dataset.look = 'select';
    const copy = textButton('Copy to my board', () => void this.copyToNotes(), 'btn primary', 'copy');
    copy.dataset.look = 'copy';
    return h('div', { class: 'panel look-bar', role: 'toolbar', 'aria-label': 'Shared board' }, hand, select, sep(), copy);
  }

  /** Put copies of what's selected on the shared board into the viewer's own board. */
  private async copyToNotes() {
    await this.opening;
    const notes = this.notes;
    const els = this.shared.selectedEls();
    if (!notes || !els.length) return;
    await notes.ed.importElements(els, referencedAssets(els, this.shared.doc.assets));
    toast(els.length === 1 ? 'Copied to your board' : `Copied ${els.length} items to your board`);
    this.shared.clearSelection();
    if (this.narrow.matches) this.showTab('notes');
  }

  // ------------------------------------------------------------ the viewer's own board

  /** The board this viewer used last time for this room, if it's still there. */
  private async rememberedBoard(): Promise<BoardDoc | undefined> {
    try {
      const id = await loadGuestNotes(this.roomId);
      return id ? await loadBoard(id) : undefined;
    } catch {
      return undefined;
    }
  }

  private blankBoard(): BoardDoc {
    const now = Date.now();
    return {
      version: 1, id: uid(), name: NOTES_NAME, createdAt: now, updatedAt: now,
      background: defaultBackground(), elements: [], assets: {}, camera: { x: 0, y: 0, zoom: 1 },
    };
  }

  /**
   * Show a board in the own-board pane. A new board only joins the viewer's list once something
   * is drawn on it, so opening a link and leaving doesn't leave empty boards behind.
   */
  private async openNotes(doc: BoardDoc, isNew: boolean) {
    await this.closeNotes();
    const pane = this.paneNotes;
    if (!pane) return;
    let kept = !isNew;
    let canKeep = true;
    if (isNew && !isElectron) {
      const usage = await getUsage().catch(() => null);
      if (usage && usage.boards >= LIMITS.maxBoards) {
        canKeep = false;
        boardLimitReached(usage);
      }
    }
    if (!this.splitting) return;

    const host = h('div', { class: 'canvas-host' });
    pane.prepend(host);
    const ed: Editor = new Editor(host, doc, {
      acceptKey: (e) => this.ownsKey('notes', e),
      acceptClipboard: (kind) => this.ownsClipboard('notes', kind),
      shouldSave: () => {
        if (kept) return true;
        if (!canKeep || !ed.elements.length) return false;
        kept = true;
        if (doc.name === NOTES_NAME && this.shared.doc.name) doc.name = `${NOTES_NAME}: ${this.shared.doc.name}`.slice(0, 120);
        void saveGuestNotes(this.roomId, doc.id).catch(() => undefined);
        head.querySelector<HTMLInputElement>('.board-name')!.value = doc.name;
        return true;
      },
    });
    ed.onError = (message) => toast(message);
    ed.onLimit = (event) => {
      if (event.kind === 'boardFull') boardFull();
      else if (event.kind === 'boardAlmostFull') boardAlmostFull(event.bytes);
      else storageFull(event.usage);
    };
    if (import.meta.env.DEV) Object.assign(window, { __notes: ed });

    const tools = createEditorTools(ed, pane);
    const name = h('input', { class: 'board-name', type: 'text', value: doc.name, 'aria-label': 'Your board’s name', maxlength: 120, spellcheck: 'false' });
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') name.value = doc.name;
      if (e.key === 'Enter' || e.key === 'Escape') name.blur();
    });
    name.addEventListener('change', () => {
      ed.rename(name.value.trim() || NOTES_NAME);
      name.value = doc.name;
    });
    const undo = iconButton('undo', 'Undo (Ctrl+Z)', () => ed.undo());
    const redo = iconButton('redo', 'Redo (Ctrl+Y)', () => ed.redo());
    const switcher = textButton('My boards', () => this.pickBoard(), 'btn');
    switcher.title = 'Start a new board, or open one of your boards, beside the shared one';
    const closeBtn = iconButton('close', 'Close my board: back to the shared board only. Your board stays saved.', () => void this.leave());
    const head = h('div', { class: 'panel notes-head' }, name, sep(), undo, redo, sep(), switcher, closeBtn);
    const paintHistory = () => {
      undo.disabled = !ed.canUndo;
      redo.disabled = !ed.canRedo;
      if (document.activeElement !== name) name.value = doc.name;
    };
    const off = ed.onChange(paintHistory);
    paintHistory();
    pane.append(head, tools.dock, tools.zoomBar, tools.selBar, tools.imageInput);
    this.notes = { doc, ed, tools, host, head, off };
    ed.zoomToFit(false);
  }

  private async closeNotes() {
    const notes = this.notes;
    if (!notes) return;
    this.notes = null;
    notes.off();
    notes.tools.destroy();
    await notes.ed.destroy();
    notes.host.remove();
    notes.head.remove();
    for (const el of [notes.tools.dock, notes.tools.zoomBar, notes.tools.selBar, notes.tools.imageInput]) el.remove();
  }

  /** Switch the own-board pane to a new board or one of the viewer's boards. */
  private pickBoard() {
    this.showPicker({ start: false, run: (open) => void (this.opening = open()) });
  }

  /**
   * The question: a new board, the one used last time, or one of their boards. `run` is given what
   * to do for the choice made. Closing the dialog without choosing does nothing.
   */
  private async showPicker(opts: { remembered?: BoardDoc; start: boolean; run: (open: () => Promise<void>) => void }) {
    const [boards, shares] = await Promise.all([listBoards(), listShares().catch(() => [])]);
    // A board the viewer is sharing themself can't be used here: it's busy with its own room.
    const sharing = new Set(shares.map((s) => s.boardId));
    const current = this.notes?.doc.id;
    const list = h('div', { class: 'board-picker' });
    const close = showModal(opts.start ? 'A board of your own' : 'Your board beside this one', list, [textButton('Cancel', () => close())]);
    const choose = (open: () => Promise<void>) => () => {
      close();
      opts.run(open);
    };
    if (opts.start) list.append(h('p', {}, 'Write along beside the shared board. Your board is kept on this device, and you can copy things from the shared board into it.'));
    list.append(textButton('New blank board', choose(() => this.openNotes(this.blankBoard(), true)), 'btn primary', 'plus'));
    if (opts.remembered) {
      const doc = opts.remembered;
      list.append(textButton(`Continue “${doc.name}”`, choose(() => this.openNotes(doc, false)), 'btn'));
    }
    const others = boards.filter((b) => b.id !== current && b.id !== opts.remembered?.id && !sharing.has(b.id));
    list.append(h('p', { class: 'muted' }, others.length ? 'Or keep writing on one you already have:' : 'You have no other boards yet.'));
    for (const b of others) {
      list.append(h('button', {
        class: 'menu-item two-line', type: 'button',
        onclick: choose(async () => {
          const doc = await loadBoard(b.id);
          if (!doc) return void toast('That board could not be opened');
          await saveGuestNotes(this.roomId, doc.id).catch(() => undefined);
          await this.openNotes(doc, false);
        }),
      }, h('strong', {}, b.name), h('span', {}, `Edited ${new Date(b.updatedAt).toLocaleString()}`)));
    }
  }
}

/** Choose how the two boards sit: for the Settings dialog. */
export function layoutChoice(viewer: ViewerBoard): HTMLElement {
  return segmented<ViewerLayout>([['side', 'Side by side'], ['stacked', 'Top and bottom']], viewer.currentLayout, (l) => viewer.setLayout(l));
}
