// The dialog for importing a PDF: pick pages, turn the ones that are sideways, and choose how they are laid out.
import type { Editor } from '../editor/editor';
import { PdfFile } from '../pdf';
import {
  DEFAULT_STACK, MAX_GRID_COLUMNS, formatPageRange, parsePageRange, rotatedSize, turn, type PageRotation, type StackMode, type StackOptions,
} from '../pdfLayout';
import { h, segmented, showModal, textButton, toast } from './dom';
import { icon } from './icons';

/** Board units per PDF point: a letter-size page comes out about 920 wide, which reads well at 100% zoom. */
const BOARD_PER_POINT = 1.5;
/** Longest side of a page's preview, in pixels. */
const THUMB_PIXELS = 260;

interface PageCell {
  n: number;
  rotation: PageRotation;
  /** The rotation the preview currently shows, or null before it has been drawn. */
  shown: PageRotation | null;
  visible: boolean;
  loading: boolean;
  cell: HTMLElement;
  frame: HTMLElement;
}

export function openPdfImport(ed: Editor, file: File) {
  let pdf: PdfFile | null = null;
  let closed = false;
  let importing = false;
  /** Set once the PDF has been read; the Import button calls it. */
  let importer: (() => Promise<void>) | null = null;

  const body = h('div', { class: 'pdf-import' }, h('p', { class: 'muted' }, `Reading ${file.name}…`));
  const cancelBtn = textButton('Cancel', () => close());
  const importBtn = textButton('Place', () => void importer?.(), 'btn primary');
  importBtn.disabled = true;
  const close = showModal('Import PDF', body, [cancelBtn, importBtn], () => {
    closed = true;
    pdf?.destroy();
  });

  PdfFile.open(file).then(
    (opened) => {
      if (closed) return opened.destroy();
      pdf = opened;
      build(opened);
    },
    (err) => {
      close();
      toast(err instanceof Error ? err.message : 'Could not read that PDF');
    },
  );

  function build(doc: PdfFile) {
    const rotations = doc.pages.map(() => 0 as PageRotation);
    const selected = new Set<number>(doc.pages.map((_, i) => i + 1));
    const stack: StackOptions = { ...DEFAULT_STACK };
    const cells: PageCell[] = [];

    // ---- pages
    const rangeInput = h('input', { type: 'text', class: 'pdf-range', 'aria-label': 'Pages to import', placeholder: 'e.g. 1-3, 5', spellcheck: 'false', autocomplete: 'off' });
    const grid = h('div', { class: 'pdf-pages' });

    const syncRange = () => {
      rangeInput.value = formatPageRange([...selected]);
      rangeInput.removeAttribute('aria-invalid');
    };
    const refresh = () => {
      for (const c of cells) {
        const on = selected.has(c.n);
        c.cell.classList.toggle('on', on);
        c.cell.setAttribute('aria-checked', String(on));
      }
      const count = selected.size;
      importBtn.disabled = importing || count === 0;
      importBtn.textContent = count === 1 ? 'Place 1 page' : `Place ${count} pages`;
      summary.textContent = `${count} of ${doc.pageCount} ${doc.pageCount === 1 ? 'page' : 'pages'} selected`;
    };
    const setSelection = (pages: Iterable<number>) => {
      selected.clear();
      for (const p of pages) selected.add(p);
      syncRange();
      refresh();
    };

    rangeInput.addEventListener('input', () => {
      const pages = parsePageRange(rangeInput.value, doc.pageCount);
      if (!pages) {
        rangeInput.setAttribute('aria-invalid', 'true');
        return;
      }
      rangeInput.removeAttribute('aria-invalid');
      selected.clear();
      pages.forEach((p) => selected.add(p));
      refresh();
    });
    // Leaving the box tidies whatever was typed into the normal "1-3, 5" form; an empty or invalid box goes back to the selection.
    rangeInput.addEventListener('blur', syncRange);

    const draw = async (c: PageCell) => {
      if (closed || !c.visible || c.loading || c.shown === c.rotation) return;
      const asked = c.rotation;
      c.loading = true;
      try {
        const canvas = await doc.render(c.n, asked, THUMB_PIXELS);
        c.frame.replaceChildren(canvas);
        c.shown = asked;
      } catch {
        // The dialog was closed, or this one page can't be drawn: leave the placeholder.
      }
      c.loading = false;
      // Turned again while it was drawing.
      if (c.shown !== c.rotation) void draw(c);
    };

    const watcher = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const c = cells[Number((e.target as HTMLElement).dataset.index)];
        c.visible = e.isIntersecting;
        void draw(c);
      }
    }, { root: grid, rootMargin: '200px' });

    const aspect = (c: PageCell) => {
      const s = rotatedSize(doc.pages[c.n - 1].w, doc.pages[c.n - 1].h, c.rotation);
      c.frame.style.aspectRatio = `${s.w} / ${s.h}`;
    };
    const rotate = (c: PageCell, quarterTurns = 1) => {
      c.rotation = rotations[c.n - 1] = turn(rotations[c.n - 1], quarterTurns);
      aspect(c);
      void draw(c);
    };

    doc.pages.forEach((_, i) => {
      const n = i + 1;
      const frame = h('div', { class: 'pdf-thumb' });
      const turnBtn = h('button', { class: 'pdf-turn', type: 'button', title: `Rotate page ${n}`, 'aria-label': `Rotate page ${n}` }, icon('rotate'));
      const cell = h('div', { class: 'pdf-page', role: 'checkbox', tabindex: '0', 'aria-label': `Page ${n}`, 'aria-checked': 'true', 'data-index': String(i) },
        frame, h('span', { class: 'pdf-num' }, String(n)), turnBtn);
      const c: PageCell = { n, rotation: 0, shown: null, visible: false, loading: false, cell, frame };
      const toggle = () => {
        if (!selected.delete(n)) selected.add(n);
        syncRange();
        refresh();
      };
      cell.addEventListener('click', toggle);
      cell.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          toggle();
        } else if (e.key === 'r' || e.key === 'R') {
          rotate(c);
        }
      });
      turnBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        rotate(c);
      });
      aspect(c);
      cells.push(c);
      grid.append(cell);
      watcher.observe(cell);
    });

    const summary = h('span', { class: 'muted pdf-summary' });
    const rotateAll = textButton('Rotate all', () => cells.forEach((c) => rotate(c)), 'btn', 'rotate');
    const pageTools = h('div', { class: 'pdf-tools' },
      h('label', { class: 'pdf-range-label' }, h('span', { class: 'field-label' }, 'Pages'), rangeInput),
      textButton('All', () => setSelection(doc.pages.map((_, i) => i + 1))),
      textButton('None', () => setSelection([])),
      rotateAll);

    // ---- layout
    const columnsInput = h('input', { type: 'number', class: 'pdf-columns', min: 1, max: MAX_GRID_COLUMNS, value: String(stack.columns), 'aria-label': 'Columns' });
    columnsInput.addEventListener('input', () => {
      const v = Math.floor(Number(columnsInput.value));
      if (v >= 1) stack.columns = Math.min(v, MAX_GRID_COLUMNS);
    });
    const columnsRow = h('label', { class: 'pdf-columns-row' }, 'Columns', columnsInput);
    columnsRow.hidden = true;
    const layout = segmented<StackMode>([['vertical', 'Top to bottom'], ['horizontal', 'Left to right'], ['grid', 'Grid']], stack.mode, (mode) => {
      stack.mode = mode;
      columnsRow.hidden = mode !== 'grid';
    });

    body.replaceChildren(
      h('p', { class: 'muted pdf-file' }, `${file.name} · ${doc.pageCount} ${doc.pageCount === 1 ? 'page' : 'pages'}`),
      pageTools,
      grid,
      summary,
      h('div', { class: 'pdf-layout' },
        h('span', { class: 'field-label' }, 'Arrange pages'),
        layout,
        columnsRow,
        h('p', { class: 'muted pdf-hint' }, 'Click a page to include or skip it. Use the turn button on a page that came in sideways.')));
    syncRange();
    refresh();
    rangeInput.focus();

    importer = async () => {
      const pages = [...selected].sort((a, b) => a - b);
      if (!pages.length || importing) return;
      importing = true;
      const label = importBtn.textContent;
      importBtn.disabled = true;
      cancelBtn.textContent = 'Stop';
      try {
        const out: { src: string; size: { w: number; h: number } }[] = [];
        for (const n of pages) {
          importBtn.textContent = `Preparing ${out.length + 1} of ${pages.length}…`;
          const info = doc.pages[n - 1];
          const picture = await doc.renderForBoard(n, rotations[n - 1], ed.imageQuality);
          if (closed) return;
          const size = rotatedSize(info.w, info.h, rotations[n - 1]);
          out.push({ src: picture.src, size: { w: size.w * BOARD_PER_POINT, h: size.h * BOARD_PER_POINT } });
        }
        if (await ed.insertPages(out, stack)) {
          close();
          toast(out.length === 1 ? 'Placed 1 page. Move, resize or turn it, or undo to remove it' : `Placed ${out.length} pages. Move, resize or turn them together, or undo to remove them`);
        }
      } catch (err) {
        if (!closed) toast(err instanceof Error ? err.message : 'Could not import that PDF');
      } finally {
        importing = false;
        if (!closed) {
          cancelBtn.textContent = 'Cancel';
          importBtn.textContent = label;
          refresh();
        }
      }
    };
  }
}
