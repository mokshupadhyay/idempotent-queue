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
 * to `<prefix>:quarantine` after the write that replaces it, as a separate,
 * best-effort write: a copy that does not fit (a full localStorage) is reported
 * and dropped, and never blocks the queue. Reading never throws for bad data.
 *
 * Every state is checked with the same validation as on read before it is
 * written, so the queue never writes a slot it would quarantine itself.
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
/** Upper bound of the stored quarantine, in characters. Longer copies are truncated. */
export const MAX_QUARANTINE_CHARS = 256 * 1024;

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
  /** Set when `raw` was cut to keep the quarantine under its size limit. */
  truncated?: boolean;
  /** Length of the original value, when `raw` was truncated. */
  length?: number;
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
  const reason = validateItems(items);
  if (reason) return { ok: false, reason };
  return { ok: true, state: { items: items as QueueItem[], seq: envelope.seq }, data: envelope.data };
}

/** Checks a parsed `data` array: every item valid, ids and keys unique. Returns a reason when invalid. */
export function validateItems(items: unknown): string | undefined {
  if (!Array.isArray(items)) return 'data is not an array';
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const item of items) {
    const reason = validateItem(item);
    if (reason) return reason;
    const { id, key } = item as QueueItem;
    if (ids.has(id)) return `duplicate item id ${id}`;
    if (keys.has(key)) return 'duplicate idempotency key';
    ids.add(id);
    keys.add(key);
  }
  return undefined;
}

/** Thrown when a change would store items that fail the load validation. Nothing is written. */
export class InvalidStateError extends Error {
  constructor(readonly reason: string) {
    super(`idempotent-queue: refused to write an invalid queue state (${reason})`);
    Object.setPrototypeOf(this, InvalidStateError.prototype);
    this.name = 'InvalidStateError';
  }
}

/**
 * Serializes `items` as they will be stored and checks the result with the
 * load validation, so values JSON cannot keep (`Infinity` becomes `null`,
 * `undefined` disappears) are caught before they are written.
 */
export function serializeItems(items: readonly QueueItem[]): string {
  let data: string | undefined;
  try {
    data = JSON.stringify(items);
  } catch (error) {
    throw new InvalidStateError(`not serializable: ${String(error)}`);
  }
  if (data === undefined) throw new InvalidStateError('not serializable');
  const reason = validateItems(JSON.parse(data));
  if (reason) throw new InvalidStateError(reason);
  return data;
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
  /** Writes of the slot that replaces the oldest copy, if anything changed. */
  writes: StorageWrite[];
  /** Bad slots seen by this plan, to copy to the quarantine after `writes` land. */
  bad: ReadState['bad'];
}

/**
 * Plans one read-modify-write. Pure: given the raw values of slot a and
 * slot b, and a change to the newest items (`undefined` for no change),
 * returns the slot write. The change must return items that pass
 * `serializeItems`, or this throws `InvalidStateError` and nothing is written.
 */
export function planWrite(
  prefix: string,
  raws: Array<string | null | undefined>,
  change: (items: readonly QueueItem[]) => readonly QueueItem[] | undefined,
): WritePlan {
  const base = readSlots(raws[0], raws[1]);
  const next = change(base.items);
  if (next === undefined) return { base, items: base.items, data: base.data, writes: [], bad: base.bad };
  const data = serializeItems(next);
  // Write the slot that does not hold the newest copy. With no valid copy,
  // overwrite a corrupted slot first, keeping any other.
  let slot: Slot;
  if (base.slot) slot = base.slot === 'a' ? 'b' : 'a';
  else slot = base.bad.length === 1 ? base.bad[0].slot : 'a';
  const encoded = encodeData(data, base.seq + 1);
  return { base, items: next, data, writes: [{ key: `${prefix}:${slot}`, value: encoded }], bad: base.bad };
}

/**
 * Adds bad slots to the stored quarantine. Returns the new quarantine value
 * and the entries added, or `undefined` when every copy is already kept. The
 * value holds at most `MAX_QUARANTINE_ENTRIES` entries and
 * `MAX_QUARANTINE_CHARS` characters; older entries go first, then long copies
 * are truncated.
 */
export function planQuarantine(
  prefix: string,
  existingRaw: string | null | undefined,
  bad: ReadState['bad'],
  now: number,
): { value: string; added: Array<{ storageKey: string; reason: string }> } | undefined {
  let entries = parseQuarantine(existingRaw);
  const added: Array<{ storageKey: string; reason: string }> = [];
  for (const entry of bad) {
    const storageKey = `${prefix}:${entry.slot}`;
    if (entries.some((existing) => existing && existing.storageKey === storageKey && sameRaw(existing, entry.raw))) continue;
    entries.push({ at: now, storageKey, reason: entry.reason, raw: entry.raw });
    added.push({ storageKey, reason: entry.reason });
  }
  if (added.length === 0) return undefined;
  entries = entries.slice(-MAX_QUARANTINE_ENTRIES);
  let value = JSON.stringify(entries);
  while (value.length > MAX_QUARANTINE_CHARS && entries.length > 1) {
    entries = entries.slice(1);
    value = JSON.stringify(entries);
  }
  if (value.length > MAX_QUARANTINE_CHARS) {
    // One copy alone is too long: keep its beginning. JSON escaping can make the cut longer, so halve until it fits.
    const only = entries[0];
    let keep = MAX_QUARANTINE_CHARS - 512;
    do {
      value = JSON.stringify([{ ...only, raw: only.raw.slice(0, keep), truncated: true, length: only.raw.length }]);
      keep = Math.floor(keep / 2);
    } while (value.length > MAX_QUARANTINE_CHARS);
  }
  return { value, added };
}

/** A truncated copy matches the raw value it was cut from. */
function sameRaw(entry: QuarantineEntry, raw: string): boolean {
  if (entry.truncated) return typeof entry.raw === 'string' && entry.length === raw.length && raw.startsWith(entry.raw);
  return entry.raw === raw;
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
  /** A bad slot was found. `saved` tells whether its copy reached the quarantine. */
  onQuarantine(reason: string, storageKey: string, saved: boolean): void;
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

  private get slotKeys(): string[] {
    return [this.slotKey('a'), this.slotKey('b')];
  }

  /** Bad slot values this instance already tried to quarantine, so a failing copy is not retried on every write. */
  private readonly quarantineTried = new Set<string>();

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
      for (const entry of state.bad) this.hooks.onQuarantine(entry.reason, this.slotKey(entry.slot), false);
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

  /**
   * Removes both slots and the quarantine. With an atomic `update` this is
   * one step. Without one, a crash between two removals must not bring an
   * older copy back, so the steps are: write an empty state with a higher
   * `seq` to the slot that does not hold the newest copy (from then on the
   * empty state wins), remove the newest copy, remove the empty state, and
   * remove the quarantine. Stopping after any step leaves the queue either
   * as it was or empty.
   */
  private async runClear(entry: Extract<Entry, { kind: 'clear' }>): Promise<void> {
    const keys = this.slotKeys.concat([this.quarantineKey]);
    try {
      if (typeof this.storage.update === 'function') {
        await this.storage.update(keys, () => keys.map((key) => ({ key, value: null })));
      } else {
        await this.locks.request(this.lockName, async () => {
          const [rawA, rawB] = await Promise.all(this.slotKeys.map((key) => this.storage.getItem(key)));
          const state = readSlots(rawA, rawB);
          if (state.slot) {
            const empty: Slot = state.slot === 'a' ? 'b' : 'a';
            await this.storage.setItem(this.slotKey(empty), encodeData(EMPTY_DATA, state.seq + 1));
            await this.storage.removeItem(this.slotKey(state.slot));
            await this.storage.removeItem(this.slotKey(empty));
          } else {
            // No valid copy, so nothing older can win: remove whatever is there.
            for (const key of this.slotKeys) await this.storage.removeItem(key);
          }
          await this.storage.removeItem(this.quarantineKey);
        });
      }
    } catch (error) {
      entry.reject(error);
      return;
    }
    this.quarantineTried.clear();
    this.hooks.onCleared();
    entry.resolve(undefined);
  }

  private async runBatch(batch: Array<Extract<Entry, { kind: 'change' }>>): Promise<void> {
    type Outcome = { ok: true; result: unknown } | { ok: false; error: unknown };
    let outcomes: Outcome[] = [];
    let plan: WritePlan | undefined;
    const prepare = (raws: Array<string | null | undefined>): StorageWrite[] => {
      outcomes = [];
      plan = planWrite(this.prefix, raws, (items) => {
        let current = items;
        let changed = false;
        for (const entry of batch) {
          try {
            const out = entry.mutator(current);
            if (out.items) {
              // A change that would store an invalid state is refused on its own; the rest of the batch goes on.
              serializeItems(out.items);
              current = out.items;
              changed = true;
            }
            outcomes.push({ ok: true, result: out.result });
          } catch (error) {
            outcomes.push({ ok: false, error });
          }
        }
        return changed ? current : undefined;
      });
      return plan.writes;
    };

    try {
      if (typeof this.storage.update === 'function') {
        await this.storage.update(this.slotKeys, (values) => prepare(values));
      } else {
        await this.locks.request(this.lockName, async () => {
          const raws = await Promise.all(this.slotKeys.map((key) => this.storage.getItem(key)));
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
    this.hooks.onCommit({ baseData: committed.base.data, items: committed.items, data: committed.data });
    if (committed.bad.length > 0) await this.saveQuarantine(committed.bad);
    batch.forEach((entry, index) => {
      const outcome = outcomes[index];
      if (outcome.ok) entry.resolve(outcome.result);
      else entry.reject(outcome.error);
    });
  }

  /**
   * Copies bad slots to the quarantine, after the write that replaced them.
   * Best effort: a failure (for example a full localStorage) is reported with
   * `saved: false` and a storage error, and never fails the write itself.
   */
  private async saveQuarantine(bad: ReadState['bad']): Promise<void> {
    const fresh = bad.filter((entry) => {
      const id = `${entry.slot}:${entry.raw.length}:${checksum(entry.raw)}`;
      if (this.quarantineTried.has(id)) return false;
      this.quarantineTried.add(id);
      return true;
    });
    if (fresh.length === 0) return;
    const key = this.quarantineKey;
    let added: Array<{ storageKey: string; reason: string }> = [];
    const plan = (existing: string | null | undefined): StorageWrite[] => {
      const next = planQuarantine(this.prefix, existing, fresh, this.hooks.now());
      added = next ? next.added : [];
      return next ? [{ key, value: next.value }] : [];
    };
    try {
      if (typeof this.storage.update === 'function') {
        await this.storage.update([key], (values) => plan(values[0]));
      } else {
        await this.locks.request(this.lockName, async () => {
          const writes = plan(await this.storage.getItem(key));
          for (const write of writes) await this.storage.setItem(write.key, write.value as string);
        });
      }
    } catch (error) {
      fresh.forEach((entry) => this.hooks.onQuarantine(entry.reason, this.slotKey(entry.slot), false));
      this.hooks.onStorageError(error);
      return;
    }
    added.forEach(({ reason, storageKey }) => this.hooks.onQuarantine(reason, storageKey, true));
  }
}

/** Reads the quarantined copies of unreadable data, newest last. */
export async function readQuarantine(
  storage: QueueStorage,
  storageKey = DEFAULT_STORAGE_KEY,
): Promise<QuarantineEntry[]> {
  return parseQuarantine(await storage.getItem(`${storageKey}:quarantine`));
}
