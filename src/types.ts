export interface Pt {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'diamond';

/** Freehand ink. `points` is a flat list of [x, y, pressure] triples in world space. */
export interface StrokeEl {
  type: 'stroke';
  id: string;
  points: number[];
  color: string;
  size: number;
  highlighter?: boolean;
  /** Arrowhead at the end of the stroke. */
  arrow?: boolean;
  /** Arrowhead at the start of the stroke. */
  arrowStart?: boolean;
  /** 0.05 – 1. Defaults to 1 (0.4 for highlighter strokes). */
  opacity?: number;
  simulatePressure?: boolean;
}

export interface ShapeEl {
  type: 'shape';
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string;
  fill: string;
  strokeWidth: number;
  /** Radians, clockwise, about the center of the box. Ink and lines have none: their points are rotated directly. */
  rotation?: number;
}

export interface LineEl {
  type: 'line';
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: number;
  arrowEnd: boolean;
}

export interface NoteEl {
  type: 'note';
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  text: string;
  rotation?: number;
}

export interface TextEl {
  type: 'text';
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: string;
  fontSize: number;
  /** When true the box grows to fit the longest line instead of wrapping. */
  autoWidth: boolean;
  rotation?: number;
}

export interface ImageEl {
  type: 'image';
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Key into BoardDoc.assets. */
  asset: string;
  rotation?: number;
}

export type El = StrokeEl | ShapeEl | LineEl | NoteEl | TextEl | ImageEl;

export type Pattern = 'none' | 'grid' | 'dots' | 'gridDots';

export interface Background {
  color: string;
  pattern: Pattern;
}

/** screen = (world - {x, y}) * zoom */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface BoardDoc {
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  background: Background;
  /** Paint order: later elements are drawn on top. */
  elements: El[];
  /** Image data URLs, keyed by asset id. */
  assets: Record<string, string>;
  camera: Camera;
}

export interface BoardMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  thumbnail?: string;
  /** Approximate bytes the board takes in storage, thumbnail included. */
  size?: number;
}
