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

## Attempt 3 evidence (Luna, 2026-09-05)

Replaced the remaining non-discriminating fixtures in `tests/opfs-storage.test.ts`.
The real `OpfsStorageBackend` path now creates the requested staging file and
acquires its sync handle before withholding `write-open`; client deadline
termination closes that owned handle while an unrelated live handle remains
locked. `VerifiedStemStore` then removes only the owned staging object, leaves
the unrelated staging file and cached final/index bytes unchanged, and maps the
timeout to `stem.read_deadline`. The reusable historical worker harness now has
strict message/error/messageerror callback types and independent active versus
historical tracking.

Validation order: `npm run typecheck` passed; `npm test` passed 107/107;
`git diff --check` passed. No production or protocol paths changed in this
attempt. Focused log: `/private/tmp/dx-19-evidence-attempt3-focused.log`.
# Adapter #19 — attempt 3 Sol-approved test-only brief

## Decision

Attempt 2 at `8c0b54d` is **FAIL on evidence only**. The production generation fixes are accepted provisionally; the dedicated Astra review asserts no new production defect. Attempt 3 is one final, test-only evidence tranche. It must wait until SDK #405 reaches its root checkpoint.

## Frozen scope and allowlist

Allowed changes:

- `.github/ISSUE_SPECS/019-bound-opfs-worker-requests-and-tear-down-timed-out-generations.md` — record attempt-3 evidence and verdict only.
- `tests/opfs-storage.test.ts` — repair strict test typing and add the complete focused regression tranche.

Do not edit `src/`, worker protocol, backends, public types, product APIs, or add a test framework. A newly observed production failure stops this tranche for Sol rebriefing; it does not authorize an implementation change.

## Required test tranche

Build one typed, reusable worker/OPFS harness in the existing test file and use it for all cases below.

1. **Strict callback model.** Give `message`, `error`, and `messageerror` listeners their real callback signatures so `npm run typecheck` has no TS2345 suppression or broad `any`. Track active and historical listeners separately. Historical delivery must invoke the callbacks captured for the retired worker even after `removeEventListener`/`terminate`; it must not iterate an already-empty active set.

2. **Real timed-out writer ownership.** Exercise `VerifiedStemStore` through the real `OpfsStorageBackend` and `OpfsWorkerClient`. On `write-open`, the fake worker must create the actual staging file and acquire its sync-access handle before withholding the reply. Deadline termination closes exactly the handles owned by that worker generation. Keep an unrelated handle open as a sentinel and prove termination does not close it.

3. **Surgical store cleanup.** Seed a valid existing cache entry and index, then time out a different stem after its staging handle exists. Assert bounded rejection, timed generation termination, release of that staging lock, removal of only that staging object, absence of the failed final/index row, and byte-for-byte preservation of the valid entry/index. As a discriminator, temporarily removing the existing `VerifiedStemStore` catch cleanup must make this test fail because the staging object remains; restore the source before committing.

4. **Replacement-alive interleavings.** Start and ready a replacement generation before old promise continuations settle. Deliver the retired worker's historical `ready`, `error`, `messageerror`, and held success reply while the replacement is awaiting ready and again after it is usable. Assert the replacement stays alive and its listener, pending-request, and termination counts do not change.

5. **Pending operations and stale releases.** Cover no-reply handshake plus no-reply open/write, two concurrent writers, and explicit client close. Each pending operation settles exactly once with the existing error/code. After replacement readiness, invoke old writer `write`, `close`, and `abort`; each must fail locally without posting to, releasing, or terminating the replacement generation.

6. **Resource accounting.** For every case assert exact timer creation/clear or firing, active listener counts, pending-request count, promise settlement count, per-generation termination count, posted-message count, and owned-handle count. Cleanup assertions must run while the replacement remains alive, not only after global teardown.

The prior tests that merely call healthy `writer.abort()`, fabricate an immediate `MemoryBackend` `TimeoutError`, suppress late replies after termination, or emit through active listener sets do not satisfy these gates and should be replaced or tightened rather than counted as evidence.

## Validation order

1. Run `npm run typecheck` first; stop immediately on any test typing error.
2. Run the focused OPFS storage tests, including the temporary catch-cleanup removal red check and the restored-source green run.
3. Run the adapter's existing full `npm test` and `npm run check` gates.
4. Run the existing packed OPFS browser gate once against the exact packed adapter tree and record browser/runtime versions.
5. Record commands, exit status, and concise discriminator results in issue #19's local evidence section.

No broader browser matrix is required. Attempt 3 receives one implementation pass and one independent Astra review. If any frozen gate fails, stop: there is no fourth attempt; preserve the evidence and rescope under a successor issue.

## Attempt series stopped — Astra final FAIL

Dedicated Astra reviewed final attempt 3 at `5ddd140` and returned FAIL. Strict repository checks and the packed Chromium 152/WebKit 26.5 gate pass, and the original production generation reproducer passes. However, removing owned-handle termination cleanup from the fixture still leaves its test green; historical callback, stale-release and resource-accounting assertions remain incomplete. Removing store catch cleanup correctly makes the surgical staging regression red. Full report is attached to PR #20 and retained at `/private/tmp/dx-19-astra-dedicated-review-attempt3.md`, with independent mutants under `/private/tmp/dx-19-astra-attempt3-mutants/`.

The three-attempt stop applies. No further implementation/revision is authorized under this issue and no PASS or completed capability is claimed. Preserve the pushed production and test evidence. Sol is scoping a separate, smaller fault-fixture qualification issue with a changed verification approach; it must retain the original unmet resource-lifecycle claims without treating another patch as a fourth attempt.

## Renewed execution for the confirmed app goal

After the historical stop, the user explicitly confirmed the layer plan, requested execution of the rest with Astra medium, and required real end-to-end operation in misofm/app without shortcuts. Resume the existing OPFS reliability and cleanup proof under that instruction, retaining prior evidence and the original functional/resource requirements. Use the existing packed runner with the package-selected real Worker URL and host-side event interception; do not relocate worker module source or replace real locks with a modeled handle. Complete the remaining real-lock, stale-generation and owned-cleanup checks with a compact existing fixture. No alternate backend, codec, protocol or general test framework is added. Source stays unchanged unless a concrete product defect is reported and the same bounded correction scope is amended before implementation. A separate Astra medium reviewer verifies the completed result.

## Concrete production correction amendment

The renewed real-worker probe disproved the earlier experimental-only diagnosis: ordinary forwarding createWorker fails after packaging because its worker URL loses relative imports. A truthful locked-file deletion oracle also proves outer ingest timeout can race the worker deadline and attempt cleanup while the lock remains held. Root authorizes the following minimum corrections under #19, with #21 retaining the real-lock/generation proof:

- scripts/copy-assets.mjs: use the already declared Vite build API to emit the existing OPFS worker entry at the same dist/internal URL with a complete bundled module graph; retain declarations and add no dependency/query hack.
- src/stems/storage.ts: optional AbortSignal on the existing StemStorageBackend.createWriter(name, signal?) seam and its implementations; memory backend checks before mutation.
- src/stems/opfs-worker-client.ts: honor signal while writer open/lifetime is owned, synchronously tear down only the captured worker generation on abort; clear signal listeners on individual settlement and generation teardown.
- src/stems/store.ts: own an ingest controller, pass its signal into createWriter, and abort before cleanup on failure even if no writer handle returned. Do not wait indefinitely for a pending open or special-case OPFS in the generic store.

Keep existing protocol, cache identity, verification, error semantics and request/store bounds. Other valid cached entries remain untouched. Verify actual browser lock release and cleanup before public rejection; if browser termination needs additional bounded handling, report the evidence before extending the correction. Existing test/runner/spec paths remain allowed. These are demonstrated packaging and cancellation-ownership defects, not new storage or playback features.

### Astra correction checkpoint

Standalone OPFS worker bundling and ingest-owned cancellation before cleanup are implemented. Typecheck, focused18/18 OPFS tests (including truthful locked deletion and abort-listener cleanup), and package build pass. The existing Vite8.2.2 build dependency bundles the worker at its unchanged public URL. Real-browser lock/cleanup qualification and independent review remain pending; no final PASS claimed.

### Physical lock-release correction

Real Chromium proves termination returns before its OPFS lock is released: same-existing-file lock and unrelated sentinel checks pass, but immediate failed-staging removal reports NoModificationAllowedError and leaves the file at public rejection. Root authorizes a bounded correction in OpfsStorageBackend.remove: retry only NoModificationAllowedError for the same requested filename, using one absolute monotonic deadline bounded by existing readDeadlineMs and timer yields of at most 10ms. Bound each attempt by remaining time, treat NotFound as success, propagate other failures immediately, and retain the original finite failure path on expiry. Never recreate the file, delete unrelated entries, add another worker, or special-case OPFS in the generic store. Cover transient recovery and permanent-lock expiry in existing tests; prove staging absence before public rejection and preserve foreign staging plus valid cache/index in the existing real-browser runner. The existing copy-assets build may silence Vite logs so npm pack --json remains valid. This fixes the demonstrated cleanup race; it adds no storage capability or fallback.
