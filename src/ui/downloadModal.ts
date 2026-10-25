import { h, showModal } from './dom';
import { icon } from './icons';
import { APP_VERSION, RELEASES_PAGE, getInstallerUrl } from '../version';

export function showDownloadModal(latestVersion = APP_VERSION) {
  showModal('Download Megahard Whiteboard', h('div', { class: 'about' },
    h('p', {}, 'Get the dedicated Windows app for a permanent whiteboard on your PC:'),
    h('ul', { style: 'margin: 10px 0 16px 18px; color: var(--muted); font-size: 14px; line-height: 1.6;' },
      h('li', {}, h('strong', {}, 'Safe from cache wipes: '), 'Stored in Windows AppData, never deleted by browser history or cache cleanups.'),
      h('li', {}, h('strong', {}, 'Works offline: '), 'Runs standalone without needing a browser or internet connection.'),
      h('li', {}, h('strong', {}, 'Distraction-free: '), 'Full-screen canvas with no browser address bar or tabs.'),
    ),
    h('div', { style: 'display: flex; flex-direction: column; gap: 8px; margin-top: 14px;' },
      h('a', {
        class: 'btn btn-primary',
        style: 'justify-content: center;',
        href: getInstallerUrl(latestVersion),
        target: '_blank',
        rel: 'noopener',
      }, icon('download'), `Download for Windows (.exe)`),
      h('a', {
        class: 'muted',
        style: 'text-align: center; font-size: 13px; margin-top: 4px;',
        href: RELEASES_PAGE,
        target: '_blank',
        rel: 'noopener',
      }, 'View release on GitHub →'),
    ),
  ));
}
