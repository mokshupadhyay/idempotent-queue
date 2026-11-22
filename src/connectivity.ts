import { getDocument, getNavigator, isEventTarget, readGlobal, type DocumentLike, type EventTargetLike } from './env.js';

export interface Connectivity {
  isOnline(): boolean | Promise<boolean>;
  subscribeToConnectivity(listener: (online: boolean) => void): () => void;
}

export interface BrowserConnectivityOptions {
  /** Receives `online` and `offline` events. Default: `window`. */
  target?: EventTargetLike;
  /** Read for `onLine`. Default: `navigator`. */
  navigator?: { onLine?: boolean };
}

/**
 * `isOnline` and `subscribeToConnectivity` from `navigator.onLine` and the
 * window's `online` and `offline` events. Spread the result into the queue
 * options; the queue uses it by default in browsers.
 *
 * `navigator.onLine === false` reliably means offline. `true` only means a
 * network interface is up, not that the server is reachable; failed attempts
 * are retried as usual.
 */
export function createBrowserConnectivity(options: BrowserConnectivityOptions = {}): Connectivity {
  const target = options.target !== undefined ? options.target : readGlobal('window');
  const nav = options.navigator !== undefined ? options.navigator : getNavigator();
  return {
    isOnline: () => !nav || nav.onLine !== false,
    subscribeToConnectivity: (listener) => {
      if (!isEventTarget(target)) return () => undefined;
      const online = () => listener(true);
      const offline = () => listener(false);
      target.addEventListener('online', online);
      target.addEventListener('offline', offline);
      return () => {
        target.removeEventListener('online', online);
        target.removeEventListener('offline', offline);
      };
    },
  };
}

/** Whether this host reports connectivity through `navigator.onLine` and window events. */
export function hasBrowserConnectivity(): boolean {
  const nav = getNavigator();
  return !!nav && typeof nav.onLine === 'boolean' && isEventTarget(readGlobal('window'));
}

/**
 * Calls `listener` each time the document becomes visible
 * (`visibilitychange` with `visibilityState === 'visible'`). Returns an
 * unsubscribe function; does nothing without a document.
 */
export function subscribeToPageVisibility(listener: () => void, doc: DocumentLike | undefined = getDocument()): () => void {
  if (!doc) return () => undefined;
  const onChange = () => {
    if (doc.visibilityState === 'visible') listener();
  };
  doc.addEventListener('visibilitychange', onChange);
  return () => doc.removeEventListener('visibilitychange', onChange);
}
