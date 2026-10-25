import { LIMITS, type Usage } from '../limits';
import { isElectron } from '../version';
import { formatBytes } from '../util';
import { h, showModal, textButton } from './dom';

/** A bar showing how much of the storage budget and board limit is used. */
export function usageMeter(u: Usage): HTMLElement {
  if (isElectron) {
    return h('div', { class: 'usage' },
      h('div', { class: 'usage-text' },
        `${formatBytes(u.bytes)} used · ${u.boards} ${u.boards === 1 ? 'board' : 'boards'}`));
  }
  const share = Math.max(u.bytes / u.budget, u.boards / LIMITS.maxBoards);
  const pct = Math.min(100, share * 100);
  const level = share >= 1 ? ' full' : share >= LIMITS.warnAt ? ' warn' : '';
  return h('div', { class: 'usage' },
    h('div', { class: `usage-bar${level}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct) },
      h('span', { style: { width: `${pct}%` } })),
    h('div', { class: 'usage-text' },
      `${formatBytes(u.bytes)} of ${formatBytes(u.budget)} · ${u.boards} of ${LIMITS.maxBoards} boards`));
}

function notice(title: string, paragraphs: string[], usage?: Usage) {
  let close = () => undefined as void;
  const ok = textButton('OK', () => close(), 'btn primary');
  close = showModal(title, h('div', { class: 'limit-notice' }, ...paragraphs.map((p) => h('p', {}, p)), usage ? usageMeter(usage) : null), [ok]);
}

const BACKUP_TIP = 'To keep a copy first, use "Back up all" on the home screen. You can import boards again any time.';

export function boardLimitReached(u: Usage) {
  notice('Board limit reached', [
    `This browser can keep up to ${LIMITS.maxBoards} boards. Delete boards you no longer need to make room.`,
    BACKUP_TIP,
  ], u);
}

export function storageFull(u: Usage) {
  notice('Storage is full', [
    'Your boards are using all the space set aside for them, so new boards, imports and images are paused.',
    'Delete boards you no longer need, or remove large images from your boards. ' + BACKUP_TIP,
  ], u);
}

export function storageAlmostFull(u: Usage) {
  // Talk about whichever limit is closer: number of boards or space.
  const byCount = u.boards / LIMITS.maxBoards > u.bytes / u.budget;
  notice(byCount ? 'Almost at the board limit' : 'Storage is almost full', [
    byCount
      ? `You have ${u.boards} of the ${LIMITS.maxBoards} boards this browser can keep.`
      : `Your boards are using ${Math.round((u.bytes / u.budget) * 100)}% of the space set aside for them.`,
    'Back up and delete boards you no longer need before you run out. Large images take the most space.',
  ], u);
}

export function boardFull() {
  notice('This board is full', [
    `A board can hold up to ${formatBytes(LIMITS.perBoard)}, and this would go over that.`,
    'Try a smaller image, or put it on a new board.',
  ]);
}

export function boardAlmostFull(bytes: number) {
  notice('This board is getting big', [
    `This board is using ${formatBytes(bytes)} of its ${formatBytes(LIMITS.perBoard)}. Large images take the most space.`,
    'Consider starting a new board for more content.',
  ]);
}
