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
