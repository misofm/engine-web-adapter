# Qualify OPFS timeout teardown with real worker locks

## Disposition of adapter #19

Issue #19 stops after its third FAIL. Preserve its production correction at `789234a`, final test checkpoint `5ddd140`, PASS full check and packed Chromium/WebKit evidence, and all three adverse reviews. The correction is useful but the original teardown claims remain **unqualified**: the modeled handle-close mutant stayed green, and historical callback/resource accounting was repeatedly vacuous. Do not reopen #19 or describe it as complete.

This successor changes the verification method. It uses a real packed browser worker and real OPFS sync-access lock for physical ownership, plus one small deterministic client fixture for interleavings that browsers cannot expose precisely. It waives none of #19's remaining gates.

## Smallest closable outcome

Prove that an OPFS worker which physically opens a writer and whose ACK is withheld is terminated by the existing deadline; the same existing file can then be locked by a fresh worker, while an unrelated lock survives. Separately prove VerifiedStemStore's surgical cleanup and prove that delayed callbacks and stale writer releases from the retired generation cannot settle twice, leak timers/listeners/pending work, or affect a live replacement.

This is qualification only. No backend, codec, protocol, public API, product behavior, or new general harness is in scope. A test that exposes a production failure ends this issue with evidence and requires a separately briefed correction.

## Exact allowlist

- `.github/ISSUE_SPECS/021-qualify-opfs-timeout-teardown-with-real-worker-locks.md`.
- `scripts/browser-opfs.mjs` for the packed real-browser discriminator.
- `tests/opfs-storage.test.ts` for the deterministic client lifecycle fixture; existing helpers may be replaced or reduced.

No `src/**`, package exports, dependencies, workflows, or additional test files.

## Gate A — packed browser physical-lock discriminator

Extend the existing packed consumer; do not build a second browser runner. Use the existing asset `createWorker(url, options)` override so the package still selects its shipped OPFS module-worker URL and module options, then wrap that real `Worker`. The wrapper forwards outbound requests unchanged and all ordinary inbound events, but for one selected `write-open` it records the exact folder/staging name and suppresses only the matching success ACK **after the real worker has produced it**. This proves the worker acquired the sync-access handle before the client deadline without duplicating or bypassing packaged asset resolution.

First exercise `OpfsStorageBackend` directly, without store cleanup or file removal obscuring the lock oracle:

1. While the ACK-holding worker is alive, use a fresh probe worker to show competing `createSyncAccessHandle()` acquisition on the exact existing file (`create: false`) fails. This establishes that the original lock exists.
2. After timeout, assert the wrapper receives exactly one termination and the public operation settles exactly once with the existing timeout mapping. Before any deletion, acquire a sync handle through a fresh worker on that same existing file with `create: false`, then close it. Reacquiring a newly created pathname or merely deleting/listing the file is insufficient.
3. Hold a sync handle on a different sentinel path in a separate worker. Competing acquisition on the sentinel must fail both before and after the timed generation's teardown, then succeed only after its owner explicitly releases it.
4. In a separate `VerifiedStemStore` scenario, assert only the failed ingest's staging object is removed, its final/index row is absent, and a pre-existing valid entry and index remain byte-identical. Keep the already proven store-catch-cleanup red mutant as supporting evidence.
5. Run an isolated test-artifact mutant that prevents the wrapper from terminating the real timed worker. The same-existing-file reacquisition must fail by deadline. Restore before commit.

Run this only in the existing Chromium and Playwright WebKit packed gate. Record exact browser/runtime versions and distinguish an unsupported sync-handle environment from a behavioral failure; both configured engines must execute the discriminator for PASS.

## Gate B — deterministic retired-generation ownership fixture

Use one strictly typed `OpfsWriteWorkerClient` fake in the existing unit-test file. It must retain separate snapshots of historical `message`, `error`, and `messageerror` callbacks and invoke those snapshots after listener removal. Instrument existing timers locally and restore globals in `finally`; add no production clock seam.

In one table-driven lifecycle tranche, create a replacement before old work settles and keep it alive while assertions run. Cover no-ready, held open/write replies, two concurrent writers, and explicit client close. Deliver old `ready`, success, `error`, and `messageerror` both while replacement readiness is pending and after it succeeds. Then invoke old writer `write`, `close`, and `abort` after replacement readiness.

For every row assert exact per-generation posts/terminations, active and removed listener counts by event type, timer created/cleared/fired counts, and settlement count. Define pending accounting honestly through the available seam as unsettled calls plus live request timers; both must return to zero. Preserve the live replacement's counters as a separate oracle. Old operations must settle once with existing errors; historical events and stale writer calls must cause no post, ownership release, or teardown in the replacement. Old `write`/`close` retain their existing rejection behavior; stale `abort` retains its existing best-effort resolution and must still leave replacement state untouched.

In isolated compiled copies, separately mutate the **actual client code**, never the fixture: (a) disable timed worker termination for Gate A; (b) remove the client generation guard exercised by historical delivery; and (c) remove the stale-release generation guard. Each named discriminator must turn red. Restore all artifacts before committing.

## Validation and stop rule

Run strict typecheck first, then the focused lifecycle tests, the three named red mutants, full `npm run check`, and the existing packed OPFS gate once. Evidence must name the assertion each mutant trips; aggregate PASS counts are insufficient.

Budget one implementation attempt and one independent Astra review. This successor may correct faulty qualification code only within its allowlist. If a required discriminator remains vacuous, a browser cannot execute the promised lock oracle, or product code fails, stop and report the exact unsupported claim. Do not broaden the matrix, add framework code, edit production, or roll the work into a fourth #19 attempt.

## Decision record

- 2026-09-05: Sol briefed this qualification-only successor with dedicated Astra input. Root approved scope. Matching GitHub issue is misofm/engine-web-adapter#21, title exactly as above. Luna implements one attempt; a dedicated Astra reviewer verifies it. Issue #19 remains stopped, with no completion claim. Production changes are forbidden here.

## Luna attempt evidence (2026-09-05)

`npm run typecheck` passed against the existing test fixture. A bounded packed
runner probe was attempted in `scripts/browser-opfs.mjs` and reverted after the
first escalated Chromium execution: the custom worker wrapper reached a worker
load failure with 404s for `/errors.js` and `/stems/opfs-worker-protocol.js`.
The page reported only a worker `Error` before any OPFS lock probe ran, so no
physical-lock claim is made. The original runner is restored unchanged. Logs:
`/private/tmp/dx-21-evidence-browser.log` (sandbox `listen EPERM`) and
`/private/tmp/dx-21-evidence-browser-escalated2.log` (worker asset 404).
Per the stop rule, this qualification attempt stops for independent Astra
review. This experimental wrapper failure establishes neither a browser OPFS
limitation nor a defect in the shipped worker. No successor or further repair is
authorized by this record; no product or protocol change was attempted.

## Dedicated Astra verdict — FAIL to qualify (2026-09-05)

The single allowed attempt is consumed. Astra confirmed the experiment failed on worker-module import 404s before any physical-lock probe. The shipped runner, package, tests, and product source are unchanged; this establishes no browser OPFS limitation or package regression. The original remaining teardown claims stay unqualified. The dedicated review is attached to PR #20. No further qualification iteration or production change is authorized under this issue.

## Renewed execution for the confirmed app goal

After the historical stop, the user explicitly confirmed the layer plan, requested execution of the rest with Astra medium, and required real end-to-end operation in misofm/app without shortcuts. Resume the existing OPFS reliability and cleanup proof under that instruction, retaining prior evidence and the original functional/resource requirements. Use the existing packed runner with the package-selected real Worker URL and host-side event interception; do not relocate worker module source or replace real locks with a modeled handle. Complete the remaining real-lock, stale-generation and owned-cleanup checks with a compact existing fixture. No alternate backend, codec, protocol or general test framework is added. Source stays unchanged unless a concrete product defect is reported and the same bounded correction scope is amended before implementation. A separate Astra medium reviewer verifies the completed result.

### Renewed Astra qualification findings (2026-09-05)

The unchanged package factory path now has a minimal concrete reproducer: the
existing packed ingest receives only `assets: { createWorker: (url, options) =>
new Worker(url, options) }`. No module source rewriting or Blob is involved.
Packed Chromium fails with 404s for `/errors.js` and
`/stems/opfs-worker-protocol.js`: Vite treats the override's package-selected
`ADAPTER_ASSETS` URL as a copied asset, while its relative module imports are
not copied alongside it. This establishes a factory deployment defect that the
historical wrapper experiment did not isolate. Log:
`/private/tmp/dx-21-renewed-factory-escalated.log` (Node 26.8.1).

A second discriminator makes `FakeDirectory.removeEntry` refuse a locked file.
The existing timed staging test then fails because staging remains: the outer
store deadline can fire before the worker request deadline, so store catch
cleanup encounters the still-owned lock and swallows removal failure. This is
a modeled reproduction requiring browser confirmation once factory loading is
fixed, not yet physical-lock evidence. Focused run: 13/14 PASS, failure at the
staging-absence assertion; `/private/tmp/dx-21-renewed-focused.log`.

Both findings were reported to root before production edits. The working
qualification changes are not a PASS claim. Prior failed evidence is retained.

## Concrete production correction amendment

The renewed real-worker probe disproved the earlier experimental-only diagnosis: ordinary forwarding createWorker fails after packaging because its worker URL loses relative imports. A truthful locked-file deletion oracle also proves outer ingest timeout can race the worker deadline and attempt cleanup while the lock remains held. Root authorizes the following minimum corrections under #19, with #21 retaining the real-lock/generation proof:

- scripts/copy-assets.mjs: use the already declared Vite build API to emit the existing OPFS worker entry at the same dist/internal URL with a complete bundled module graph; retain declarations and add no dependency/query hack.
- src/stems/storage.ts: optional AbortSignal on the existing StemStorageBackend.createWriter(name, signal?) seam and its implementations; memory backend checks before mutation.
- src/stems/opfs-worker-client.ts: honor signal while writer open/lifetime is owned, synchronously tear down only the captured worker generation on abort; clear signal listeners on individual settlement and generation teardown.
- src/stems/store.ts: own an ingest controller, pass its signal into createWriter, and abort before cleanup on failure even if no writer handle returned. Do not wait indefinitely for a pending open or special-case OPFS in the generic store.

Keep existing protocol, cache identity, verification, error semantics and request/store bounds. Other valid cached entries remain untouched. Verify actual browser lock release and cleanup before public rejection; if browser termination needs additional bounded handling, report the evidence before extending the correction. Existing test/runner/spec paths remain allowed. These are demonstrated packaging and cancellation-ownership defects, not new storage or playback features.

### Physical lock-release correction

Real Chromium proves termination returns before its OPFS lock is released: same-existing-file lock and unrelated sentinel checks pass, but immediate failed-staging removal reports NoModificationAllowedError and leaves the file at public rejection. Root authorizes a bounded correction in OpfsStorageBackend.remove: retry only NoModificationAllowedError for the same requested filename, using one absolute monotonic deadline bounded by existing readDeadlineMs and timer yields of at most 10ms. Bound each attempt by remaining time, treat NotFound as success, propagate other failures immediately, and retain the original finite failure path on expiry. Never recreate the file, delete unrelated entries, add another worker, or special-case OPFS in the generic store. Cover transient recovery and permanent-lock expiry in existing tests; prove staging absence before public rejection and preserve foreign staging plus valid cache/index in the existing real-browser runner. The existing copy-assets build may silence Vite logs so npm pack --json remains valid. This fixes the demonstrated cleanup race; it adds no storage capability or fallback.

## Renewed completion evidence — awaiting independent Astra review

Astra implemented the approved corrections and remaining discriminators. The
public forwarding factory is exercised unchanged: package-selected URL and
`{ type: "module" }` construct a real Worker. Only main-realm delivery of one
successful `write-open` ACK is withheld. A separate tiny probe worker opens
existing files with `create: false`; it contains no copied package code.

The packed gate passes Chromium **152.0.7977.76** and Playwright WebKit **26.5**
(Playwright **1.62.1**, Node **26.8.1**, Vite **8.2.2**). Both prove a competing
lock refusal before timed-owner termination, reacquisition on the same existing
file before any deletion, exactly one timed termination/settlement, and an
unrelated sentinel lock that remains held until its own owner releases it.
Chromium refuses competing acquisition with `NoModificationAllowedError`;
WebKit reports `InvalidStateError`. This is Playwright WebKit evidence, **not
shipping Safari or iOS qualification**.

The separate real store scenario now removes failed staging before public
`stem.read_deadline` rejection, preserves valid PCM and index byte-for-byte,
preserves foreign staging, and leaves no failed final file or index row. The
browser reproduction proved that `Worker.terminate()` returns before physical
OPFS release; the approved same-entry removal retry uses one monotonic deadline,
bounds each attempt by remaining time, yields at most 10ms between lock refusals,
and retries only `NoModificationAllowedError`. Unit coverage also refuses
permanent locks by deadline, bounds a never-settling remove, and immediately
propagates unrelated errors. Silent Vite build logging preserves `npm pack
--json` stdout as machine-readable JSON.

Five deterministic client rows cover handshake, held open, held write, shared
writers and explicit close. Each starts a live replacement before old rejection
continuations settle, invokes removed historical message/error/messageerror
callbacks before and after replacement readiness, and checks stale writer calls
leave replacement ownership intact. Accounting covers per-generation posts,
active/historical listeners, terminations, signal subscriptions, pending calls,
active timers, created timers, clear calls (including fired timers), timer firing
and promise settlements. Pending accounting means observed unsettled calls plus
live request timers; it does not claim access to private implementation fields.

Validation:

- `npm run typecheck` and focused OPFS suite: PASS, **19 tests**.
- `npm run check`: PASS, **113 tests**, decoder and package policy included;
  `/private/tmp/dx-21-final-check.log`.
- Existing packed `node scripts/browser-opfs.mjs`: PASS both configured engines;
  `/private/tmp/dx-21-final-browser.log`.
- Isolated compiled artifact baseline: PASS. Removing actual client receive
  generation guard: FAIL, `old success cannot acknowledge replacement open`.
  Removing actual stale-release guard: FAIL,
  `stale writer release must preserve replacement ownership`.
- Removing actual store catch cleanup: FAIL, failed staging still present.
  Removing actual store cancellation: FAIL,
  `store cancellation does not wait for the worker deadline` (store deadline
  20ms, worker deadline 1000ms makes the ownership discriminator independent of
  eventual worker timeout). Logs/copies: `/private/tmp/dx-21-final-mutants/`.
- Isolated runner mutant skips termination of the real ACK-holding worker:
  FAIL, `same existing file reacquires after timeout termination before deletion`.
  Source/log: `/private/tmp/dx-21-no-termination.mjs` and
  `/private/tmp/dx-21-no-termination.log`. The fixture does not delete/recreate
  the path, so disabling actual termination cannot pass by cleanup side effects.

Historical failures remain recorded above. These are implementation evidence,
not an independent PASS verdict; root must checkpoint/push this tranche and
obtain the separately requested Astra review before claiming completion.

## Dedicated Astra medium final PASS

Independent reviewer verified c7af187: full113 tests, focused19, packed Chromium152.0.7977.76/WebKit26.5 physical lock and surgical cleanup, plus five meaningful negative discriminators. No release-blocking defect remains in the renewed bounded scope. Report attached to PR20. Historical failures remain retained; this PASS describes the completed renewed execution. App migration and cache policy are separate work.
