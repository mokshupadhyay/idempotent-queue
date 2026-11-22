# Changelog

## 0.1.0

First release. The web and Node version of `react-native-idempotent-queue`, with the same API and storage design.

- `createIdempotentQueue` with `enqueue`, `start`, `stop`, `flush`, `getItems`, `retry`, `discard`, `subscribe`, `clear`, `load`, `isRunning` and `isSender`.
- Items are saved before `enqueue` resolves, and each attempt is saved before the request is sent. Every attempt of an item uses the same idempotency key.
- Several tabs share one queue. One tab at a time holds the `<storageKey>:sender` lock and sends; when it closes or stops, the next tab takes over and returns the items it left in flight to `pending`, with the same key. Web Locks by default, `createBroadcastChannelLocks` where they are missing, and a `locks` option for anything else.
- Tabs tell each other about changes over a `BroadcastChannel` (`synced` event), or re-read storage every `syncIntervalMs` without one.
- Every change is an atomic read-modify-write of the stored state, so tabs never overwrite each other's changes. Deduplication by key happens inside that write.
- Storage in a versioned, checksummed envelope across two alternating keys, with a quarantine for unreadable data. `createIndexedDBStorage` (the default in browsers, one readwrite transaction per change), `createLocalStorageAdapter` (behind the storage lock) and `createMemoryStorage` (the default in Node). Custom adapters can provide an atomic `update`.
- A guard that never sends a key twice at once, `concurrency`, and sequential `group`s.
- Exponential backoff with full jitter, `maxAttempts`, `Retry-After`, and a waiting state while offline that does not use attempts.
- Connectivity from `navigator.onLine` and the `online` and `offline` events, and a flush when the page becomes visible. `createBrowserConnectivity` and `subscribeToPageVisibility` for other targets.
- `defaultClassifyError` for network errors and HTTP statuses, `HttpError`, `parseRetryAfter`.
- `fetchSender`, which adds an `Idempotency-Key` header, maps responses to `HttpError`, and can set `keepalive` always or only while the page is hidden or unloading (`keepalive: 'pagehide'`).
- `useQueueItems` from `idempotent-queue/react`, which uses `useSyncExternalStore` on React 18+ and an effect subscription on React 16.8 and 17. React is an optional peer dependency.
- UUID v4 keys from `crypto.randomUUID`, then `crypto.getRandomValues`, then a `Math.random` fallback that logs a warning. `keySource` and `getKeySource()` report which source was used.
- ESM and CommonJS builds with an `exports` map and types for both.

### Fixed before release, after an independent review

- A classifier `delayMs` of `Infinity` or a `Retry-After` of 309 or more digits stored `nextAttemptAt: null`. The slot was then quarantined and the queue rolled back, sending succeeded items again and losing an enqueue that had resolved. `parseRetryAfter` now ignores values that do not fit a finite delay. Classifier delays below 0 count as 0, `NaN` is ignored, and `Infinity` or more than 7 days becomes `retry.maxDelayMs`. The storage layer checks every new state with the load validation before writing, and refuses an invalid change with an `InvalidStateError` while keeping the stored state and the other changes of the same transaction.
- HTTP 409 is now retryable. Servers that implement idempotency keys (Stripe, the IETF `Idempotency-Key` draft) answer 409 while a request with the same key is still being processed, so the item used to end `dead` although the server charged. 400 and 422 stay permanent.
- A corrupt slot in a `localStorage` close to its quota blocked every write, because the quarantine copy was written in the same step. The replacement slot is now written first and the quarantine copy is written afterwards, as best effort. The `quarantined` event has `saved`, and the quarantine is capped at 5 copies and 256 KiB (`truncated: true` on a cut copy).
- `clear()` on storage without `update` could bring an older slot back if it stopped between two removals. It now writes an empty state that wins first, so an interrupted clear leaves the queue as it was or empty.
- A `failed` or `dead` item now holds back the later items of its group until it is retried and succeeds, or is discarded. Before, the next item of the group was sent, and a later `retry()` sent the first one after it.
- `useQueueItems` passes a server snapshot (no items) to `useSyncExternalStore`, so server rendering works on React 18 and 19.
- `send` receives an `AbortSignal` in its context. The new `attemptTimeoutMs` option (30 seconds by default) aborts an attempt that runs too long and counts it as a retryable failure with the same key. `stop({ abortAfterMs })` aborts attempts in flight after a grace period. `fetchSender` passes the signal to `fetch`. Before, a request that never settled blocked `stop()` and the handover of the sender lock forever.
- `start()`, `stop()`, `start()` in a row (React StrictMode) left an extra channel and visibility subscription behind.
- Timer delays are clamped to 2^31−1 ms. A `syncIntervalMs` of `Infinity` or 2^31 or more overflowed `setTimeout` and read storage about every millisecond.
- `fetchSender` accepts headers as a `Headers` object or an array of pairs, not only a plain object.
- `keepalive` is set only when the body's size is known and fits in what is left of 64 KiB after the keepalive requests already in flight. Before, only string bodies were measured, one request at a time.
- The `uuidV4` documentation no longer says Node 18 has both crypto sources; it has no global `crypto`.
