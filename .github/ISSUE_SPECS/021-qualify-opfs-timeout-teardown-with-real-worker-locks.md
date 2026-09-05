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
