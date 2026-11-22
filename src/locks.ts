import { getNavigator, randomId, readGlobal, type EventListenerLike } from './env.js';
import type { AbortSignalLike, LockRequestOptions, QueueLocks } from './types.js';

function abortError(): Error {
  const error = new Error('The lock request was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * A FIFO wait list per lock name. `run` is called when the entry reaches the
 * head of its list; `next(name)` moves on to the following entry.
 */
function createWaitList() {
  const queues = new Map<string, Array<() => void>>();
  return {
    enter(name: string, run: () => void): () => boolean {
      const queue = queues.get(name);
      if (queue) queue.push(run);
      else {
        queues.set(name, [run]);
        run();
      }
      // Leaves the list if still waiting. Returns false once `run` was called.
      return () => {
        const list = queues.get(name);
        if (!list) return false;
        const index = list.indexOf(run);
        if (index <= 0) return false;
        list.splice(index, 1);
        return true;
      };
    },
    next(name: string): void {
      const queue = queues.get(name);
      if (!queue) return;
      queue.shift();
      if (queue.length > 0) queue[0]();
      else queues.delete(name);
    },
  };
}

/**
 * Locks for one JavaScript realm: a FIFO queue per name. They coordinate
 * queues in one tab or one Node process, not across tabs.
 */
export function createMemoryLocks(): QueueLocks {
  const waits = createWaitList();
  return {
    request<T>(name: string, callback: () => T | PromiseLike<T>, options?: LockRequestOptions): Promise<T> {
      const signal = options && options.signal;
      return new Promise<T>((resolve, reject) => {
        if (signal && signal.aborted) {
          reject(abortError());
          return;
        }
        let onAbort: (() => void) | undefined;
        const run = () => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          Promise.resolve()
            .then(callback)
            .then(
              (value) => {
                waits.next(name);
                resolve(value);
              },
              (error: unknown) => {
                waits.next(name);
                reject(error);
              },
            );
        };
        const leave = waits.enter(name, run);
        if (signal) {
          onAbort = () => {
            if (leave()) reject(abortError());
          };
          signal.addEventListener('abort', onAbort);
        }
      });
    },
  };
}

/** The part of the Web Locks `LockManager` used here. */
export interface LockManagerLike {
  request(name: string, options: { signal?: AbortSignalLike }, callback: (lock: unknown) => unknown): Promise<unknown>;
}

function isLockManager(value: unknown): value is LockManagerLike {
  return !!value && typeof (value as LockManagerLike).request === 'function';
}

/** The browser's `navigator.locks`, if it has one. */
export function getLockManager(): LockManagerLike | undefined {
  const nav = getNavigator();
  const locks = nav ? nav.locks : undefined;
  return isLockManager(locks) ? locks : undefined;
}

/**
 * Locks from the Web Locks API (`navigator.locks`, or the manager you pass).
 * They are shared by every tab and worker of the origin, and the browser
 * releases a tab's locks when the tab closes or crashes.
 */
export function createWebLocks(lockManager?: LockManagerLike): QueueLocks {
  const manager = lockManager !== undefined ? lockManager : getLockManager();
  if (!isLockManager(manager)) {
    throw new TypeError('createWebLocks: navigator.locks is not available here. Pass a LockManager.');
  }
  return {
    request: <T>(name: string, callback: () => T | PromiseLike<T>, options?: LockRequestOptions) =>
      manager.request(name, options && options.signal ? { signal: options.signal } : {}, () => callback()) as Promise<T>,
  };
}

/** The part of `BroadcastChannel` used here. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: EventListenerLike): void;
  removeEventListener(type: 'message', listener: EventListenerLike): void;
  close(): void;
}

/** Creates a `BroadcastChannel`, or throws when the host has none. */
export function openBroadcastChannel(name: string): BroadcastChannelLike {
  const Ctor = readGlobal('BroadcastChannel');
  if (typeof Ctor !== 'function') throw new TypeError('BroadcastChannel is not available here.');
  return new (Ctor as new (name: string) => BroadcastChannelLike)(name);
}

export interface BroadcastChannelLocksOptions {
  /** Default `'idempotent-queue:locks'`. */
  channelName?: string;
  /** How long a claim waits for objections before it wins. Default 100. */
  probeMs?: number;
  /** How long a waiting request waits for a release message before claiming again. Default 1000. */
  retryMs?: number;
  /** Default: `new BroadcastChannel(name)`. */
  createChannel?: (name: string) => BroadcastChannelLike;
}

type LockMessage =
  | { t: 'claim'; name: string; id: string; at: number }
  | { t: 'held'; name: string; id: string }
  | { t: 'released'; name: string; id: string };

function isLockMessage(value: unknown): value is LockMessage {
  if (!value || typeof value !== 'object') return false;
  const { t, name, id } = value as { t?: unknown; name?: unknown; id?: unknown };
  if (typeof name !== 'string' || typeof id !== 'string') return false;
  if (t === 'claim') return typeof (value as { at?: unknown }).at === 'number';
  return t === 'held' || t === 'released';
}

/**
 * A fallback for browsers without Web Locks, built on `BroadcastChannel`.
 *
 * To take a lock, a tab broadcasts a claim and waits `probeMs`. The holder of
 * the lock answers every claim with `held`; of two tabs claiming at once, the
 * earlier claim wins, and the tab that made it answers the later one with
 * `held` too. A tab that hears an objection waits for a `released`
 * message, or `retryMs`, and claims again. A tab that closes stops answering,
 * so the next claim after it is gone wins.
 *
 * This is best effort. It assumes messages arrive within `probeMs`, and a tab
 * that the browser freezes (for example in the back-forward cache) cannot
 * answer claims, so another tab can take the lock while the frozen one still
 * thinks it holds it. Use Web Locks wherever they exist.
 */
export function createBroadcastChannelLocks(options: BroadcastChannelLocksOptions = {}): QueueLocks {
  const channelName = options.channelName || 'idempotent-queue:locks';
  const probeMs = options.probeMs !== undefined ? options.probeMs : 100;
  const retryMs = options.retryMs !== undefined ? options.retryMs : 1000;
  const create = options.createChannel || openBroadcastChannel;
  // Fail now, not on the first request, when BroadcastChannel is missing.
  if (!options.createChannel && typeof readGlobal('BroadcastChannel') !== 'function') {
    throw new TypeError('createBroadcastChannelLocks: BroadcastChannel is not available here.');
  }
  const id = randomId();
  const held = new Set<string>();
  /** Claims this tab is probing, by lock name. */
  const claiming = new Map<string, { at: number; id: string }>();
  const listeners = new Set<(message: LockMessage) => void>();
  let channel: BroadcastChannelLike | undefined;
  let users = 0;

  const onMessage: EventListenerLike = (event) => {
    const message = event && typeof event === 'object' ? (event as { data?: unknown }).data : undefined;
    if (!isLockMessage(message) || message.id === id) return;
    if (message.t === 'claim') {
      // Object to a claim while holding the lock, and while probing an earlier claim: a tab
      // whose channel opened after this tab's claim never saw it, and must hear about it now.
      const mine = claiming.get(message.name);
      if (held.has(message.name) || (mine && earlier(mine, message))) post({ t: 'held', name: message.name, id });
    }
    listeners.forEach((listener) => listener(message));
  };

  const earlier = (a: { at: number; id: string }, b: { at: number; id: string }) =>
    a.at < b.at || (a.at === b.at && a.id < b.id);

  function post(message: LockMessage): void {
    if (channel) channel.postMessage(message);
  }

  // The channel stays open only while a lock is wanted or held, so an idle page or process holds no handle.
  function retain(): void {
    if (users++ === 0) {
      channel = create(channelName);
      channel.addEventListener('message', onMessage);
    }
  }

  function releaseChannel(): void {
    if (--users === 0 && channel) {
      channel.removeEventListener('message', onMessage);
      channel.close();
      channel = undefined;
    }
  }

  const sleep = (ms: number, wake?: (resume: () => void) => void) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      if (wake) wake(finish);
    });

  /** Resolves `true` when the lock is won, `false` when `aborted` resolves first. */
  async function acquire(name: string, aborted: Promise<void>): Promise<boolean> {
    let stop = false;
    void aborted.then(() => {
      stop = true;
      if (wakeUp) wakeUp();
    });
    let wakeUp: (() => void) | undefined;
    let onRelease: (() => void) | undefined;
    while (!stop) {
      const claim = { t: 'claim' as const, name, id, at: Date.now() };
      let objected = false;
      const listener = (message: LockMessage) => {
        if (message.name !== name) return;
        if (message.t === 'held') objected = true;
        else if (message.t === 'claim' && earlier(message, claim)) objected = true;
        else if (message.t === 'released' && onRelease) onRelease();
      };
      listeners.add(listener);
      try {
        claiming.set(name, claim);
        post(claim);
        await sleep(probeMs, (resume) => (wakeUp = resume));
        wakeUp = undefined;
        claiming.delete(name);
        if (stop) return false;
        if (!objected) {
          held.add(name);
          return true;
        }
        // Spread retries so waiting tabs do not claim in lockstep. A release wakes this wait early,
        // never the probe above: cutting a probe short could let two claims both win.
        await sleep(retryMs * (0.5 + Math.random()), (resume) => (wakeUp = onRelease = resume));
        wakeUp = onRelease = undefined;
      } finally {
        if (claiming.get(name) === claim) claiming.delete(name);
        listeners.delete(listener);
      }
    }
    return false;
  }

  function release(name: string): void {
    if (held.delete(name)) post({ t: 'released', name, id });
  }

  const waits = createWaitList();

  return {
    request<T>(name: string, callback: () => T | PromiseLike<T>, options?: LockRequestOptions): Promise<T> {
      const signal = options && options.signal;
      return new Promise<T>((resolve, reject) => {
        if (signal && signal.aborted) {
          reject(abortError());
          return;
        }
        let onAbort: (() => void) | undefined;
        let cancel: (() => void) | undefined;
        const done = () => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        };
        const run = () => {
          retain();
          let acquired = false;
          const finish = () => {
            if (acquired) release(name);
            releaseChannel();
            waits.next(name);
          };
          const aborted = new Promise<void>((resolveAbort) => (cancel = resolveAbort));
          acquire(name, aborted).then(
            (won) => {
              done();
              if (!won) {
                finish();
                reject(abortError());
                return;
              }
              acquired = true;
              Promise.resolve()
                .then(callback)
                .then(
                  (value) => {
                    finish();
                    resolve(value);
                  },
                  (error: unknown) => {
                    finish();
                    reject(error);
                  },
                );
            },
            (error: unknown) => {
              done();
              finish();
              reject(error);
            },
          );
        };
        const leave = waits.enter(name, run);
        if (signal) {
          onAbort = () => {
            if (leave()) {
              done();
              reject(abortError());
            } else if (cancel) cancel();
          };
          signal.addEventListener('abort', onAbort);
        }
      });
    },
  };
}
