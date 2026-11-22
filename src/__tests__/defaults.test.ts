import { IDBFactory } from 'fake-indexeddb';
import { createIdempotentQueue } from '../queue';
import type { IdempotentQueue, QueueItem } from '../types';

/*
 * The defaults in a simulated browser: IndexedDB from fake-indexeddb, a fake
 * document and window, and Node's own navigator.locks and BroadcastChannel,
 * which behave like the browser's between objects in one process.
 */
type Listener = (event: unknown) => void;

function eventTarget() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => listeners.get(type)?.delete(listener),
    fire: (type: string) => listeners.get(type)?.forEach((listener) => listener({ type })),
    count: (type: string) => (listeners.get(type) ? listeners.get(type)!.size : 0),
  };
}

const global = globalThis as Record<string, unknown>;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let window: ReturnType<typeof eventTarget>;
let document: ReturnType<typeof eventTarget> & { visibilityState: string };
let navigator: { onLine: boolean; locks: unknown };

beforeEach(() => {
  window = eventTarget();
  document = Object.assign(eventTarget(), { visibilityState: 'visible' });
  const hostLocks = originalNavigator && (originalNavigator.get ? originalNavigator.get.call(globalThis) : originalNavigator.value);
  navigator = { onLine: true, locks: (hostLocks as { locks?: unknown }).locks };
  global.window = window;
  global.document = document;
  global.indexedDB = new IDBFactory();
  Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true, writable: true });
});

afterEach(() => {
  delete global.window;
  delete global.document;
  delete global.indexedDB;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise<void>((resolve) => setTimeout(() => resolve(), 5));
  expect(check()).toBe(true);
}

const statuses = (queue: IdempotentQueue) => queue.getItems().map((item) => `${item.key}:${item.status}`);

it('uses IndexedDB, Web Locks and BroadcastChannel, so two tabs share one queue', async () => {
  const sent: string[] = [];
  const open = () =>
    createIdempotentQueue({
      send: (item: QueueItem) => {
        sent.push(item.key);
        return 'ok';
      },
    });
  const one = open();
  const two = open();
  await one.start();
  await waitFor(() => one.isSender());
  await two.start();
  await two.enqueue({ payload: 1, key: 'pay-1' });
  await waitFor(() => statuses(two).join() === 'pay-1:succeeded');
  expect(sent).toEqual(['pay-1']);
  expect(two.isSender()).toBe(false);
  // A third tab sees the stored item.
  const three = open();
  await three.load();
  expect(statuses(three)).toEqual(['pay-1:succeeded']);

  await one.stop();
  await waitFor(() => two.isSender());
  await two.stop();
});

it('waits while navigator.onLine is false, sends on the online event, and flushes when the page becomes visible', async () => {
  navigator.onLine = false;
  let attempts = 0;
  const queue = createIdempotentQueue({
    send: () => {
      attempts++;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return 'ok';
    },
    retry: { baseDelayMs: 60000, maxDelayMs: 60000 },
    random: () => 0.99,
  });
  await queue.start();
  await waitFor(() => queue.isSender());
  await queue.enqueue({ payload: 1, key: 'k' });
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 30));
  expect(attempts).toBe(0);
  expect(window.count('online')).toBe(1);

  navigator.onLine = true;
  window.fire('online');
  await waitFor(() => attempts === 1 && queue.getItems()[0].status === 'pending');
  // The retry waits about a minute; the page becoming visible makes it due now.
  document.fire('visibilitychange');
  await waitFor(() => statuses(queue).join() === 'k:succeeded');
  expect(attempts).toBe(2);

  await queue.stop();
  expect(window.count('online') + window.count('offline') + document.count('visibilitychange')).toBe(0);
});

it('falls back to BroadcastChannel locks without navigator.locks, and the other tab takes over', async () => {
  navigator.locks = undefined;
  const sent: Array<[string, number]> = [];
  const open = (tab: string) =>
    createIdempotentQueue({
      send: (_item: QueueItem, { attempt }) => {
        sent.push([tab, attempt]);
        return 'ok';
      },
    });
  const one = open('one');
  const two = open('two');
  await one.start();
  await waitFor(() => one.isSender());
  await two.start();
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 250));
  expect(two.isSender()).toBe(false);
  await one.stop();
  await waitFor(() => two.isSender());
  await two.enqueue({ payload: 1, key: 'k' });
  await waitFor(() => statuses(two).join() === 'k:succeeded');
  expect(sent).toEqual([['two', 1]]);
  await two.stop();
});
