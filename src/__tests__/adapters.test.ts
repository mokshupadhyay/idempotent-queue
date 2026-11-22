import { IDBFactory } from 'fake-indexeddb';
import { createBroadcastQueueChannel, createMemoryChannel } from '../channel';
import { createBrowserConnectivity, subscribeToPageVisibility } from '../connectivity';
import type { EventListenerLike } from '../env';
import {
  createBroadcastChannelLocks,
  createMemoryLocks,
  createWebLocks,
  openBroadcastChannel,
  type BroadcastChannelLike,
  type LockManagerLike,
} from '../locks';
import { createIndexedDBStorage, createLocalStorageAdapter, createMemoryStorage, type WebStorageLike } from '../storage';
import type { QueueChannelMessage, QueueLocks } from '../types';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(() => resolve(), ms));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('createMemoryStorage', () => {
  it('stores, reads and removes strings', async () => {
    const storage = createMemoryStorage({ a: '1' });
    expect(await storage.getItem('a')).toBe('1');
    expect(await storage.getItem('missing')).toBeNull();
    await storage.setItem('b', '2');
    await storage.removeItem('a');
    expect(Array.from(storage.data.entries())).toEqual([['b', '2']]);
  });

  it('applies update atomically, and nothing when mutate throws', async () => {
    const storage = createMemoryStorage({ n: '1' });
    await storage.update(['n', 'missing'], (values) => {
      expect(values).toEqual(['1', null]);
      return [
        { key: 'n', value: '2' },
        { key: 'other', value: 'x' },
      ];
    });
    expect(storage.data.get('n')).toBe('2');
    await expect(
      storage.update(['n'], () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    await storage.update(['other'], () => [{ key: 'other', value: null }]);
    expect(Array.from(storage.data.keys())).toEqual(['n']);
  });
});

describe('createLocalStorageAdapter', () => {
  function webStorage(): WebStorageLike & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
      setItem: (key, value) => {
        if (value.length > 20) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        data.set(key, value);
      },
      removeItem: (key) => void data.delete(key),
    };
  }

  it('wraps a Web Storage object and turns its exceptions into rejections', async () => {
    const store = webStorage();
    const adapter = createLocalStorageAdapter(store);
    await adapter.setItem('k', 'v');
    expect(await adapter.getItem('k')).toBe('v');
    await adapter.removeItem('k');
    expect(store.data.size).toBe(0);
    await expect(adapter.setItem('k', 'x'.repeat(21))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect('update' in adapter).toBe(false);
  });

  it('uses the global localStorage, and explains a missing one', async () => {
    expect(() => createLocalStorageAdapter()).toThrow(/localStorage is not available/);
    expect(() => createLocalStorageAdapter({} as never)).toThrow(TypeError);
    const store = webStorage();
    const global = globalThis as { localStorage?: unknown };
    global.localStorage = store;
    try {
      await createLocalStorageAdapter().setItem('k', 'v');
      expect(store.data.get('k')).toBe('v');
    } finally {
      delete global.localStorage;
    }
  });
});

describe('createIndexedDBStorage', () => {
  it('stores, reads and removes strings', async () => {
    const storage = createIndexedDBStorage({ indexedDB: new IDBFactory() });
    expect(await storage.getItem('k')).toBeNull();
    await storage.setItem('k', 'v');
    expect(await storage.getItem('k')).toBe('v');
    await storage.removeItem('k');
    expect(await storage.getItem('k')).toBeNull();
    storage.close();
  });

  it('keeps data across connections and databases opened by other tabs', async () => {
    const indexedDB = new IDBFactory();
    const one = createIndexedDBStorage({ indexedDB, databaseName: 'db', storeName: 'store' });
    await one.setItem('k', 'v');
    one.close();
    const two = createIndexedDBStorage({ indexedDB, databaseName: 'db', storeName: 'store' });
    expect(await two.getItem('k')).toBe('v');
    // The first one reopens after close().
    expect(await one.getItem('k')).toBe('v');
    one.close();
    two.close();
  });

  it('runs update in one transaction, so concurrent updates from two tabs never lose a write', async () => {
    const indexedDB = new IDBFactory();
    const tabs = [createIndexedDBStorage({ indexedDB }), createIndexedDBStorage({ indexedDB })];
    await tabs[0].setItem('n', '0');
    const increments = Array.from({ length: 20 }, (_, i) =>
      tabs[i % 2].update(['n'], ([value]) => [{ key: 'n', value: String(Number(value) + 1) }]),
    );
    await Promise.all(increments);
    expect(await tabs[1].getItem('n')).toBe('20');
    tabs.forEach((tab) => tab.close());
  });

  it('writes nothing and rejects when mutate throws', async () => {
    const storage = createIndexedDBStorage({ indexedDB: new IDBFactory() });
    await storage.setItem('a', '1');
    await expect(
      storage.update(['a'], () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    await storage.update(['a', 'b'], (values) => {
      expect(values).toEqual(['1', null]);
      return [
        { key: 'a', value: null },
        { key: 'b', value: '2' },
      ];
    });
    expect([await storage.getItem('a'), await storage.getItem('b')]).toEqual([null, '2']);
    storage.close();
  });

  it('explains a missing indexedDB', async () => {
    await expect(createIndexedDBStorage().getItem('k')).rejects.toThrow(/indexedDB is not available/);
  });
});

/** Checks that `locks` never lets two holders in at once and keeps FIFO order within one tab. */
async function checkExclusive(locks: QueueLocks[], name: string, count: number, holdMs: number) {
  let holding = 0;
  let maxHolding = 0;
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      locks[i % locks.length].request(name, async () => {
        holding++;
        maxHolding = Math.max(maxHolding, holding);
        order.push(i);
        await sleep(holdMs);
        holding--;
        return i;
      }),
    ),
  );
  expect(maxHolding).toBe(1);
  expect(order.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
  return order;
}

describe('createMemoryLocks', () => {
  it('runs callbacks one at a time, in request order, and returns their results', async () => {
    const locks = createMemoryLocks();
    expect(await checkExclusive([locks], 'x', 5, 1)).toEqual([0, 1, 2, 3, 4]);
    await expect(locks.request('x', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await locks.request('x', () => 7)).toBe(7);
  });

  it('gives up waiting when the signal aborts', async () => {
    const locks = createMemoryLocks();
    const held = deferred();
    void locks.request('x', () => held.promise);
    const controller = new AbortController();
    const ran = jest.fn();
    const waiting = locks.request('x', ran, { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    held.resolve();
    await sleep(0);
    expect(ran).not.toHaveBeenCalled();
    expect(await locks.request('x', () => 'free')).toBe('free');
    await expect(locks.request('x', ran, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('createWebLocks', () => {
  it('uses a LockManager, passing the abort signal', async () => {
    const calls: Array<{ name: string; options: unknown }> = [];
    const manager: LockManagerLike = {
      request: (name, options, callback) => {
        calls.push({ name, options });
        return Promise.resolve(callback({ name }));
      },
    };
    const locks = createWebLocks(manager);
    expect(await locks.request('x', () => 1)).toBe(1);
    const { signal } = new AbortController();
    await locks.request('y', () => 2, { signal });
    expect(calls).toEqual([
      { name: 'x', options: {} },
      { name: 'y', options: { signal } },
    ]);
    expect(() => createWebLocks({} as never)).toThrow(TypeError);
  });

  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  const itWithLocks = nav && nav.locks ? it : it.skip;
  itWithLocks('works with the host navigator.locks', async () => {
    const locks = createWebLocks();
    await checkExclusive([locks, createWebLocks()], 'idempotent-queue-test', 6, 2);
    const held = deferred();
    void locks.request('idempotent-queue-abort', () => held.promise);
    const controller = new AbortController();
    const waiting = locks.request('idempotent-queue-abort', () => 'never', { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    held.resolve();
  });
});

describe('createBroadcastChannelLocks', () => {
  it('lets one of several tabs hold a lock at a time', async () => {
    const tabs = [0, 1, 2].map(() => createBroadcastChannelLocks({ channelName: 'locks-1', probeMs: 15, retryMs: 30 }));
    await checkExclusive(tabs, 'sender', 6, 5);
  });

  it('lets another tab take a lock when the holding tab closes', async () => {
    // A tab that closes stops answering: its channel stops delivering and sending messages.
    let closed = false;
    const closable = (name: string): BroadcastChannelLike => {
      const real = openBroadcastChannel(name);
      const wrapped = new Map<EventListenerLike, EventListenerLike>();
      return {
        postMessage: (message) => {
          if (!closed) real.postMessage(message);
        },
        addEventListener: (type, listener) => {
          const inner: EventListenerLike = (event) => {
            if (!closed) listener(event);
          };
          wrapped.set(listener, inner);
          real.addEventListener(type, inner);
        },
        removeEventListener: (type, listener) => real.removeEventListener(type, wrapped.get(listener) || listener),
        close: () => real.close(),
      };
    };
    const one = createBroadcastChannelLocks({ channelName: 'locks-2', probeMs: 15, retryMs: 30, createChannel: closable });
    const two = createBroadcastChannelLocks({ channelName: 'locks-2', probeMs: 15, retryMs: 30 });
    const forever = deferred();
    const gotOne = deferred();
    const holding = one.request('sender', () => {
      gotOne.resolve();
      return forever.promise;
    });
    await gotOne.promise;
    let gotTwo = false;
    const second = two.request('sender', () => {
      gotTwo = true;
    });
    await sleep(120);
    expect(gotTwo).toBe(false);
    closed = true;
    await second;
    expect(gotTwo).toBe(true);
    forever.resolve();
    await holding;
  });

  it('gives up waiting when the signal aborts', async () => {
    const one = createBroadcastChannelLocks({ channelName: 'locks-3', probeMs: 10, retryMs: 20 });
    const two = createBroadcastChannelLocks({ channelName: 'locks-3', probeMs: 10, retryMs: 20 });
    const held = deferred();
    const got = deferred();
    const holding = one.request('x', () => {
      got.resolve();
      return held.promise;
    });
    await got.promise;
    const controller = new AbortController();
    const ran = jest.fn();
    const waiting = two.request('x', ran, { signal: controller.signal });
    await sleep(30);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    held.resolve();
    await holding;
    expect(ran).not.toHaveBeenCalled();
    expect(await two.request('x', () => 'free')).toBe('free');
  });

  it('explains a missing BroadcastChannel', () => {
    const global = globalThis as { BroadcastChannel?: unknown };
    const original = global.BroadcastChannel;
    delete global.BroadcastChannel;
    try {
      expect(() => createBroadcastChannelLocks()).toThrow(/BroadcastChannel is not available/);
    } finally {
      global.BroadcastChannel = original;
    }
  });
});

describe('channels', () => {
  it('createMemoryChannel delivers asynchronously to every subscriber', async () => {
    const channel = createMemoryChannel();
    const seen: QueueChannelMessage[] = [];
    const off = channel.subscribe((message) => seen.push(message));
    channel.subscribe((message) => seen.push(message));
    channel.postMessage({ type: 'changed', source: 'a' });
    expect(seen).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toHaveLength(2);
    off();
    channel.postMessage({ type: 'changed', source: 'b' });
    await sleep(0);
    expect(seen).toHaveLength(3);
  });

  it('createBroadcastQueueChannel reaches other channels with the same name and ignores other messages', async () => {
    const one = createBroadcastQueueChannel('changes-1');
    const two = createBroadcastQueueChannel('changes-1');
    const raw = openBroadcastChannel('changes-1');
    const seen: QueueChannelMessage[] = [];
    two.subscribe((message) => seen.push(message));
    one.postMessage({ type: 'changed', source: 'tab-1' });
    raw.postMessage({ something: 'else' });
    await sleep(20);
    expect(seen).toEqual([{ type: 'changed', source: 'tab-1' }]);
    two.close();
    one.postMessage({ type: 'changed', source: 'tab-1' });
    await sleep(20);
    expect(seen).toHaveLength(1);
    one.close();
    one.postMessage({ type: 'changed', source: 'closed' });
    raw.close();
  });
});

describe('connectivity and visibility', () => {
  function target() {
    const listeners = new Map<string, Set<EventListenerLike>>();
    return {
      listeners,
      addEventListener: (type: string, listener: EventListenerLike) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: EventListenerLike) => listeners.get(type)?.delete(listener),
      fire: (type: string) => listeners.get(type)?.forEach((listener) => listener({ type })),
    };
  }

  it('reads navigator.onLine and the online and offline events', () => {
    const window = target();
    const navigator = { onLine: false };
    const connectivity = createBrowserConnectivity({ target: window, navigator });
    expect(connectivity.isOnline()).toBe(false);
    navigator.onLine = true;
    expect(connectivity.isOnline()).toBe(true);
    const seen: boolean[] = [];
    const off = connectivity.subscribeToConnectivity((online) => seen.push(online));
    window.fire('offline');
    window.fire('online');
    expect(seen).toEqual([false, true]);
    off();
    expect(window.listeners.get('online')!.size).toBe(0);
    expect(window.listeners.get('offline')!.size).toBe(0);
  });

  it('counts a missing navigator as online', () => {
    expect(createBrowserConnectivity({ navigator: {} }).isOnline()).toBe(true);
  });

  it('calls the visibility listener only when the page becomes visible', () => {
    const doc = Object.assign(target(), { visibilityState: 'hidden' });
    const listener = jest.fn();
    const off = subscribeToPageVisibility(listener, doc);
    doc.fire('visibilitychange');
    expect(listener).not.toHaveBeenCalled();
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    expect(doc.listeners.get('visibilitychange')!.size).toBe(0);
    expect(subscribeToPageVisibility(listener, undefined)()).toBeUndefined();
  });
});
