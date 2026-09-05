# Reclaim only unpinned verified cache entries under quota pressure

## Existing product behavior

The current app reclaims unpinned PCM cache entries when space is needed. Adapter adoption must preserve that behavior; current adapter preflight only refuses quota. Build on reviewed#25 pin/lease/compatibility ownership, without a second cache implementation or a new public API. This is the bounded cache-policy successor already separated from#25 and required by app#101.

## Frozen contract

- When the existing storage estimate demonstrates insufficient capacity, choose verified indexed unpinned victims by oldest lastUsedAt then identity. Reclaim only enough for current need; if no eligible capacity remains, return existing typed stem.quota. Unknown/unavailable estimates keep existing behavior, and actual write quota failures stay typed.
- Protect durable offline pins, every live independent lease, and every source already verified for an in-progress multi-source open. Install provisional ownership before releasing a successfully verified source lock; rollback only that open's pins on failure/cancel, and promote/retain exact ownership for returned lease. No acknowledged lease may lose bytes through eviction.
- Recheck victim existence and pin ownership while holding its compatible stem/index coordination before removal. A second-tab pin racing victim selection must win protection if admitted before eviction's protected mutation. Never hold the index lock while acquiring a stem lock, and never wait for another victim stem while holding the current ingest stem. Move preflight/admission outside the target stem critical section and recheck on reacquisition if needed; do not add ad-hoc try-lock protocols or alter public lock-provider contracts.
- Use current recognized session-pin liveness and reliable lock-query evidence if stale session pins need pruning; preserve ambiguous pins and all offline pins. Do not invent new cache schemas, reset data or treat unavailable liveness as proof of death. Report any concrete compatibility ambiguity before broader recovery changes.
- Preserve source verification, bounded I/O, store timeout/cancel cleanup and historical folder/lock semantics. No new backend, decoder, playback, telemetry, benchmark or general recovery framework.

## Paths and gates

Allowed src/stems/store.ts, existing tests/store.test.ts, README only for exact existing quota behavior, this spec. A necessary additional path requires a concrete report before edit. Start isolated codex/dx-cache-quota from reviewed cache0d4e2db. SDK/adapter consumer changes remain separate and are merged only after review.

Existing lock/backend fixtures prove deterministic eligible victims, multiple offline/live pins protected, first verified stem of an unfinished open protected, pin-versus-eviction race, partial-open rollback, insufficient reclaimable quota and finite failure with no false lease ACK. Assert no nested stem-lock deadlock with two concurrent cold opens using existing fixture. Run focused types/store then pause for rootcheckpoint; full npm run check/package after. No broad browser matrix or timing benchmark. Astra medium implements; dedicated independent Astra medium reviewer checks completed evidence.

Matching issue misofm/engine-web-adapter#27.

## Attempt 1 implementation and evidence

Astra medium implemented the bounded store change; root checkpoint `57b0b3b`
contains only `src/stems/store.ts` and `tests/store.test.ts`. No public API,
index schema, backend, session, feed, pump, or wire changes. The initial
independent verdict and bounded correction are recorded below.

An open now acquires its unique lifetime lock before verification and installs
that ownership on each verified source before releasing the source lock. The
returned lease retains the same pins; failed or cancelled opens roll back only
their accumulated pins. Cold admission releases the target stem lock before
reclamation, then rechecks verification and capacity after reacquiring it.
Eviction takes a finite oldest-first/identity-tiebroken snapshot and rechecks
current pins and capacity under victim-stem then index locks before removal.
All existing pins, including ambiguous or stale-looking session pins, remain
protected; no optional stale-pin pruning was introduced.

Validation in `/private/tmp/miso-dx-adapter-quota`:

- `npm run typecheck` and `./node_modules/.bin/tsc -p tsconfig.test.json`: PASS.
- `node --test .test-dist/tests/store.test.js`: PASS, 27 tests. New cases cover
  deterministic minimal reclamation, multiple offline and independent live
  pins, provisional first-source protection with partial-open rollback,
  a second-tab pin admitted after victim selection, and two concurrent cold
  opens completing without nested victim/ingest lock deadlock. Existing
  cancellation, persistence failure, digest repair, and lock compatibility
  regressions remain green.
- `npm run check`: PASS, including format, type/source policy, decoder audit,
  all 136 tests, and the existing fresh-consumer package gate. Full output:
  `/private/tmp/dx27-check.log`. No browser matrix or benchmark was added.

Root committed the attempt 1 README/spec evidence at `65b6b65`; its independent
review returned the bounded failure below.


## Attempt 2: reclamation metadata quota classification

Dedicated independent Astra medium review of `65b6b65` returned **FAIL**, one
P2: quota failure while persisting the reclaimed index escaped as a raw
`QuotaExceededError`, because reclamation runs outside the ingest catch.
The first report remains at `/private/tmp/dx-27-astra-medium-review.md`;
its reproducer is `/private/tmp/dx27-review-quota-error.mjs`. The reviewer
reported no other blocker in this frozen slice.

Root checkpoint `66ab248` contains the bounded correction in the same store
and existing test paths. Reclamation preflight now classifies actual quota
failures as `EngineWebAdapterError("stem.quota")`, retaining the original
exception as cause and the incoming identity/required byte count as details.
Non-quota failures still propagate. No ownership, reclamation ordering,
cleanup, public API, schema, or backend changes were added.

The focused regression reproduces `index.pending` writer creation failing
after the eligible victim is removed. It asserts the typed error, original
cause and details, no ready acknowledgment or resolver request, no pending
index file, and released opening/mutation locks.

- `npm run typecheck` and `./node_modules/.bin/tsc -p tsconfig.test.json`: PASS.
- `node --test .test-dist/tests/store.test.js`: PASS, 28 tests.
- `npm run check` at `66ab248`: PASS, including format, type/source policy,
  decoder audit, all 137 tests, and fresh-consumer package validation
  (158 files, 145288 bytes). Log: `/private/tmp/dx27-attempt2-check.log`.

This final spec evidence awaits root checkpoint and the same independent
reviewer's exact-fix recheck. Attempt 1's FAIL is retained; attempt 2 does not
yet claim independent approval.
