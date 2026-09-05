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
