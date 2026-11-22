import { backoffDelay, resolveRetryPolicy } from './backoff.js';
import { createBroadcastQueueChannel, createMemoryChannel, type BroadcastQueueChannel } from './channel.js';
import { defaultClassifyError, httpDetails } from './classify.js';
import { createBrowserConnectivity, hasBrowserConnectivity, subscribeToPageVisibility } from './connectivity.js';
import { getDocument, isBrowserLike, randomId, readGlobal } from './env.js';
import { getKeySource, uuidV4, validateKey } from './keys.js';
import { createBroadcastChannelLocks, createMemoryLocks, createWebLocks, getLockManager } from './locks.js';
import { DEFAULT_STORAGE_KEY, QueuePersistence, type Mutator } from './persistence.js';
import { createIndexedDBStorage, createMemoryStorage, isMemoryStorage } from './storage.js';
import type {
  AbortSignalLike,
  EnqueueInput,
  ErrorClassification,
  IdempotentQueue,
  JsonObject,
  KeySource,
  QueueChannel,
  QueueErrorKind,
  QueueEvent,
  QueueItem,
  QueueItemError,
  QueueListener,
  QueueLocks,
  QueueOptions,
  QueueStorage,
  QueueTimers,
} from './types.js';

const HOUR = 60 * 60 * 1000;
/** Longer waits are split into wake-ups of at most a minute, so a suspended laptop catches up soon after it wakes. */
const MAX_TIMER_DELAY = 60 * 1000;
const MAX_ERROR_MESSAGE = 500;
const LOG_PREFIX = '[idempotent-queue]';

const defaultTimers: QueueTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Locks for queues in this realm when the host has no lock API. */
let realmLocks: QueueLocks | undefined;
const getRealmLocks = () => realmLocks || (realmLocks = createMemoryLocks());
/** Queues sharing a memory storage object share locks and a channel by default; other memory storages are unrelated. */
const memoryLocks = new WeakMap<object, QueueLocks>();
const memoryChannels = new WeakMap<object, QueueChannel>();
let warnedMemoryFallback = false;

function cloneJson<T>(value: T, name: string): T {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${name} must be JSON-serializable: ${String(error)}`);
  }
  if (text === undefined) throw new TypeError(`${name} must be JSON-serializable`);
  return JSON.parse(text) as T;
}

function errorMessage(error: unknown): string {
  let message: string;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    message = (error as { message: string }).message;
  } else {
    try {
      message = typeof error === 'string' ? error : String(error);
    } catch {
      message = 'Unknown error';
    }
  }
  return message.length > MAX_ERROR_MESSAGE ? message.slice(0, MAX_ERROR_MESSAGE) : message;
}

function toItemError(kind: QueueErrorKind, error: unknown, at: number): QueueItemError {
  const result: QueueItemError = { kind, message: errorMessage(error), at };
  const details = httpDetails(error);
  if (details) result.status = details.status;
  return result;
}

function isClassification(value: unknown): value is ErrorClassification {
  if (!value || typeof value !== 'object') return false;
  const { type, delayMs } = value as { type?: unknown; delayMs?: unknown };
  if (type === 'permanent') return true;
  if (type === 'retryable') return delayMs === undefined || (typeof delayMs === 'number' && !Number.isNaN(delayMs));
  if (type === 'rateLimited') return typeof delayMs === 'number' && !Number.isNaN(delayMs);
  return false;
}

function checkCount(name: string, value: number | undefined, fallback: number, min: number, integer: boolean): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value) || value < min || (integer && Math.floor(value) !== value)) {
    throw new TypeError(`${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}, got ${String(value)}`);
  }
  return value;
}

function isStorage(value: unknown): value is QueueStorage {
  return (
    !!value &&
    typeof (value as QueueStorage).getItem === 'function' &&
    typeof (value as QueueStorage).setItem === 'function' &&
    typeof (value as QueueStorage).removeItem === 'function'
  );
}

function defaultStorage(): QueueStorage {
  if (readGlobal('indexedDB')) return createIndexedDBStorage();
  if (isBrowserLike() && !warnedMemoryFallback) {
    warnedMemoryFallback = true;
    console.warn(`${LOG_PREFIX} indexedDB is not available, so the queue is kept in memory and lost on reload.`);
  }
  return createMemoryStorage();
}

function defaultLocks(storage: QueueStorage, prefix: string): QueueLocks {
  if (isMemoryStorage(storage)) {
    let shared = memoryLocks.get(storage);
    if (!shared) memoryLocks.set(storage, (shared = createMemoryLocks()));
    return shared;
  }
  if (getLockManager()) return createWebLocks();
  if (isBrowserLike() && typeof readGlobal('BroadcastChannel') === 'function') {
    return createBroadcastChannelLocks({ channelName: `${prefix}:locks` });
  }
  return getRealmLocks();
}

interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(): void;
}

function createAbortController(): AbortControllerLike | undefined {
  const Ctor = readGlobal('AbortController');
  return typeof Ctor === 'function' ? new (Ctor as new () => AbortControllerLike)() : undefined;
}

const replaceAt = <T>(list: readonly T[], index: number, value: T): T[] => {
  const copy = list.slice();
  copy[index] = value;
  return copy;
};

/**
 * Creates a queue. Nothing is read or sent until `start()` (or `load()`,
 * `enqueue()`) is called. Use one queue per `storageKey` in each tab; tabs
 * that use the same storage and `storageKey` share the queue.
 */
export function createIdempotentQueue<TPayload = unknown, TResult = unknown>(
  options: QueueOptions<TPayload, TResult>,
): IdempotentQueue<TPayload, TResult> {
  type Item = QueueItem<TPayload>;
  type Event = QueueEvent<TPayload, TResult>;

  if (!options || typeof options !== 'object') throw new TypeError('createIdempotentQueue: options are required');
  const { send } = options;
  if (options.storage !== undefined && !isStorage(options.storage)) {
    throw new TypeError('createIdempotentQueue: storage needs getItem, setItem and removeItem');
  }
  if (typeof send !== 'function') throw new TypeError('createIdempotentQueue: send must be a function');
  if (options.locks !== undefined && (!options.locks || typeof options.locks.request !== 'function')) {
    throw new TypeError('createIdempotentQueue: locks needs a request method');
  }
  if (
    options.channel &&
    (typeof options.channel.postMessage !== 'function' || typeof options.channel.subscribe !== 'function')
  ) {
    throw new TypeError('createIdempotentQueue: channel needs postMessage and subscribe');
  }

  const policy = resolveRetryPolicy(options.retry);
  const concurrency = checkCount('concurrency', options.concurrency, 1, 1, true);
  const keepSucceededMs = checkCount('keepSucceededMs', options.keepSucceededMs, 24 * HOUR, 0, false);
  const offlineRecheckMs = checkCount('offlineRecheckMs', options.offlineRecheckMs, 5000, 1, false);
  const syncIntervalMs = checkCount('syncIntervalMs', options.syncIntervalMs, 2000, 1, false);
  const prefix = options.storageKey || DEFAULT_STORAGE_KEY;
  const now = options.now || (() => Date.now());
  const random = options.random || Math.random;
  const timers = options.timers || defaultTimers;
  const classify = options.classifyError || defaultClassifyError;
  const generateKey = options.generateKey || uuidV4;
  const keySource: KeySource = options.generateKey ? 'custom' : getKeySource();
  const storage = options.storage || defaultStorage();
  const locks = options.locks || defaultLocks(storage, prefix);
  const senderLock = `${prefix}:sender`;
  const instanceId = randomId();

  let isOnline = options.isOnline;
  let subscribeToConnectivity = options.subscribeToConnectivity;
  if (!isOnline && !subscribeToConnectivity && hasBrowserConnectivity()) {
    ({ isOnline, subscribeToConnectivity } = createBrowserConnectivity());
  }
  const subscribeToVisibility =
    options.subscribeToVisibility !== undefined
      ? options.subscribeToVisibility
      : getDocument()
        ? (listener: () => void) => subscribeToPageVisibility(listener)
        : null;

  const listeners = new Set<QueueListener<TPayload, TResult>>();
  /** The last committed state this tab saw. Every change goes through storage first. */
  let snapshot: readonly Item[] = Object.freeze([]);
  let byId = new Map<string, Item>();
  let knownData: string | undefined;

  let loaded = false;
  let loading: Promise<void> | undefined;
  let running = false;
  let sender = false;
  let resign: (() => void) | undefined;
  let generation = 0;
  let abortSender: AbortControllerLike | undefined;

  /** Keys with a request in flight from this tab, including one whose item was discarded. */
  const inflightKeys = new Set<string>();
  /** Items this tab is claiming or sending. Any other stored `inflight` item is left over from a closed tab. */
  const ownIds = new Set<string>();
  const busyGroups = new Set<string>();
  let active = 0;
  const tasks = new Set<Promise<void>>();

  let channel: QueueChannel | undefined;
  let ownedChannel: BroadcastQueueChannel | undefined;
  let unsubscribeChannel: (() => void) | undefined;
  let unsubscribeConnectivity: (() => void) | undefined;
  let unsubscribeVisibility: (() => void) | undefined;
  let online = true;
  let timer: unknown;
  let timerAt = Infinity;
  let syncTimer: unknown;
  let pausedUntil = 0;
  let pumpScheduled = false;
  let pumping = false;
  let pumpAgain = false;
  let refreshing = false;
  let refreshAgain = false;
  let housekeeping = false;
  let idleWaiters: Array<() => void> = [];

  function emit(event: Event): void {
    if ((event.type === 'storage-error' || event.type === 'lock-error') && listeners.size === 0) {
      console.warn(`${LOG_PREFIX} ${event.type === 'lock-error' ? 'Lock' : 'Storage'} error:`, event.error);
    }
    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.warn(`${LOG_PREFIX} A queue listener threw:`, error);
      }
    });
  }

  function setCache(items: readonly QueueItem[], data: string): boolean {
    if (data === knownData) return false;
    knownData = data;
    snapshot = Object.freeze(items.slice()) as readonly Item[];
    byId = new Map(snapshot.map((item) => [item.id, item]));
    return true;
  }

  /** The channel given in the options, or the default one for this storage. Created on first use. */
  function resolveChannel(): QueueChannel | undefined {
    if (channel) return channel;
    if (options.channel === null) return undefined;
    if (options.channel) return (channel = options.channel);
    if (isMemoryStorage(storage)) {
      let shared = memoryChannels.get(storage);
      if (!shared) memoryChannels.set(storage, (shared = createMemoryChannel()));
      return (channel = shared);
    }
    if (isBrowserLike() && typeof readGlobal('BroadcastChannel') === 'function') {
      return (channel = ownedChannel = createBroadcastQueueChannel(`${prefix}:changes`));
    }
    return undefined;
  }

  function closeOwnedChannel(): void {
    if (!ownedChannel) return;
    if (channel === ownedChannel) channel = undefined;
    ownedChannel.close();
    ownedChannel = undefined;
  }

  function postChanged(): void {
    const target = resolveChannel();
    if (!target) return;
    try {
      target.postMessage({ type: 'changed', source: instanceId });
    } catch (error) {
      emit({ type: 'storage-error', error });
    }
    // A stopped tab does not keep a BroadcastChannel open; messages already posted are still delivered.
    if (!running) closeOwnedChannel();
  }

  const persistence = new QueuePersistence(storage, prefix, locks, {
    onCommit: ({ baseData, items, data }) => {
      const external = knownData !== undefined && baseData !== knownData;
      setCache(items, data);
      if (data !== baseData) postChanged();
      if (external && loaded) {
        emit({ type: 'synced', items: snapshot });
        schedulePump();
      }
    },
    onCleared: () => {
      setCache([], '[]');
      postChanged();
    },
    onQuarantine: (reason, storageKey) => emit({ type: 'quarantined', reason, storageKey }),
    onStorageError: (error) => emit({ type: 'storage-error', error }),
    now,
  });

  const transact = <R>(mutator: Mutator<R>) => persistence.transact(mutator as Mutator<R>);

  function getItems(): readonly Item[] {
    return snapshot;
  }

  function load(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (!loading) {
      loading = persistence.load().then(
        (state) => {
          knownData = undefined;
          setCache(state.items, state.data);
          loaded = true;
          emit({ type: 'loaded', items: snapshot });
        },
        (error: unknown) => {
          loading = undefined;
          throw error;
        },
      );
    }
    return loading;
  }

  /** Reads storage again, in order with this tab's writes, to pick up other tabs' changes. */
  function refresh(): void {
    if (!loaded) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    transact(() => ({ result: undefined }))
      .then(undefined, (error: unknown) => emit({ type: 'storage-error', error }))
      .then(() => {
        refreshing = false;
        if (refreshAgain) {
          refreshAgain = false;
          refresh();
        }
      });
  }

  function scheduleSync(): void {
    if (syncTimer !== undefined || !running || resolveChannel()) return;
    syncTimer = timers.setTimeout(() => {
      syncTimer = undefined;
      refresh();
      scheduleSync();
    }, syncIntervalMs);
  }

  function newId(items: readonly QueueItem[]): string {
    for (let i = 0; i < 5; i++) {
      const id = generateKey();
      if (!byId.has(id) && !items.some((item) => item.id === id)) return id;
    }
    throw new Error('createIdempotentQueue: generateKey keeps returning ids that already exist');
  }

  async function enqueue(input: EnqueueInput<TPayload>): Promise<Item> {
    if (!input || typeof input !== 'object') throw new TypeError('enqueue: input must be an object');
    const explicitKey = input.key !== undefined ? validateKey(input.key, 'enqueue: key') : undefined;
    if (input.group !== undefined && (typeof input.group !== 'string' || input.group === '')) {
      throw new TypeError('enqueue: group must be a non-empty string');
    }
    if (
      input.metadata !== undefined &&
      (input.metadata === null || typeof input.metadata !== 'object' || Array.isArray(input.metadata))
    ) {
      throw new TypeError('enqueue: metadata must be an object');
    }
    const payload = cloneJson(input.payload, 'enqueue: payload');
    const metadata = input.metadata === undefined ? undefined : cloneJson(input.metadata, 'enqueue: metadata');

    await load();

    let key = explicitKey;
    if (key === undefined) {
      key = validateKey(generateKey(), 'generateKey()');
      for (let i = 0; snapshot.some((item) => item.key === key); i++) {
        if (i >= 5) throw new Error('enqueue: generateKey keeps returning keys that already exist');
        key = validateKey(generateKey(), 'generateKey()');
      }
    }
    const itemKey = key;
    const id = newId(snapshot);
    const t = now();

    // Deduplicated against the stored items, in the same atomic step that adds the item,
    // so two tabs enqueuing one key at once still create one item.
    const outcome = await transact<{ item: Item; created: boolean }>((stored) => {
      const existing = stored.find((item) => item.key === itemKey) as Item | undefined;
      if (existing) {
        if (explicitKey === undefined) throw new Error('enqueue: generateKey returned a key that already exists');
        return { result: { item: existing, created: false } };
      }
      if (stored.some((item) => item.id === id)) throw new Error('enqueue: generateKey returned an id that already exists');
      let sequence = 1;
      for (const item of stored) if (item.sequence >= sequence) sequence = item.sequence + 1;
      const item = {
        id,
        key: itemKey,
        payload,
        status: 'pending',
        attempts: 0,
        sequence,
        createdAt: t,
        updatedAt: t,
        nextAttemptAt: t,
      } as { -readonly [K in keyof Item]: Item[K] };
      if (input.group !== undefined) item.group = input.group;
      if (metadata !== undefined) item.metadata = metadata as JsonObject;
      return { items: stored.concat([item as QueueItem]), result: { item, created: true } };
    });
    const current = byId.get(outcome.item.id) || outcome.item;
    if (outcome.created) {
      emit({ type: 'enqueued', item: current });
      schedulePump();
    }
    return current;
  }

  function schedulePump(): void {
    if (pumpScheduled) return;
    pumpScheduled = true;
    Promise.resolve().then(() => {
      pumpScheduled = false;
      void runPump();
    });
  }

  async function runPump(): Promise<void> {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        await pumpOnce();
      } while (pumpAgain);
    } catch (error) {
      emit({ type: 'storage-error', error });
    } finally {
      pumping = false;
    }
    if (active === 0 && !pumpScheduled && !housekeeping) resolveIdle();
  }

  function resolveIdle(): void {
    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  function clearTimer(): void {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
    timerAt = Infinity;
  }

  function scheduleWake(at: number): void {
    if (timer !== undefined && timerAt === at) return;
    clearTimer();
    if (!running || !sender || at === Infinity) return;
    timerAt = at;
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, at - now()));
    timer = timers.setTimeout(() => {
      timer = undefined;
      timerAt = Infinity;
      schedulePump();
    }, delay);
  }

  /** Turns an `inflight` item whose attempt was interrupted back into `pending`, or `failed` after the last attempt. */
  function recovered(item: QueueItem, t: number): QueueItem {
    if (item.attempts >= policy.maxAttempts) {
      return {
        ...item,
        status: 'failed',
        updatedAt: t,
        lastError: {
          kind: 'interrupted',
          message: 'The sending tab or process stopped while the last allowed attempt was in flight.',
          at: t,
        },
      };
    }
    return { ...item, status: 'pending', updatedAt: t, nextAttemptAt: t };
  }

  /**
   * Housekeeping that only the sending tab does, in one transaction:
   * - an `inflight` item that this tab is not sending was left by a tab that
   *   closed or crashed while sending it (only one tab sends at a time), so it
   *   goes back to `pending` and is sent again with the same key;
   * - succeeded items older than `keepSucceededMs` are removed.
   * It runs on every pass of the queue rather than on its own timer, so an
   * idle queue keeps no timer.
   */
  async function housekeep(t: number): Promise<void> {
    const orphaned = snapshot.some((item) => item.status === 'inflight' && !ownIds.has(item.id));
    const expired = (item: QueueItem) => {
      if (keepSucceededMs === Infinity || item.status !== 'succeeded') return false;
      const completed = item.completedAt !== undefined ? item.completedAt : item.updatedAt;
      return completed + keepSucceededMs <= t;
    };
    if (!orphaned && !snapshot.some(expired)) return;
    housekeeping = true;
    try {
      const { updated, removed } = await transact((stored) => {
        const updatedItems: QueueItem[] = [];
        const removedItems: QueueItem[] = [];
        const next: QueueItem[] = [];
        for (const item of stored) {
          if (item.status === 'inflight' && !ownIds.has(item.id)) {
            const back = recovered(item, t);
            updatedItems.push(back);
            next.push(back);
          } else if (expired(item)) {
            removedItems.push(item);
          } else {
            next.push(item);
          }
        }
        if (updatedItems.length === 0 && removedItems.length === 0) return { result: { updated: [], removed: [] } };
        return { items: next, result: { updated: updatedItems, removed: removedItems } };
      });
      updated.forEach((item) => emit({ type: 'updated', item: item as Item }));
      removed.forEach((item) => emit({ type: 'removed', item: item as Item }));
    } catch (error) {
      emit({ type: 'storage-error', error });
      pause(t);
    } finally {
      housekeeping = false;
    }
  }

  /** After a storage error, the sender waits a little before it tries again, instead of spinning. */
  function pause(t: number): void {
    pausedUntil = t + Math.max(1, backoffDelay(2, policy, random));
  }

  /** Items that may start now, in order, and when the next waiting one becomes due. */
  function collectDue(t: number): { due: Item[]; wake: number } {
    const due: Item[] = [];
    let wake = Infinity;
    const blockedGroups = new Set(busyGroups);
    const claimedKeys = new Set<string>();
    snapshot.forEach((item) => {
      if (item.status === 'inflight' && item.group !== undefined) blockedGroups.add(item.group);
    });
    snapshot.forEach((item) => {
      if (item.status !== 'pending') return;
      if (item.group !== undefined) {
        // Only the oldest pending item of a group may go, and only when none is in flight.
        if (blockedGroups.has(item.group)) return;
        blockedGroups.add(item.group);
      }
      // Never two requests with the same key at once.
      if (inflightKeys.has(item.key) || claimedKeys.has(item.key)) return;
      if (item.nextAttemptAt > t) {
        if (item.nextAttemptAt < wake) wake = item.nextAttemptAt;
        return;
      }
      claimedKeys.add(item.key);
      due.push(item);
    });
    return { due, wake };
  }

  async function checkOnline(): Promise<boolean> {
    if (!isOnline) return online;
    try {
      return (await isOnline()) !== false;
    } catch {
      return true;
    }
  }

  async function pumpOnce(): Promise<void> {
    if (!running || !sender || !loaded) return;
    let t = now();
    if (t < pausedUntil) {
      scheduleWake(pausedUntil);
      return;
    }
    await housekeep(t);
    if (!running || !sender) return;
    t = now();
    if (t < pausedUntil) {
      scheduleWake(pausedUntil);
      return;
    }
    let { due, wake } = collectDue(t);
    let offline = false;
    if (due.length > 0 && active < concurrency) {
      const reachable = await checkOnline();
      if (!running || !sender) return;
      t = now();
      if (reachable) {
        ({ due, wake } = collectDue(t));
        for (const item of due) {
          if (active >= concurrency) break;
          startAttempt(item, t);
        }
      } else {
        offline = true;
      }
    }
    let at = wake;
    if (offline && !subscribeToConnectivity) at = Math.min(at, t + offlineRecheckMs);
    scheduleWake(at);
  }

  function startAttempt(item: Item, t: number): void {
    active++;
    inflightKeys.add(item.key);
    ownIds.add(item.id);
    if (item.group !== undefined) busyGroups.add(item.group);
    const task = runAttempt(item, t).then(undefined, (error: unknown) => emit({ type: 'storage-error', error }));
    tasks.add(task);
    void task.then(() => tasks.delete(task));
  }

  /** Marks the item in flight in storage, if it is still due there. */
  function claim(id: string, t: number): Mutator<QueueItem | undefined> {
    return (stored) => {
      const index = stored.findIndex((item) => item.id === id);
      if (index < 0) return { result: undefined };
      const item = stored[index];
      if (item.status !== 'pending' || item.nextAttemptAt > t) return { result: undefined };
      if (
        item.group !== undefined &&
        stored.some(
          (other) =>
            other.id !== id &&
            other.group === item.group &&
            (other.status === 'inflight' || (other.status === 'pending' && other.sequence < item.sequence)),
        )
      ) {
        return { result: undefined };
      }
      const next: QueueItem = { ...item, status: 'inflight', attempts: item.attempts + 1, updatedAt: t };
      return { items: replaceAt(stored, index, next), result: next };
    };
  }

  /** Applies `change` to the stored copy of an attempt this tab made, unless it was discarded, cleared or retried meanwhile. */
  function settle(attempt: Item, change: (item: QueueItem) => QueueItem): Mutator<Item | undefined> {
    return (stored) => {
      const index = stored.findIndex((item) => item.id === attempt.id);
      if (index < 0) return { result: undefined };
      const item = stored[index];
      if (item.status !== 'inflight' || item.attempts !== attempt.attempts) return { result: undefined };
      const next = change(item);
      return { items: replaceAt(stored, index, next), result: next as Item };
    };
  }

  async function runAttempt(candidate: Item, t: number): Promise<void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      inflightKeys.delete(candidate.key);
      ownIds.delete(candidate.id);
      if (candidate.group !== undefined) busyGroups.delete(candidate.group);
      schedulePump();
    };
    try {
      // The attempt is counted in storage before the request leaves.
      let item: Item | undefined;
      try {
        item = (await transact(claim(candidate.id, t))) as Item | undefined;
      } catch (error) {
        emit({ type: 'storage-error', error });
        pause(now());
        return;
      }
      if (!item) return;
      emit({ type: 'attempt', item });
      if (!running) {
        // Stopped before sending: give the attempt back.
        const attempt = item;
        try {
          const back = await transact(
            settle(attempt, (stored) => ({
              ...stored,
              status: 'pending',
              attempts: stored.attempts - 1,
              updatedAt: now(),
              nextAttemptAt: now(),
            })),
          );
          if (back) emit({ type: 'updated', item: back });
        } catch (error) {
          // Left inflight in storage; the next sending tab recovers it.
          emit({ type: 'storage-error', error });
        }
        return;
      }

      let result: TResult | undefined;
      let failure: { error: unknown } | undefined;
      try {
        result = await send(item, { key: item.key, attempt: item.attempts });
      } catch (error) {
        failure = { error };
      }

      const at = now();
      let change: (stored: QueueItem) => QueueItem;
      let toEvent: (next: Item) => Event;
      if (!failure) {
        change = (stored) => {
          const { lastError: _ignored, ...rest } = stored;
          return { ...rest, status: 'succeeded', updatedAt: at, nextAttemptAt: at, completedAt: at };
        };
        toEvent = (next) => ({ type: 'succeeded', item: next, result: result as TResult });
      } else {
        const { error } = failure;
        let decision: ErrorClassification;
        try {
          const value: unknown = classify(error, { item, attempt: item.attempts, now: at });
          decision = isClassification(value) ? value : { type: 'retryable' };
        } catch {
          decision = { type: 'retryable' };
        }
        if (decision.type === 'permanent') {
          change = (stored) => ({ ...stored, status: 'dead', updatedAt: at, lastError: toItemError('permanent', error, at) });
          toEvent = (next) => ({ type: 'dead', item: next, error });
        } else if (item.attempts >= policy.maxAttempts) {
          const kind = decision.type;
          change = (stored) => ({ ...stored, status: 'failed', updatedAt: at, lastError: toItemError(kind, error, at) });
          toEvent = (next) => ({ type: 'failed', item: next, error });
        } else {
          const kind = decision.type;
          const delayMs =
            decision.delayMs !== undefined ? Math.max(0, decision.delayMs) : backoffDelay(item.attempts, policy, random);
          change = (stored) => ({
            ...stored,
            status: 'pending',
            updatedAt: at,
            nextAttemptAt: at + delayMs,
            lastError: toItemError(kind, error, at),
          });
          toEvent = (next) => ({ type: 'retry-scheduled', item: next, error, delayMs });
        }
      }
      let next: Item | undefined;
      try {
        next = await transact(settle(item, change));
      } catch (error) {
        // The item stays inflight in storage. Once this attempt is released it no longer
        // belongs to this tab, so housekeeping returns it to pending and it is sent again
        // with the same key.
        emit({ type: 'storage-error', error });
        pause(now());
        return;
      }
      // Discarded, cleared or retried while in flight: the result is ignored.
      if (next) emit(toEvent(next));
    } finally {
      release();
    }
  }

  function requestSender(): void {
    const gen = ++generation;
    const controller = createAbortController();
    abortSender = controller;
    const acquired = () => {
      if (gen !== generation || !running) return undefined;
      return new Promise<void>((resolve) => {
        resign = resolve;
        sender = true;
        emit({ type: 'sender', active: true });
        schedulePump();
      });
    };
    locks.request(senderLock, acquired, controller ? { signal: controller.signal } : undefined).then(
      undefined,
      (error: unknown) => {
        if (gen === generation && running) emit({ type: 'lock-error', error });
      },
    );
  }

  function subscribeChannel(): void {
    const target = resolveChannel();
    if (target) {
      unsubscribeChannel = target.subscribe((message) => {
        if (message.source !== instanceId) refresh();
      });
    }
  }

  async function start(): Promise<void> {
    if (running) return load();
    running = true;
    if (subscribeToConnectivity && !unsubscribeConnectivity) {
      unsubscribeConnectivity = subscribeToConnectivity((value) => {
        online = value !== false;
        if (online) schedulePump();
      });
    }
    try {
      await load();
    } catch (error) {
      running = false;
      unsubscribeAll();
      throw error;
    }
    if (!running) return;
    subscribeChannel();
    // Catch changes made by other tabs between the load and the subscription.
    refresh();
    scheduleSync();
    if (subscribeToVisibility) {
      unsubscribeVisibility = subscribeToVisibility(() => {
        flush().then(undefined, (error: unknown) => emit({ type: 'storage-error', error }));
      });
    }
    requestSender();
  }

  function unsubscribeAll(): void {
    if (unsubscribeConnectivity) unsubscribeConnectivity();
    unsubscribeConnectivity = undefined;
    if (unsubscribeVisibility) unsubscribeVisibility();
    unsubscribeVisibility = undefined;
    if (unsubscribeChannel) unsubscribeChannel();
    unsubscribeChannel = undefined;
    if (syncTimer !== undefined) timers.clearTimeout(syncTimer);
    syncTimer = undefined;
  }

  async function stop(): Promise<void> {
    running = false;
    generation++;
    if (abortSender) abortSender.abort();
    abortSender = undefined;
    clearTimer();
    unsubscribeAll();
    // Keep the sender lock until this tab's attempts have settled, so no other tab sends them meanwhile.
    while (tasks.size > 0) await Promise.all(Array.from(tasks));
    // Hand the lock on even when `start()` ran meanwhile: its own request is waiting for this lock.
    if (sender) {
      sender = false;
      const done = resign;
      resign = undefined;
      if (done) done();
      emit({ type: 'sender', active: false });
    }
    if (running) return;
    resolveIdle();
    closeOwnedChannel();
  }

  async function flush(): Promise<void> {
    await load();
    if (!running) return;
    const t = now();
    await transact((stored) => {
      let changed = false;
      const next = stored.map((item) => {
        if (item.status !== 'pending' || item.nextAttemptAt <= t) return item;
        // A server's Retry-After is respected even when flushing.
        if (item.lastError && item.lastError.kind === 'rateLimited') return item;
        changed = true;
        return { ...item, nextAttemptAt: t, updatedAt: t };
      });
      return changed ? { items: next, result: undefined } : { result: undefined };
    });
    if (!running || !sender) return;
    const idle = new Promise<void>((resolve) => idleWaiters.push(resolve));
    schedulePump();
    await idle;
  }

  async function retry(id: string): Promise<Item> {
    await load();
    const t = now();
    const next = await transact<Item>((stored) => {
      const index = stored.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`retry: no item with id ${id}`);
      const item = stored[index];
      if (item.status === 'inflight' || item.status === 'succeeded') {
        throw new Error(`retry: the item is ${item.status}`);
      }
      const updated: QueueItem = { ...item, status: 'pending', attempts: 0, nextAttemptAt: t, updatedAt: t };
      return { items: replaceAt(stored, index, updated), result: updated as Item };
    });
    emit({ type: 'updated', item: next });
    schedulePump();
    return next;
  }

  async function discard(id: string): Promise<boolean> {
    await load();
    const removed = await transact<Item | undefined>((stored) => {
      const index = stored.findIndex((item) => item.id === id);
      if (index < 0) return { result: undefined };
      return { items: stored.slice(0, index).concat(stored.slice(index + 1)), result: stored[index] as Item };
    });
    if (!removed) return false;
    emit({ type: 'removed', item: removed });
    return true;
  }

  async function clear(): Promise<void> {
    const wasRunning = running;
    await stop();
    try {
      await load();
    } catch {
      // Unreadable storage is removed below anyway.
    }
    await persistence.clear();
    loaded = true;
    emit({ type: 'cleared' });
    if (wasRunning) await start();
  }

  function subscribe(listener: QueueListener<TPayload, TResult>): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    enqueue,
    load,
    start,
    stop,
    flush,
    getItems,
    retry,
    discard,
    subscribe,
    clear,
    isRunning: () => running,
    isSender: () => sender,
    keySource,
  };
}
