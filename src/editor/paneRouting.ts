// A viewer sees two boards at once: the shared one (look and copy only) and their own. Both
// editors listen to the whole page for keys and for copy and paste, so these rules decide which
// one answers. Editing shortcuts always belong to the viewer's own board.
export type Pane = 'shared' | 'notes';

interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Keys that mean something on the shared board: moving around, and selecting what to copy. */
function isLookKey(e: KeyLike): boolean {
  if (e.ctrlKey || e.metaKey) return ['=', '+', '-', '0', 'a'].includes(e.key.toLowerCase());
  return e.key === ' ' || e.key === 'Escape' || (e.shiftKey && e.code === 'Digit1');
}

/** Which board a key press is for, given which one the viewer last clicked on. */
export function keyOwner(active: Pane, e: KeyLike): Pane {
  return active === 'shared' && isLookKey(e) ? 'shared' : 'notes';
}

/** Which board a copy, cut or paste is for. Cut and paste only ever touch the viewer's own board. */
export function clipboardOwner(active: Pane, kind: 'copy' | 'cut' | 'paste', sharedHasSelection: boolean): Pane {
  return kind === 'copy' && active === 'shared' && sharedHasSelection ? 'shared' : 'notes';
}
