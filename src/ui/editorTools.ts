// The drawing tools around a board: the ink tray, the main dock, zoom, and the selection bar.
// Built once per editor, so a viewer's own board gets a full set beside the shared one.
import type { Editor, EraserMode, KeyAction, LineEnds, ShapeTool } from '../editor/editor';
import { SHAPE_TOOLS, isInkTool, keyLabel } from '../editor/editor';
import { closePopover, h, iconButton, isPopoverFor, segmented, sep, swatchRow, toast, togglePopover, type Placement } from './dom';
import { icon, type IconName } from './icons';
import { HIGHLIGHT_COLORS, INK_COLORS, NOTE_COLORS, PEN_MAX_SIZE, REACTIONS } from '../palette';
import { TEMPLATES } from '../templates';
import { clamp } from '../util';

const SHAPE_LABELS: Record<ShapeTool, string> = {
  rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', diamond: 'Diamond', line: 'Line', arrow: 'Arrow',
};

// Standing-pen illustrations for the ink tray. Colors come from saved prefs, so only plain hex is allowed into the SVG.
const safeHex = (c: string) => (/^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '#1f1f1f');

function penArt(color: string) {
  const c = safeHex(color);
  return `<svg viewBox="0 0 28 52" aria-hidden="true"><path d="M7 54V21l7-14 7 14v33z" class="art-body"/><path d="M9.5 16L14 7l4.5 9z" fill="${c}"/></svg>`;
}

function highlighterArt(color: string) {
  const c = safeHex(color);
  return `<svg viewBox="0 0 28 52" aria-hidden="true"><rect x="5" y="21" width="18" height="33" rx="2" class="art-body"/><path d="M7 21v-9l14-5v14z" fill="${c}"/></svg>`;
}

function eraserArt(mode: EraserMode) {
  // A rounded tip for the stroke eraser, a flat square block for the square one.
  const tip = mode === 'area' ? '<path d="M6 21V10h16v11z" fill="#f2a7b8"/>' : '<path d="M6 21v-7a5 5 0 015-5h6a5 5 0 015 5v7z" fill="#f2a7b8"/>';
  return `<svg viewBox="0 0 28 52" aria-hidden="true"><rect x="6" y="18" width="16" height="36" rx="2.5" class="art-body"/>${tip}</svg>`;
}

export interface EditorTools {
  dock: HTMLElement;
  zoomBar: HTMLElement;
  selBar: HTMLElement;
  imageInput: HTMLInputElement;
  /** Bring every button up to date with the editor (it also does this itself whenever the editor changes). */
  update(): void;
  destroy(): void;
}

/** `view` is the area the tools float over: the selection bar is kept inside it. */
export function createEditorTools(ed: Editor, view: HTMLElement): EditorTools {
  const popoverButton = (anchor: () => HTMLElement, build: () => HTMLElement, placement: Placement = 'below') =>
    () => togglePopover(anchor(), build, placement);

  // ------------------------------------------------------------ bottom dock: ink tray (shown while drawing)
  const trayTool = (label: string, art: () => string, onClick: (b: HTMLButtonElement) => void) => {
    const b = h('button', { class: 'tray-tool', type: 'button', title: label, 'aria-label': label });
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => onClick(b));
    return { b, paint: () => (b.innerHTML = art()) };
  };
  const penTools = [0, 1, 2].map((i) =>
    trayTool(`Pen ${i + 1} (${i + 1}) · click again for color and thickness`, () => penArt(ed.pens[i].color), (b) => {
      if (ed.tool === 'pen' && ed.penIndex === i) togglePopover(b, () => penPopover(i), 'above');
      else {
        closePopover();
        ed.setPen(i);
      }
    }));
  const hlTool = trayTool('Highlighter (H) · click again for options', () => highlighterArt(ed.highlighter.color), (b) => {
    if (ed.tool === 'highlighter') togglePopover(b, highlighterPopover, 'above');
    else {
      closePopover();
      ed.setTool('highlighter');
    }
  });
  const eraserTool = trayTool('Eraser (E) · click again for options', () => eraserArt(ed.eraser.mode), (b) => {
    if (ed.tool === 'eraser') togglePopover(b, eraserPopover, 'above');
    else {
      closePopover();
      ed.setTool('eraser');
    }
  });
  const trayTools = [...penTools, hlTool, eraserTool];
  const lassoBtn = iconButton('lasso', 'Lasso select (L)', () => ed.setTool('lasso'));
  const inkShapeBtn = iconButton('inkShape', 'Ink to shape (beta): tidies hand-drawn lines and shapes. It’s new and doesn’t always get it right yet.', () => {
    ed.setInkToShape(!ed.inkToShape);
    toast(ed.inkToShape ? 'Ink to shape is on. It’s a beta feature, so it won’t always get your shape right yet.' : 'Ink to shape is off', ed.inkToShape ? 5000 : undefined);
  });
  inkShapeBtn.append(h('span', { class: 'beta-badge', 'aria-hidden': 'true' }, 'BETA'));
  const inkTray = h('div', { class: 'panel ink-tray', role: 'toolbar', 'aria-label': 'Inking tools' },
    ...trayTools.map((t) => t.b), lassoBtn, inkShapeBtn, sep(),
    iconButton('close', 'Stop drawing', () => ed.setTool('select')));

  // Pen and highlighter options: thickness and opacity sliders, two rows of colors, line ends.
  function inkPopover(opts: {
    palette: string[];
    color: string;
    size: number;
    sizeMax: number;
    opacity: number;
    ends?: LineEnds;
    onChange: (patch: { color?: string; size?: number; opacity?: number; ends?: LineEnds }) => void;
  }) {
    const pop = h('div', { class: 'pop-section ink-pop' });
    const setInk = (c: string) => pop.style.setProperty('--ink', c);
    setInk(opts.color);

    // Thickness
    const sizeOut = h('output', { class: 'slider-value' }, String(opts.size));
    const size = h('input', { type: 'range', class: 'slider', title: 'Thickness', 'aria-label': 'Thickness', min: 1, max: opts.sizeMax, step: 1, value: String(opts.size) });
    size.addEventListener('input', () => {
      sizeOut.textContent = size.value;
      opts.onChange({ size: Number(size.value) });
    });

    // Opacity, as a slider over a see-through track plus a number box
    const pct = Math.round(opts.opacity * 100);
    const opacity = h('input', { type: 'range', class: 'slider opacity-slider', title: 'Opacity', 'aria-label': 'Opacity', min: 5, max: 100, step: 1, value: String(pct) });
    const opacityNum = h('input', { type: 'number', class: 'slider-num', 'aria-label': 'Opacity (%)', min: 5, max: 100, step: 1, value: String(pct) });
    const setOpacity = (v: number) => {
      const n = clamp(Math.round(v) || 100, 5, 100);
      opacity.value = opacityNum.value = String(n);
      opts.onChange({ opacity: n / 100 });
    };
    opacity.addEventListener('input', () => setOpacity(Number(opacity.value)));
    opacityNum.addEventListener('change', () => setOpacity(Number(opacityNum.value)));

    // Colors: custom picker, the palette, then the last custom color
    const grid = h('div', { class: 'color-grid', role: 'radiogroup', 'aria-label': 'Color' });
    const picker = h('input', {
      type: 'color', class: 'hidden-picker', tabindex: '-1', 'aria-hidden': 'true',
      value: /^#[0-9a-fA-F]{6}$/.test(opts.color) ? opts.color : '#000000',
    });
    const markActive = (c: string) =>
      grid.querySelectorAll<HTMLElement>('.swatch[data-color]').forEach((s) => {
        const on = s.dataset.color === c.toLowerCase();
        s.classList.toggle('active', on);
        s.setAttribute('aria-checked', String(on));
      });
    const pick = (c: string) => {
      setInk(c);
      markActive(c);
      opts.onChange({ color: c });
    };
    const swatch = (c: string) => {
      const b = h('button', { class: 'swatch', type: 'button', role: 'radio', title: c, 'aria-label': c, style: { background: c } });
      b.dataset.color = c.toLowerCase();
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => pick(c));
      return b;
    };
    const customSlot = h('span', { class: 'custom-slot' });
    const renderCustom = () => {
      const c = ed.customColor;
      customSlot.replaceChildren(...(c && !opts.palette.includes(c.toLowerCase()) ? [swatch(c)] : []));
    };
    const addBtn = h('button', { class: 'swatch add-color', type: 'button', title: 'Custom color', 'aria-label': 'Pick a custom color' }, icon('plus'));
    addBtn.addEventListener('click', () => picker.click());
    picker.addEventListener('input', () => {
      ed.setCustomColor(picker.value);
      renderCustom();
      pick(picker.value);
    });
    grid.append(addBtn, ...opts.palette.map(swatch), customSlot);
    renderCustom();
    markActive(opts.color);

    pop.append(h('div', { class: 'slider-row' }, size, sizeOut), h('div', { class: 'slider-row' }, opacity, opacityNum), h('hr'), grid, picker);

    // Line ends (pens only)
    if (opts.ends) {
      const choices: [LineEnds, IconName, string][] = [
        ['none', 'noArrow', 'No arrows'],
        ['end', 'arrowEnd', 'Arrow at the end'],
        ['both', 'arrowBoth', 'Arrows at both ends'],
      ];
      const row = h('div', { class: 'ends-row', role: 'radiogroup', 'aria-label': 'Line ends' });
      for (const [value, iconName, label] of choices) {
        const b = iconButton(iconName, label, () => {
          row.querySelectorAll('.icon-btn').forEach((x) => {
            x.classList.toggle('active', x === b);
            x.setAttribute('aria-checked', String(x === b));
          });
          opts.onChange({ ends: value });
        }, value === opts.ends ? 'active' : '');
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(value === opts.ends));
        row.append(b);
      }
      pop.append(h('hr'), row);
    }
    return pop;
  }

  function penPopover(i: number) {
    const pen = ed.pens[i];
    return inkPopover({
      palette: INK_COLORS, color: pen.color, size: pen.size, sizeMax: PEN_MAX_SIZE, opacity: pen.opacity, ends: pen.ends,
      onChange: (patch) => ed.updatePen(i, patch),
    });
  }

  function highlighterPopover() {
    const hl = ed.highlighter;
    return inkPopover({
      palette: HIGHLIGHT_COLORS, color: hl.color, size: hl.size, sizeMax: 60, opacity: hl.opacity,
      onChange: (patch) => ed.updateHighlighter(patch),
    });
  }

  function eraserPopover() {
    const sizeOut = h('output', { class: 'slider-value' }, String(ed.eraser.size));
    const size = h('input', { type: 'range', class: 'slider', title: 'Size', 'aria-label': 'Eraser size', min: 8, max: 80, step: 1, value: String(ed.eraser.size) });
    size.addEventListener('input', () => {
      sizeOut.textContent = size.value;
      ed.updateEraser({ size: Number(size.value) });
    });
    return h('div', { class: 'pop-section ink-pop' },
      segmented<EraserMode>([['stroke', 'Stroke'], ['area', 'Square']], ed.eraser.mode, (mode) => ed.updateEraser({ mode })),
      h('p', { class: 'muted eraser-note' }, 'Stroke removes whole lines it touches. Square rubs out only what it passes over. Both grow when you move fast.'),
      h('div', { class: 'slider-row' }, size, sizeOut));
  }

  // ------------------------------------------------------------ bottom dock: main tools
  const imageInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  imageInput.addEventListener('change', () => {
    const c = ed.viewCenter;
    [...(imageInput.files ?? [])].forEach((f, i) => void ed.insertImageFile(f, { x: c.x + i * 30, y: c.y + i * 30 }));
    imageInput.value = '';
  });

  function shapePopover() {
    const grid = h('div', { class: 'shape-grid' });
    for (const k of SHAPE_TOOLS) {
      grid.append(iconButton(k, SHAPE_LABELS[k], () => {
        closePopover();
        ed.setShapeKind(k);
        const name = SHAPE_LABELS[k].toLowerCase();
        toast(`Drag on the board to draw ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`);
      }, ed.shapeKind === k ? 'active' : ''));
    }
    return h('div', { class: 'pop-section' }, h('div', { class: 'pop-label' }, 'Shapes'), grid);
  }

  // Less common things to add live together behind one button.
  function morePopover() {
    const pick = (run: () => void) => () => {
      closePopover();
      run();
    };
    return h('div', { class: 'pop-section more-pop' },
      h('div', { class: 'pop-label' }, 'Sticky note (N)'),
      swatchRow(NOTE_COLORS, null, (c) => pick(() => ed.insertNote(c))()),
      h('div', { class: 'pop-label' }, 'Reactions'),
      h('div', { class: 'emoji-grid' }, ...REACTIONS.map((r) =>
        h('button', { type: 'button', class: 'emoji-btn', 'aria-label': `Add ${r}`, onclick: pick(() => ed.insertReaction(r)) }, r))),
      h('div', { class: 'pop-label' }, 'Templates'),
      ...TEMPLATES.map((t) =>
        h('button', { class: 'menu-item two-line', type: 'button', onclick: pick(() => ed.insertTemplate(t.id)) },
          h('strong', {}, t.name), h('span', {}, t.description))));
  }

  const selectBtn = iconButton('pointer', 'Select (V)', () => ed.setTool('select'));
  const handBtn = iconButton('hand', 'Pan (or hold Space)', () => ed.setTool('hand'));
  const inkBtn = iconButton('inkMode', 'Draw', () => {
    closePopover();
    if (isInkTool(ed.tool)) ed.setTool('select');
    else if (ed.lastInkTool === 'pen') ed.setPen(ed.penIndex);
    else ed.setTool(ed.lastInkTool);
  });
  const textBtn = iconButton('text', 'Text (T)', () => {
    closePopover();
    ed.insertText();
  });
  const shapeBtn: HTMLButtonElement = iconButton('shapes', 'Shapes (S)', popoverButton(() => shapeBtn, shapePopover, 'above'));
  const imageBtn = iconButton('image', 'Image', () => {
    closePopover();
    imageInput.click();
  });
  const moreBtn: HTMLButtonElement = iconButton('addMore', 'More: sticky notes, reactions, templates', popoverButton(() => moreBtn, morePopover, 'above'));
  const mainBar = h('div', { class: 'panel dock-main', role: 'toolbar', 'aria-label': 'Tools' },
    selectBtn, handBtn, inkBtn, sep(), textBtn, shapeBtn, imageBtn, moreBtn);
  const dock = h('div', { class: 'dock' }, inkTray, mainBar);

  // ------------------------------------------------------------ zoom
  const zoomLabel = h('button', { class: 'zoom-label', type: 'button', title: 'Reset to 100% (Ctrl+0)', onclick: () => ed.setZoom(1) }, '100%');
  const zoomBar = h('div', { class: 'panel zoom-bar' },
    iconButton('minus', 'Zoom out (Ctrl+-)', () => ed.zoomBy(1 / 1.25)), zoomLabel,
    iconButton('plus', 'Zoom in (Ctrl+=)', () => ed.zoomBy(1.25)),
    iconButton('fit', 'Zoom to fit (Shift+1)', () => ed.zoomToFit()));

  // ------------------------------------------------------------ selection toolbar
  const selBar = h('div', { class: 'panel sel-bar', role: 'toolbar', 'aria-label': 'Selection' });
  selBar.hidden = true;

  function buildSelBar() {
    selBar.replaceChildren();
    const els = ed.selectedEls();
    if (!els.length || ed.isEditingText || ed.isInteracting || ed.readOnly) {
      selBar.hidden = true;
      return;
    }
    selBar.hidden = false;
    const allNotes = els.every((e) => e.type === 'note');
    const hasInk = els.some((e) => e.type !== 'note' && e.type !== 'image');
    if (allNotes) selBar.append(swatchRow(NOTE_COLORS, els.length === 1 && els[0].type === 'note' ? els[0].color : null, (c) => ed.setNoteColor(c)), sep());
    else if (hasInk) selBar.append(swatchRow(INK_COLORS.filter((c) => c !== '#ffffff').slice(0, 8), null, (c) => ed.setInkColor(c)), sep());
    if (els.some((e) => e.type === 'shape')) selBar.append(iconButton('fill', 'Fill on/off', () => ed.toggleFill()));
    if (els.length === 1 && (els[0].type === 'note' || els[0].type === 'text')) selBar.append(iconButton('edit', 'Edit text (Enter)', () => ed.editSelected()));
    selBar.append(
      iconButton('copy', 'Duplicate (Ctrl+D)', () => ed.duplicateSelection()),
      iconButton('front', 'Bring to front', () => ed.bringToFront()),
      iconButton('back', 'Send to back', () => ed.sendToBack()),
      iconButton('trash', 'Delete (Del)', () => ed.deleteSelection()),
    );
    positionSelBar();
  }

  function positionSelBar() {
    if (selBar.hidden) return;
    const b = ed.selectionScreenBounds();
    if (!b) return;
    const vw = view.clientWidth, vh = view.clientHeight;
    const bw = selBar.offsetWidth, bh = selBar.offsetHeight;
    const x = clamp(b.x + b.w / 2 - bw / 2, 8, Math.max(8, vw - bw - 8));
    const maxY = vh - dock.offsetHeight - 12 - bh - 12;
    let y = b.y - bh - 16;
    if (y < 64) y = b.y + b.h + 16;
    y = Math.min(y, maxY);
    selBar.style.left = `${x}px`;
    selBar.style.top = `${Math.max(8, y)}px`;
  }

  function update() {
    const t = ed.tool;
    dock.hidden = ed.readOnly;
    const setActive = (b: HTMLElement, on: boolean) => {
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    };
    const hint = (text: string, action: KeyAction) => (ed.keys[action] ? `${text} (${keyLabel(ed.keys[action])})` : text);
    const label = (b: HTMLElement, text: string) => {
      b.title = text;
      b.setAttribute('aria-label', text);
    };
    label(selectBtn, hint('Select', 'select'));
    label(handBtn, hint('Pan', 'hand'));
    penTools.forEach((p, i) => label(p.b, `${hint(`Pen ${i + 1}`, `pen${i + 1}` as KeyAction)} · click again for color and thickness`));
    label(hlTool.b, `${hint('Highlighter', 'highlighter')} · click again for options`);
    label(eraserTool.b, `${hint('Eraser', 'eraser')} · click again for options`);
    label(lassoBtn, hint('Lasso select', 'lasso'));
    label(textBtn, hint('Text', 'text'));
    label(shapeBtn, hint('Shapes', 'shape'));

    setActive(selectBtn, t === 'select');
    setActive(handBtn, t === 'hand');
    setActive(inkBtn, isInkTool(t));
    setActive(shapeBtn, t === 'shape');

    inkTray.hidden = !isInkTool(t);
    if (inkTray.hidden && trayTools.some((tool) => isPopoverFor(tool.b))) closePopover();
    penTools.forEach((p, i) => setActive(p.b, t === 'pen' && ed.penIndex === i));
    setActive(hlTool.b, t === 'highlighter');
    setActive(eraserTool.b, t === 'eraser');
    trayTools.forEach((tool) => tool.paint());
    setActive(lassoBtn, t === 'lasso');
    setActive(inkShapeBtn, ed.inkToShape);
    buildSelBar();
  }

  const offChange = ed.onChange(update);
  const offRender = ed.onRender(() => {
    zoomLabel.textContent = `${Math.round(ed.cam.zoom * 100)}%`;
    positionSelBar();
  });
  update();

  return {
    dock, zoomBar, selBar, imageInput, update,
    destroy() {
      offChange();
      offRender();
    },
  };
}
