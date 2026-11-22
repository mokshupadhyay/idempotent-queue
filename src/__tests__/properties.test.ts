import fc from 'fast-check';
import { createIdempotentQueue } from '../queue';
import type { QueueItem } from '../types';
import { World, type Fault, type Payload, type WorldConfig } from './support/world';

/*
 * Property tests against a fake server that deduplicates by idempotency key.
 * Time is a fake clock; every timer, storage write and response runs on it.
 * Set NUM_RUNS to run more cases (default 120 per property).
 */
declare const process: { env: Record<string, string | undefined> };
const NUM_RUNS = Number(process.env.NUM_RUNS || 120);

/**
 * Counts of the interesting situations the generated cases reached. Each
 * property asserts its counters are non-zero, so a generator change that stops
 * producing crashes mid-flight (for example) fails loudly instead of passing.
 */
function coverage<K extends string>(...names: K[]) {
  const counts = {} as Record<K, number>;
  names.forEach((name) => (counts[name] = 0));
  return {
    counts,
    hit(name: K, condition = true) {
      if (condition) counts[name]++;
    },
    expectAllReached() {
      if (process.env.SHOW_COVERAGE) console.warn(JSON.stringify(counts));
      names.forEach((name) => expect({ [name]: counts[name] > 0 }).toEqual({ [name]: true }));
    },
  };
}
const KEYS = 6;
const keyName = (n: number) => `key-${n}`;
const groupOf = (n: number) => (n % 3 === 0 ? undefined : `group-${n % 3}`);

type Op =
  | { t: 'enqueue'; key: number; tab?: number }
  | { t: 'crash'; tab?: number }
  | { t: 'offline' }
  | { t: 'online' }
  | { t: 'advance'; ms: number }
  | { t: 'flush'; tab?: number }
  | { t: 'stop'; tab?: number }
  | { t: 'start'; tab?: number }
  | { t: 'discard'; index: number; tab?: number }
  | { t: 'retry'; index: number; tab?: number }
  | { t: 'resubmit'; index: number; tab?: number };

const tabArb = fc.integer({ min: 0, max: 1 });
const enqueueOf = (keys: number) =>
  fc.record({ t: fc.constant('enqueue' as const), key: fc.integer({ min: 0, max: keys - 1 }), tab: tabArb });
const enqueueOp = enqueueOf(KEYS);
const advanceOp = fc.record({ t: fc.constant('advance' as const), ms: fc.integer({ min: 0, max: 400 }) });
const simple = (t: 'crash' | 'offline' | 'online' | 'flush' | 'stop' | 'start') =>
  fc.record({ t: fc.constant(t), tab: tabArb }) as fc.Arbitrary<Op>;
const indexOp = (t: 'discard' | 'retry' | 'resubmit') =>
  fc.record({ t: fc.constant(t), index: fc.integer({ min: 0, max: 9 }), tab: tabArb }) as fc.Arbitrary<Op>;

const networkFault = fc.constantFrom<Fault>('ok', 'ok', 'lostRequest', 'lostResponse', 'http500', 'http429');
const anyFault = fc.constantFrom<Fault>('ok', 'lostRequest', 'lostResponse', 'http500', 'http429', 'http400');

const worldConfig = (faults: fc.Arbitrary<Fault>, maxAttempts: fc.Arbitrary<number>, minSendLatency = 1) =>
  fc.record<WorldConfig>({
    concurrency: fc.integer({ min: 1, max: 3 }),
    storageLatency: fc.integer({ min: 0, max: 3 }),
    sendLatency: fc.integer({ min: minSendLatency, max: 40 }),
    useSubscription: fc.boolean(),
    seed: fc.integer(),
    retry: maxAttempts.map((value) => ({ maxAttempts: value, baseDelayMs: 20, maxDelayMs: 300 })),
    faults: fc.array(faults, { maxLength: 40 }),
    atomicStorage: fc.boolean(),
    useChannel: fc.boolean(),
  });

/** Runs every timer until `done()` or a generous simulated deadline. */
async function settle(world: World, done: () => boolean): Promise<void> {
  for (let i = 0; i < 3000 && !done(); i++) await world.clock.advance(50);
}

/** Tab slot an op targets: always 0 in single-tab worlds. */
const slotOf = (world: World, op: Op) => (('tab' in op && op.tab) || 0) % world.tabs.length;

function enqueue(world: World, slot: number, key: number, n: number, confirmed?: Set<string>) {
  const name = keyName(key);
  const group = groupOf(key);
  world.tabs[slot].queue
    .enqueue({ payload: { key: name, n }, key: name, ...(group ? { group } : {}) })
    .then(
      () => confirmed && confirmed.add(name),
      () => undefined,
    );
}

const terminal = (item: QueueItem) => item.status !== 'pending' && item.status !== 'inflight';

describe('property 1: every enqueued key is applied exactly once and ends succeeded', () => {
  it('holds across crashes, offline periods and lost responses', async () => {
    const seen = coverage('resentAfterCrash', 'lostResponse', 'duplicateEnqueue', 'lostToOffline', 'lostUnconfirmedEnqueue');
    await fc.assert(
      fc.asyncProperty(
        worldConfig(networkFault, fc.constant(Infinity)),
        fc.array(
          fc.oneof(
            { weight: 4, arbitrary: enqueueOp },
            { weight: 4, arbitrary: advanceOp },
            { weight: 2, arbitrary: simple('crash') },
            { weight: 1, arbitrary: simple('offline') },
            { weight: 1, arbitrary: simple('online') },
            { weight: 1, arbitrary: simple('flush') },
          ),
          { maxLength: 40, size: 'medium' },
        ),
        async (config, ops) => {
          const world = new World(config);
          void world.process.queue.start();
          /** Keys the app asked for, and the payload it used first. */
          const requested = new Map<string, number>();
          const confirmed = new Set<string>();
          let n = 0;
          for (const op of ops) {
            if (op.t === 'enqueue') {
              const name = keyName(op.key);
              seen.hit('duplicateEnqueue', requested.has(name));
              if (!requested.has(name)) requested.set(name, n);
              enqueue(world, 0, op.key, n++, confirmed);
            } else if (op.t === 'crash') {
              seen.hit('lostUnconfirmedEnqueue', Array.from(requested.keys()).some((key) => !confirmed.has(key)));
              world.crash();
              void world.process.queue.start();
              // An app re-enqueues, with the same key, anything it was not told was saved.
              requested.forEach((first, name) => {
                if (!confirmed.has(name)) enqueue(world, 0, Number(name.slice(4)), first, confirmed);
              });
            } else if (op.t === 'offline') world.setOnline(false);
            else if (op.t === 'online') world.setOnline(true);
            else if (op.t === 'flush') void world.process.queue.flush();
            else if (op.t === 'advance') await world.clock.advance(op.ms);
            await world.clock.advance(0);
          }

          world.setOnline(true);
          world.stopFaults();
          const allSucceeded = () => {
            const items = world.process.queue.getItems();
            return Array.from(requested.keys()).every(
              (key) => confirmed.has(key) && items.some((item) => item.key === key && item.status === 'succeeded'),
            );
          };
          await settle(world, allSucceeded);

          const items = world.process.queue.getItems();
          for (const key of requested.keys()) {
            expect(confirmed.has(key)).toBe(true);
            expect(world.server.applied.get(key)).toBe(1);
            const matching = items.filter((item) => item.key === key);
            expect(matching).toHaveLength(1);
            expect(matching[0].status).toBe('succeeded');
          }
          expect(items).toHaveLength(requested.size);

          seen.hit('lostResponse', world.sends.some((send) => send.online && send.fault === 'lostResponse'));
          seen.hit('lostToOffline', world.sends.some((send) => send.lostToOffline === true));
          seen.hit(
            'resentAfterCrash',
            Array.from(requested.keys()).some((key) => {
              const tabs = new Set(world.sends.filter((send) => send.key === key).map((send) => send.tab));
              return tabs.size > 1;
            }),
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
    seen.expectAllReached();
  });
});

describe('property 2: the same key is never in flight twice at the same time', () => {
  it('holds with concurrency, groups, discards of items in flight and re-enqueues', async () => {
    const seen = coverage('discardInFlight', 'reenqueueWhileOldInFlight', 'parallelDifferentKeys');
    await fc.assert(
      fc.asyncProperty(
        worldConfig(anyFault, fc.integer({ min: 1, max: 5 }), 10),
        fc.array(
          fc.oneof(
            { weight: 4, arbitrary: enqueueOf(3) },
            { weight: 3, arbitrary: advanceOp },
            { weight: 2, arbitrary: indexOp('discard') },
            { weight: 2, arbitrary: indexOp('resubmit') },
            { weight: 1, arbitrary: indexOp('retry') },
            { weight: 1, arbitrary: simple('flush') },
            { weight: 1, arbitrary: simple('offline') },
            { weight: 1, arbitrary: simple('online') },
          ),
          { maxLength: 40, size: 'medium' },
        ),
        async (config, ops) => {
          const world = new World(config);
          const { queue } = world.process;
          void queue.start();
          let n = 0;
          for (const op of ops) {
            const items = queue.getItems();
            if (op.t === 'enqueue') enqueue(world, 0, op.key, n++);
            else if (op.t === 'discard' && items.length > 0) {
              // Prefer items in flight: that is when a re-enqueue could overlap.
              const inflight = items.filter((item) => item.status === 'inflight');
              seen.hit('discardInFlight', inflight.length > 0);
              const pool = inflight.length > 0 ? inflight : items;
              void queue.discard(pool[op.index % pool.length].id);
            } else if (op.t === 'resubmit' && items.length > 0) {
              // Cancel and send again with the same key, as a "try again" button might.
              const inflight = items.filter((item) => item.status === 'inflight');
              const pool = inflight.length > 0 ? inflight : items;
              const item = pool[op.index % pool.length];
              void queue.discard(item.id).then(() => {
                seen.hit('reenqueueWhileOldInFlight', (world.inflight.get(item.key) || 0) > 0);
                enqueue(world, 0, Number(item.key.slice(4)), n++);
              });
            } else if (op.t === 'retry' && items.length > 0) {
              queue.retry(items[op.index % items.length].id).catch(() => undefined);
            } else if (op.t === 'flush') void queue.flush();
            else if (op.t === 'offline') world.setOnline(false);
            else if (op.t === 'online') world.setOnline(true);
            else if (op.t === 'advance') await world.clock.advance(op.ms);
            await world.clock.advance(0);
            seen.hit('parallelDifferentKeys', queue.getItems().filter((item) => item.status === 'inflight').length > 1);
          }
          world.setOnline(true);
          await settle(world, () => queue.getItems().every(terminal));
          expect(world.maxSameKeyInFlight).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
    seen.expectAllReached();
  });
});

describe('property 3: permanent errors are never retried; retryable errors use at most maxAttempts', () => {
  it('holds for any mix of errors, offline periods and stop/start', async () => {
    const seen = coverage('dead', 'failed', 'succeededAfterRetry', 'rateLimited');
    await fc.assert(
      fc.asyncProperty(
        worldConfig(anyFault, fc.integer({ min: 1, max: 4 })),
        fc.array(
          fc.oneof(
            { weight: 4, arbitrary: enqueueOp },
            { weight: 4, arbitrary: advanceOp },
            { weight: 1, arbitrary: simple('offline') },
            { weight: 1, arbitrary: simple('online') },
            { weight: 1, arbitrary: simple('flush') },
            { weight: 1, arbitrary: simple('stop') },
            { weight: 1, arbitrary: simple('start') },
          ),
          { maxLength: 40, size: 'medium' },
        ),
        fc.constantFrom<Fault>('ok', 'http500', 'lostResponse'),
        async (config, ops, tail) => {
          // After the scripted faults, every request ends the same way.
          const world = new World({ ...config, faults: config.faults.concat(new Array(200).fill(tail)) });
          const { queue } = world.process;
          const maxAttempts = config.retry!.maxAttempts!;
          void queue.start();
          let n = 0;
          for (const op of ops) {
            if (op.t === 'enqueue') enqueue(world, 0, op.key, n++);
            else if (op.t === 'offline') world.setOnline(false);
            else if (op.t === 'online') world.setOnline(true);
            else if (op.t === 'flush') void queue.flush();
            else if (op.t === 'stop') void queue.stop();
            else if (op.t === 'start') void queue.start();
            else if (op.t === 'advance') await world.clock.advance(op.ms);
            await world.clock.advance(0);
          }
          world.setOnline(true);
          void queue.start();
          await settle(world, () => queue.getItems().every(terminal));

          for (const item of queue.getItems()) {
            expect(terminal(item)).toBe(true);
            const sends = world.sends.filter((record) => record.key === item.key);
            expect(sends.length).toBeLessThanOrEqual(maxAttempts);
            const permanent = sends.findIndex((record) => record.outcome === 'permanent');
            if (permanent >= 0) {
              expect(permanent).toBe(sends.length - 1);
              expect(item.status).toBe('dead');
            } else {
              expect(item.status).not.toBe('dead');
            }
            if (item.status === 'failed') expect(sends).toHaveLength(maxAttempts);
            expect(item.attempts).toBe(sends.length);
            seen.hit('dead', item.status === 'dead');
            seen.hit('failed', item.status === 'failed' && maxAttempts > 1);
            seen.hit('succeededAfterRetry', item.status === 'succeeded' && sends.length > 1);
            seen.hit('rateLimited', sends.some((send) => send.outcome === 'rateLimited'));
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
    seen.expectAllReached();
  });
});

/** What a reload must show for a live item: interrupted attempts return to `pending`, or `failed` after the last one. */
function afterReload(item: QueueItem, maxAttempts: number) {
  const status =
    item.status === 'inflight' ? (item.attempts >= maxAttempts ? 'failed' : 'pending') : item.status;
  return {
    id: item.id,
    key: item.key,
    group: item.group,
    payload: item.payload,
    sequence: item.sequence,
    attempts: item.attempts,
    status,
  };
}

describe('property 4: reloading from storage gives the same items as the live queue', () => {
  it('holds after every prefix of operations', async () => {
    const seen = coverage('comparedInFlight', 'comparedAfterCrash', 'comparedTerminal', 'comparedWhileStopped');
    await fc.assert(
      fc.asyncProperty(
        worldConfig(anyFault, fc.integer({ min: 1, max: 4 })).map((config) => ({ ...config, storageLatency: 0 })),
        fc.array(
          fc.oneof(
            { weight: 4, arbitrary: enqueueOp },
            { weight: 3, arbitrary: advanceOp },
            { weight: 1, arbitrary: indexOp('discard') },
            { weight: 1, arbitrary: indexOp('retry') },
            { weight: 1, arbitrary: simple('crash') },
            { weight: 1, arbitrary: simple('offline') },
            { weight: 1, arbitrary: simple('online') },
            { weight: 1, arbitrary: simple('flush') },
            { weight: 1, arbitrary: simple('stop') },
            { weight: 1, arbitrary: simple('start') },
          ),
          { maxLength: 40, size: 'medium' },
        ),
        async (config, ops) => {
          const world = new World(config);
          const maxAttempts = config.retry!.maxAttempts!;
          void world.process.queue.start();
          let n = 0;
          let reloads = 0;
          for (const op of ops) {
            const { queue } = world.process;
            const items = queue.getItems();
            if (op.t === 'enqueue') enqueue(world, 0, op.key, n++);
            else if (op.t === 'crash') {
              world.crash();
              void world.process.queue.start();
            } else if (op.t === 'discard' && items.length > 0) void queue.discard(items[op.index % items.length].id);
            else if (op.t === 'retry' && items.length > 0) {
              queue.retry(items[op.index % items.length].id).catch(() => undefined);
            } else if (op.t === 'offline') world.setOnline(false);
            else if (op.t === 'online') world.setOnline(true);
            else if (op.t === 'flush') void world.process.queue.flush();
            else if (op.t === 'stop') void queue.stop();
            else if (op.t === 'start') void queue.start();
            else if (op.t === 'advance') await world.clock.advance(op.ms);
            await world.clock.advance(0);

            const live = world.process.queue;
            await live.load();
            const liveItems = live.getItems();
            // A fresh tab on a copy of the storage, started but offline: it recovers interrupted
            // attempts and sends nothing.
            const owner = `reload-${++reloads}`;
            const reloaded = createIdempotentQueue<Payload>({
              storage: world.snapshotStorage(),
              send: () => new Promise(() => undefined),
              retry: config.retry,
              isOnline: () => false,
              subscribeToVisibility: null,
              storageKey: 'idempotent-queue',
              now: () => world.clock.now,
              timers: world.clock.timersFor(owner),
            });
            void reloaded.start();
            await world.clock.advance(0);
            expect(reloaded.isSender()).toBe(true);
            const reloadedItems = reloaded.getItems();
            void reloaded.stop();
            world.clock.kill(owner);
            await world.clock.advance(0);
            seen.hit('comparedInFlight', liveItems.some((item) => item.status === 'inflight'));
            seen.hit('comparedAfterCrash', op.t === 'crash' && liveItems.length > 0);
            seen.hit('comparedTerminal', liveItems.some(terminal));
            seen.hit('comparedWhileStopped', !live.isRunning() && liveItems.length > 0);
            expect(reloadedItems.map((item) => afterReload(item, maxAttempts))).toEqual(
              liveItems.map((item) => afterReload(item, maxAttempts)),
            );
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
    seen.expectAllReached();
  });
});

/** Two tabs: random enqueues, discards and re-enqueues from either tab, crashes and reloads of either. */
const tabsOps = fc.array(
  fc.oneof(
    { weight: 4, arbitrary: enqueueOf(4) },
    { weight: 4, arbitrary: advanceOp },
    { weight: 2, arbitrary: simple('crash') },
    { weight: 1, arbitrary: simple('stop') },
    { weight: 1, arbitrary: simple('start') },
    { weight: 2, arbitrary: indexOp('resubmit') },
    { weight: 1, arbitrary: simple('offline') },
    { weight: 1, arbitrary: simple('online') },
    { weight: 1, arbitrary: simple('flush') },
  ),
  { maxLength: 40, size: 'medium' },
);

const tabsConfig = worldConfig(networkFault, fc.constant(Infinity), 5).map((config) => ({ ...config, tabs: 2 }));

interface TabsRun {
  world: World;
  requested: Map<string, number>;
  confirmed: Set<string>;
  senderChanges: number;
  bothRunning: number;
  /** Re-enqueues of a key while a request for it was still in flight. */
  reenqueuedWhileInFlight: number;
  /** Enqueues made in a tab that was not the sender at the time. */
  enqueuedInNonSender: number;
}

async function runTabs(config: WorldConfig, ops: Op[], resubmit: boolean): Promise<TabsRun> {
  const world = new World(config);
  world.tabs.forEach((tab) => void tab.queue.start());
  const requested = new Map<string, number>();
  const confirmed = new Set<string>();
  let n = 0;
  let senderChanges = 0;
  let bothRunning = 0;
  let reenqueuedWhileInFlight = 0;
  let enqueuedInNonSender = 0;
  let lastSender: string | undefined;
  for (const op of ops) {
    const slot = slotOf(world, op);
    const { queue } = world.tabs[slot];
    if (op.t === 'enqueue') {
      const name = keyName(op.key);
      if (!requested.has(name)) requested.set(name, n);
      if (!queue.isSender()) enqueuedInNonSender++;
      enqueue(world, slot, op.key, n++, confirmed);
    } else if (op.t === 'crash') {
      world.crash(slot);
      void world.tabs[slot].queue.start();
      // The reloaded page re-enqueues, with the same key, anything it was not told was saved.
      requested.forEach((first, name) => {
        if (!confirmed.has(name)) enqueue(world, slot, Number(name.slice(4)), first, confirmed);
      });
    } else if (op.t === 'stop') void queue.stop();
    else if (op.t === 'start') void queue.start();
    else if (op.t === 'resubmit' && resubmit) {
      // "Try again" in this tab, possibly while the other tab is sending the item.
      const items = queue.getItems();
      if (items.length > 0) {
        const inflight = items.filter((item) => item.status === 'inflight');
        const pool = inflight.length > 0 ? inflight : items;
        const item = pool[op.index % pool.length];
        void queue.discard(item.id).then(
          () => {
            if ((world.inflight.get(item.key) || 0) > 0) reenqueuedWhileInFlight++;
            enqueue(world, slot, Number(item.key.slice(4)), n++, confirmed);
          },
          () => undefined,
        );
      }
    } else if (op.t === 'offline') world.setOnline(false);
    else if (op.t === 'online') world.setOnline(true);
    else if (op.t === 'flush') void queue.flush();
    else if (op.t === 'advance') await world.clock.advance(op.ms);
    await world.clock.advance(0);
    const holder = world.locks.holder('idempotent-queue:sender');
    if (holder && lastSender && holder !== lastSender) senderChanges++;
    if (holder) lastSender = holder;
    if (world.tabs.every((tab) => tab.queue.isRunning())) bothRunning++;
  }
  return { world, requested, confirmed, senderChanges, bothRunning, reenqueuedWhileInFlight, enqueuedInNonSender };
}

describe('property 5: with two tabs, the same key is never in flight twice', () => {
  it('holds across crashes and reloads of either tab, stops, and re-enqueues from the other tab', async () => {
    const seen = coverage('senderChanged', 'resentByOtherTab', 'reenqueueWhileInFlight', 'sentByEachTab');
    await fc.assert(
      fc.asyncProperty(tabsConfig, tabsOps, async (config, ops) => {
        const { world, senderChanges, reenqueuedWhileInFlight } = await runTabs(config, ops, true);
        world.setOnline(true);
        world.tabs.forEach((tab) => void tab.queue.start());
        await settle(world, () => world.stored().every(terminal));
        expect(world.maxSameKeyInFlight).toBeLessThanOrEqual(1);

        seen.hit('senderChanged', senderChanges > 0);
        const tabsByKey = new Map<string, Set<number>>();
        world.sends.forEach((send) => {
          const set = tabsByKey.get(send.key) || new Set<number>();
          set.add(send.tab);
          tabsByKey.set(send.key, set);
        });
        seen.hit('resentByOtherTab', Array.from(tabsByKey.values()).some((set) => set.size > 1));
        seen.hit('sentByEachTab', new Set(world.sends.map((send) => send.tab)).size > 1);
        seen.hit('reenqueueWhileInFlight', reenqueuedWhileInFlight > 0);
      }),
      { numRuns: NUM_RUNS },
    );
    seen.expectAllReached();
  });
});

describe('property 6: with two tabs, every key ends applied exactly once and succeeded', () => {
  it('holds across crashes and reloads of either tab, offline periods and lost responses', async () => {
    const seen = coverage('senderChanged', 'enqueuedInNonSender', 'resentAfterSenderCrash', 'lostResponse', 'bothRunning');
    await fc.assert(
      fc.asyncProperty(tabsConfig, tabsOps, async (config, ops) => {
        const { world, requested, confirmed, senderChanges, bothRunning, enqueuedInNonSender } = await runTabs(
          config,
          ops,
          false,
        );
        world.setOnline(true);
        world.stopFaults();
        world.tabs.forEach((tab) => void tab.queue.start());
        const allSucceeded = () => {
          const stored = world.stored();
          const seenByTabs = world.tabs.every((tab) =>
            Array.from(requested.keys()).every((key) =>
              tab.queue.getItems().some((item) => item.key === key && item.status === 'succeeded'),
            ),
          );
          return (
            seenByTabs &&
            Array.from(requested.keys()).every(
              (key) => confirmed.has(key) && stored.some((item) => item.key === key && item.status === 'succeeded'),
            )
          );
        };
        await settle(world, allSucceeded);

        const stored = world.stored();
        for (const key of requested.keys()) {
          expect(confirmed.has(key)).toBe(true);
          expect(world.server.applied.get(key)).toBe(1);
          const matching = stored.filter((item) => item.key === key);
          expect(matching).toHaveLength(1);
          expect(matching[0].status).toBe('succeeded');
        }
        expect(stored).toHaveLength(requested.size);
        // Each tab ends up showing the same items as storage.
        world.tabs.forEach((tab) => expect(tab.queue.getItems()).toEqual(stored));

        seen.hit('senderChanged', senderChanges > 0);
        seen.hit('bothRunning', bothRunning > 0);
        seen.hit('lostResponse', world.sends.some((send) => send.online && send.fault === 'lostResponse'));
        seen.hit('enqueuedInNonSender', enqueuedInNonSender > 0);
        seen.hit(
          'resentAfterSenderCrash',
          Array.from(requested.keys()).some((key) => new Set(world.sends.filter((s) => s.key === key).map((s) => s.tab)).size > 1),
        );
      }),
      { numRuns: NUM_RUNS },
    );
    seen.expectAllReached();
  });
});
