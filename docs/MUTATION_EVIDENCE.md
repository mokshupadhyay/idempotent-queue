# Mutation evidence

Each property test was checked against one small deliberate break in `src/queue.ts`. `scripts/mutation-check.mjs` does the following for each row:

1. copies the file to a backup in a temporary directory;
2. applies the one-line change shown;
3. runs only that property (`jest src/__tests__/properties.test.ts -t "<property>:"`, 120 generated cases, each run limited to 10 minutes);
4. restores the file from the backup;
5. runs `cmp <file> <backup>`, which stops the script if the restored file is not byte-identical.

After all rows it runs the unmutated property suite again. Run it with `timeout 3000 node scripts/mutation-check.mjs`.

Result of the recorded run (`timeout 3000 node scripts/mutation-check.mjs`, exit 0): every mutation made its property fail, every `cmp` reported identical files, and the unmutated properties all passed. Separately, a SHA-256 of all 32 files under `src/` was taken before the run and checked after it (`shasum -a 256 -c`), and all 32 matched.

| # | Property | Deliberate break (`src/queue.ts`) | Property result | Failing check | Shrunk counterexample | Restored, `cmp` |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1. Every enqueued key ends applied exactly once and `succeeded` | Do not recover items left in flight by a closed tab: `if (item.status === 'inflight' && !ownIds.has(item.id)) {` → `if (false && item.status === 'inflight' && !ownIds.has(item.id)) {` | FAILED after 4 cases | Expected status `"succeeded"`, received `"inflight"` | Enqueue `key-0`, then close the tab while it is in flight | identical |
| 2 | 1. Every enqueued key ends applied exactly once and `succeeded` | Drop the dedupe by key inside the enqueue write: `if (existing) {` → `if (existing && false) {` | FAILED after 3 cases | Expected 1 item for the key, received 2 | Enqueue `key-1`, wait 1 ms, go offline, enqueue `key-1` again | identical |
| 3 | 2. The same key is never in flight twice at once | Drop the in-flight key guard: `if (inflightKeys.has(item.key) \|\| claimedKeys.has(item.key)) return;` → `if (claimedKeys.has(item.key)) return;` | FAILED after 1 case | Expected at most 1 request per key in flight, received 2 | Concurrency 2: enqueue `key-0`, then discard it while in flight and enqueue the same key again | identical |
| 4 | 3. Permanent errors never retried; retryable errors at most `maxAttempts` times | Off by one: `item.attempts >= policy.maxAttempts` → `item.attempts > policy.maxAttempts` | FAILED after 2 cases | Expected at most 1 send (`maxAttempts: 1`), received 2 | `maxAttempts: 1`, enqueue `key-0`, every response is HTTP 500 | identical |
| 5 | 4. Reloading from storage gives the same items as the live queue | Off by one when recovering an interrupted last attempt: `if (item.attempts >= policy.maxAttempts) {` → `if (item.attempts > policy.maxAttempts) {` (in `recovered`) | FAILED after 2 cases | The reloaded item was `pending`; the interrupted last attempt should reload as `failed` | `maxAttempts: 1`, enqueue `key-0` and let it start | identical |
| 6 | 5. With two tabs, the same key is never in flight twice | Release the sender lock as soon as it is granted: `return new Promise<void>((resolve) => {` → `void new Promise<void>((resolve) => {` | FAILED after 5 cases | Expected at most 1 request per key in flight across tabs, received 2 | Two tabs, enqueue `key-0` in the first | identical |
| 7 | 6. With two tabs, every key ends applied exactly once and `succeeded` | Ignore other tabs' change notifications: `if (message.source !== instanceId) refresh();` → `if (false) refresh();` | FAILED after 2 cases | The tab that did not send still showed `attempts: 0` and no `completedAt`, while storage held the succeeded item | Two tabs with a change channel, enqueue `key-0` in the first | identical |

## Notes

- Case counts and counterexamples depend on fast-check's random seed, so a new run can report different numbers. In separate runs of the same script while the tests were being written, every row failed within the 120 cases.
- The "Failing check" column for rows 5 and 7 is taken from separate runs of the same mutation and the same property, because the script's one-line summary does not capture a deep-equality diff. Those runs failed after 8 and 1 cases. Both files were restored and checked with `cmp` afterwards, and the 32 checksums still matched.
- A property that never meets the situation it guards would pass without testing anything. To prevent that, each property counts the situations its generated cases reached and fails if any count stays at zero. Examples: a tab closed mid-flight, a lost response, a response lost to going offline, a re-enqueue while the discarded request is still in flight, the sender changing between tabs, an item re-sent by the other tab after a crash, and an enqueue in a tab that does not send. `SHOW_COVERAGE=1 npx jest src/__tests__/properties.test.ts` prints the counts.
- The generated worlds mix both storage modes: atomic `update`, as with IndexedDB, and plain `getItem`/`setItem` behind the storage lock, as with localStorage. They also mix tabs that notify each other over a channel with tabs that poll.
- The unit tests in `src/__tests__/adapters.test.ts` found a bug in the BroadcastChannel lock fallback while they were being written. A tab whose channel opened after another tab's claim never saw that claim, so with three tabs claiming at once, all three could win (the test saw 3 holders). The fix makes a tab that is still waiting on its own earlier claim object to later claims. The test "lets one of several tabs hold a lock at a time" failed before the fix and passes after it. It was not re-checked by reverting the fix.
