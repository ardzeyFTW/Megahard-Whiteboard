import type { BoardMeta } from '../types';
import {
  backfillSizes, deleteBoard, duplicateBoard, listBoards, listShares, loadAllBoards, loadBoard, loadShare, renameBoard, requestPersistence, saveBoard, storageInfo,
} from '../db';
import { collectClosedRooms } from '../sync/collect';
import { removeRoom } from '../sync/connection';
import { LIMITS, getUsage, type Usage } from '../limits';
import { estimateDocBytes } from '../storageFormat';
import { boardLimitReached, storageAlmostFull, storageFull, usageMeter } from './limitDialogs';
import { newBoardDoc } from '../model';
import { FILE_ACCEPT, FILE_EXT, backupBlob, boardFileBlob, parseImport, saveBlob } from '../io';
import { makeThumbnail } from '../render';
import { relativeTime, safeFileName } from '../util';
import { closePopover, confirmDialog, h, iconButton, openPopover, textButton, toast } from './dom';
import { LOGO_SVG, icon, type IconName } from './icons';
import { isElectron } from '../version';
import { showDownloadModal } from './downloadModal';

export async function mountHome(root: HTMLElement): Promise<() => void> {
  let metas: BoardMeta[] = [];
  /** Boards this device is sharing. */
  let shared = new Set<string>();
  let query = '';

  const page = h('div', { class: 'home' });
  const grid = h('div', { class: 'board-grid' });
  const storageLine = h('div', { class: 'storage-line' });
  const fileInput = h('input', { type: 'file', accept: FILE_ACCEPT, multiple: true, hidden: true });
  fileInput.addEventListener('change', async () => {
    await importFiles([...(fileInput.files ?? [])]);
    fileInput.value = '';
  });
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search boards', 'aria-label': 'Search boards' });
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    renderGrid();
  });
  const logo = h('span', { class: 'logo' });
  logo.innerHTML = LOGO_SVG;

  page.append(
    h('header', { class: 'home-header' },
      h('div', { class: 'brand' }, logo,
        h('h1', {}, 'Megahard Whiteboard')),
      h('div', { class: 'home-actions' },
        h('label', { class: 'search-wrap' }, icon('search'), search),
        ...(!isElectron ? [textButton('Desktop App', () => showDownloadModal(), 'btn', 'desktop')] : []),
        textButton('Import', () => fileInput.click(), 'btn', 'upload'),
        textButton('Back up all', () => void backupAll(), 'btn', 'download'))),
    h('main', { class: 'home-main' }, h('h2', {}, 'Your boards'), grid, storageLine),
    fileInput,
  );
  root.append(page);

  page.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      page.classList.add('dropping');
    }
  });
  page.addEventListener('dragleave', (e) => {
    if (e.target === page) page.classList.remove('dropping');
  });
  page.addEventListener('drop', (e) => {
    e.preventDefault();
    page.classList.remove('dropping');
    void importFiles([...(e.dataTransfer?.files ?? [])]);
  });

  async function refresh() {
    [metas, shared] = await Promise.all([listBoards(), listShares().then((all) => new Set(all.map((s) => s.boardId)))]);
    renderGrid();
    void updateStorage();
  }

  function renderGrid() {
    const items = metas.filter((m) => !query || m.name.toLowerCase().includes(query));
    const tile = h('button', { class: 'board-card new-board', type: 'button', onclick: () => void createBoard() },
      h('span', { class: 'new-icon' }, icon('plus')), h('span', { class: 'new-label' }, 'New board'));
    grid.replaceChildren(tile, ...items.map(card));
    if (query && !items.length) grid.append(h('p', { class: 'empty' }, `No boards match "${search.value}".`));
  }

  function card(m: BoardMeta) {
    const title = h('span', { class: 'card-title', title: m.name }, m.name);
    const titleWrap = h('div', { class: 'card-text' }, title,
      h('span', { class: 'card-date' }, shared.has(m.id) ? h('span', { class: 'shared-tag' }, 'Shared') : null, `Edited ${relativeTime(m.updatedAt)}`));
    const more: HTMLButtonElement = iconButton('more', `Options for ${m.name}`, () => openPopover(more, cardMenu(m, title), 'below-end'));
    return h('div', { class: 'board-card' },
      h('a', { class: 'thumb', href: `#/board/${m.id}`, 'aria-label': `Open ${m.name}` },
        m.thumbnail ? h('img', { src: m.thumbnail, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb-empty' })),
      h('div', { class: 'card-meta' }, titleWrap, more));
  }

  function cardMenu(m: BoardMeta, title: HTMLElement) {
    const item = (name: IconName, label: string, run: () => void, cls = '') =>
      h('button', { class: `menu-item ${cls}`, type: 'button', onclick: () => { closePopover(); run(); } }, icon(name), label);
    return h('div', { class: 'pop-section menu' },
      item('edit', 'Rename', () => startRename(m, title)),
      item('copy', 'Duplicate', async () => {
        if (!(await canAdd(1, m.size ?? 0))) return;
        await duplicateBoard(m.id);
        await refresh();
      }),
      item('file', `Download board file (${FILE_EXT})`, async () => {
        const doc = await loadBoard(m.id);
        if (doc) await saveBlob(boardFileBlob(doc), `${safeFileName(doc.name)}${FILE_EXT}`);
      }),
      item('trash', 'Delete', async () => {
        const sharing = shared.has(m.id) ? ' Sharing ends too, and the links stop working.' : '';
        const ok = await confirmDialog('Delete board?', `"${m.name}" will be permanently deleted from this device.${sharing}`, 'Delete', true);
        if (!ok) return;
        // End sharing on the server too. If it can't be reached, the room closes on its own timers.
        const share = await loadShare(m.id);
        if (share) await removeRoom(share, 'stopped');
        await deleteBoard(m.id);
        toast(`Deleted "${m.name}"`);
        await refresh();
      }, 'danger'));
  }

  function startRename(m: BoardMeta, title: HTMLElement) {
    const input = h('input', { class: 'rename-input', type: 'text', value: m.name, 'aria-label': 'Board name', maxlength: 120 });
    title.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== m.name) await renameBoard(m.id, name);
      await refresh();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void finish(true);
      if (e.key === 'Escape') void finish(false);
    });
    input.addEventListener('blur', () => void finish(true));
  }

  /** Check the board and storage limits before adding boards, showing a pop-up if they'd be exceeded. */
  async function canAdd(boards: number, bytes: number, usage?: Usage): Promise<boolean> {
    if (isElectron) return true;
    const u = usage ?? (await getUsage());
    if (u.boards + boards > LIMITS.maxBoards) {
      boardLimitReached(u);
      return false;
    }
    if (u.bytes + bytes > u.budget) {
      storageFull(u);
      return false;
    }
    return true;
  }

  async function createBoard() {
    if (!(await canAdd(1, 0))) return;
    const doc = newBoardDoc();
    await saveBoard(doc);
    void requestPersistence();
    location.hash = `#/board/${doc.id}`;
  }

  async function importFiles(files: File[]) {
    let count = 0;
    const usage = await getUsage();
    import_loop: for (const file of files) {
      try {
        for (const doc of await parseImport(file)) {
          const bytes = estimateDocBytes(doc);
          if (!(await canAdd(1, bytes, usage))) break import_loop;
          await saveBoard(doc, await makeThumbnail(doc));
          usage.boards++;
          usage.bytes += bytes;
          count++;
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : `Could not import ${file.name}`);
      }
    }
    if (count) {
      toast(`Imported ${count} board${count === 1 ? '' : 's'}`);
      await refresh();
    }
  }

  async function backupAll() {
    const docs = await loadAllBoards();
    if (!docs.length) {
      toast('There are no boards to back up yet');
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    await saveBlob(backupBlob(docs), `megahard-whiteboard-backup-${date}${FILE_EXT}`);
  }

  async function updateStorage() {
    const [usage, info] = await Promise.all([getUsage(), storageInfo()]);
    const note = isElectron
      ? 'Stored permanently on this PC.'
      : info.persisted
        ? 'Saved on this device only.'
        : 'Saved on this device only. Your browser may clear it if your disk runs low, so back up boards that matter.';
    storageLine.replaceChildren(
      usageMeter(usage),
      h('p', {}, note),
      ...(!isElectron ? [
        h('p', { class: 'muted', style: 'font-size: 13px; margin-top: 4px;' },
          'Tip: To keep your boards immune to browser cache cleanups, ',
          h('button', {
            type: 'button',
            style: 'background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; text-decoration: underline; font: inherit;',
            onclick: () => showDownloadModal(),
          }, 'download the standalone app (.exe)'),
          '.',
        ),
      ] : []),
    );
    return usage;
  }

  await refresh();
  // Shared boards whose rooms closed while their owner was away: bring others' changes home.
  void collectClosedRooms().then((names) => {
    if (!names.length || !page.isConnected) return;
    void refresh();
    toast(names.length === 1 ? `Saved others' changes to "${names[0]}"` : `Saved others' changes to ${names.length} shared boards`, 4000);
  });
  // Boards saved before sizes were tracked are measured once, in the background.
  void backfillSizes(metas).then((changed) => {
    if (changed) void refresh();
  });

  // Warn once per visit when close to a limit (browser only; desktop has no limits).
  if (!isElectron) {
    const usage = await getUsage();
    const nearlyFull = usage.bytes >= usage.budget * LIMITS.warnAt || usage.boards >= LIMITS.maxBoards * LIMITS.warnAt;
    if (nearlyFull && !sessionStorage.getItem('megahard:warned')) {
      sessionStorage.setItem('megahard:warned', '1');
      if (usage.boards >= LIMITS.maxBoards) boardLimitReached(usage);
      else if (usage.bytes >= usage.budget) storageFull(usage);
      else storageAlmostFull(usage);
    }
  }
  return () => {
    closePopover();
    page.remove();
  };
}
