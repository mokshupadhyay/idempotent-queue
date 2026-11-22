import { defaultClassifyError, HttpError, parseRetryAfter } from '../classify';
import { fetchSender, KEEPALIVE_BODY_LIMIT, type FetchLike } from '../fetchSender';
import { createMemoryLocks } from '../locks';
import { decodeEnvelope, QueuePersistence, readQuarantine, readSlots } from '../persistence';
import { createIdempotentQueue } from '../queue';
import { createLocalStorageAdapter, createMemoryStorage, type WebStorageLike } from '../storage';
import type {
  ErrorClassification,
  QueueChannel,
  QueueEvent,
  QueueItem,
  QueueOptions,
  QueueStorage,
  SendContext,
} from '../types';
import { FakeClock, flushMicrotasks } from './support/fakeClock';
import { FakeLocks } from './support/fakeLocks';

/*
 * One block per finding of the independent review. Each test failed on the
 * code before its fix.
 */

type Call = { item: QueueItem; context: SendContext; resolve(value?: unknown): void; reject(error: unknown): void };

function harness(overrides: Partial<QueueOptions> = {}, storage: QueueStorage = createMemoryStorage(), owner = 'app') {
  const clock = new FakeClock();
  const locks = new FakeLocks();
  const calls: Call[] = [];
  const events: QueueEvent[] = [];
  const queue = createIdempotentQueue({
    storage,
    send: (item, context) =>
      new Promise((resolve, reject) => {
        calls.push({ item, context, resolve, reject });
      }),
    now: () => clock.now,
    random: () => 0.5,
    timers: clock.timersFor(owner),
    locks: locks.locksFor(owner),
    channel: null,
    subscribeToVisibility: null,
    retry: { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000 },
    ...overrides,
  });
  queue.subscribe((event) => events.push(event));
  return { clock, calls, events, queue, storage, tick: () => clock.advance(0) };
}

/** Every stored slot must pass the same validation the queue applies when it loads. */
function expectSlotsValid(storage: { data: Map<string, string> }, prefix = 'idempotent-queue') {
  for (const slot of ['a', 'b']) {
    const raw = storage.data.get(`${prefix}:${slot}`);
    if (raw === undefined) continue;
    expect({ slot, result: decodeEnvelope(raw).ok }).toEqual({ slot, result: true });
  }
}

const types = (events: QueueEvent[]) => events.map((event) => event.type);

describe('finding 1: non-finite retry delays never reach storage', () => {
  it.each<[string, ErrorClassification]>([
    ['retryable Infinity', { type: 'retryable', delayMs: Infinity }],
    ['rateLimited Infinity', { type: 'rateLimited', delayMs: Infinity }],
    ['huge finite', { type: 'retryable', delayMs: 1e300 }],
  ])('clamps a classifier delay (%s) to maxDelayMs and keeps storage valid', async (_name, decision) => {
    const storage = createMemoryStorage();
    const { queue, calls, events, clock, tick } = harness({ classifyError: () => decision }, storage);
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'pay-1' });
    await tick();
    calls[0].reject(new Error('busy'));
    await tick();
    const [item] = queue.getItems();
    expect(item.status).toBe('pending');
    expect(item.nextAttemptAt).toBe(clock.now + 10000);
    expectSlotsValid(storage);
    // The next write in the same tab does not roll the queue back.
    await queue.enqueue({ payload: 2, key: 'pay-2' });
    expectSlotsValid(storage);
    expect(types(events)).not.toContain('quarantined');
    expect(queue.getItems().map((i) => [i.key, i.attempts])).toEqual([
      ['pay-1', 1],
      ['pay-2', 0],
    ]);
  });

  it('treats a negative delay as 0 and NaN as no delay (normal backoff)', async () => {
    const decisions: ErrorClassification[] = [
      { type: 'retryable', delayMs: -5000 },
      { type: 'retryable', delayMs: NaN },
    ];
    const { queue, calls, events, clock, tick } = harness({ classifyError: () => decisions.shift()! });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    calls[0].reject(new Error('x'));
    await tick();
    const delays: number[] = [];
    events.forEach((event) => event.type === 'retry-scheduled' && delays.push(event.delayMs));
    expect(delays).toEqual([0]);
    calls[1].reject(new Error('x'));
    await tick();
    expect(queue.getItems()[0].nextAttemptAt).toBe(clock.now + 1000); // backoff for 2 failures at random 0.5
  });

  it('parseRetryAfter rejects values that do not fit a finite delay', () => {
    expect(parseRetryAfter('9'.repeat(400), 0)).toBeUndefined();
    expect(parseRetryAfter('1e400', 0)).toBeUndefined();
    expect(parseRetryAfter('120', 0)).toBe(120000);
  });

  it('does not resend a succeeded item after a huge Retry-After (review r7b)', async () => {
    const storage = createMemoryStorage();
    const { queue, calls, tick } = harness({ concurrency: 2 }, storage);
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'pay-ok' });
    await queue.enqueue({ payload: 2, key: 'pay-429' });
    await tick();
    calls[0].resolve('charged');
    calls[1].reject(new HttpError(429, 'slow down', { 'Retry-After': '9'.repeat(400) }));
    await tick();
    await queue.enqueue({ payload: 3, key: 'later' });
    await tick();
    expectSlotsValid(storage);
    expect(calls.filter((call) => call.context.key === 'pay-ok')).toHaveLength(1);
    expect(queue.getItems().find((i) => i.key === 'pay-ok')!.status).toBe('succeeded');
  });

  it('refuses to write a state that would fail validation, and keeps the stored state', async () => {
    const storage = createMemoryStorage();
    const persistence = new QueuePersistence(storage, 'q', createMemoryLocks(), {
      onCommit: () => undefined,
      onCleared: () => undefined,
      onQuarantine: () => undefined,
      onStorageError: () => undefined,
      now: () => 0,
    });
    const good: QueueItem = {
      id: 'a',
      key: 'ka',
      payload: 1,
      status: 'pending',
      attempts: 0,
      sequence: 1,
      createdAt: 0,
      updatedAt: 0,
      nextAttemptAt: 0,
    };
    await persistence.transact(() => ({ items: [good], result: undefined }));
    const before = new Map(storage.data);
    const bad = persistence.transact(() => ({ items: [{ ...good, nextAttemptAt: Infinity }], result: undefined }));
    const other = persistence.transact((items) => ({
      items: items.concat([{ ...good, id: 'b', key: 'kb', sequence: 2 }]),
      result: 'ok',
    }));
    await expect(bad).rejects.toThrow(/nextAttemptAt/);
    // A valid change in the same batch is still written.
    await expect(other).resolves.toBe('ok');
    expectSlotsValid(storage, 'q');
    expect(readSlots(storage.data.get('q:a'), storage.data.get('q:b')).items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(before.get('q:a')).toBe(storage.data.get('q:a'));
  });
});

describe('finding 2: HTTP 409 (key still being processed) is retried', () => {
  it('classifies 409 as retryable, honours Retry-After, and keeps 400 and 422 permanent', () => {
    expect(defaultClassifyError(new HttpError(409), { now: 0 })).toEqual({ type: 'retryable' });
    expect(defaultClassifyError(new HttpError(409, undefined, { 'Retry-After': '2' }), { now: 0 })).toEqual({
      type: 'rateLimited',
      delayMs: 2000,
    });
    expect(defaultClassifyError(new HttpError(422), { now: 0 })).toEqual({ type: 'permanent' });
    expect(defaultClassifyError(new HttpError(400), { now: 0 })).toEqual({ type: 'permanent' });
  });

  it('ends succeeded when the server answers 409 until the first request finishes (review r10)', async () => {
    const { queue, calls, clock, tick } = harness();
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'pay-1' });
    await tick();
    calls[0].reject(new HttpError(409, 'Conflict'));
    await tick();
    expect(queue.getItems()[0].status).toBe('pending');
    await clock.advance(10000);
    expect(calls[1].context).toMatchObject({ key: 'pay-1', attempt: 2 });
    calls[1].resolve({ charged: true });
    await tick();
    expect(queue.getItems()[0].status).toBe('succeeded');
  });
});

/** A Web Storage with a quota, like localStorage (about 5 MB per origin in browsers). */
function quotaStorage(limit: number): WebStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const used = () => Array.from(map).reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    map,
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => {
      const old = map.has(key) ? key.length + (map.get(key) as string).length : 0;
      if (used() - old + key.length + value.length > limit) {
        throw Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' });
      }
      map.set(key, value);
    },
  };
}

describe('finding 3: a quarantine copy that does not fit never blocks normal writes', () => {
  it('writes the replacement slot first and reports the lost copy (review r12)', async () => {
    const web = quotaStorage(250 * 1024);
    const storage = createLocalStorageAdapter(web);
    const first = createIdempotentQueue({ storage, send: () => 1, locks: createMemoryLocks(), channel: null });
    for (let i = 0; i < 4; i++) await first.enqueue({ payload: 'x'.repeat(25 * 1024), key: `k${i}` });
    const a = web.map.get('idempotent-queue:a')!;
    web.map.set('idempotent-queue:a', a.slice(0, 500) + 'Z' + a.slice(501));

    const second = createIdempotentQueue({ storage, send: () => 1, locks: createMemoryLocks(), channel: null });
    const events: QueueEvent[] = [];
    second.subscribe((event) => events.push(event));
    await second.load();
    await expect(second.enqueue({ payload: 'new payment', key: 'new' })).resolves.toMatchObject({ key: 'new' });
    await expect(second.enqueue({ payload: 'another', key: 'new2' })).resolves.toMatchObject({ key: 'new2' });
    expect(second.getItems()).toHaveLength(6);
    const quarantined = events.filter((event) => event.type === 'quarantined');
    expect(quarantined).toEqual([
      { type: 'quarantined', reason: 'checksum mismatch', storageKey: 'idempotent-queue:a', saved: false },
    ]);
  });

  it('caps the stored quarantine', async () => {
    const storage = createMemoryStorage();
    const queue = createIdempotentQueue({ storage, send: () => 1, channel: null });
    await queue.enqueue({ payload: 1, key: 'k' });
    storage.data.set('idempotent-queue:b', 'x'.repeat(2 * 1024 * 1024));
    await createIdempotentQueue({ storage, send: () => 1, channel: null }).load();
    const raw = storage.data.get('idempotent-queue:quarantine')!;
    expect(raw.length).toBeLessThanOrEqual(256 * 1024 + 1024);
    const [entry] = await readQuarantine(storage);
    expect(entry).toMatchObject({ storageKey: 'idempotent-queue:b', truncated: true });
  });
});

/** An async store without `update`, like the README's Node file adapter, that can "die" on one removeItem. */
function dyingStore() {
  const mem = new Map<string, string>();
  const state = { failOn: undefined as string | undefined };
  const storage: QueueStorage = {
    getItem: async (key) => (mem.has(key) ? (mem.get(key) as string) : null),
    setItem: async (key, value) => {
      if (key === state.failOn) throw new Error('process killed');
      mem.set(key, value);
    },
    removeItem: async (key) => {
      if (key === state.failOn) throw new Error('process killed');
      mem.delete(key);
    },
  };
  return { mem, state, storage };
}

describe('finding 4: an interrupted clear() never brings old items back', () => {
  it.each(['idempotent-queue:a', 'idempotent-queue:b', 'idempotent-queue:quarantine'])(
    'is empty or unchanged after dying at the step that touches %s',
    async (failOn) => {
      // Two or three items, sent or not, so that either slot can hold the newest copy.
      for (const [count, sendFirst] of [[2, false], [3, false], [2, true], [3, true]] as Array<[number, boolean]>) {
        const { state, storage } = dyingStore();
        const q1 = createIdempotentQueue({ storage, send: async () => 1, channel: null, locks: createMemoryLocks() });
        for (let i = 1; i <= count; i++) await q1.enqueue({ payload: i, key: `pay-${i}` });
        if (sendFirst) {
          await q1.start();
          await q1.flush();
          await q1.stop();
        }
        const before = q1.getItems().map((i) => [i.key, i.status]);
        state.failOn = failOn;
        const outcome = await q1.clear().then(
          () => 'resolved',
          () => 'rejected',
        );
        state.failOn = undefined;
        const q2 = createIdempotentQueue({ storage, send: async () => 1, channel: null, locks: createMemoryLocks() });
        await q2.load();
        const after = q2.getItems().map((i) => [i.key, i.status]);
        // Either the clear took effect, or nothing changed. An older state (a rollback) is neither.
        const expected = outcome === 'resolved' || after.length === 0 ? [] : before;
        expect({ failOn, count, sendFirst, after }).toEqual({ failOn, count, sendFirst, after: expected });
      }
    },
  );

  it('ends empty when it dies after the first step (review r11, r11b)', async () => {
    const { state, storage, mem } = dyingStore();
    const q1 = createIdempotentQueue({ storage, send: async () => 1, channel: null, locks: createMemoryLocks() });
    await q1.enqueue({ payload: 100, key: 'pay-1' });
    await q1.enqueue({ payload: 200, key: 'pay-2' });
    state.failOn = 'idempotent-queue:b';
    await expect(q1.clear()).rejects.toThrow('process killed');
    state.failOn = undefined;
    const q2 = createIdempotentQueue({ storage, send: async () => 1, channel: null, locks: createMemoryLocks() });
    await q2.load();
    expect(q2.getItems()).toEqual([]);
    // The clear can be finished later.
    await q2.clear();
    expect(Array.from(mem.keys())).toEqual([]);
  });
});

describe('finding 5: a failed or dead item holds back the rest of its group', () => {
  it('keeps send order when the head fails and is retried (review r13)', async () => {
    const { queue, calls, tick } = harness({ retry: { maxAttempts: 1 } });
    await queue.start();
    const head = await queue.enqueue({ payload: 1, key: 'open-account', group: 'acct' });
    await queue.enqueue({ payload: 2, key: 'transfer', group: 'acct' });
    await queue.enqueue({ payload: 3, key: 'free' });
    await tick();
    calls[0].reject(new Error('network'));
    await tick();
    expect(queue.getItems().map((i) => i.status)).toEqual(['failed', 'pending', 'inflight']);
    calls[1].resolve();
    await tick();
    expect(calls.map((call) => call.context.key)).toEqual(['open-account', 'free']);
    await queue.retry(head.id);
    await tick();
    calls[2].resolve();
    await tick();
    calls[3].resolve();
    await tick();
    expect(calls.map((call) => call.context.key)).toEqual(['open-account', 'free', 'open-account', 'transfer']);
  });

  it('releases the group when the dead head is discarded', async () => {
    const { queue, calls, tick } = harness();
    await queue.start();
    const head = await queue.enqueue({ payload: 1, key: 'a', group: 'g' });
    await queue.enqueue({ payload: 2, key: 'b', group: 'g' });
    await tick();
    calls[0].reject(new HttpError(400));
    await tick();
    expect(calls.map((call) => call.context.key)).toEqual(['a']);
    await queue.discard(head.id);
    await tick();
    expect(calls.map((call) => call.context.key)).toEqual(['a', 'b']);
  });
});

describe('finding 7: a send that never settles cannot block the queue', () => {
  it('passes an AbortSignal and aborts an attempt after attemptTimeoutMs, as a retryable attempt', async () => {
    const { queue, calls, events, clock, tick } = harness({ attemptTimeoutMs: 5000 });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    const { signal } = calls[0].context;
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    signal!.addEventListener('abort', () => calls[0].reject(new Error('aborted')));
    await clock.advance(5000);
    expect(signal!.aborted).toBe(true);
    const [item] = queue.getItems();
    expect(item).toMatchObject({ status: 'pending', attempts: 1, lastError: { kind: 'retryable' } });
    expect(item.lastError!.message).toMatch(/5000 ms/);
    expect(types(events)).toContain('retry-scheduled');
    await clock.advance(10000);
    expect(calls[1].context).toMatchObject({ key: 'k', attempt: 2 });
  });

  it('defaults attemptTimeoutMs to 30 seconds', async () => {
    const { queue, calls, clock, tick } = harness();
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    await clock.advance(29999);
    expect(calls[0].context.signal!.aborted).toBe(false);
    await clock.advance(1);
    expect(calls[0].context.signal!.aborted).toBe(true);
  });

  it('lets stop() abort attempts in flight after a grace period and hand the lock on (review r8)', async () => {
    const { queue, calls, clock, tick } = harness({ attemptTimeoutMs: Infinity });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    let stopped = false;
    void queue.stop({ abortAfterMs: 1000 }).then(() => (stopped = true));
    await clock.advance(999);
    expect(stopped).toBe(false);
    await clock.advance(1);
    // The send ignores the signal and never settles; stop() still resolves.
    expect(calls[0].context.signal!.aborted).toBe(true);
    expect(stopped).toBe(true);
    expect(queue.isSender()).toBe(false);
    expect(queue.getItems()[0]).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: clock.now });
  });

  it('keeps the key blocked in this tab until a send that ignores the signal settles', async () => {
    const { queue, calls, clock, tick } = harness({ attemptTimeoutMs: 1000, retry: { baseDelayMs: 0 } });
    await queue.start();
    await queue.enqueue({ payload: 1, key: 'k' });
    await tick();
    await clock.advance(5000);
    expect(calls).toHaveLength(1);
    calls[0].reject(new Error('late'));
    await tick();
    expect(calls).toHaveLength(2);
  });
});

describe('finding 8: start/stop/start leaves no extra subscriptions', () => {
  it('returns channel, visibility and connectivity subscriptions to zero after the final stop (review r2)', async () => {
    const subs = { channel: 0, visibility: 0, connectivity: 0 };
    const channel: QueueChannel = {
      postMessage: () => undefined,
      subscribe: () => {
        subs.channel++;
        return () => void subs.channel--;
      },
    };
    const queue = createIdempotentQueue({
      storage: createMemoryStorage(),
      channel,
      send: async () => 'ok',
      subscribeToVisibility: () => {
        subs.visibility++;
        return () => void subs.visibility--;
      },
      isOnline: () => true,
      subscribeToConnectivity: () => {
        subs.connectivity++;
        return () => void subs.connectivity--;
      },
    });
    await Promise.all([queue.start(), queue.stop(), queue.start()]);
    expect(subs).toEqual({ channel: 1, visibility: 1, connectivity: 1 });
    await queue.stop();
    expect(subs).toEqual({ channel: 0, visibility: 0, connectivity: 0 });
    expect(queue.isRunning()).toBe(false);
  });
});

describe('finding 9: every timer delay fits setTimeout', () => {
  it.each([Infinity, 2 ** 31, 1e300])('clamps syncIntervalMs %s', async (syncIntervalMs) => {
    const delays: number[] = [];
    const clock = new FakeClock();
    const timers = clock.timersFor('app');
    const queue = createIdempotentQueue({
      storage: createMemoryStorage(),
      channel: null,
      syncIntervalMs,
      send: async () => 1,
      locks: new FakeLocks().locksFor('app'),
      timers: {
        setTimeout: (callback, ms) => {
          delays.push(ms);
          return timers.setTimeout(callback, ms);
        },
        clearTimeout: timers.clearTimeout,
      },
    });
    await queue.start();
    await clock.advance(10);
    expect(delays.length).toBeGreaterThan(0);
    delays.forEach((ms) => expect(ms >= 0 && ms <= 2 ** 31 - 1).toBe(true));
    await queue.stop();
  });
});

describe('finding 10: fetchSender accepts every HeadersInit shape', () => {
  const run = async (headers: unknown) => {
    const seen: Array<Record<string, unknown>> = [];
    const fetch: FetchLike = async (_url, init) => {
      seen.push(init);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => '' };
    };
    await fetchSender('/pay', { headers: headers as Record<string, string> }, { fetch })(
      { payload: { a: 1 } } as QueueItem,
      { key: 'k1', attempt: 1 },
    );
    return seen[0].headers as Record<string, string>;
  };

  it('reads a Headers instance, an array of pairs and a record', async () => {
    const expected = { 'Idempotency-Key': 'k1', 'Content-Type': 'application/json' };
    expect(await run(new Headers({ Authorization: 'Bearer T' }))).toEqual({ authorization: 'Bearer T', ...expected });
    expect(await run([['Authorization', 'Bearer T']])).toEqual({ Authorization: 'Bearer T', ...expected });
    expect(await run({ Authorization: 'Bearer T' })).toEqual({ Authorization: 'Bearer T', ...expected });
  });

  it('still never lets a Headers instance or pair replace the key, and keeps its content type', async () => {
    expect(await run(new Headers({ 'idempotency-key': 'evil', 'content-type': 'text/plain' }))).toEqual({
      'content-type': 'text/plain',
      'Idempotency-Key': 'k1',
    });
    expect(await run([['Idempotency-Key', 'evil']])).toEqual({
      'Idempotency-Key': 'k1',
      'Content-Type': 'application/json',
    });
  });
});

describe('finding 11: keepalive bodies are measured, and their total in flight stays under 64 KiB', () => {
  const sender = (body?: unknown) => {
    const seen: Array<Record<string, unknown>> = [];
    const answers: Array<() => void> = [];
    const fetch: FetchLike = (_url, init) => {
      seen.push(init);
      return new Promise((resolve) =>
        answers.push(() => resolve({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' })),
      );
    };
    const send = fetchSender('/pay', body === undefined ? undefined : { body }, { fetch, keepalive: true });
    return { seen, answers, send };
  };
  const item = (payload: unknown) => ({ payload }) as QueueItem;

  it.each<[string, unknown, boolean]>([
    ['Blob over the limit', new Blob(['x'.repeat(KEEPALIVE_BODY_LIMIT + 1)]), false],
    ['Blob under the limit', new Blob(['x'.repeat(1000)]), true],
    ['ArrayBuffer over the limit', new ArrayBuffer(KEEPALIVE_BODY_LIMIT + 1), false],
    ['typed array over the limit', new Uint8Array(KEEPALIVE_BODY_LIMIT + 1), false],
    ['typed array under the limit', new Uint8Array(10), true],
    ['URLSearchParams over the limit', new URLSearchParams({ a: 'x'.repeat(KEEPALIVE_BODY_LIMIT) }), false],
    ['URLSearchParams under the limit', new URLSearchParams({ a: 'b' }), true],
    ['FormData (size unknown)', new FormData(), false],
  ])('%s', async (_name, body, keepalive) => {
    const { seen, answers, send } = sender(body);
    const done = send(item(null), { key: 'k', attempt: 1 });
    await flushMicrotasks(5);
    expect(seen[0].keepalive === true).toBe(keepalive);
    answers[0]();
    await done;
  });

  it('sends without keepalive when the bodies already in flight would exceed the limit', async () => {
    const { seen, answers, send } = sender();
    const first = send(item('y'.repeat(40 * 1024)), { key: 'a', attempt: 1 });
    const second = send(item('z'.repeat(40 * 1024)), { key: 'b', attempt: 1 });
    await flushMicrotasks(5);
    expect(seen.map((init) => init.keepalive === true)).toEqual([true, false]);
    answers.forEach((answer) => answer());
    await Promise.all([first, second]);
    // Once they settle, the budget is free again.
    const third = send(item('w'.repeat(40 * 1024)), { key: 'c', attempt: 1 });
    await flushMicrotasks(5);
    expect(seen[2].keepalive).toBe(true);
    answers[2]();
    await third;
  });
});
