/** A value that survives `JSON.stringify` and `JSON.parse` unchanged. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object, used for item metadata. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * - `pending`: waiting to be sent, possibly until `nextAttemptAt`.
 * - `inflight`: the sending tab is running `send` for this item.
 * - `succeeded`: `send` resolved. Kept for `keepSucceededMs`, then pruned.
 * - `failed`: every allowed attempt failed with a retryable error. Call `retry(id)` to try again.
 * - `dead`: the classifier called the last error permanent. Call `retry(id)` to try again anyway.
 */
export type QueueItemStatus = 'pending' | 'inflight' | 'succeeded' | 'failed' | 'dead';

/**
 * Why the last attempt did not succeed.
 * `interrupted` means the sending tab or process stopped while the final allowed attempt was in flight.
 */
export type QueueErrorKind = 'retryable' | 'permanent' | 'rateLimited' | 'interrupted';

/** The last error of an item, as stored. */
export interface QueueItemError {
  kind: QueueErrorKind;
  message: string;
  /** HTTP status when the error carried one. */
  status?: number;
  /** When the error happened, in `now()` milliseconds. */
  at: number;
}

/** One request in the queue. Items are immutable snapshots; every change creates a new object. */
export interface QueueItem<TPayload = unknown> {
  /** Local identifier, used by `retry`, `discard` and UI lists. */
  readonly id: string;
  /** Idempotency key sent with every attempt of this item. Never changes. */
  readonly key: string;
  /** Items with the same group are sent one at a time, in enqueue order. */
  readonly group?: string;
  readonly payload: TPayload;
  readonly metadata?: JsonObject;
  readonly status: QueueItemStatus;
  /** Attempts started so far, including one interrupted by a closed tab or a stopped process. */
  readonly attempts: number;
  /** Enqueue order. */
  readonly sequence: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** A `pending` item is not sent before this time. */
  readonly nextAttemptAt: number;
  /** When the item succeeded. */
  readonly completedAt?: number;
  readonly lastError?: QueueItemError;
}

/** One write returned by `QueueStorage.update`. `value: null` removes the key. */
export interface StorageWrite {
  key: string;
  value: string | null;
}

/**
 * Key-value storage of strings. `createIndexedDBStorage`,
 * `createLocalStorageAdapter` and `createMemoryStorage` implement it; so can
 * an encrypted store with a small wrapper.
 */
export interface QueueStorage {
  getItem(key: string): Promise<string | null | undefined>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  /**
   * Optional. Reads `keys`, passes their values (in the same order, `null`
   * when missing) to `mutate`, and applies the writes `mutate` returns, as one
   * atomic step that no other tab or process can interleave with. `mutate` is
   * synchronous and may throw, in which case nothing is written and the
   * promise rejects with that error.
   *
   * Storage without `update` is protected by the `${storageKey}:storage` lock
   * around each read, change and write instead.
   */
  update?(keys: readonly string[], mutate: (values: Array<string | null>) => StorageWrite[]): Promise<void>;
}

/** The part of `AbortSignal` that lock implementations read. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface LockRequestOptions {
  /**
   * Gives up waiting when aborted: the request rejects and `callback` never
   * runs. Has no effect once the lock is held. The queue passes a native
   * `AbortSignal` when the host has `AbortController`.
   */
  signal?: AbortSignalLike;
}

/**
 * Exclusive named locks shared by every tab (or process) that shares the
 * storage. `navigator.locks` matches this through `createWebLocks`.
 */
export interface QueueLocks {
  /**
   * Waits for the lock `name`, runs `callback` while holding it, and releases
   * it when the promise `callback` returns settles. The lock must also be
   * released when the tab or process holding it ends. Implementations may
   * ignore `options`; the queue then releases a lock it no longer wants as
   * soon as it gets it.
   */
  request<T>(name: string, callback: () => T | PromiseLike<T>, options?: LockRequestOptions): Promise<T>;
}

/** Tells other tabs that the stored queue changed. */
export interface QueueChannelMessage {
  type: 'changed';
  /** Id of the queue instance that wrote. */
  source: string;
}

/** A message bus between tabs, such as a `BroadcastChannel`. See `createBroadcastQueueChannel`. */
export interface QueueChannel {
  postMessage(message: QueueChannelMessage): void;
  /** Calls `listener` for messages from other tabs. Returns an unsubscribe function. */
  subscribe(listener: (message: QueueChannelMessage) => void): () => void;
  /** Called by `stop()`. */
  close?(): void;
}

/** What `send` receives besides the item. */
export interface SendContext {
  /** The item's idempotency key. Send it to the server with every attempt. */
  key: string;
  /** 1 for the first attempt, 2 for the first retry, and so on. */
  attempt: number;
  /**
   * Aborted when the attempt runs longer than `attemptTimeoutMs`, or when
   * `stop({ abortAfterMs })` gives up waiting. Pass it to `fetch` (as
   * `fetchSender` does) so the request is cancelled. Present wherever the
   * host has `AbortController` (every current browser, Node 16+).
   */
  signal?: AbortSignalLike;
}

export interface StopOptions {
  /**
   * How long `stop()` waits for attempts in flight before it aborts them.
   * An aborted attempt counts as a retryable failure: the item goes back to
   * `pending`, due now, with the same key. Default: no limit, so `stop()`
   * waits until each attempt settles or reaches `attemptTimeoutMs`.
   */
  abortAfterMs?: number;
}

/** The classifier's decision about an error thrown by `send`. */
export type ErrorClassification =
  /** Try again after the backoff delay, or after `delayMs` when given. */
  | { type: 'retryable'; delayMs?: number }
  /** Never try again automatically. The item becomes `dead`. */
  | { type: 'permanent' }
  /** The server asked to wait. Try again after `delayMs`. */
  | { type: 'rateLimited'; delayMs: number };

export interface ClassifyContext<TPayload = unknown> {
  item: QueueItem<TPayload>;
  attempt: number;
  /** Current time from the queue's clock, for parsing HTTP dates. */
  now: number;
}

export type ErrorClassifier<TPayload = unknown> = (
  error: unknown,
  context: ClassifyContext<TPayload>,
) => ErrorClassification;

export interface RetryPolicy {
  /** Total attempts, including the first. `Infinity` retries forever. Default 8. */
  maxAttempts?: number;
  /** Upper bound of the first retry delay. Default 1000. */
  baseDelayMs?: number;
  /** Upper bound of any backoff delay. Default 60000. */
  maxDelayMs?: number;
}

/** Injectable timers, mainly for tests. */
export interface QueueTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Where the default key generator got its randomness from. */
export type KeySource = 'crypto.randomUUID' | 'crypto.getRandomValues' | 'Math.random' | 'custom';

export interface QueueOptions<TPayload = unknown, TResult = unknown> {
  /**
   * Sends one item. Resolve when the server accepted it; throw (or reject) otherwise.
   * Called again with the same `context.key` after a failure, a reload or a closed tab.
   */
  send: (item: QueueItem<TPayload>, context: SendContext) => Promise<TResult> | TResult;
  /**
   * Where items are stored. Default: `createIndexedDBStorage()` when
   * `indexedDB` exists, otherwise `createMemoryStorage()` (Node), which does
   * not survive a restart.
   */
  storage?: QueueStorage;
  /**
   * Locks shared by every tab using the same storage. Default:
   * `createWebLocks()` when `navigator.locks` exists, otherwise
   * `createBroadcastChannelLocks()` in browsers that have `BroadcastChannel`,
   * otherwise `createMemoryLocks()` shared by the whole process.
   */
  locks?: QueueLocks;
  /**
   * Notifies other tabs of changes. Default: `createBroadcastQueueChannel()`
   * in browsers that have `BroadcastChannel`, none in Node. `null` turns it off.
   */
  channel?: QueueChannel | null;
  /**
   * Without a channel, a running queue re-reads storage this often to see
   * other tabs' changes. Default 2000.
   */
  syncIntervalMs?: number;
  /**
   * Default: `defaultClassifyError`, for HTTP-like and network errors. A
   * `delayMs` below 0 counts as 0; `NaN` is ignored (the normal backoff
   * applies); `Infinity` or more than 7 days becomes `retry.maxDelayMs`.
   */
  classifyError?: ErrorClassifier<TPayload>;
  /**
   * How long one attempt may run. After that its `signal` is aborted and the
   * attempt counts as a retryable failure (same key, so a duplicate is safe
   * on a server that honours it). A `send` that ignores the signal keeps the
   * key blocked in this tab until it settles. Default 30000; `Infinity`
   * turns the limit off.
   */
  attemptTimeoutMs?: number;
  retry?: RetryPolicy;
  /**
   * Checked before sending. Offline items wait without using attempts.
   * Default: `navigator.onLine` where it exists, otherwise always online.
   */
  isOnline?: () => boolean | Promise<boolean>;
  /**
   * Calls the listener when connectivity changes and returns an unsubscribe
   * function. Default: the window's `online` and `offline` events, when
   * `isOnline` is not given either. Without it, an offline queue checks
   * `isOnline` again every `offlineRecheckMs`.
   */
  subscribeToConnectivity?: (listener: (online: boolean) => void) => () => void;
  /** How long an offline queue waits before checking `isOnline` again. Default 5000. */
  offlineRecheckMs?: number;
  /**
   * Calls the listener when the page becomes visible; the queue then calls
   * `flush()`. Default: the document's `visibilitychange` event. `null` turns it off.
   */
  subscribeToVisibility?: ((listener: () => void) => () => void) | null;
  /** Items sent at the same time. Items with the same `group` are always sequential. Default 1. */
  concurrency?: number;
  /**
   * How long succeeded items stay, to deduplicate repeated enqueues of a key.
   * They are removed at the next queue activity after this time. Default 24 hours.
   */
  keepSucceededMs?: number;
  /**
   * Prefix of the stored keys, the lock names and the channel name. Use one
   * queue per prefix in each tab. Default `'idempotent-queue'`.
   */
  storageKey?: string;
  /** Generates idempotency keys and item ids. Default: UUID v4, see `getKeySource()`. */
  generateKey?: () => string;
  now?: () => number;
  /** Returns a number in [0, 1). Used for backoff jitter. Default `Math.random`. */
  random?: () => number;
  timers?: QueueTimers;
}

export interface EnqueueInput<TPayload = unknown> {
  /** Must be JSON-serializable. It is stored in the browser or process. */
  payload: TPayload;
  /** Idempotency key. Generated when omitted. An existing key returns the existing item. */
  key?: string;
  group?: string;
  metadata?: JsonObject;
}

/** Events delivered to `subscribe` listeners. Every event may follow a change of `getItems()`. */
export type QueueEvent<TPayload = unknown, TResult = unknown> =
  | { type: 'loaded'; items: readonly QueueItem<TPayload>[] }
  | { type: 'enqueued'; item: QueueItem<TPayload> }
  | { type: 'attempt'; item: QueueItem<TPayload> }
  | { type: 'succeeded'; item: QueueItem<TPayload>; result: TResult }
  | { type: 'retry-scheduled'; item: QueueItem<TPayload>; error: unknown; delayMs: number }
  | { type: 'failed'; item: QueueItem<TPayload>; error: unknown }
  | { type: 'dead'; item: QueueItem<TPayload>; error: unknown }
  | { type: 'updated'; item: QueueItem<TPayload> }
  | { type: 'removed'; item: QueueItem<TPayload> }
  | { type: 'cleared' }
  /** Another tab changed the stored items; `getItems()` shows the new state. */
  | { type: 'synced'; items: readonly QueueItem<TPayload>[] }
  /** This tab became (`true`) or stopped being (`false`) the tab that sends. */
  | { type: 'sender'; active: boolean }
  | { type: 'storage-error'; error: unknown }
  /** The sender lock could not be requested, so this tab cannot send. */
  | { type: 'lock-error'; error: unknown }
  /**
   * Unreadable data was found at `storageKey` and replaced. `saved` tells
   * whether a copy reached `<storageKey prefix>:quarantine` (best effort: a
   * copy that does not fit is dropped and also reported as a `storage-error`).
   */
  | { type: 'quarantined'; reason: string; storageKey: string; saved: boolean };

export type QueueListener<TPayload = unknown, TResult = unknown> = (
  event: QueueEvent<TPayload, TResult>,
) => void;

export interface IdempotentQueue<TPayload = unknown, TResult = unknown> {
  /** Saves the item, then resolves with it. Rejects if it could not be saved. */
  enqueue(input: EnqueueInput<TPayload>): Promise<QueueItem<TPayload>>;
  /** Reads storage once, without sending anything. `start`, `enqueue` and the other methods call it. */
  load(): Promise<void>;
  /**
   * Loads, follows other tabs' changes and asks for the sender lock. The tab
   * that gets it returns interrupted items to `pending` and sends; the others
   * wait and take over when it closes or stops.
   */
  start(): Promise<void>;
  /**
   * Stops starting new attempts, waits for the attempts in flight (or aborts
   * them after `options.abortAfterMs`), then hands the sender lock on.
   */
  stop(options?: StopOptions): Promise<void>;
  /**
   * Makes waiting items due now (except items waiting for a server's
   * `Retry-After`). In the sending tab, resolves when nothing is in flight or
   * due; in other tabs, when the change is saved. Does nothing while stopped.
   */
  flush(): Promise<void>;
  /** Current items in enqueue order. The array is replaced, never mutated, on change. */
  getItems(): readonly QueueItem<TPayload>[];
  /** Returns a `failed`, `dead` or `pending` item to `pending` with zero attempts, due now, same key. */
  retry(id: string): Promise<QueueItem<TPayload>>;
  /**
   * Removes an item. An item in flight is removed now; its result is ignored and
   * its key stays blocked in the sending tab until the request settles.
   */
  discard(id: string): Promise<boolean>;
  subscribe(listener: QueueListener<TPayload, TResult>): () => void;
  /** Waits for this tab's attempts in flight, then deletes every item and the stored data, including quarantined copies. */
  clear(): Promise<void>;
  /** Whether `start` was called without a later `stop`. */
  isRunning(): boolean;
  /** Whether this tab holds the sender lock and sends items. */
  isSender(): boolean;
  /** Where item ids and generated keys get their randomness from. */
  readonly keySource: KeySource;
}
