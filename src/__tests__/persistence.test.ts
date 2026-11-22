import fc from 'fast-check';
import { createMemoryLocks } from '../locks';
import {
  checksum,
  decodeEnvelope,
  encodeEnvelope,
  planQuarantine,
  planWrite,
  QueuePersistence,
  readQuarantine,
  readSlots,
  validateItem,
  VERSION,
  type Commit,
} from '../persistence';
import { createMemoryStorage } from '../storage';
import type { QueueItem, QueueStorage } from '../types';
import { flushMicrotasks } from './support/fakeClock';

const item = (id: string, overrides: Partial<QueueItem> = {}): QueueItem => ({
  id,
  key: `key-${id}`,
  payload: { amount: 5 },
  status: 'pending',
  attempts: 0,
  sequence: 1,
  createdAt: 0,
  updatedAt: 0,
  nextAttemptAt: 0,
  ...overrides,
});

/** Storage with only getItem, setItem and removeItem, like localStorage. */
function plain(memory = createMemoryStorage()): QueueStorage & { data: Map<string, string> } {
  return {
    data: memory.data,
    getItem: memory.getItem,
    setItem: memory.setItem,
    removeItem: memory.removeItem,
  };
}

function setup(storage: QueueStorage = createMemoryStorage()) {
  const quarantined: string[] = [];
  const errors: unknown[] = [];
  const commits: Commit[] = [];
  const persistence = new QueuePersistence(storage, 'q', createMemoryLocks(), {
    onCommit: (commit) => commits.push(commit),
    onCleared: () => undefined,
    onQuarantine: (reason) => quarantined.push(reason),
    onStorageError: (error) => errors.push(error),
    now: () => 42,
  });
  const save = (items: QueueItem[]) => persistence.transact(() => ({ items, result: undefined }));
  return { persistence, quarantined, errors, commits, save };
}

describe('envelope', () => {
  it('round-trips items with a version and checksum', () => {
    const raw = encodeEnvelope([item('a')], 3);
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({ format: 'idempotent-queue', version: VERSION, seq: 3 });
    expect(parsed.checksum).toBe(checksum(parsed.data));
    expect(decodeEnvelope(raw)).toEqual({ ok: true, state: { items: [item('a')], seq: 3 }, data: parsed.data });
  });

  it.each([
    ['not JSON', '{"format":'],
    ['another format', JSON.stringify({ format: 'other', version: 1 })],
    ['a future version', JSON.stringify({ format: 'idempotent-queue', version: 2, seq: 1, data: '[]', checksum: checksum('[]') })],
    ['a checksum mismatch', encodeEnvelope([item('a')], 1).replace('"amount\\":5', '"amount\\":6')],
    ['data that is not an array', (() => { const data = '{}'; return JSON.stringify({ format: 'idempotent-queue', version: 1, seq: 1, data, checksum: checksum(data) }); })()],
    ['an invalid item', encodeEnvelope([{ ...item('a'), status: 'weird' } as unknown as QueueItem], 1)],
    ['duplicate keys', encodeEnvelope([item('a'), { ...item('b'), key: 'key-a' }], 1)],
  ])('rejects %s', (_name, raw) => {
    expect(decodeEnvelope(raw).ok).toBe(false);
  });

  it('rejects every truncation of a valid envelope', () => {
    const raw = encodeEnvelope([item('a'), item('b', { sequence: 2 })], 7);
    for (let length = 0; length < raw.length; length++) {
      expect(decodeEnvelope(raw.slice(0, length)).ok).toBe(false);
    }
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(() => decodeEnvelope(raw)).not.toThrow();
      }),
    );
  });

  it('validates item fields', () => {
    expect(validateItem(item('a'))).toBeUndefined();
    expect(validateItem({ ...item('a'), attempts: -1 })).toMatch(/attempts/);
    expect(validateItem({ ...item('a'), key: '' })).toMatch(/key/);
    expect(validateItem({ ...item('a'), lastError: { kind: 'retryable', message: 'x', at: 'now' } })).toMatch(
      /lastError/,
    );
    const { payload: _payload, ...withoutPayload } = item('a');
    expect(validateItem(withoutPayload)).toMatch(/payload/);
  });
});

describe('planWrite', () => {
  it('writes the slot that does not hold the newest copy, with the next seq', () => {
    const a = encodeEnvelope([item('a')], 4);
    const b = encodeEnvelope([], 3);
    const plan = planWrite('q', [a, b], (items) => items.concat([item('b', { sequence: 2 })]));
    expect(plan.writes.map((write) => write.key)).toEqual(['q:b']);
    expect(decodeEnvelope(plan.writes[0].value!)).toMatchObject({ ok: true, state: { seq: 5 } });
    expect(plan.base.data).toBe(JSON.stringify([item('a')]));
  });

  it('writes nothing when the change returns undefined', () => {
    const plan = planWrite('q', [encodeEnvelope([item('a')], 1), null], () => undefined);
    expect(plan.writes).toEqual([]);
    expect(plan.items).toEqual([item('a')]);
  });

  it('writes only the replacement slot and returns the bad slot for a separate quarantine write', () => {
    const plan = planWrite('q', ['garbage', null], () => [item('a')]);
    expect(plan.writes.map((write) => write.key)).toEqual(['q:a']);
    expect(plan.bad).toEqual([{ slot: 'a', raw: 'garbage', reason: 'envelope is not valid JSON' }]);
    const quarantine = planQuarantine('q', null, plan.bad, 7)!;
    expect(JSON.parse(quarantine.value)).toEqual([
      { at: 7, storageKey: 'q:a', reason: 'envelope is not valid JSON', raw: 'garbage' },
    ]);
    // A copy that is already kept is not added again.
    expect(planQuarantine('q', quarantine.value, plan.bad, 8)).toBeUndefined();
  });

  it('keeps the valid copy when the other slot is bad', () => {
    expect(readSlots('garbage', encodeEnvelope([item('a')], 9))).toMatchObject({ slot: 'b', seq: 9, items: [item('a')] });
  });
});

describe('QueuePersistence', () => {
  it.each([
    ['atomic update', () => createMemoryStorage()],
    ['the storage lock', () => plain()],
  ])('alternates slots so the previous copy survives a torn write (%s)', async (_name, make) => {
    const storage = make();
    const { save } = setup(storage);
    await save([item('a')]);
    await save([item('a'), item('b', { sequence: 2 })]);
    expect(storage.data.has('q:a') && storage.data.has('q:b')).toBe(true);

    // The tab dies halfway through the next write: the newest slot is torn.
    const newest = JSON.parse(storage.data.get('q:b')!).seq > JSON.parse(storage.data.get('q:a')!).seq ? 'q:b' : 'q:a';
    storage.data.set(newest, storage.data.get(newest)!.slice(0, 40));

    const reloaded = setup(storage);
    const state = await reloaded.persistence.load();
    expect(state.items.map((i) => i.id)).toEqual(['a']);
    expect(reloaded.quarantined).toEqual(['envelope is not valid JSON']);
  });

  it('keeps writing after a torn slot without overwriting the good one first', async () => {
    const storage = createMemoryStorage();
    await setup(storage).save([item('a')]); // slot a, seq 1
    storage.data.set('q:b', 'garbage');
    const second = setup(storage);
    await second.persistence.load();
    await second.save([item('a'), item('b', { sequence: 2 })]);
    // The write went to the corrupted slot b; slot a still holds the older copy.
    expect(decodeEnvelope(storage.data.get('q:a')!)).toMatchObject({ ok: true, state: { seq: 1 } });
    expect(decodeEnvelope(storage.data.get('q:b')!)).toMatchObject({ ok: true, state: { seq: 2 } });
  });

  it('quarantines unreadable data instead of throwing and starts empty', async () => {
    const storage = createMemoryStorage({ 'q:a': '\u0000\u0001not json', 'q:b': '{"format":"x"}' });
    const { persistence, quarantined } = setup(storage);
    await expect(persistence.load()).resolves.toMatchObject({ items: [], seq: 0 });
    expect(quarantined).toHaveLength(2);
    const entries = await readQuarantine(storage, 'q');
    expect(entries.map((entry) => entry.raw)).toEqual(['\u0000\u0001not json', '{"format":"x"}']);
    expect(entries[0]).toMatchObject({ at: 42, storageKey: 'q:a', reason: 'envelope is not valid JSON' });

    // Loading again does not duplicate quarantined copies.
    const again = setup(storage);
    await again.persistence.load();
    expect(again.quarantined).toEqual([]);
    expect(await readQuarantine(storage, 'q')).toHaveLength(2);
  });

  it('survives a quarantine that cannot be written', async () => {
    const storage = plain(createMemoryStorage({ 'q:a': 'broken' }));
    storage.setItem = () => Promise.reject(new Error('disk full'));
    const { persistence, errors, quarantined } = setup(storage);
    await expect(persistence.load()).resolves.toMatchObject({ items: [], seq: 0 });
    expect(errors).toHaveLength(1);
    expect(quarantined).toEqual(['envelope is not valid JSON']);
  });

  it('applies each change to the newest stored state, including writes by another tab', async () => {
    const storage = createMemoryStorage();
    const tabA = setup(storage);
    const tabB = setup(storage);
    await tabA.persistence.transact((items) => ({ items: items.concat([item('a')]), result: undefined }));
    await tabB.persistence.transact((items) => ({ items: items.concat([item('b', { sequence: 2 })]), result: undefined }));
    const result = await tabA.persistence.transact((items) => ({ result: items.map((i) => i.id) }));
    expect(result).toEqual(['a', 'b']);
    // Tab A's last transaction read a state it had not written itself.
    expect(tabA.commits[1].baseData).not.toBe(tabA.commits[0].data);
  });

  it('never runs two transactions at once and batches the ones that wait', async () => {
    const memory = createMemoryStorage();
    let running = 0;
    let maxRunning = 0;
    const releases: Array<() => void> = [];
    const storage = plain(memory);
    storage.setItem = (key, value) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      return new Promise<void>((resolve) =>
        releases.push(() => {
          running--;
          memory.data.set(key, value);
          resolve();
        }),
      );
    };
    const { persistence } = setup(storage);
    const add = (id: string) => persistence.transact((items) => ({ items: items.concat([item(id, { sequence: items.length + 1 })]), result: id }));
    const first = add('a');
    await flushMicrotasks();
    expect(releases).toHaveLength(1);
    // The first write is running; the next two share one transaction.
    const second = add('b');
    const third = add('c');
    await flushMicrotasks();
    expect(releases).toHaveLength(1);
    releases[0]();
    expect(await first).toBe('a');
    await flushMicrotasks();
    expect(releases).toHaveLength(2);
    releases[1]();
    expect(await Promise.all([second, third])).toEqual(['b', 'c']);
    await flushMicrotasks();
    expect(releases).toHaveLength(2);
    expect(maxRunning).toBe(1);
    const loaded = await setup(memory).persistence.load();
    expect(loaded.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('rejects only the change that threw, and still writes the others in its batch', async () => {
    const storage = createMemoryStorage();
    const { persistence } = setup(storage);
    const ok = persistence.transact((items) => ({ items: items.concat([item('a')]), result: 1 }));
    const bad = persistence.transact(() => {
      throw new Error('nope');
    });
    await expect(ok).resolves.toBe(1);
    await expect(bad).rejects.toThrow('nope');
    expect((await setup(storage).persistence.load()).items).toHaveLength(1);
  });

  it('rejects a failed write and keeps the next one going', async () => {
    const memory = createMemoryStorage();
    let fail = true;
    const storage = plain(memory);
    storage.setItem = (key, value) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('io'));
      }
      return memory.setItem(key, value);
    };
    const { save } = setup(storage);
    await expect(save([item('a')])).rejects.toThrow('io');
    await save([item('a')]);
    expect((await setup(memory).persistence.load()).items).toHaveLength(1);
  });

  it('clear removes both slots and the quarantine', async () => {
    const storage = createMemoryStorage({ 'q:b': 'broken' });
    const { persistence, save } = setup(storage);
    await persistence.load();
    await save([item('a')]);
    await persistence.clear();
    expect(Array.from(storage.data.keys())).toEqual([]);
  });

  it('holds the storage lock around each read-modify-write without an atomic update', async () => {
    const storage = plain();
    const locks = createMemoryLocks();
    const names: string[] = [];
    const persistence = new QueuePersistence(storage, 'q', {
      request: (name, callback) => {
        names.push(name);
        return locks.request(name, callback);
      },
    }, {
      onCommit: () => undefined,
      onCleared: () => undefined,
      onQuarantine: () => undefined,
      onStorageError: () => undefined,
      now: () => 0,
    });
    await persistence.transact(() => ({ items: [item('a')], result: undefined }));
    await persistence.clear();
    expect(names).toEqual(['q:storage', 'q:storage']);
  });
});
