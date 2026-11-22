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
