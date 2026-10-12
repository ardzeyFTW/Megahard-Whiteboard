import type { El, LineEl, Pt, ShapeEl } from './types';
import { createNote, createText } from './model';
import { uid } from './util';

export const TEMPLATES = [
  { id: 'kanban', name: 'Kanban', description: 'Move work across To do, Doing and Done.' },
  { id: 'retro', name: 'Retrospective', description: 'What went well, what to improve, actions.' },
  { id: 'swot', name: 'SWOT analysis', description: 'Strengths, weaknesses, opportunities, threats.' },
  { id: 'brainstorm', name: 'Brainstorm', description: 'A central idea with branches to explore.' },
] as const;

export type TemplateId = (typeof TEMPLATES)[number]['id'];

function rect(x: number, y: number, w: number, h: number, fill = '#f3f4f6', stroke = '#d0d5dd'): ShapeEl {
  return { type: 'shape', id: uid(), kind: 'rect', x, y, w, h, stroke, fill, strokeWidth: 2 };
}

function columns(c: Pt, cols: { title: string; notes: { color: string; text: string }[] }[]): El[] {
  const colW = 380, gap = 40, colH = 720;
  const total = cols.length * colW + (cols.length - 1) * gap;
  const x0 = c.x - total / 2, y0 = c.y - colH / 2;
  const out: El[] = [];
  cols.forEach((col, i) => {
    const x = x0 + i * (colW + gap);
    out.push(rect(x, y0, colW, colH));
    out.push(createText(x + 24, y0 + 22, col.title, { fontSize: 30 }));
    col.notes.forEach((n, j) => out.push(createNote(x + colW / 2, y0 + 210 + j * 230, n.color, n.text)));
  });
  return out;
}

export function buildTemplate(id: TemplateId, c: Pt): El[] {
  switch (id) {
    case 'kanban':
      return columns(c, [
        { title: 'To do', notes: [{ color: '#fff4a3', text: 'Drag notes between columns' }, { color: '#fff4a3', text: '' }] },
        { title: 'Doing', notes: [{ color: '#c5e3ff', text: 'Double-click a note to edit it' }] },
        { title: 'Done', notes: [{ color: '#c3f0cf', text: 'Set up the board' }] },
      ]);
    case 'retro':
      return columns(c, [
        { title: 'What went well', notes: [{ color: '#c3f0cf', text: '' }] },
        { title: 'What could be better', notes: [{ color: '#ffc9de', text: '' }] },
        { title: 'Action items', notes: [{ color: '#c5e3ff', text: '' }] },
      ]);
    case 'swot': {
      const size = 460, gap = 24;
      const x0 = c.x - size - gap / 2, y0 = c.y - size - gap / 2;
      const cells = [
        { title: 'Strengths', fill: '#e6f6ea', stroke: '#9fd8ae' },
        { title: 'Weaknesses', fill: '#fde8e8', stroke: '#f1a9a9' },
        { title: 'Opportunities', fill: '#e6f0ff', stroke: '#a8c5f5' },
        { title: 'Threats', fill: '#fff4e0', stroke: '#f3cd8a' },
      ];
      return cells.flatMap((cell, i) => {
        const x = x0 + (i % 2) * (size + gap), y = y0 + Math.floor(i / 2) * (size + gap);
        return [rect(x, y, size, size, cell.fill, cell.stroke), createText(x + 24, y + 22, cell.title, { fontSize: 30 })];
      });
    }
    case 'brainstorm': {
      const prompts = ['Who is it for?', 'Why now?', 'Quick wins', 'Big bets', 'What could go wrong?', 'Open questions'];
      const lines: LineEl[] = [];
      const notes: El[] = [];
      prompts.forEach((text, i) => {
        const a = (i / prompts.length) * Math.PI * 2 - Math.PI / 2;
        const nx = c.x + Math.cos(a) * 560, ny = c.y + Math.sin(a) * 340;
        lines.push({
          type: 'line', id: uid(), x1: c.x + Math.cos(a) * 180, y1: c.y + Math.sin(a) * 100, x2: nx, y2: ny,
          color: '#9aa4b2', strokeWidth: 3, arrowEnd: false,
        });
        notes.push(createNote(nx, ny, '#fff4a3', text));
      });
      const hub: ShapeEl = { type: 'shape', id: uid(), kind: 'ellipse', x: c.x - 180, y: c.y - 100, w: 360, h: 200, stroke: '#e0b400', fill: '#fff4a3', strokeWidth: 3 };
      const title = createText(0, 0, 'Central idea', { fontSize: 36 });
      title.x = c.x - title.w / 2;
      title.y = c.y - title.h / 2;
      return [...lines, hub, title, ...notes];
    }
  }
}
