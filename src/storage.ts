import { readGlobal } from './env.js';
import type { QueueStorage, StorageWrite } from './types.js';

export interface MemoryStorage extends QueueStorage {
  /** The stored values, for inspection in tests. */
  readonly data: Map<string, string>;
  update(keys: readonly string[], mutate: (values: Array<string | null>) => StorageWrite[]): Promise<void>;
}

const memoryStorages = new WeakSet<object>();

/** Whether `storage` came from `createMemoryStorage`, which is local to one JavaScript realm. */
export function isMemoryStorage(storage: QueueStorage): boolean {
  return memoryStorages.has(storage);
}

function applyWrites(data: Map<string, string>, writes: StorageWrite[]): void {
  for (const write of writes) {
    if (write.value === null) data.delete(write.key);
    else data.set(write.key, write.value);
  }
}

/**
 * Storage that lives only as long as the JavaScript realm (the tab, or the
 * Node process). The default in Node. Queues in one realm that are given the
 * same memory storage object share it like tabs share IndexedDB.
 */
export function createMemoryStorage(initial?: Record<string, string>): MemoryStorage {
  const data = new Map<string, string>();
  if (initial) for (const key of Object.keys(initial)) data.set(key, initial[key]);
  const storage: MemoryStorage = {
    data,
    getItem: (key) => Promise.resolve(data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    // Synchronous, so nothing can run between the read and the write.
    update: (keys, mutate) => {
      try {
        const values = keys.map((key) => (data.has(key) ? (data.get(key) as string) : null));
        applyWrites(data, mutate(values));
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  memoryStorages.add(storage);
  return storage;
}

/** The synchronous Web Storage API (`localStorage`, `sessionStorage`). */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isWebStorage(value: unknown): value is WebStorageLike {
  return (
    !!value &&
    typeof (value as WebStorageLike).getItem === 'function' &&
    typeof (value as WebStorageLike).setItem === 'function' &&
    typeof (value as WebStorageLike).removeItem === 'function'
  );
}

/**
 * Storage backed by `localStorage`, or the Web Storage object you pass.
 *
 * It has no atomic `update`, so the queue holds the `<storageKey>:storage`
 * lock around each read-modify-write. Browsers do not promise that a
 * localStorage write in one tab is visible in another tab as soon as the lock
 * is released, so with several tabs `createIndexedDBStorage` is the safer
 * choice. A full localStorage (`QuotaExceededError`) rejects the write.
 */
export function createLocalStorageAdapter(webStorage?: WebStorageLike): QueueStorage {
  const store = webStorage !== undefined ? webStorage : readGlobal('localStorage');
  if (!isWebStorage(store)) {
    throw new TypeError(
      webStorage !== undefined
        ? 'createLocalStorageAdapter: the argument needs getItem, setItem and removeItem.'
        : 'createLocalStorageAdapter: localStorage is not available here. Pass a Web Storage object.',
    );
  }
  const call = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return {
    getItem: (key) => call(() => store.getItem(key)),
    setItem: (key, value) => call(() => store.setItem(key, value)),
    removeItem: (key) => call(() => store.removeItem(key)),
  };
}

// Minimal IndexedDB shapes, so the library builds without DOM typings.
interface IDBEventTargetLike {
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface IDBRequestLike<T = unknown> extends IDBEventTargetLike {
  readonly result: T;
  readonly error: unknown;
}

export interface IDBObjectStoreLike {
  get(key: string): IDBRequestLike;
  put(value: string, key: string): IDBRequestLike;
  delete(key: string): IDBRequestLike;
}

export interface IDBTransactionLike {
  objectStore(name: string): IDBObjectStoreLike;
  abort(): void;
  readonly error: unknown;
  oncomplete: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onabort: ((event: unknown) => void) | null;
}

export interface IDBDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(
    storeNames: string | string[],
    mode: 'readonly' | 'readwrite',
    options?: { durability?: 'default' | 'strict' | 'relaxed' },
  ): IDBTransactionLike;
  close(): void;
  onversionchange: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
}

export interface IDBOpenRequestLike extends IDBRequestLike<IDBDatabaseLike> {
  onupgradeneeded: ((event: unknown) => void) | null;
  onblocked: ((event: unknown) => void) | null;
}

export interface IDBFactoryLike {
  open(name: string, version?: number): IDBOpenRequestLike;
}

export interface IndexedDBStorageOptions {
  /** Default `'idempotent-queue'`. */
  databaseName?: string;
  /** Default `'kv'`. */
  storeName?: string;
  /** Default: the global `indexedDB`. Pass `fake-indexeddb` in tests. */
  indexedDB?: IDBFactoryLike;
  /**
   * Durability hint for writes. `'strict'` (default) asks the browser to
   * flush to disk before a write counts as done. Browsers without the option
   * ignore it.
   */
  durability?: 'default' | 'strict' | 'relaxed';
}

export interface IndexedDBStorage extends QueueStorage {
  update(keys: readonly string[], mutate: (values: Array<string | null>) => StorageWrite[]): Promise<void>;
  /** Closes the database connection. The next call opens it again. */
  close(): void;
}

function asString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : String(value);
}

/**
 * Storage in an IndexedDB object store, the default in browsers. `update`
 * runs in one readwrite transaction. IndexedDB never runs two readwrite
 * transactions on the same store at once, in any tab, so a read-modify-write
 * needs no lock and cannot be torn.
 */
export function createIndexedDBStorage(options: IndexedDBStorageOptions = {}): IndexedDBStorage {
  const databaseName = options.databaseName || 'idempotent-queue';
  const storeName = options.storeName || 'kv';
  const durability = options.durability || 'strict';
  let opening: Promise<IDBDatabaseLike> | undefined;
  let current: IDBDatabaseLike | undefined;

  function factory(): IDBFactoryLike {
    const value = options.indexedDB || readGlobal('indexedDB');
    if (!value || typeof (value as IDBFactoryLike).open !== 'function') {
      throw new Error('createIndexedDBStorage: indexedDB is not available here. Pass options.indexedDB.');
    }
    return value as IDBFactoryLike;
  }

  function forget(db: IDBDatabaseLike): void {
    if (current === db) {
      current = undefined;
      opening = undefined;
    }
  }

  function open(): Promise<IDBDatabaseLike> {
    if (opening) return opening;
    const promise = new Promise<IDBDatabaseLike>((resolve, reject) => {
      const request = factory().open(databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrades or deletes the database: let it, and reopen on the next call.
        db.onversionchange = () => {
          db.close();
          forget(db);
        };
        db.onclose = () => forget(db);
        current = db;
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      // `onblocked`: another tab holds an older version open. The request waits until it closes.
      request.onblocked = () => undefined;
    });
    opening = promise;
    promise.then(undefined, () => {
      if (opening === promise) opening = undefined;
    });
    return promise;
  }

  async function transaction(mode: 'readonly' | 'readwrite'): Promise<IDBTransactionLike> {
    let db = await open();
    try {
      return db.transaction(storeName, mode, mode === 'readwrite' ? { durability } : undefined);
    } catch (error) {
      // The connection was closed under us (for example by a version change): reopen once.
      forget(db);
      db = await open();
      return db.transaction(storeName, mode, mode === 'readwrite' ? { durability } : undefined);
    }
  }

  function run<T>(
    mode: 'readonly' | 'readwrite',
    body: (store: IDBObjectStoreLike, tx: IDBTransactionLike, fail: (error: unknown) => void) => () => T,
  ): Promise<T> {
    return transaction(mode).then(
      (tx) =>
        new Promise<T>((resolve, reject) => {
          let failure: { error: unknown } | undefined;
          const fail = (error: unknown) => {
            failure = { error };
            try {
              tx.abort();
            } catch {
              // Already finished.
            }
          };
          let result: () => T = () => undefined as unknown as T;
          tx.oncomplete = () => resolve(result());
          tx.onabort = () => reject(failure ? failure.error : tx.error || new Error('IndexedDB transaction aborted'));
          tx.onerror = () => undefined;
          try {
            result = body(tx.objectStore(storeName), tx, fail);
          } catch (error) {
            fail(error);
          }
        }),
    );
  }

  return {
    getItem: (key) =>
      run('readonly', (store) => {
        const request = store.get(key);
        return () => asString(request.result);
      }),
    setItem: (key, value) =>
      run('readwrite', (store) => {
        store.put(value, key);
        return () => undefined;
      }),
    removeItem: (key) =>
      run('readwrite', (store) => {
        store.delete(key);
        return () => undefined;
      }),
    update: (keys, mutate) =>
      run('readwrite', (store, _tx, fail) => {
        const values: Array<string | null> = keys.map(() => null);
        let remaining = keys.length;
        const apply = () => {
          let writes: StorageWrite[];
          try {
            writes = mutate(values);
          } catch (error) {
            fail(error);
            return;
          }
          // Issued from a request callback, so the transaction is still active.
          for (const write of writes) {
            if (write.value === null) store.delete(write.key);
            else store.put(write.value, write.key);
          }
        };
        if (remaining === 0) apply();
        keys.forEach((key, index) => {
          const request = store.get(key);
          request.onsuccess = () => {
            values[index] = asString(request.result);
            remaining--;
            if (remaining === 0) apply();
          };
        });
        return () => undefined;
      }),
    close: () => {
      const db = current;
      if (db) {
        forget(db);
        db.close();
      }
    },
  };
}
