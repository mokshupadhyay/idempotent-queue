# idempotent-queue

[![npm](https://img.shields.io/npm/v/idempotent-queue?label=npm)](https://www.npmjs.com/package/idempotent-queue)
[![license](https://img.shields.io/npm/l/idempotent-queue)](https://github.com/mokshupadhyay/idempotent-queue/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-mokshupadhyay%2Fidempotent--queue-181717?logo=github)](https://github.com/mokshupadhyay/idempotent-queue)

A queue for requests that change state on a server, such as a payment, a transfer or an order, so they survive a flaky network, a reload and a closed tab. It runs in browsers and in Node 18+. It is the web version of [react-native-idempotent-queue](https://github.com/mokshupadhyay/react-native-idempotent-queue), with the same design and API.

- **Saved before it is sent.** `enqueue` resolves only after the request is written to storage. Each attempt is recorded in storage before the request leaves.
- **One idempotency key per request.** The key is created once and sent with every attempt: after a timeout, a 5xx, a lost response, a reload, or a tab closed in the middle of a request.
- **Never sent in parallel with itself, across tabs.** Tabs of the same site share the queue. One tab at a time holds a [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) and sends; when it closes, another tab takes over. A key is never in flight twice. Items in the same `group` go one at a time, in order.
- **Tabs stay in sync.** A tab that changes the queue tells the others over a `BroadcastChannel`, so every tab shows the same items.
- **Retries that behave.** Exponential backoff with full jitter, `maxAttempts`, `Retry-After`, and a waiting state while offline (`navigator.onLine`) that does not use up attempts. The queue flushes when the page becomes visible again.
- **Safe storage.** IndexedDB by default, with every change applied in one transaction. A versioned envelope with a checksum, two alternating slots, and a quarantine for unreadable data instead of a crash.

## What it guarantees, and what it does not

Read this before using it for money.

- **At-least-once delivery with a stable key.** The library keeps sending a request, always with the same idempotency key, until `send` succeeds, the error is permanent, or `maxAttempts` is used up.
- **An exactly-once effect depends on your server.** Your server must honour the idempotency key. It stores the result of the first request with a given key and, for any repeat with that key, returns that stored result without doing the work again. Without that, a retry can charge a customer twice.
- **A success lost to a closed tab is sent again.** If the server applied a request but the tab closed, the browser crashed, or the network dropped before the response arrived, the queue cannot know it succeeded. It sends the request again with the same key, and the server must replay the stored response.
- **One sending tab at a time, as far as the lock goes.** With Web Locks (every current browser) the browser itself guarantees that one tab holds the sender lock and releases it when that tab closes. Without Web Locks the queue falls back to a lock built on `BroadcastChannel`, which is best effort (see [Several tabs](#several-tabs)). The idempotency key is what protects you if two tabs ever send the same request.
- **No ordering across groups.** Items in the same `group` are sent in enqueue order, one at a time. An item of the group that ends `failed` or `dead` holds back the later items of that group until you `retry` it (and it succeeds) or `discard` it. Items in different groups, or without a group, can be sent and finish in any order when `concurrency` is above 1.
- **An attempt that hangs is given up after `attemptTimeoutMs`** (30 seconds by default). Its `signal` is aborted and the item is retried with the same key. If your `send` ignores the signal, its request may still reach the server, so this relies on the server honouring the key, as a lost response does.
- **Payloads are stored in plain text** unless your storage adapter encrypts them. IndexedDB and `localStorage` are readable by any script running on your origin and are kept unencrypted on disk. For sensitive data (card numbers, tokens, personal data), keep it out of the payload (send a server-side reference instead) or use an encrypting adapter (see [Sensitive data](#sensitive-data)).
- **Delivery needs a page or process to run.** The queue sends while one of your pages is open, or while your Node process runs. It does not use Background Sync or a service worker. Pending items are sent the next time a page calls `start()`.
- **To wipe the queue, call `clear()`.** Never delete the stored keys or the IndexedDB database by hand while a page is open (see [Storage format](#storage-format-and-corrupted-data)).

## Install

```sh
npm install idempotent-queue
```

It has no dependencies. React is an optional peer dependency, used only by `idempotent-queue/react`.

The library is tested with Jest in Node against simulated storage, locks, tabs, clocks and networks, against `fake-indexeddb`, and against Node's own `navigator.locks` and `BroadcastChannel` (see [Testing](#testing)). Outside Jest, version 0.1.0 was checked with real tabs in Chromium, Firefox and WebKit (one sending tab; the sending tab closed mid-request and another tab finished it with the same key, applied once; items kept across a reload), and with a process killed mid-request and recovered from file storage on Node 18, 20 and 24, Bun and Deno. It has not been used in a production app yet. Please [report issues](https://github.com/mokshupadhyay/idempotent-queue/issues).

## Usage with `fetch`

```ts
import { createIdempotentQueue, fetchSender } from 'idempotent-queue';

type Payment = { amount: number; currency: string; to: string };

export const payments = createIdempotentQueue<Payment>({
  send: fetchSender('/api/payments', () => ({
    headers: { Authorization: `Bearer ${getToken()}` },
  })),
});

payments.start();

// In a click handler
const item = await payments.enqueue({
  payload: { amount: 2500, currency: 'EUR', to: 'acct_42' },
  group: 'payments',
});
// The payment is saved now and will be sent, and retried, with item.key, by whichever tab sends.
```

Call `start()` in every tab, at page load. In a browser the defaults are: IndexedDB storage, Web Locks (or the `BroadcastChannel` fallback), `BroadcastChannel` notifications between tabs, `navigator.onLine` with the `online` and `offline` events, and a flush on `visibilitychange`. Every one of them can be replaced through the options.

`fetchSender(url, init?, options?)` returns a `send` function that, for each attempt:

- uses `init.method`, or `POST`;
- sets the `Idempotency-Key` header (or `options.headerName`) to the item's key. A header with the same name in `init` is ignored, so it cannot override the key;
- sends the payload as the body: a string as it is, anything else as JSON with `Content-Type: application/json` unless you set a content type;
- passes the queue's `AbortSignal` as `signal`, so a timed-out or stopped attempt cancels the request (combined with an `init.signal` of yours where `AbortSignal.any` exists);
- sets `keepalive` as `options.keepalive` says (see below);
- resolves with the response body (parsed when it is JSON) for a 2xx response, and throws an `HttpError` with `status`, `headers` and `body` otherwise.

`url` and `init` can be functions of the item. Pass `init` as a function when headers such as a token must be read at send time. `init.headers` can be a plain object, an array of `[name, value]` pairs or a `Headers` object. A network failure rejects as `fetch` does and is retried. `options.fetch` replaces the global `fetch`.

**Your server must honour the header.** Stripe, Adyen and many payment APIs do. For your own API, store `(key, response)` when you first handle a key and return the stored response when the key is seen again.

### Sending while the page closes: `keepalive`

A request started just before the user closes the tab is normally cancelled. `keepalive: true` lets the browser finish it after the page is gone. `keepalive: 'pagehide'` sets it only on requests that start while the page is hidden or being unloaded (after `pagehide`, or with `document.visibilityState === 'hidden'`):

```ts
send: fetchSender('/api/payments', undefined, { keepalive: 'pagehide' }),
```

The page cannot see the answer to such a request, so the item stays in flight in storage. The next tab that sends returns it to `pending` and sends it again with the same key, and your server replays the stored answer. `keepalive` gives the request a chance to arrive sooner; it does not replace that retry. Browsers refuse keepalive requests whose bodies add up to more than 64 KiB in flight (`KEEPALIVE_BODY_LIMIT`). So `fetchSender` sets `keepalive` only when it knows the body's size (a string, `Blob`, `ArrayBuffer`, typed array, `DataView` or `URLSearchParams`) and the body fits in what is left of 64 KiB after the keepalive requests it already has in flight. Otherwise, for example for a `FormData` or a stream, the request is sent without `keepalive`. The count covers requests made through `fetchSender`; keepalive requests your page sends by other means are not seen.

### Your own `send`

Any function works. It receives the item and `{ key, attempt, signal }`, and resolves on success or throws on failure. Pass `signal` on to your HTTP client, so an attempt the queue gives up on is cancelled:

```ts
const orders = createIdempotentQueue({
  send: async (item, { key, signal }) => {
    const response = await api.post('/orders', item.payload, { headers: { 'Idempotency-Key': key }, signal });
    return response.data;
  },
});
```

`signal` is aborted when the attempt runs longer than `attemptTimeoutMs` (30 seconds by default, `Infinity` turns it off), or when `stop({ abortAfterMs })` stops waiting for it. The attempt then counts as a retryable failure and the item is sent again with the same key. A `send` that ignores the signal keeps that key blocked in this tab until it settles, so this tab never has two requests with one key in flight. After `stop()` hands the lock on, another tab may send the key while the ignored request is still running; the idempotency key is what protects you then.

The default classifier reads `status` and the `Retry-After` header from errors shaped like `{ status, headers }` and from Axios errors (`{ response: { status, headers } }`). Pass `classifyError` for anything else.

## Several tabs

Every tab that uses the same storage and `storageKey` shares one queue. Any tab can `enqueue`, `retry`, `discard`, `flush` and `clear`, and every tab sees every item. Only one tab sends:

1. `start()` asks for the lock `<storageKey>:sender`. The first tab to get it is the sending tab (`isSender()` is `true`, and it receives a `{ type: 'sender', active: true }` event). The other tabs wait in the lock's queue.
2. Every change is a read-modify-write of the stored state (see [Storage](#storage)), so two tabs that change the queue at the same moment do not lose each other's change. The deduplication by key happens in that same step, so two tabs that enqueue the same key at once create one item.
3. After a change, a tab posts a message on the `BroadcastChannel` `<storageKey>:changes`. The other tabs re-read storage, update `getItems()` and emit `{ type: 'synced', items }`. Without a channel (`channel: null`, or no `BroadcastChannel`), running tabs re-read storage every `syncIntervalMs` (2 seconds) instead.
4. When the sending tab closes or crashes, the browser releases its lock and the next waiting tab gets it. That tab finds items still marked `inflight` that it is not sending, returns them to `pending`, and sends them again with the same key. The interrupted attempt counts toward `maxAttempts`.
5. `stop()` keeps the lock until the attempts in flight have settled, then hands it to the next tab. An attempt that never settles is aborted after `attemptTimeoutMs`, or after `stop({ abortAfterMs })` if that is shorter, so a hung request cannot keep the lock forever.

The browser removes the lock of a tab that closes, crashes or navigates away. A tab that the browser freezes in the background keeps its lock, so the queue waits until it is unfrozen or discarded.

**Without Web Locks.** Web Locks need a secure context (HTTPS or `localhost`) and arrived in Chrome 69, Firefox 96 and Safari 15.4. Where `navigator.locks` is missing, the queue uses `createBroadcastChannelLocks()`. A tab claims the lock on a `BroadcastChannel`, and the holder and any earlier claimer object to the claim within `probeMs` (100 ms). This fallback assumes messages arrive within `probeMs`. A tab frozen in the background cannot object, so another tab can take the lock while the frozen one still thinks it holds it. Then two tabs send for a while, and only the idempotency key keeps the server from applying a request twice. Where neither Web Locks nor `BroadcastChannel` exist, the lock only coordinates queues inside one page.

Pass `locks` to use your own lock, for example in a worker setup: `{ request(name, callback, { signal }) }`, with the semantics of `navigator.locks.request`.

### Showing the queue in the UI

`idempotent-queue/react` has a hook. React is an optional peer dependency and the main entry point never imports it.

```tsx
import { useQueueItems } from 'idempotent-queue/react';

function PendingPayments() {
  const { items, counts } = useQueueItems(payments);
  return (
    <>
      <p>{counts.pending + counts.inflight} sending, {counts.failed + counts.dead} need attention</p>
      {items
        .filter((item) => item.status === 'failed' || item.status === 'dead')
        .map((item) => (
          <Row
            key={item.id}
            title={item.lastError?.message}
            onRetry={() => payments.retry(item.id)}
            onRemove={() => payments.discard(item.id)}
          />
        ))}
    </>
  );
}
```

It re-renders on every change, including changes made by other tabs once the queue is started. It uses `useSyncExternalStore` on React 18 and later, and an effect subscription on React 16.8 and 17. `counts` has one entry per status and `total`.

With server rendering (`renderToString`, Next.js and the like), React 18 and later render no items on the server and during hydration, because the server cannot see the browser's storage. React then re-renders with the queue's items. On React 16.8 and 17 the server renders the queue's current items, which on a server are normally none. This was tested with `react-dom/server` on React 17, 18 and 19.

## Storage

| Adapter | Default | Atomic read-modify-write | Shared by tabs | Survives a reload |
| --- | --- | --- | --- | --- |
| `createIndexedDBStorage(options?)` | in browsers | one readwrite transaction | yes | yes |
| `createLocalStorageAdapter(storage?)` | | under the `<storageKey>:storage` lock | yes, see below | yes |
| `createMemoryStorage()` | in Node, and where IndexedDB is missing | synchronous | queues in the same page or process given the same object | no |
| your own `{ getItem, setItem, removeItem, update? }` | | `update` if you provide it, else the storage lock | as your store is | as your store is |

The queue keeps the reference library's storage format, a versioned and checksummed envelope written to two alternating slots, and changes how a write happens. Every write now reads both slots, applies the change to the newest copy, and writes the other slot, as one step.

- On IndexedDB that step is one `readwrite` transaction (`createIndexedDBStorage().update`). IndexedDB runs readwrite transactions on the same object store one at a time across all tabs, and a transaction either commits completely or not at all. So no tab can write between another tab's read and its write, and no write is torn. The writes ask for `durability: 'strict'`, where the browser supports it, so they reach the disk before they count as done.
- With several tabs, the atomic read-modify-write is what keeps the queue correct. Without it, two tabs could read the same state, each make a change, and one would overwrite the other. Alternating slots alone do not prevent that.
- The two slots and the checksum stay because the same format works on `localStorage` and custom adapters, where a write can be torn. On IndexedDB they also keep the previous state if one copy is ever corrupted.

**localStorage.** It is synchronous and has no transactions, so the queue holds the `<storageKey>:storage` lock around each read-modify-write. Browsers do not promise that one tab's `localStorage` write is visible in another tab as soon as the first tab releases the lock. So with several tabs, a change can in rare cases be lost to a stale read. Prefer IndexedDB when several tabs are open. Use `localStorage` for one tab, or where IndexedDB is unavailable. A full `localStorage` (about 5 MB per origin) makes `enqueue` reject.

**IndexedDB options:** `databaseName` (`'idempotent-queue'`), `storeName` (`'kv'`), `indexedDB` (the factory, for tests or workers) and `durability` (`'strict'`). `storage.close()` closes the connection. A tab that upgrades or deletes the database makes the others close and reopen theirs.

### Node

In Node 18+ the queue works with the memory adapter (the default, lost when the process exits) or any adapter you write:

```ts
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createIdempotentQueue, fetchSender, type QueueStorage } from 'idempotent-queue';

function fileStorage(dir: string): QueueStorage {
  const file = (key: string) => join(dir, encodeURIComponent(key));
  return {
    async getItem(key) {
      try {
        return await readFile(file(key), 'utf8');
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return null;
        throw error;
      }
    },
    async setItem(key, value) {
      await mkdir(dir, { recursive: true });
      // Write a temporary file and rename it, so a crash never leaves half a value.
      await writeFile(`${file(key)}.tmp`, value);
      await rename(`${file(key)}.tmp`, file(key));
    },
    async removeItem(key) {
      await rm(file(key), { force: true });
    },
  };
}

const queue = createIdempotentQueue({ storage: fileStorage('./queue-data'), send: fetchSender('https://api.example.com/payments') });
await queue.start();
```

This adapter was checked by killing a Node 24 process in the middle of a request and starting a new one. The new process sent the item again with the same key (`attempt: 2`), it succeeded, and the process exited on its own after `stop()`.

Locks in Node coordinate queues inside one process. Queues that share a memory storage object share an in-process lock. With other storage, the queue uses `navigator.locks` where the runtime has one (Node 24 does), otherwise an in-process lock. Two processes that share one store do not see each other's locks. Run one process per store, or pass `locks` that work across processes (for example a database advisory lock) together with an `update` that is atomic across processes. In Node there is no default channel and no connectivity or visibility events. Pass `isOnline` and `subscribeToConnectivity` if you have a connectivity signal.

A custom adapter's optional `update(keys, mutate)` reads `keys`, calls `mutate(values)` synchronously, and applies the `{ key, value }` writes it returns (`value: null` removes the key), all as one atomic step. If `mutate` throws, nothing is written and `update` rejects. Without `update`, the queue uses the storage lock around `getItem` and `setItem`.

## Connectivity and visibility

By default in browsers, `isOnline()` reads `navigator.onLine` and the queue listens for the `online` and `offline` events. `navigator.onLine === false` reliably means offline. `true` only means a network interface is up, so failed attempts are still retried as usual. While offline, items wait and do not use attempts.

When the page becomes visible again (`visibilitychange`), the queue calls `flush()`, so items waiting for a backoff are tried at once. Pass `subscribeToVisibility: null` to turn this off.

Override any of these with `isOnline`, `subscribeToConnectivity` and `subscribeToVisibility`, or build them from other events with `createBrowserConnectivity({ target, navigator })` and `subscribeToPageVisibility(listener, document)`.

## Item states

| Status | Meaning | Next |
| --- | --- | --- |
| `pending` | Waiting to be sent, possibly until `nextAttemptAt` | `inflight` |
| `inflight` | The sending tab is running `send` | `succeeded`, `pending` (retry), `failed`, `dead` |
| `succeeded` | `send` resolved | Pruned after `keepSucceededMs` |
| `failed` | Every allowed attempt failed with a retryable error | `retry(id)` or `discard(id)` |
| `dead` | The error was permanent (for example HTTP 400 or 422) | `retry(id)` or `discard(id)` |

A `failed` or `dead` item in a `group` holds back the later items of that group. They stay `pending` until the item is retried and succeeds, or is discarded. Otherwise a transfer could be sent before the account it pays into was opened.

An item left `inflight` by a tab that closed goes back to `pending` when the next tab starts sending, and is sent again with the same key. The interrupted attempt counts toward `maxAttempts`. If it was the last allowed attempt, the item becomes `failed` with `lastError.kind === 'interrupted'`. A tab that does not send leaves such items as they are, because it cannot tell an interrupted attempt from one another tab is still running.

Succeeded items are kept for `keepSucceededMs` (24 hours by default), so enqueuing the same key again, for example after a double click, returns the succeeded item instead of sending again. The sending tab removes them at its next activity after that time. An idle queue keeps no timer for this.

## API

### `createIdempotentQueue(options)`

| Option | Default | |
| --- | --- | --- |
| `send(item, { key, attempt, signal })` | required | Sends one item. Resolve on success, throw on failure. `attempt` starts at 1. `signal` is an `AbortSignal` where the host has `AbortController` |
| `attemptTimeoutMs` | `30000` | How long one attempt may run before its `signal` is aborted and it counts as a retryable failure. `Infinity` turns it off |
| `storage` | IndexedDB in browsers, memory elsewhere | See [Storage](#storage) |
| `locks` | Web Locks, else `BroadcastChannel` locks in browsers, else in-process locks. A memory storage gets in-process locks shared by the queues that use it | `{ request(name, callback, { signal }) }` |
| `channel` | `BroadcastChannel` `<storageKey>:changes` in browsers; shared in-process channel for a shared memory storage; none in Node | `{ postMessage, subscribe }`. `null` turns it off |
| `syncIntervalMs` | `2000` | How often a running tab re-reads storage when there is no channel. Like every timer delay, it is capped at 2^31−1 ms (about 24.8 days), the largest delay `setTimeout` accepts |
| `classifyError(error, { item, attempt, now })` | `defaultClassifyError` | Returns `{ type: 'retryable', delayMs? }`, `{ type: 'permanent' }` or `{ type: 'rateLimited', delayMs }`. A negative `delayMs` counts as 0, `NaN` is ignored (normal backoff), and `Infinity` or more than 7 days becomes `retry.maxDelayMs` |
| `retry` | `{ maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 60000 }` | `maxAttempts` counts the first attempt and may be `Infinity` |
| `isOnline()` | `navigator.onLine`, else always online | May return a promise. While offline, items wait and do not use attempts |
| `subscribeToConnectivity(listener)` | `online` and `offline` events | Returns an unsubscribe function. Without it, an offline queue checks `isOnline` every `offlineRecheckMs` |
| `offlineRecheckMs` | `5000` | |
| `subscribeToVisibility(listener)` | `visibilitychange` to visible | The queue calls `flush()` each time. `null` turns it off |
| `concurrency` | `1` | Items sent at the same time by the sending tab. Items with the same `group` are always sequential |
| `keepSucceededMs` | 24 hours | |
| `storageKey` | `'idempotent-queue'` | Prefix of the stored keys, lock names and channel name. One queue per prefix in each tab |
| `generateKey()` | UUID v4 | Generates idempotency keys and item ids |
| `now()`, `random()`, `timers` | `Date.now`, `Math.random`, global timers | Injectable for tests |

The retry delay after the n-th failed attempt is a random integer in `[0, min(maxDelayMs, baseDelayMs × 2^(n−1)))` ("full jitter"). A classifier's `delayMs` (for example from `Retry-After`) replaces it.

### The queue

| Method | |
| --- | --- |
| `enqueue({ payload, key?, group?, metadata? })` | Saves the item, then resolves with it. Rejects if it could not be saved. A key that is already stored returns the existing item and creates nothing. `payload` and `metadata` must be JSON-serializable; keys are 1 to 255 characters |
| `start()` | Loads storage, follows other tabs' changes and asks for the sender lock. Rejects if storage cannot be read |
| `stop({ abortAfterMs? })` | Stops starting attempts, resolves when this tab's attempts in flight have settled, and hands the sender lock to the next tab. With `abortAfterMs`, attempts still running after that long are aborted and go back to `pending`, due at once, with the same key. Without it, `stop()` waits at most `attemptTimeoutMs` |
| `flush()` | Makes waiting items due now. A server's `Retry-After` is still respected. In the sending tab it resolves when nothing is in flight or due; in other tabs, once the change is saved. Does nothing while stopped |
| `getItems()` | Items in enqueue order, as last read from storage. The array is frozen and replaced on every change, so it can be compared by reference |
| `retry(id)` | Returns a `failed`, `dead` or `pending` item to `pending` with zero attempts, due now, with the same key |
| `discard(id)` | Removes an item. If it is in flight, its result is ignored and its key stays blocked in the sending tab until that request settles |
| `clear()` | Waits for this tab's attempts in flight, then deletes every item and the stored data, including quarantined copies. If it is interrupted (a crash, a failing storage call), the queue is left either as it was or empty, never with older items |
| `subscribe(listener)` | Returns an unsubscribe function. Events are listed below |
| `load()` | Reads storage without sending. Called by `start`, `enqueue` and the other methods |
| `isRunning()`, `isSender()`, `keySource` | |

Events: `loaded`, `enqueued`, `attempt`, `succeeded` (with `result`), `retry-scheduled` (with `error`, `delayMs`), `failed`, `dead`, `updated`, `removed`, `cleared`, `synced` (another tab changed the items), `sender` (with `active`), `storage-error`, `lock-error`, `quarantined` (with `reason`, `storageKey` and `saved`). Attempt events (`attempt`, `succeeded`, `retry-scheduled`, `failed`, `dead`) fire in the sending tab. Other tabs get `synced`.

### `defaultClassifyError`

| Error | Decision |
| --- | --- |
| No HTTP status: network failure (`TypeError: Failed to fetch`), timeout, abort, anything else thrown | retryable |
| 408, 409, 425, 429, 500–599 | retryable, or `rateLimited` for the `Retry-After` delay (seconds or an HTTP date) when present |
| Any other status: other 4xx, and 1xx–3xx thrown as errors | permanent |

A classifier that throws or returns something invalid counts as retryable. A `Retry-After` too large to be a finite number of milliseconds is ignored, and the normal backoff applies.

**Why 409 is retried.** Servers that implement idempotency keys answer `409 Conflict` when a request arrives while an earlier request with the same key is still being processed. Stripe does, and so does the IETF draft for the `Idempotency-Key` header (draft-ietf-httpapi-idempotency-key-header). This happens to the queue when a tab closes mid-request and the next tab sends the same key while the server is still working on the first one. The first request may well succeed, so the item must not end `dead`: it is retried with backoff, and the retry gets the stored result. The draft's other key errors stay permanent, because sending again does not change them: `400` when a required key is missing, and `422` when the key was already used with a different payload. If your API uses 409 for real conflicts (a duplicate username, say), pass a `classifyError` that makes those permanent.

### Idempotency keys

The default `generateKey` makes a UUID v4 from the first source available:

1. `crypto.randomUUID()`;
2. `crypto.getRandomValues()`;
3. `Math.random()`. This fallback is not cryptographically secure. Keys are unique in practice but guessable, and a warning is logged the first time it is used.

Browsers provide `crypto.randomUUID` only in secure contexts (HTTPS and `localhost`), so a plain-HTTP page uses `getRandomValues`. Node 20+, Bun and Deno have both. Node 18 has no global `crypto`, so the queue falls back to `Math.random()` and logs the warning; on Node 18 pass `generateKey: randomUUID` with `import { randomUUID } from 'node:crypto'`. `queue.keySource` and `getKeySource()` report the source (`'crypto.randomUUID'`, `'crypto.getRandomValues'`, `'Math.random'` or `'custom'`). When the server issues the key, or the request has a natural unique id (an order id), pass it as `key`.

### Other exports

`createIndexedDBStorage`, `createLocalStorageAdapter`, `createMemoryStorage`, `createWebLocks`, `createBroadcastChannelLocks`, `createMemoryLocks`, `createBroadcastQueueChannel`, `createMemoryChannel`, `createBrowserConnectivity`, `subscribeToPageVisibility`, `HttpError`, `parseRetryAfter(value, now)`, `InvalidStateError`, `backoffDelay`, `backoffCeiling`, `DEFAULT_RETRY_POLICY`, `uuidV4()`, `getKeySource()`, `readQuarantine(storage, storageKey?)`, `countItems(items)`, `KEEPALIVE_BODY_LIMIT`, and every type. `idempotent-queue/react` exports `useQueueItems` and `countItems`.

## Storage format and corrupted data

The queue writes its whole state to one of two keys, `<storageKey>:a` and `<storageKey>:b`, alternating between them. With IndexedDB these are records in the object store `kv` of the database `idempotent-queue`. Each value is an envelope:

```json
{ "format": "idempotent-queue", "version": 1, "seq": 12, "checksum": "1f0c9a3b", "data": "[...items]" }
```

On read, the valid envelope with the highest `seq` wins. A value that is not JSON, has another format or version, fails its checksum, or holds an invalid item is replaced by the next write, and then copied to `<storageKey>:quarantine` in a separate write. That copy is best effort: if it does not fit (a `localStorage` close to its quota), it is dropped, and the `quarantined` event says `saved: false` and a `storage-error` follows. The queue goes on writing either way. The quarantine keeps at most 5 copies and 256 KiB; a longer copy is cut and marked `truncated: true`. Reading never throws because of bad data. `readQuarantine(storage)` returns the copies for inspection. Only a failing read of storage itself makes `start()` reject.

Before every write, the queue checks the new state with the same validation it applies on read, and refuses to write a state that would fail it (the change rejects with an `InvalidStateError`, and storage and `getItems()` keep the previous state). So the queue never writes a slot that it would quarantine itself on the next read. Other changes in the same transaction are still written.

The checksum (FNV-1a) catches truncation and accidental corruption. It does not protect against a script that can write to your origin's storage.

Each write stores every item, so keep the queue small. Discard `failed` and `dead` items you no longer need, and keep large data out of the payload.

To wipe the queue, call `queue.clear()`, for example on logout. On IndexedDB, memory storage and adapters with `update`, `clear()` is one atomic step. Without `update` (`localStorage`, a file adapter), it first writes an empty state that wins over both slots, then removes the slots and the quarantine, so a crash in the middle leaves the queue either as it was or empty. Do not delete `<storageKey>:a`, `<storageKey>:b` or the database by hand. Another open tab still holds the items in memory and in flight, and its next write puts them back. If an old item survives that way, enqueuing its key again returns the old item instead of sending, which is the deduplication working as intended.

## Sensitive data

The payload is stored as JSON in whatever `storage` you use. IndexedDB and `localStorage` keep it unencrypted on disk, and any script that runs on your origin, including injected script, can read it. For sensitive data:

- send a reference (a cart id, a server-side payment intent) instead of the data itself; or
- wrap the storage in an adapter that encrypts values before `setItem` and decrypts after `getItem`, for example with Web Crypto AES-GCM and a non-extractable key kept in IndexedDB. Implement `update` too if you want the atomic read-modify-write, or leave it out and the queue uses the storage lock.

Never put card numbers or long-lived secrets in a payload stored in plain text. Payloads are not written to logs; error messages from `send` are stored in `lastError.message`, truncated to 500 characters.

## Example

[`example/`](example/) (not published) is a page with two frames that share one queue, like two tabs, and a pretend server that honours `Idempotency-Key`. Close the sending frame while a payment is in flight, and the other frame takes over and sends the same key again. See [example/README.md](example/README.md). Its self-test (`example/?selftest`) passed in headless Chrome 158, once with Web Locks and once with the `BroadcastChannel` fallback (`?selftest&nolocks`).

## Testing

```sh
npm install
npm run typecheck
npm test
npm run build
```

Besides unit tests, `src/__tests__/properties.test.ts` uses [fast-check](https://github.com/dubzzz/fast-check) to generate sequences of enqueues, crashes, offline periods, lost requests and lost responses, against a fake server that deduplicates by key. A crash drops a tab's memory, its unfinished writes and its locks, and the tab reloads from storage. The generated worlds use both atomic storage, like IndexedDB, and storage behind the lock, like `localStorage`, and tabs that either notify each other or poll. The properties check that:

1. every enqueued key ends with its effect applied exactly once on the server and its item `succeeded`;
2. the same key is never in flight twice at the same time;
3. a permanent error is never retried, and a retryable error is attempted at most `maxAttempts` times;
4. a tab that reloads from storage after any prefix of operations shows the same items as the live tab;
5. with two tabs sharing storage and locks, and random crashes and reloads of either one, the same key is never in flight twice across both;
6. in the same two-tab setting, every key ends applied exactly once and `succeeded`, and both tabs show what storage holds;
7. for any classifier output, including `NaN`, `Infinity`, negative and huge delays, every slot the queue writes passes the validation it applies on load;
8. the storage layer refuses any change whose items would fail that validation, keeps the stored state, and still writes the valid changes of the same transaction.

`src/__tests__/regressions.test.ts` holds one test (or more) per finding of an independent review of 0.1.0, each of which failed before its fix. `src/__tests__/react-ssr.test.ts` renders the hook with `react-dom/server` on React 17, 18 and 19, installed as dev dependencies under aliases (`react-17`, `react-18`, `react-dom-17`, `react-dom-18`; the repository's `.npmrc` sets `legacy-peer-deps` so they install next to React 19).

Everything runs on a fake clock, so no test waits on real time. `NUM_RUNS=2000 npm test` runs more cases. `node scripts/mutation-check.mjs` breaks the source in small ways and confirms that each property catches its break. The results are in [docs/MUTATION_EVIDENCE.md](docs/MUTATION_EVIDENCE.md).

IndexedDB is tested with [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB). Web Locks and the `BroadcastChannel` fallback are tested with Node's own implementations, which behave like the browser's between objects in one process.

## How it works

- `src/queue.ts` handles the sender lock, the attempt loop, recovery, deduplication and the sync between tabs.
- `src/persistence.ts` handles the envelope, the two slots, the atomic read-modify-write transactions and the quarantine.
- `src/storage.ts`, `src/locks.ts` and `src/channel.ts` are the storage adapters, the locks and the channels between tabs.
- `src/backoff.ts` and `src/classify.ts` decide when to try again. `src/connectivity.ts` and `src/page.ts` read the browser's online and visibility state.
- `src/timers.ts` clamps every timer delay to what `setTimeout` accepts.
- `src/keys.ts` generates keys. `src/fetchSender.ts` is the `fetch` helper. `src/react.ts` is the React hook.

## License

MIT
