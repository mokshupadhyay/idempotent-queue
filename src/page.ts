import { getDocument, isEventTarget, readGlobal } from './env.js';

let installed = false;
let hiding = false;

function install(): void {
  if (installed) return;
  installed = true;
  const target = readGlobal('window');
  if (!isEventTarget(target)) return;
  target.addEventListener('pagehide', () => {
    hiding = true;
  });
  target.addEventListener('pageshow', () => {
    hiding = false;
  });
}

/**
 * True while the page is hidden (`document.visibilityState === 'hidden'`) or
 * after `pagehide` fired and before the next `pageshow`. False outside
 * browsers. The first call installs the `pagehide` and `pageshow` listeners.
 */
export function isPageHidden(): boolean {
  install();
  if (hiding) return true;
  const doc = getDocument();
  return !!doc && doc.visibilityState === 'hidden';
}

/** Testing hook. */
export function resetPageStateForTests(): void {
  installed = false;
  hiding = false;
}
