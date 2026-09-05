# Bound OPFS worker requests and tear down timed-out generations

## Attempt 1 evidence (Luna, 2026-09-05)

Implemented in the approved paths only: `src/stems/opfs-worker-client.ts`,
`src/stems/storage.ts`, and `tests/opfs-storage.test.ts`. The worker client now
owns the backend deadline for its handshake and requests, clears request
timers, fail-closes the whole generation on timeout, rejects pending work once,
and ignores late replies after listener removal and termination. The backend no
longer races that deadline with an outer `Promise.race` around worker-backed
writer operations; public interfaces and existing error names remain unchanged.

Focused discriminator `/private/tmp/dx-opfs-open-repro.mjs` changed from the
baseline `{ "deadlineRejected": "TimeoutError", "lateOpenAborted": false,
"workerTerminated": false }` to `{ "deadlineRejected": "TimeoutError",
"lateOpenAborted": false, "workerTerminated": true }`. The new repository
regression is `a timed-out writer open terminates its generation and ignores a
late reply` in `tests/opfs-storage.test.ts`.

Validation: `npm run typecheck` passed; `npm test` passed with 101/101 tests;
`npm run check` reached the same suite and its format, lint, source-policy, and
decoder gates, but the first run exposed the timer race now corrected and must
be rerun. `npm run test:browser:opfs` could not start its local server in this
sandbox (`listen EPERM 127.0.0.1`), so packed Chromium/WebKit evidence remains
the existing baseline and is not claimed as rerun here. No worker protocol or
worker implementation changes were made.

**Repository baseline:** `engine-web-adapter` `origin/main` at `63b4ee6212287000ff85e1cfa969d385f6246d2d`  
**Issue:** https://github.com/misofm/engine-web-adapter/issues/19. Do not reopen closed issue #13.  
**Workflow:** Luna implements attempt 1 after engine issue #393 reaches its commit/review boundary; Astra performs the adversarial PR review. The user's model assignments override the repository's default role wording for this issue only.

## Proven defect

`OpfsStorageBackend.createWriter()` applies an external deadline to `OpfsWriteWorkerClient.createWriter()`, but that deadline only abandons the promise. The underlying `write-open` remains pending. A late successful reply can therefore create an unreachable writer whose sync access handle remains active and whose shared worker is retained.

The baseline reproducer `/private/tmp/dx-opfs-open-repro.mjs` fails on `63b4ee6`; `/private/tmp/dx-baseline-evidence/opfs-late-open-repro.log` records `{ deadlineRejected: "TimeoutError", lateOpenAborted: false, workerTerminated: false }`. Existing packed OPFS behavior is green in Chromium 152 and Playwright WebKit 26.5 (`adapter-opfs-browser.log`).

## Smallest closable product slice

Make the existing OPFS worker client own bounded completion for its handshake and writer requests. If the handshake or any request exceeds the existing backend deadline, aborts through existing backend/session close, or loses the worker, fail-close that entire shared worker generation: detach listeners, terminate the worker, reject every pending operation exactly once with the authoritative existing reason, invalidate every writer from that generation, and return to an idle state from which a later healthy operation can create a fresh worker.

Termination is the cancellation primitive. A protocol abort cannot provide bounded cleanup when the worker is stalled or never replies. A late reply from a terminated/detached generation must be inert and cannot resolve an abandoned open, decrement a new generation's ownership, or leave an active handle. Do not add a generic cancellation framework.

Preserve the public `StemStorageBackend` and `StemStorageWriter` interfaces and existing error codes. Continue mapping a timed-out ingest operation through the current `TimeoutError`/`stem.read_deadline` path. Existing `close()` remains terminal for the current worker generation and idempotent; the backend object remains truthfully reusable only after that generation is fully torn down. Healthy writer behavior and shared-worker reuse remain unchanged.

The client must track writer ownership exactly once. Concurrent writers share one generation. A timeout in any operation invalidates all writers in that generation because terminating the shared worker closes all of their physical handles. Their pending calls reject once; later `write`, `close`, or `abort` cannot post into a replacement worker. `abort()` remains idempotent/best-effort at the public writer seam.

Preserve every valid cache entry. Cleanup may remove or truncate only the staging object owned by the failed ingest through the existing store cleanup path. Do not scan or delete the OPFS directory, rebuild the index, demote verified entries, or change promotion/quota policy.

## Implementation boundary

Pass the backend's existing deadline into `OpfsWriteWorkerClient`; enforce it inside worker handshake and pending-request bookkeeping so timeout actually tears down the generation. Clear request timers and listeners on every success, failure, close, and teardown path. Generation checks must prevent late callbacks and stale writer releases from affecting a replacement worker.

The worker protocol and worker implementation should remain unchanged: hard Worker termination is sufficient and is the only bounded answer to no reply. Amend them only if implementation proves a concrete cleanup operation cannot be expressed through termination; if so, stop for Sol rescope before editing.

## Allowed paths

- `.github/ISSUE_SPECS/019-bound-opfs-worker-requests-and-tear-down-timed-out-generations.md`
- `src/stems/opfs-worker-client.ts`
- `src/stems/storage.ts`
- `tests/opfs-storage.test.ts`
- `src/stems/opfs-worker-protocol.ts` and `src/internal/engine-web-opfs-worker.ts` only after a documented Sol rescope proving termination insufficient
- `scripts/browser-opfs.mjs` only if a small packed regression can exercise timeout cleanup without weakening its current real-OPFS assertions

No other tracked path may change without amending the issue.

## Forbidden scope

- Quota estimation/reservation, move/promotion redesign, manifests, hashing, new storage backends, storage-interface expansion, cache eviction, or global cleanup.
- SDK/engine, host request IDs, console, decoder/FLAC, pump, HTTP/resolver, session API, or UI changes.
- New public errors, public timeout/cancellation options, worker pools, reusable request framework, or claims covering private mode/webviews beyond tested evidence.
- Reopening or rewriting issue #13.

## Objective gates

1. **Baseline discriminator.** Preserve the exact late-open reproduction as a focused test: the caller receives `TimeoutError`; after the delayed open would have succeeded, the old worker is terminated, its handle/lock is gone, no abort/close promise remains pending, and no late reply changes state. Demonstrate that the test fails on `63b4ee6` and passes after the fix.
2. **No-reply handshake.** A worker that never emits `worker-ready` reaches the deadline, rejects open once, terminates once, removes every listener/timer, and leaves zero active workers/pending requests. A subsequent operation starts a fresh generation and succeeds.
3. **Late handshake reply.** A ready reply delivered after timeout is inert, cannot mark support for or resolve the replacement generation, and cannot retain the old worker.
4. **No-reply and late-reply requests.** Cover `write-open` and one already-open operation (`write` or `write-close`). Timeout rejects the initiating call and all same-generation pending calls exactly once, terminates once, invalidates all writers, and makes historical late replies inert.
5. **Concurrent writers and close.** Two writers share one worker. Timeout one pending operation and prove both writers settle/invalidate without underflow or double release. Separately, call backend `close()` with handshake/open/write operations pending; every promise settles once with current close behavior, termination occurs once, repeated close is inert, and a healthy later create uses a fresh generation.
6. **Owned staging only.** Through `VerifiedStemStore`, a timed-out writer open removes its own staging name, publishes no final/index row, and leaves a pre-existing verified stem and index entry byte-identical. No directory-wide deletion occurs.
7. **Healthy path unchanged.** Existing sync-access write, abort, concurrent-writer, capability refusal, verified ingest/promotion, warm reopen, and worker-release tests remain green. A healthy writer still shares the current worker and releases it when the last writer settles.
8. **Errors remain truthful.** Direct backend timeout remains a `TimeoutError`; store ingest preserves the existing `stem.read_deadline` mapping. Close/cancellation keeps the existing `session.closed`/abort reason behavior. No new error code or public API appears.
9. **Packed OPFS evidence.** Run the existing real packed OPFS gate and report exact tested engines. It must retain cold ingest, warm-cache reuse, Worker-only sync-access behavior, and current browser claims; the issue does not broaden the matrix.
10. **Proportional repository gates.** Run `npm test`, `npm run check`, and `npm run test:browser:opfs` once after focused tests are green. Attach commands, versions, pass counts, and the before/after reproducer result. No unrelated SDK/Rust/decoder benchmark matrix is required beyond what `npm run check` already invokes.
11. **Scope proof.** Final diff contains only approved paths, public storage interfaces are unchanged, worker protocol/worker are unchanged unless separately reapproved, and no valid cache entry is modified by the new regressions.

## Astra review questions

- Can any deadline reject while its worker generation or sync handle survives?
- Does every pending operation settle exactly once under timeout, close, error, messageerror, and historical late reply?
- Can a stale writer or callback mutate counters/support/pending state in a replacement generation?
- Does failure of one shared worker truthfully invalidate every writer that depended on it?
- Is the existing staging cleanup surgical, with verified cache entries preserved?
- Did the implementation retain existing error meanings and avoid new public/storage/protocol machinery?

## Delivery stop

Root creates and synchronizes the new numbered issue/spec, then commits that issue-only checkpoint before Luna begins. Luna stops after one coherent implementation tranche and focused evidence. Root performs the status/commit audit before Astra review. The normal three-attempt limit remains in force; quota or broader storage work requires a separate issue.
# Adapter issue #19 — attempt 2 addendum (Sol approved)

**Attempt 1 verdict:** FAIL at `acf86f5`; Astra review: `/private/tmp/dx-19-astra-review.md`.  
**Implementer/reviewer:** Luna performs this bounded revision; Astra re-reviews attempt 2.  
**Baseline evidence:** `npm run check` is green with 101 tests and the real packed OPFS gate is green. Preserve both.

The original issue #19 contract and all eleven gates remain frozen. This revision fixes the generation race and handshake callback retention, then supplies every missing gate. It adds no storage feature.

## Required production corrections

1. In `OpfsWriteWorkerClient.#acquire()`, capture the generation that owns the acquire before awaiting `#ready`. Every success/failure continuation and ownership release must use that captured generation. A close/timeout may reset ownership and advance the generation; the old continuation must then be a no-op. It must never decrement `#openWriters`, reject, or tear down a replacement worker.
2. Make the ready rejection callback one stable closure identity. Store that identity in `#readyReject`, and have the handshake's single settlement path clear it only when it still owns the field. Healthy ready, error, messageerror, timeout, explicit close, and teardown each clear their timer/listeners/callback exactly once.
3. Keep the current client-owned request deadlines and generation checks. Do not restore an outer writer-operation race that can abandon live work. Resolve the `deadlineMs - 1` comment/behavior consistently: `open()` may retain its outer deadline for main-thread directory operations, but worker handshake/request cleanup must complete through the client before its promise rejects. Avoid depending on timer ordering as correctness.

The concrete red case is `/private/tmp/dx-19-generation-repro.mjs`: pending acquire → `close()` → replacement acquire/ready → old catch. After correction, the first rejects `session.closed`, the replacement succeeds and stays active, the old worker terminates once, and the replacement is not terminated by stale cleanup.

## Missing mandatory evidence to add

- Replace the attempt-1 fake that suppresses events after terminate with a historical-listener fake capable of delivering late ready/request replies after termination. Track listeners, timers, posts, terminations, simulated handles, and locks explicitly.
- Never-ready handshake: timeout rejects once, terminates once, clears pending/listeners/timer, then a new generation succeeds.
- Late-ready handshake: historical reply is inert and cannot set support or settle/tear down the replacement.
- No-reply and late-reply `write-open`, plus one already-open `write` or `write-close`: all same-generation pending calls reject exactly once, all physical handles/locks disappear on termination, and stale replies are inert.
- Two concurrent writers: timeout one request, prove both writers invalidate and settle without underflow/double release; their later calls cannot post to a replacement.
- Explicit `close()` during each of handshake, open, and write: all pending operations settle once with existing close behavior, termination occurs once, repeated close is inert, and healthy reopen starts only after teardown.
- `VerifiedStemStore` timeout: remove only its owned staging file, publish no final/index row, preserve a pre-existing verified stem and index bytes, and retain existing `stem.read_deadline` mapping. Direct backend timeout remains `TimeoutError`; abort/close reasons remain unchanged.
- Existing healthy sync-access, abort, concurrent writers, capability refusal, ingest/promotion, warm reopen, and last-writer worker release remain green.

## Allowed paths

- `.github/ISSUE_SPECS/019-bound-opfs-worker-requests-and-tear-down-timed-out-generations.md` (attempt/evidence record)
- `src/stems/opfs-worker-client.ts`
- `src/stems/storage.ts`
- `tests/opfs-storage.test.ts`

No worker protocol/worker edit is needed or authorized. No quota, move/promotion, manifest, hashing, backend, SDK/engine, decoder, pump, public interface, error-code, or directory-wide cleanup change.

## Validation before Astra re-review

Run the focused issue-19 tests including the independent generation reproducer before/after, then `npm test`, `npm run check`, and `npm run test:browser:opfs`. Attach exact counts and tested engines. Evidence must include a table for handshake/open/write timeout and close, listing settlement count, termination count, listener/timer/pending counts, handle/lock state, and replacement-generation result.

Attempt 2 passes only when both Astra findings and every omitted original gate have executable evidence. Do not lower gates or treat termination behavior supplied by a fake as client proof.

Root qualification update: `npm run test:browser:opfs` passed outside the sandbox on `acf86f5`, preserving packed cold ingest and warm reuse in Chromium 152 and Playwright WebKit 26.5. This does not replace missing adversarial unit evidence and is not shipping Safari/iOS qualification. Log: `/private/tmp/dx-baseline-evidence/adapter-opfs-pr20.log`. Astra attempt 1 remains FAIL until the generation race and all frozen missing gates are corrected.

## Attempt 2 implementation evidence (Luna, pending Astra review)

Production corrections are in `src/stems/opfs-worker-client.ts` and
`src/stems/storage.ts`: acquire continuations carry their generation, stale
success/failure/release paths cannot touch a replacement, ready settlement uses
one stable callback identity, and worker handshake/request deadlines are owned
by the client without timer-ordering offsets. Worker event callbacks also carry
generation, so historical replies cannot mutate a later generation.

| Gate area | Evidence | Result |
| --- | --- | --- |
| Generation replacement | `/private/tmp/dx-19-generation-repro.mjs` | `first=session.closed`, `second=success`, `terminations=[1,0]`, `active=1` |
| Late open timeout | `tests/opfs-storage.test.ts` | TimeoutError, one termination, historical reply inert |
| Already-open write timeout | `tests/opfs-storage.test.ts` | TimeoutError, one termination, stale writer rejected as `session.closed` |
| Existing suite | `npm test` | 102/102 passing |

The full handshake/open/write/close and VerifiedStemStore gate matrix still
requires executable coverage before PASS; no claim is made for those rows yet.

## Attempt 2 supplemental evidence (Luna, 2026-09-05)

Added the remaining lifecycle regressions to `tests/opfs-storage.test.ts`:

- a never-ready handshake times out once, removes listeners, ignores late ready/error/messageerror, and a replacement generation succeeds;
- close during handshake, open, and write is idempotent and a replacement generation succeeds;
- two shared writers reject on one operation timeout, with stale replies inert and a fresh generation usable;
- the real OPFS fake's owned sync handle is released without removing an unrelated file;
- a timed staging admission through `VerifiedStemStore` maps to `stem.read_deadline`, removes only the owned staging name, and preserves a pre-existing verified final/index byte-for-byte while a distinct requested identity misses the warm cache.

Focused validation: `npm test` passed 107/107. The timed store case uses the
existing deterministic storage seam for the injected no-progress timeout; the
direct OPFS worker timeout and physical sync-handle paths remain covered by the
neighboring worker-backed tests. No public interface or worker protocol changed;
the storage constructor comment was corrected to describe client-owned deadline
teardown.
