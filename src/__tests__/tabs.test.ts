import { IDBFactory } from 'fake-indexeddb';
import { createMemoryChannel } from '../channel';
import { HttpError } from '../classify';
import { createMemoryLocks } from '../locks';
import { createIdempotentQueue } from '../queue';
import { createIndexedDBStorage, createLocalStorageAdapter, createMemoryStorage, type WebStorageLike } from '../storage';
import type { IdempotentQueue, QueueChannel, QueueEvent, QueueItem, QueueOptions, QueueStorage, SendContext } from '../types';
import { FakeClock } from './support/fakeClock';
import { FakeLocks } from './support/fakeLocks';

type Call = { tab: string; item: QueueItem; context: SendContext; resolve(value?: unknown): void; reject(error: unknown): void };

/** Several tabs on one fake clock, sharing storage, locks and a channel. */
function browser(shared: { storage?: QueueStorage; channel?: QueueChannel | null } = {}) {
  const clock = new FakeClock();
  const locks = new FakeLocks();
  const storage = shared.storage || createMemoryStorage();
  const channel = shared.channel === undefined ? createMemoryChannel() : shared.channel;
  const calls: Call[] = [];
  let ids = 0;
  const open = (owner: string, overrides: Partial<QueueOptions> = {}) => {
    const events: QueueEvent[] = [];
    const queue = createIdempotentQueue({
      storage,
      channel,
      locks: locks.locksFor(owner),
      send: (item, context) =>
        new Promise((resolve, reject) => calls.push({ tab: owner, item, context, resolve, reject })),
      now: () => clock.now,
      random: () => 0.5,
      timers: clock.timersFor(owner),
      generateKey: () => `${owner}-${++ids}`,
      subscribeToVisibility: null,
      ...overrides,
    });
    queue.subscribe((event) => events.push(event));
    const close = () => {
      clock.kill(owner);
      locks.kill(owner);
    };
    return { owner, queue, events, close };
  };
  return { clock, locks, storage, calls, open, tick: () => clock.advance(0) };
}

const statuses = (queue: IdempotentQueue) => queue.getItems().map((item) => `${item.key}:${item.status}`);

describe('two tabs', () => {
  it('elects one sending tab; the other enqueues and sees the result', async () => {
    const b = browser();
    const one = b.open('one');
    const two = b.open('two');
    await one.queue.start();
    await two.queue.start();
    await b.tick();
    expect([one.queue.isSender(), two.queue.isSender()]).toEqual([true, false]);
    expect(one.events.some((event) => event.type === 'sender' && event.active)).toBe(true);

    await two.queue.enqueue({ payload: { amount: 5 }, key: 'pay-1' });
    await b.tick();
    expect(b.calls.map((call) => [call.tab, call.context.key])).toEqual([['one', 'pay-1']]);
    expect(statuses(two.queue)).toEqual(['pay-1:inflight']);
    b.calls[0].resolve('ok');
    await b.tick();
    expect(statuses(one.queue)).toEqual(['pay-1:succeeded']);
    expect(statuses(two.queue)).toEqual(['pay-1:succeeded']);
    expect(two.events.filter((event) => event.type === 'synced').length).toBeGreaterThan(0);
  });

  it('creates one item when both tabs enqueue the same key at once', async () => {
    const b = browser();
    const one = b.open('one');
    const two = b.open('two');
    const [a, c] = await Promise.all([
      one.queue.enqueue({ payload: 1, key: 'k' }),
      two.queue.enqueue({ payload: 2, key: 'k' }),
    ]);
    expect(c.id).toBe(a.id);
    expect(c.payload).toBe(1);
    await b.tick();
    expect(one.queue.getItems()).toHaveLength(1);
    expect(two.queue.getItems()).toHaveLength(1);
  });

  it('hands sending over on stop, only after the attempt in flight settles', async () => {
    const b = browser();
    const one = b.open('one');
    const two = b.open('two');
    await one.queue.start();
    await two.queue.start();
    await one.queue.enqueue({ payload: 1, key: 'a' });
    await one.queue.enqueue({ payload: 2, key: 'b' });
    await b.tick();
    expect(b.calls).toHaveLength(1);
    const stopping = one.queue.stop();
    await b.tick();
    // Tab one still holds the lock while 'a' is in flight.
    expect(two.queue.isSender()).toBe(false);
    b.calls[0].resolve();
    await stopping;
    await b.tick();
    expect(two.queue.isSender()).toBe(true);
    expect(b.calls.map((call) => [call.tab, call.context.key])).toEqual([
      ['one', 'a'],
      ['two', 'b'],
    ]);
  });

  it('takes over when the sending tab closes and resends its item with the same key', async () => {
    const b = browser();
    const one = b.open('one');
    const two = b.open('two');
    await one.queue.start();
    await two.queue.start();
    await two.queue.enqueue({ payload: 1, key: 'pay-1' });
    await b.tick();
    expect(b.calls.map((call) => call.tab)).toEqual(['one']);
    one.close();
    await b.tick();
    expect(two.queue.isSender()).toBe(true);
    expect(b.calls.map((call) => [call.tab, { key: call.context.key, attempt: call.context.attempt }])).toEqual([
      ['one', { key: 'pay-1', attempt: 1 }],
      ['two', { key: 'pay-1', attempt: 2 }],
    ]);
    b.calls[1].resolve();
    await b.tick();
    expect(statuses(two.queue)).toEqual(['pay-1:succeeded']);
    // A tab opened later sees the final state.
    const three = b.open('three');
    await three.queue.load();
    expect(statuses(three.queue)).toEqual(['pay-1:succeeded']);
  });

  it('applies retry and discard made in a tab that does not send', async () => {
    const b = browser();
    const one = b.open('one', { retry: { maxAttempts: 1 } });
    const two = b.open('two', { retry: { maxAttempts: 1 } });
    await one.queue.start();
    await two.queue.start();
    const item = await two.queue.enqueue({ payload: 1, key: 'k' });
    const other = await two.queue.enqueue({ payload: 2, key: 'other' });
    await b.tick();
    b.calls[0].reject(new HttpError(500));
    await b.tick();
    expect(statuses(two.queue)).toEqual(['k:failed', 'other:inflight']);
    expect(await two.queue.discard(other.id)).toBe(true);
    await two.queue.retry(item.id);
    await b.tick();
    b.calls[1].resolve();
    await b.tick();
    expect(b.calls.map((call) => ({ key: call.context.key, attempt: call.context.attempt }))).toEqual([
      { key: 'k', attempt: 1 },
      { key: 'other', attempt: 1 },
      { key: 'k', attempt: 1 },
    ]);
    // The result of the discarded item is ignored.
    expect(statuses(one.queue)).toEqual(['k:inflight']);
  });

  it('resolves flush in a tab that does not send once the change is saved', async () => {
    const b = browser();
    const one = b.open('one');
    const two = b.open('two');
    await one.queue.start();
    await two.queue.start();
    await one.queue.enqueue({ payload: 1, key: 'k' });
    await b.tick();
    b.calls[0].reject(new HttpError(503));
    await b.tick();
    expect(one.queue.getItems()[0].nextAttemptAt).toBeGreaterThan(b.clock.now);
    await two.queue.flush();
    await b.tick();
    expect(b.calls).toHaveLength(2);
    expect(b.calls[1].tab).toBe('one');
  });

  it('polls storage every syncIntervalMs without a channel', async () => {
    const b = browser({ channel: null });
    const one = b.open('one', { syncIntervalMs: 1000 });
    const two = b.open('two', { syncIntervalMs: 1000 });
    await one.queue.start();
    await two.queue.start();
    await b.tick();
    await two.queue.enqueue({ payload: 1, key: 'k' });
    await b.tick();
    expect(b.calls).toHaveLength(0);
    expect(one.queue.getItems()).toEqual([]);
    await b.clock.advance(1000);
    expect(b.calls.map((call) => call.tab)).toEqual(['one']);
    b.calls[0].resolve();
    await one.queue.stop();
    await two.queue.stop();
    // A stopped queue keeps no timer.
    expect(b.clock.pending()).toBe(0);
  });

  it('keeps no timer and no subscription when every tab is stopped', async () => {
    const inner = createMemoryChannel();
    const unsubscribed = jest.fn();
    const channel: QueueChannel = {
      postMessage: (message) => inner.postMessage(message),
      subscribe: (listener) => {
        const off = inner.subscribe(listener);
        return () => {
          unsubscribed();
          off();
        };
      },
    };
    const b = browser({ channel });
    const one = b.open('one');
    await one.queue.start();
    await one.queue.enqueue({ payload: 1, key: 'k' });
    await b.tick();
    b.calls[0].resolve();
    await one.queue.stop();
    expect(b.clock.pending()).toBe(0);
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(one.queue.isSender()).toBe(false);
    await b.tick();
    expect(b.locks.holder('idempotent-queue:sender')).toBeUndefined();
  });

  it('shares a memory storage, its locks and its channel between queues by default', async () => {
    const storage = createMemoryStorage();
    const sent: string[] = [];
    const make = () =>
      createIdempotentQueue({ storage, send: (item) => void sent.push(item.key), subscribeToVisibility: null });
    const one = make();
    const two = make();
    await one.start();
    await two.start();
    await two.enqueue({ payload: 1, key: 'k' });
    for (let i = 0; i < 50 && one.getItems().length === 0; i++) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
    expect(sent).toEqual(['k']);
    expect([one.isSender(), two.isSender()].filter(Boolean)).toHaveLength(1);
    expect(statuses(one)).toEqual(['k:succeeded']);
    expect(statuses(two)).toEqual(['k:succeeded']);
    await one.stop();
    await two.stop();
  });
});

describe('storage adapters with two tabs', () => {
  async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !check(); i++) await new Promise<void>((resolve) => setTimeout(() => resolve(), 5));
    expect(check()).toBe(true);
  }

  it('works on IndexedDB', async () => {
    const indexedDB = new IDBFactory();
    const sent: Array<[string, SendContext]> = [];
    const locks = createMemoryLocks();
    const channel = createMemoryChannel();
    const open = (tab: string) => {
      const storage = createIndexedDBStorage({ indexedDB, databaseName: 'shop' });
      const queue = createIdempotentQueue({
        storage,
        locks,
        channel,
        send: (_item, context) => {
          sent.push([tab, { key: context.key, attempt: context.attempt }]);
          return 'ok';
        },
        subscribeToVisibility: null,
      });
      return { queue, storage };
    };
    const one = open('one');
    const two = open('two');
    await one.queue.start();
    await two.queue.start();
    await waitFor(() => one.queue.isSender());
    await two.queue.enqueue({ payload: { amount: 1 }, key: 'pay-1' });
    await one.queue.enqueue({ payload: { amount: 2 }, key: 'pay-2' });
    await two.queue.enqueue({ payload: { amount: 3 }, key: 'pay-1' });
    await waitFor(() => statuses(two.queue).join() === 'pay-1:succeeded,pay-2:succeeded');
    expect(sent).toEqual([
      ['one', { key: 'pay-1', attempt: 1 }],
      ['one', { key: 'pay-2', attempt: 1 }],
    ]);
    await one.queue.stop();
    await two.queue.stop();
    one.storage.close();
    two.storage.close();
  });

  it('works on localStorage, with the storage lock', async () => {
    const data = new Map<string, string>();
    const webStorage: WebStorageLike = {
      getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    };
    const locks = createMemoryLocks();
    const channel = createMemoryChannel();
    const requested: string[] = [];
    const sent: string[] = [];
    const open = () =>
      createIdempotentQueue({
        storage: createLocalStorageAdapter(webStorage),
        locks: {
          request: (name, callback, options) => {
            requested.push(name);
            return locks.request(name, callback, options);
          },
        },
        channel,
        send: (item) => void sent.push(item.key),
        subscribeToVisibility: null,
      });
    const one = open();
    const two = open();
    await one.start();
    await two.start();
    await Promise.all([one.enqueue({ payload: 1, key: 'a' }), two.enqueue({ payload: 2, key: 'b' }), two.enqueue({ payload: 3, key: 'a' })]);
    await waitFor(() => statuses(two).join() === 'a:succeeded,b:succeeded');
    expect(sent).toEqual(['a', 'b']);
    expect(requested).toContain('idempotent-queue:storage');
    expect(requested).toContain('idempotent-queue:sender');
    await one.stop();
    await two.stop();
  });
});
