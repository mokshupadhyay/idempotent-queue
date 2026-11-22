/**
 * Access to host globals without DOM or Node typings. Every lookup happens at
 * call time and tolerates a missing global, so the same build runs in
 * browsers, workers and Node.
 */

export type EventListenerLike = (event: unknown) => void;

export interface EventTargetLike {
  addEventListener(type: string, listener: EventListenerLike): void;
  removeEventListener(type: string, listener: EventListenerLike): void;
}

export function getGlobal(): Record<string, unknown> {
  if (typeof globalThis !== 'undefined') return globalThis as unknown as Record<string, unknown>;
  // Browsers released before globalThis (2019).
  if (typeof self !== 'undefined') return self as unknown as Record<string, unknown>;
  return {};
}

declare const self: unknown;

export function readGlobal(name: string): unknown {
  try {
    return getGlobal()[name];
  } catch {
    // Some hosts throw on access, for example `localStorage` with storage disabled.
    return undefined;
  }
}

export function isEventTarget(value: unknown): value is EventTargetLike {
  return (
    !!value &&
    typeof (value as EventTargetLike).addEventListener === 'function' &&
    typeof (value as EventTargetLike).removeEventListener === 'function'
  );
}

/** True in a window or a worker, false in Node and other server runtimes. */
export function isBrowserLike(): boolean {
  if (readGlobal('document') !== undefined) return true;
  return typeof readGlobal('WorkerGlobalScope') === 'function';
}

export interface DocumentLike extends EventTargetLike {
  visibilityState?: string;
}

export function getDocument(): DocumentLike | undefined {
  const doc = readGlobal('document');
  return isEventTarget(doc) ? (doc as DocumentLike) : undefined;
}

export function getNavigator(): Record<string, unknown> | undefined {
  const nav = readGlobal('navigator');
  return nav && typeof nav === 'object' ? (nav as Record<string, unknown>) : undefined;
}

/** A short random id for tabs and lock holders. Not used for idempotency keys. */
export function randomId(random: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < 4; i++) id += Math.floor(random() * 0x100000000).toString(36);
  return id;
}
