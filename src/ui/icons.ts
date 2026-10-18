// Original line icons, 24x24, drawn with currentColor.
const PATHS = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>',
  pointer: '<path d="M5 3l6.5 17 2.3-7.2L21 10.5z"/>',
  pen: '<path d="M4 20l1.2-4.2L16.5 4.5a2.1 2.1 0 013 3L8.2 18.8z"/><path d="M14.5 6.5l3 3"/>',
  highlighter: '<path d="M8.5 13.5l7.8-7.8a2 2 0 012.8 0l.2.2a2 2 0 010 2.8l-7.8 7.8"/><path d="M8.5 13.5l2 2-2.5 2.5H5.5l-1-1v-1z"/><path d="M14 20h6"/>',
  eraser: '<path d="M14.6 4.4a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L11 18H7.2l-3-3a2 2 0 010-2.8z"/><path d="M9 9l6 6"/><path d="M7 20h13"/>',
  lasso: '<ellipse cx="12" cy="9.5" rx="8" ry="5.5" stroke-dasharray="3 2.6"/><path d="M8.5 14.4c-1.4 1.6-.6 3.6 1.4 3.6 1.6 0 2 1.4 1.1 3"/>',
  inkShape: '<path d="M3 19c1.6-2.6 2.6-.6 4.2-3.4"/><path d="M12.5 19.5l4.2-8 4.3 8z"/><path d="M9 7.5h.01M7.5 4.5h.01M11 4h.01" stroke-width="2.4"/>',
  note: '<path d="M5 4h14v10l-6 6H5z"/><path d="M13 20v-6h6"/>',
  text: '<path d="M5 7V4.5h14V7"/><path d="M12 4.5V20"/><path d="M9 20h6"/>',
  shapes: '<rect x="3.5" y="11" width="9" height="9" rx="1"/><circle cx="16" cy="8" r="4.5"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M21 16l-5-5-8.5 8"/>',
  template: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 007 0"/><path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.6"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
  front: '<rect x="3.5" y="3.5" width="11" height="11" rx="1.5" stroke-dasharray="2.5 2"/><rect x="9.5" y="9.5" width="11" height="11" rx="1.5" fill="currentColor" fill-opacity=".3"/>',
  back: '<rect x="3.5" y="3.5" width="11" height="11" rx="1.5" fill="currentColor" fill-opacity=".3"/><rect x="9.5" y="9.5" width="11" height="11" rx="1.5" stroke-dasharray="2.5 2"/>',
  fill: '<path d="M12 3.5l5.5 8.5a6 6 0 11-11 0z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 17h6"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" stroke-width="2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01" stroke-width="2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  rotate: '<path d="M19.5 12a7.5 7.5 0 11-2.2-5.3"/><path d="M19.5 4v4.5H15"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  triangle: '<path d="M12 4l9 16H3z"/>',
  diamond: '<path d="M12 3l9 9-9 9-9-9z"/>',
  line: '<path d="M5 19L19 5"/>',
  arrow: '<path d="M5 19L19 5M10 5h9v9"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M10.4 3h3.2l.5 2.4 1.7.9 2.3-.9 1.6 2.8-1.8 1.6v2.4l1.8 1.6-1.6 2.8-2.3-.9-1.7.9-.5 2.4h-3.2l-.5-2.4-1.7-.9-2.3.9-1.6-2.8 1.8-1.6v-2.4L4.3 8.2l1.6-2.8 2.3.9 1.7-.9z"/>',
  noArrow: '<circle cx="12" cy="12" r="8"/><path d="M6.4 17.6L17.6 6.4"/>',
  arrowEnd: '<path d="M5 19L18 6"/><path d="M10.5 6H18v7.5"/>',
  arrowBoth: '<path d="M6 18L18 6"/><path d="M11.5 6H18v6.5"/><path d="M12.5 18H6v-6.5"/>',
  hand: '<path d="M8 12.5V6.5a1.5 1.5 0 013 0V11"/><path d="M11 11V5a1.5 1.5 0 013 0v6"/><path d="M14 11V6.5a1.5 1.5 0 013 0V15"/><path d="M8 12.5l-1.6-1.6a1.6 1.6 0 00-2.3 2.3L8 17.5A6 6 0 0012.3 20h.7a4 4 0 004-4v-1"/>',
  inkMode: '<path d="M3 20c2.5 0 3-3 5.5-3s2.5 2 4.5 2"/><path d="M12.5 15.5l7.3-7.3a1.9 1.9 0 00-2.7-2.7l-7.3 7.3-.8 3.5z"/>',
  addMore: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><path d="M16.75 13.5v6.5M13.5 16.75H20"/>',
  share: '<circle cx="17.5" cy="5.5" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18.5" r="2.5"/><path d="M8.7 10.7l6.6-3.9M8.7 13.3l6.6 3.9"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  splitSide: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><path d="M16 4.6a3.5 3.5 0 010 6.8M18 14.2a6.5 6.5 0 013.5 5.8"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function iconSvg(name: IconName): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}

export function icon(name: IconName): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = iconSvg(name);
  return span;
}

export const LOGO_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#2f6fde"/><path d="M8 21c3-7 6-9 8-5s4 3 8-5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle cx="24" cy="11" r="2" fill="#ffd34d"/></svg>`;
