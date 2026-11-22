import { createMemoryChannel } from '../../channel';
import { HttpError } from '../../classify';
import { readSlots } from '../../persistence';
import { createIdempotentQueue } from '../../queue';
import { createMemoryStorage } from '../../storage';
import type {
  ErrorClassifier,
  IdempotentQueue,
  QueueChannel,
  QueueItem,
  QueueOptions,
  QueueStorage,
  SendContext,
} from '../../types';
import { FakeClock, seededRandom } from './fakeClock';
import { FakeLocks } from './fakeLocks';

/**
 * What happens to one request:
 * - `ok`: applied, answered.
 * - `lostRequest`: never reaches the server (network error).
 * - `lostResponse`: applied, then the answer is lost (network error).
 * - `http500`: the server fails before applying it.
 * - `http429`: rate limited with `Retry-After: 1`, not applied.
 * - `http400`: rejected as invalid, not applied (permanent).
 */
export type Fault = 'ok' | 'lostRequest' | 'lostResponse' | 'http500' | 'http429' | 'http400';

export type Payload = { key: string; n: number };

export const STORAGE_KEY = 'idempotent-queue';

/** A server that applies each idempotency key at most once and replays the first answer. */
export class FakeServer {
  /** How many times each key's effect was applied. */
  readonly applied = new Map<string, number>();
  private readonly answers = new Map<string, { receipt: string }>();

  handle(key: string, payload: Payload): { receipt: string } {
    const stored = this.answers.get(key);
    if (stored) return stored;
    this.applied.set(key, (this.applied.get(key) || 0) + 1);
    const answer = { receipt: `${key}:${payload.n}` };
    this.answers.set(key, answer);
    return answer;
  }
}

export interface SendRecord {
  key: string;
  attempt: number;
  fault: Fault;
  /** Online when the request left. */
  online: boolean;
  /** The tab instance that sent it. */
  tab: number;
  /** What the app saw, set when the answer arrives. */
  outcome?: 'success' | 'network' | 'retryable' | 'rateLimited' | 'permanent';
  /** The network went down while the request was in flight, so the answer was lost. */
  lostToOffline?: boolean;
}

export interface WorldConfig {
  concurrency: number;
  storageLatency: number;
  sendLatency: number;
  useSubscription: boolean;
  seed: number;
  retry: QueueOptions['retry'];
  faults: Fault[];
  /** Number of tabs open at once. Default 1. */
  tabs?: number;
  /**
   * `true`: storage with an atomic `update`, like IndexedDB. `false`: only
   * getItem/setItem/removeItem, like localStorage, so the queue uses the
   * storage lock. Default true.
   */
  atomicStorage?: boolean;
  /** Tabs tell each other about changes over a channel; otherwise they poll. Default true. */
  useChannel?: boolean;
  /** Replaces the default classifier in every tab. */
  classifyError?: ErrorClassifier<Payload>;
}

export type Tab = {
  /** Increases with every tab opened, across reloads. */
  id: number;
  owner: string;
  queue: IdempotentQueue<Payload, { receipt: string }>;
};

const never = <T>() => new Promise<T>(() => undefined);

/**
 * A browser profile: storage shared by every tab (it survives tabs closing),
 * locks shared by every tab, a network that can go offline and a server.
 * `crash(slot)` closes the tab in that slot mid-whatever (its timers stop,
 * its storage writes that have not landed are lost, its requests never
 * answer, its locks are released) and opens a fresh tab on the same storage.
 */
export class World {
  readonly clock = new FakeClock();
  readonly disk = new Map<string, string>();
  readonly server = new FakeServer();
  readonly locks = new FakeLocks();
  readonly sends: SendRecord[] = [];
  /** Requests in flight by key, across every live tab. */
  readonly inflight = new Map<string, number>();
  /** Highest number of simultaneous requests seen for one key, across every live tab. */
  maxSameKeyInFlight = 0;
  /** Every value written to storage, in order. */
  readonly writes: Array<{ key: string; value: string }> = [];
  /** `storage-error` events from every tab. */
  readonly storageErrors: unknown[] = [];
  online = true;
  readonly tabs: Tab[] = [];
  private tabCount = 0;
  private faultIndex = 0;
  private readonly listeners = new Map<string, Set<(online: boolean) => void>>();
  private readonly inflightByTab = new Map<string, Map<string, number>>();
  private readonly channel: QueueChannel = createMemoryChannel();
  readonly random: () => number;

  constructor(readonly config: WorldConfig) {
    this.random = seededRandom(config.seed);
    const tabs = config.tabs || 1;
    for (let i = 0; i < tabs; i++) this.tabs.push(this.spawn());
  }

  /** The first tab, for single-tab scenarios. */
  get process(): Tab {
    return this.tabs[0];
  }

  /** The items as stored now. */
  stored(): QueueItem<Payload>[] {
    return readSlots(this.disk.get(`${STORAGE_KEY}:a`), this.disk.get(`${STORAGE_KEY}:b`)).items as QueueItem<Payload>[];
  }

  storageFor(owner: string): QueueStorage {
    const timers = this.clock.timersFor(owner);
    const latency = this.config.storageLatency;
    const later = <T>(apply: () => T): Promise<T> => {
      if (this.clock.isDead(owner)) return never();
      if (latency === 0) {
        try {
          return Promise.resolve(apply());
        } catch (error) {
          return Promise.reject(error);
        }
      }
      // A write that has not landed when the tab closes is lost.
      return new Promise<T>((resolve, reject) => {
        timers.setTimeout(() => {
          try {
            resolve(apply());
          } catch (error) {
            reject(error);
          }
        }, latency);
      });
    };
    const read = (key: string) => (this.disk.has(key) ? (this.disk.get(key) as string) : null);
    const storage: QueueStorage = {
      getItem: (key) => (this.clock.isDead(owner) ? never() : Promise.resolve(read(key))),
      setItem: (key, value) =>
        later(() => {
          this.writes.push({ key, value });
          this.disk.set(key, value);
        }),
      removeItem: (key) => later(() => void this.disk.delete(key)),
    };
    if (this.config.atomicStorage !== false) {
      // Like an IndexedDB readwrite transaction: read and write in one step when it commits.
      storage.update = (keys, mutate) =>
        later(() => {
          const writes = mutate(keys.map(read));
          for (const write of writes) {
            if (write.value === null) this.disk.delete(write.key);
            else {
              this.writes.push({ key: write.key, value: write.value });
              this.disk.set(write.key, write.value);
            }
          }
        });
    }
    return storage;
  }

  private nextFault(): Fault {
    const { faults } = this.config;
    return this.faultIndex < faults.length ? faults[this.faultIndex++] : 'ok';
  }

  /** Makes every later request succeed. */
  stopFaults(): void {
    this.faultIndex = this.config.faults.length;
  }

  private spawn(): Tab {
    const id = ++this.tabCount;
    const owner = `tab-${id}`;
    const timers = this.clock.timersFor(owner);
    const mine = new Map<string, number>();
    this.inflightByTab.set(owner, mine);
    const listeners = new Set<(online: boolean) => void>();
    this.listeners.set(owner, listeners);
    const bump = (key: string, by: number) => {
      mine.set(key, (mine.get(key) || 0) + by);
      const total = (this.inflight.get(key) || 0) + by;
      this.inflight.set(key, total);
      this.maxSameKeyInFlight = Math.max(this.maxSameKeyInFlight, total);
    };
    const send = (item: QueueItem<Payload>, context: SendContext): Promise<{ receipt: string }> => {
      if (this.clock.isDead(owner)) return never();
      bump(context.key, 1);
      const online = this.online;
      const fault = this.nextFault();
      const record: SendRecord = { key: context.key, attempt: context.attempt, fault, online, tab: id };
      this.sends.push(record);
      let outcome: { value: { receipt: string } } | { error: unknown };
      if (!online || fault === 'lostRequest') {
        outcome = { error: new TypeError('Failed to fetch') };
      } else if (fault === 'http500') {
        outcome = { error: new HttpError(500) };
      } else if (fault === 'http429') {
        outcome = { error: new HttpError(429, undefined, { 'Retry-After': '1' }) };
      } else if (fault === 'http400') {
        outcome = { error: new HttpError(400) };
      } else {
        const value = this.server.handle(context.key, item.payload);
        outcome = fault === 'lostResponse' ? { error: new TypeError('Failed to fetch') } : { value };
      }
      return new Promise((resolve, reject) => {
        timers.setTimeout(() => {
          bump(context.key, -1);
          if (!this.online) {
            // Whatever the server did, the answer does not reach an offline browser.
            record.lostToOffline = true;
            outcome = { error: new TypeError('Failed to fetch') };
          }
          if ('error' in outcome) {
            const status = (outcome.error as { status?: number }).status;
            record.outcome =
              status === undefined ? 'network' : status === 400 ? 'permanent' : status === 429 ? 'rateLimited' : 'retryable';
            reject(outcome.error);
          } else {
            record.outcome = 'success';
            resolve(outcome.value);
          }
        }, this.config.sendLatency);
      });
    };
    const queue = createIdempotentQueue<Payload, { receipt: string }>({
      storage: this.storageFor(owner),
      locks: this.locks.locksFor(owner),
      channel: this.config.useChannel === false ? null : this.channel,
      syncIntervalMs: 50,
      send,
      retry: this.config.retry,
      ...(this.config.classifyError ? { classifyError: this.config.classifyError } : {}),
      concurrency: this.config.concurrency,
      isOnline: () => this.online,
      subscribeToConnectivity: this.config.useSubscription
        ? (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          }
        : undefined,
      subscribeToVisibility: null,
      offlineRecheckMs: 100,
      storageKey: STORAGE_KEY,
      now: () => this.clock.now,
      random: this.random,
      timers,
      generateKey: () => `id-${Math.floor(this.random() * 1e12).toString(36)}-${this.clock.now}`,
    });
    // A queue that never logs keeps test output readable.
    queue.subscribe((event) => {
      if (event.type === 'storage-error') this.storageErrors.push(event.error);
    });
    return { id, owner, queue };
  }

  setOnline(online: boolean): void {
    this.online = online;
    this.listeners.forEach((set) => set.forEach((listener) => listener(online)));
  }

  /** Closes the tab in `slot` (default the first) mid-whatever and opens a fresh one on the same storage. */
  crash(slot = 0): Tab {
    const tab = this.tabs[slot];
    this.clock.kill(tab.owner);
    this.locks.kill(tab.owner);
    this.listeners.delete(tab.owner);
    // Requests of a closed tab are aborted with it.
    const mine = this.inflightByTab.get(tab.owner);
    if (mine) {
      mine.forEach((count, key) => this.inflight.set(key, (this.inflight.get(key) || 0) - count));
      this.inflightByTab.delete(tab.owner);
    }
    this.tabs[slot] = this.spawn();
    return this.tabs[slot];
  }

  /** Copy of the disk, for loading a separate queue without touching the live ones. */
  snapshotStorage(): QueueStorage {
    const copy: Record<string, string> = {};
    this.disk.forEach((value, key) => (copy[key] = value));
    return createMemoryStorage(copy);
  }
}
