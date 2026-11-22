import type { QueueErrorKind, QueueItem, QueueItemStatus, QueueLocks, QueueStorage, StorageWrite } from './types.js';

/**
 * Stored layout
 * -------------
 * The queue alternates between two slots, `<prefix>:a` and `<prefix>:b`. Each
 * write goes to the slot that does not hold the newest valid copy, so a write
 * torn by a crash leaves the previous copy intact. Each slot holds an envelope:
 *
 *   { "format": "idempotent-queue", "version": 1,
 *     "seq": 12, "checksum": "<fnv-1a of data>", "data": "<JSON array of items>" }
 *
 * On read the valid envelope with the highest `seq` wins. A slot that fails to
 * parse, has an unknown version, a wrong checksum or an invalid item is copied
 * to `<prefix>:quarantine` before it is overwritten; reading never throws for
 * bad data.
 *
 * Several tabs share the slots, so every write is a read-modify-write of the
 * whole state: read both slots, apply the change to the newest copy, write the
 * other slot. It runs as one `storage.update` call when the storage has one
 * (memory and IndexedDB do; IndexedDB uses one readwrite transaction), or
 * while holding the `<prefix>:storage` lock otherwise (localStorage).
 */
export const DEFAULT_STORAGE_KEY = 'idempotent-queue';
export const FORMAT = 'idempotent-queue';
export const VERSION = 1;
const MAX_QUARANTINE_ENTRIES = 5;

export type Slot = 'a' | 'b';

export interface StoredState {
  items: QueueItem[];
  seq: number;
}

export interface QuarantineEntry {
  at: number;
  storageKey: string;
  reason: string;
  raw: string;
}

/** FNV-1a over UTF-16 code units, as 8 hex digits. Detects truncation and bit flips, not tampering. */
export function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ('0000000' + hash.toString(16)).slice(-8);
}

const STATUSES: QueueItemStatus[] = ['pending', 'inflight', 'succeeded', 'failed', 'dead'];
const ERROR_KINDS: QueueErrorKind[] = ['retryable', 'permanent', 'rateLimited', 'interrupted'];

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && isFinite(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Structural check of one stored item. Returns a reason when invalid. */
export function validateItem(value: unknown): string | undefined {
  if (!isObject(value)) return 'item is not an object';
  if (typeof value.id !== 'string' || value.id === '') return 'item.id is invalid';
  if (typeof value.key !== 'string' || value.key === '') return 'item.key is invalid';
  if (value.group !== undefined && typeof value.group !== 'string') return 'item.group is invalid';
  if (!('payload' in value)) return 'item.payload is missing';
  if (value.metadata !== undefined && !isObject(value.metadata)) return 'item.metadata is invalid';
  if (STATUSES.indexOf(value.status as QueueItemStatus) < 0) return 'item.status is invalid';
  if (!isFiniteNumber(value.attempts) || value.attempts < 0) return 'item.attempts is invalid';
  for (const field of ['sequence', 'createdAt', 'updatedAt', 'nextAttemptAt']) {
    if (!isFiniteNumber(value[field])) return `item.${field} is invalid`;
  }
  if (value.completedAt !== undefined && !isFiniteNumber(value.completedAt)) return 'item.completedAt is invalid';
  if (value.lastError !== undefined) {
    const error = value.lastError;
    if (
      !isObject(error) ||
      ERROR_KINDS.indexOf(error.kind as QueueErrorKind) < 0 ||
      typeof error.message !== 'string' ||
      !isFiniteNumber(error.at) ||
      (error.status !== undefined && !isFiniteNumber(error.status))
    ) {
      return 'item.lastError is invalid';
    }
  }
  return undefined;
}

export function encodeEnvelope(items: readonly QueueItem[], seq: number): string {
  return encodeData(JSON.stringify(items), seq);
}

function encodeData(data: string, seq: number): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, seq, checksum: checksum(data), data });
}

export type DecodeResult = { ok: true; state: StoredState; data: string } | { ok: false; reason: string };

export function decodeEnvelope(raw: string): DecodeResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'envelope is not valid JSON' };
  }
  if (!isObject(envelope) || envelope.format !== FORMAT) return { ok: false, reason: 'unknown format' };
  if (envelope.version !== VERSION) return { ok: false, reason: `unsupported version ${String(envelope.version)}` };
  if (!isFiniteNumber(envelope.seq) || typeof envelope.data !== 'string' || typeof envelope.checksum !== 'string') {
    return { ok: false, reason: 'envelope fields are invalid' };
  }
  if (checksum(envelope.data) !== envelope.checksum) return { ok: false, reason: 'checksum mismatch' };
  let items: unknown;
  try {
    items = JSON.parse(envelope.data);
  } catch {
    return { ok: false, reason: 'data is not valid JSON' };
  }
  if (!Array.isArray(items)) return { ok: false, reason: 'data is not an array' };
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const item of items) {
    const reason = validateItem(item);
    if (reason) return { ok: false, reason };
    const { id, key } = item as QueueItem;
    if (ids.has(id)) return { ok: false, reason: `duplicate item id ${id}` };
    if (keys.has(key)) return { ok: false, reason: 'duplicate idempotency key' };
    ids.add(id);
    keys.add(key);
  }
  return { ok: true, state: { items: items as QueueItem[], seq: envelope.seq }, data: envelope.data };
}

/** The state read from the two slots. */
export interface ReadState {
  items: QueueItem[];
  /** The stored `data` string, `'[]'` when nothing is stored. Equal strings mean equal states. */
  data: string;
  seq: number;
  /** The slot holding the newest valid copy. */
  slot: Slot | undefined;
  bad: Array<{ slot: Slot; raw: string; reason: string }>;
}

const EMPTY_DATA = '[]';

/** Picks the newest valid slot. Pure. */
export function readSlots(rawA: string | null | undefined, rawB: string | null | undefined): ReadState {
  let best: { slot: Slot; state: StoredState; data: string } | undefined;
  const bad: ReadState['bad'] = [];
  const raws: Array<[Slot, string | null | undefined]> = [
    ['a', rawA],
    ['b', rawB],
  ];
  for (const [slot, raw] of raws) {
    if (raw == null) continue;
    const result = decodeEnvelope(raw);
    if (!result.ok) {
      bad.push({ slot, raw, reason: result.reason });
      continue;
    }
    if (!best || result.state.seq > best.state.seq) best = { slot, state: result.state, data: result.data };
  }
  if (!best) return { items: [], data: EMPTY_DATA, seq: 0, slot: undefined, bad };
  return { items: best.state.items, data: best.data, seq: best.state.seq, slot: best.slot, bad };
}

function parseQuarantine(raw: string | null | undefined): QuarantineEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as QuarantineEntry[]) : [];
  } catch {
    return [];
  }
}

export interface WritePlan {
  base: ReadState;
  items: readonly QueueItem[];
  data: string;
  writes: StorageWrite[];
  /** Bad slots copied to the quarantine by this plan. */
  quarantined: Array<{ storageKey: string; reason: string }>;
}

/**
 * Plans one read-modify-write. Pure: given the raw values of slot a, slot b
 * and the quarantine, and a change to the newest items (`undefined` for no
 * change), returns the writes. Bad slots are added to the quarantine (once
 * per raw value) in the same writes, before any slot is overwritten.
 */
export function planWrite(
  prefix: string,
  raws: Array<string | null | undefined>,
  change: (items: readonly QueueItem[]) => readonly QueueItem[] | undefined,
  now: number,
): WritePlan {
  const base = readSlots(raws[0], raws[1]);
  const next = change(base.items);
  const writes: StorageWrite[] = [];
  const quarantined: WritePlan['quarantined'] = [];
  if (base.bad.length > 0) {
    const entries = parseQuarantine(raws[2]);
    for (const entry of base.bad) {
      const storageKey = `${prefix}:${entry.slot}`;
      if (entries.some((existing) => existing && existing.raw === entry.raw && existing.storageKey === storageKey)) continue;
      entries.push({ at: now, storageKey, reason: entry.reason, raw: entry.raw });
      quarantined.push({ storageKey, reason: entry.reason });
    }
    if (quarantined.length > 0) {
      writes.push({ key: `${prefix}:quarantine`, value: JSON.stringify(entries.slice(-MAX_QUARANTINE_ENTRIES)) });
    }
  }
  if (next === undefined) return { base, items: base.items, data: base.data, writes, quarantined };
  const data = JSON.stringify(next);
  // Write the slot that does not hold the newest copy. With no valid copy,
  // overwrite a corrupted slot first (it is quarantined above), keeping any other.
  let slot: Slot;
  if (base.slot) slot = base.slot === 'a' ? 'b' : 'a';
  else slot = base.bad.length === 1 ? base.bad[0].slot : 'a';
  writes.push({ key: `${prefix}:${slot}`, value: encodeData(data, base.seq + 1) });
  return { base, items: next, data, writes, quarantined };
}

/** A change applied inside a transaction. Must not have side effects: it may run more than once. */
export type Mutator<R> = (items: readonly QueueItem[]) => { items?: readonly QueueItem[]; result: R };

export interface Commit {
  /** The state the transaction read, before this tab's changes. */
  baseData: string;
  items: readonly QueueItem[];
  data: string;
}

export interface PersistenceHooks {
  /** Runs once per committed transaction, before the callers' promises resolve. */
  onCommit(commit: Commit): void;
  /** Runs after `clear()` removed the stored data. */
  onCleared(): void;
  onQuarantine(reason: string, storageKey: string): void;
  onStorageError(error: unknown): void;
  now(): number;
}

type Entry =
  | { kind: 'change'; mutator: Mutator<unknown>; resolve(value: unknown): void; reject(error: unknown): void }
  | { kind: 'clear'; resolve(value: unknown): void; reject(error: unknown): void };

/**
 * Reads and writes the queue's state. Transactions from one queue run one at
 * a time. Changes requested while a transaction is running are batched into
 * the next one, which reads the newest stored state when it starts.
 */
export class QueuePersistence {
  private pending: Entry[] = [];
  private running = false;

  constructor(
    private readonly storage: QueueStorage,
    private readonly prefix: string,
    private readonly locks: QueueLocks,
    private readonly hooks: PersistenceHooks,
  ) {}

  slotKey(slot: Slot): string {
    return `${this.prefix}:${slot}`;
  }

  get quarantineKey(): string {
    return `${this.prefix}:quarantine`;
  }

  get lockName(): string {
    return `${this.prefix}:storage`;
  }

  private get keys(): string[] {
    return [this.slotKey('a'), this.slotKey('b'), this.quarantineKey];
  }

  /**
   * Reads the newest state without writing. Each slot holds a whole committed
   * state, so reading the slots one after the other, even while another tab
   * writes, returns some committed state. Rejects only when storage itself
   * fails to read.
   */
  async read(): Promise<ReadState> {
    const [a, b] = await Promise.all([this.storage.getItem(this.slotKey('a')), this.storage.getItem(this.slotKey('b'))]);
    return readSlots(a, b);
  }

  /** Reads, and quarantines bad slots. Bad data never makes it reject. */
  async load(): Promise<ReadState> {
    const state = await this.read();
    if (state.bad.length === 0) return state;
    try {
      await this.transact(() => ({ result: undefined }));
      return await this.read();
    } catch (error) {
      for (const entry of state.bad) this.hooks.onQuarantine(entry.reason, this.slotKey(entry.slot));
      this.hooks.onStorageError(error);
      return state;
    }
  }

  /** Applies `mutator` to the newest stored items and writes the result, atomically. */
  transact<R>(mutator: Mutator<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.pending.push({ kind: 'change', mutator, resolve: resolve as (value: unknown) => void, reject });
      this.schedule();
    });
  }

  /** Removes both slots and the quarantine, after the transactions already requested. */
  clear(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ kind: 'clear', resolve: resolve as (value: unknown) => void, reject });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.running) return;
    this.running = true;
    Promise.resolve()
      .then(() => this.drain())
      .then(undefined, (error: unknown) => this.hooks.onStorageError(error));
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const first = this.pending[0];
        if (first.kind === 'clear') {
          this.pending.shift();
          await this.runClear(first);
          continue;
        }
        let count = 0;
        while (count < this.pending.length && this.pending[count].kind === 'change') count++;
        const batch = this.pending.splice(0, count) as Array<Extract<Entry, { kind: 'change' }>>;
        await this.runBatch(batch);
      }
    } finally {
      this.running = false;
    }
  }

  private async runClear(entry: Extract<Entry, { kind: 'clear' }>): Promise<void> {
    const keys = this.keys;
    try {
      if (typeof this.storage.update === 'function') {
        await this.storage.update(keys, () => keys.map((key) => ({ key, value: null })));
      } else {
        await this.locks.request(this.lockName, async () => {
          for (const key of keys) await this.storage.removeItem(key);
        });
      }
    } catch (error) {
      entry.reject(error);
      return;
    }
    this.hooks.onCleared();
    entry.resolve(undefined);
  }

  private async runBatch(batch: Array<Extract<Entry, { kind: 'change' }>>): Promise<void> {
    type Outcome = { ok: true; result: unknown } | { ok: false; error: unknown };
    let outcomes: Outcome[] = [];
    let plan: WritePlan | undefined;
    const now = this.hooks.now();
    const prepare = (raws: Array<string | null | undefined>): StorageWrite[] => {
      outcomes = [];
      plan = planWrite(
        this.prefix,
        raws,
        (items) => {
          let current = items;
          let changed = false;
          for (const entry of batch) {
            try {
              const out = entry.mutator(current);
              if (out.items) {
                current = out.items;
                changed = true;
              }
              outcomes.push({ ok: true, result: out.result });
            } catch (error) {
              outcomes.push({ ok: false, error });
            }
          }
          return changed ? current : undefined;
        },
        now,
      );
      return plan.writes;
    };

    try {
      if (typeof this.storage.update === 'function') {
        await this.storage.update(this.keys, (values) => prepare(values));
      } else {
        await this.locks.request(this.lockName, async () => {
          const raws = await Promise.all(this.keys.map((key) => this.storage.getItem(key)));
          // The quarantine comes first in the writes, so bad data is copied before it is overwritten.
          for (const write of prepare(raws)) {
            if (write.value === null) await this.storage.removeItem(write.key);
            else await this.storage.setItem(write.key, write.value);
          }
        });
      }
    } catch (error) {
      batch.forEach((entry) => entry.reject(error));
      return;
    }
    const committed = plan as WritePlan | undefined;
    if (!committed) {
      batch.forEach((entry) => entry.reject(new Error('storage.update did not call mutate')));
      return;
    }
    committed.quarantined.forEach(({ reason, storageKey }) => this.hooks.onQuarantine(reason, storageKey));
    this.hooks.onCommit({ baseData: committed.base.data, items: committed.items, data: committed.data });
    batch.forEach((entry, index) => {
      const outcome = outcomes[index];
      if (outcome.ok) entry.resolve(outcome.result);
      else entry.reject(outcome.error);
    });
  }
}

/** Reads the quarantined copies of unreadable data, newest last. */
export async function readQuarantine(
  storage: QueueStorage,
  storageKey = DEFAULT_STORAGE_KEY,
): Promise<QuarantineEntry[]> {
  return parseQuarantine(await storage.getItem(`${storageKey}:quarantine`));
}
