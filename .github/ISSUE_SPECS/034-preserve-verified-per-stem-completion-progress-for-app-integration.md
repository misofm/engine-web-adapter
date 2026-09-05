# Preserve verified per-stem completion progress for app integration

## Frozen product slice

App #101 must preserve its existing per-stem completion UI and cancellation/reload checks while the adapter owns canonical verification and storage. Current StemProgress reports only aggregate ready after every source completes. The app cannot truthfully mark a completed short stem while another stem is still ingesting; its existing two-completed-stems/partial-large-stem recovery predicates are impossible. Preserve that already-existing behavior with one typed progress event, not a new loading mode.

Baseline: reviewed adapter source fad01a7d3ab94ed377f5be66ea6530b3f5179f9e in /private/tmp/miso-dx-adapter-app-ready. Implement on codex/dx-source-ready. Keep exact installed reviewed SDK434 and unchanged decoder artifacts. Astra medium implements, dedicated independent Astra medium reviews. Root checkpoints and pushes exact focused-green paths before more work.

## Public contract

Add a distinct StemProgress variant `source-ready` with required readonly identity: StemIdentity and bytes: number. It means this opening has verified exact canonical length and SHA-256 and successfully persisted its ownership pin/index update for that identity. Emit once per unique identity for this open, for both cold ingest and warm verification, only after #ensure and own persistence succeed. The event carries no PCM and is progress evidence, not a playable session or perpetual cache guarantee.

Keep existing aggregate `ready` unchanged: it occurs only after all declarations are ready; session prefill and the returned playable session still wait for the complete set. Never overload aggregate ready with partial counters. No progressive playback, new backend, extra pipeline, callback registry, wire/Worker protocol, codec change, memory profiler or hash-progress-as-proof. No new SDK or Rust work.

Respect existing cancellation and cleanup: no source-ready for a failed verification/write/pin commit; no event after the operation has observed cancellation. A callback-triggered cancellation must reject and release leases with no aggregate ready. If a different source later fails, previously reported successfully stored bytes may remain cacheable, but the open fails and its pins are released as today. Deduplicated identity aliases emit one event, and empty opens retain existing aggregate semantics.

## Exact paths and gates

Change src/stems/types.ts, the existing VerifiedStemStore.openSession completion path in src/stems/store.ts, existing tests/stems.test.ts or actual existing store test file, existing public type test if needed, README progress documentation and this issue spec. Do not refactor store algorithms/locks or introduce a test framework.

Use existing storage fixtures to prove one source completes while another is held incomplete; event follows verified final/index ownership persistence; aggregate ready is absent until the other succeeds. Cover warm and cold order, failed hash/length or pin commit no-proof, callback cancellation and lease cleanup, and duplicate identities without duplicate events. Reuse existing relevant cases where they already cover these contracts. Run focused store/session/type gates, then existing package/full check once. Independently review the actual evidence. App maps only the named row to ready; it enters preparing-engine only on unchanged aggregate ready. App integration and browser recovery qualification remain #101.

## Evidence and scope record

Gap demonstrated by adapter store.ts aggregate emission after runBounded, app gate-machine ingestAdapter marking all rows together, and existing browser9c/9d predicates. Read-only record /private/tmp/dx101-per-source-proof-gap.md. This issue is the smallest adapter correction required to preserve the already-approved app behavior; no unrelated browser tooling is included. Matching GitHub issue number must be confirmed before implementation.

Matching GitHub issue: misofm/engine-web-adapter#34; number and title confirmed before implementation. Root approves the frozen scope and gates.

## Independent review and delivery

Dedicated independent Astra medium review PASS at 38b10cb8e6108b2de35585248144720b49672ffc (source c9ab9b1). Independent focused tests PASS 47/47; an additional concurrent sibling-failure scenario preserves the first verified source's cache bytes, releases all opening pins, emits no aggregate ready and returns the sibling error. Full author checks PASS 148/148 plus type/source/format/decoder/build/package policy. README and evidence match the reviewed temporal ownership contract. Review record `/private/tmp/dx-34-astra-medium-review.md`.

The adapter event capability is complete; app #101 still owns package adoption, per-row mapping and browser recovery qualification. No app completion, publication or deployment is claimed. Root pushes this evidence and synchronizes/ closes issue #34 in the same workflow.

## Source checkpoint evidence

The new required-identity/byte-count source-ready variant is emitted after awaited #ensure, including verified final content and persisted opening ownership. Cancellation is checked immediately before and after the callback. Aggregate ready and session prefill are unchanged. Existing fixtures prove a held pin commit emits no proof, cold and warm completion while a second source is held, one event for aliased identities, no event on hash/length/pin failure, and cancellation cleanup without aggregate readiness.

Typecheck and test compilation PASS; existing store/session/public-types focused suites PASS 47/47. Diff check is clean. Logs `/private/tmp/dx34-{type,compile,focused}.log`. Root checkpoints this focused-green source before documentation/full package gates and dedicated independent Astra review. No final issue PASS or app browser completion is claimed.


## Implementation evidence

Source checkpoint c9ab9b1 adds the distinct required-identity/bytes variant and
emits it after awaited #ensure (including ownership persistence), with abort
checks before and after the callback. Aggregate readiness and prefill are
unchanged. Existing store tests cover a held pin write, cold/warm source proof
while a second source is incomplete, duplicate aliases, bad length/digest,
persistence failure, and cancellation at persistence/source-ready/aggregate
boundaries with pin and lock cleanup.

- Typecheck and test compilation PASS; focused store/session/public-type suite
  47/47 PASS. Logs /private/tmp/dx34-{type,compile,focused}.log.
- One `npm run check` PASS: formatting/source policy, typecheck, decoder gate,
  all 148 tests, build and package policy (154 files, 136320 bytes before the
  final README prose update). Log /private/tmp/dx34-check.log.
- No SDK installation, dependency metadata, decoder artifacts, cache algorithm,
  browser protocol or app files changed. Installed reviewed SDK434 retained.
- README documents source completion versus aggregate/session readiness.

Concrete browser prerequisite: app 9d at651a9d5 timed out in waitForGate before
its first reload while the session ultimately reached ready with three completed
rows. Its two-short-ready/partial-large predicate could not hold because the
previous adapter emitted only aggregate ready. The new event exposes the store's
existing verified ownership fact; no UI proof is inferred from hash progress.
Evidence /private/tmp/dx101-9d-diagnostic-detail.json. App projection and browser
recovery qualification remain app#101; no browser PASS is claimed here.

Independent review pending; no publication/archive promotion claimed.
