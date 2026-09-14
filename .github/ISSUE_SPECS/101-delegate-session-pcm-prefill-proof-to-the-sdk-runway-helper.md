# Delegate session PCM prefill proof to the SDK runway helper

Depends on misofm/engine#797 and a published SDK containing its
`waitForPcmRunway` contract for final package acceptance. Independent of adapter
misofm/engine-web-adapter#95, misofm/engine-web-adapter#102 and app misofm/app#210; never hold their delivery for this work.

## Smallest outcome and facts

Dense and sparse session opening/seek use the SDK's generic PCM runway proof,
leaving this adapter responsible for its producer and aggregate choreography.
Current source baseline is main
`f833303f146de7cbe1705fe88ae68a6d6e0d4e45`; refresh before implementation.
`src/feed.ts`, `src/scratch.ts` and `src/stems/ring.ts` already delegate to SDK
primitives. Only `src/session.ts::waitForRunway` duplicates the generic generation,
contiguity and ring-capacity proof. This is source-level ownership evidence.

## Required change

1. Replace that algorithm with SDK `waitForPcmRunway`. Opening supplies existing
   source totals/rings, frame 0, generation 1 and the current two-second timeout;
   seek supplies its acknowledged target/full generation and the same deadline.
   Omit `minimumFrames` to retain today's full-capacity/EOF-clamped policy.
2. Keep source `pump.seekFrames`, feed attachment/`prepareSeek`, context-state
   checks, suspension/resumption, serialized transport, producer/refill work and
   terminal cleanup exactly at their current composition seam. The helper never
   grants permission to skip these steps or resumes audio itself.
3. Remove now-unused per-prefill observer construction and direct protocol
   checks. Keep the existing diagnostic/source-observation objects because they
   have independent callers. Do not alter ring/read cursor behavior or prefetch.
4. Translate `PcmRunwayError` into existing `session.open`/`session.seek` failures,
   preserving source ID, cause and timeout/mismatch distinction in details.
   Preserve abort/close semantics and meaningful SDK usage errors. No second
   fallback algorithm or copy retained after migration.
5. Preserve dense/sparse canonical BLAKE3/count checks, warm/cold worker limits,
   512 KiB reads, 128 KiB ingest bounds, 64 KiB zero checkpoints, source-specific
   cleanup/locks, current diagnostics and all playback behavior. No codec,
   storage framework, source-policy expansion or transport rewrite.

## Focused proof and delivery

Files: `src/session.ts`, an existing error translation seam only if needed,
`tests/session.test.ts`, README and package/provenance pins when adopting the
published SDK. Reuse existing opening, suspended/running seek and failure tests:
full current-generation prefill before success, wrong generation/contiguity,
EOF, timeout/cancellation, close during seek, and restore-running only after
successful proof. Assert consumer preparation precedes the SDK call and a
failure still completes aggregate cleanup. SDK owns detailed ring unit cases;
do not duplicate its matrix or add an engine factory just for testing.

Root commits one focused-green implementation tranche. Run `npm run check`;
for a released candidate run existing packed-browser/publish-dry-run gates and
fresh-consumer dependency checks once. Package with another coherent adapter
release when available; do not delay misofm/engine-web-adapter#95/app plotting to manufacture batching.
Final published adoption needs exact SDK/adapter versions, merged source SHAs,
registry integrities and existing provenance/attestation checks. If it cannot
share misofm/engine-web-adapter#95's cut, use a stateless ordinary release issue for publication and
record that dependency explicitly; source availability is never registry proof.

Luna XHIGH implements; a fresh Astra MEDIUM independently verifies and fixes
concrete in-scope bugs only; coordinator is a separate fresh Astra MEDIUM.
Maximum five coherent attempts with one verdict each; preserve evidence and
rebrief after five failures. Root synchronizes numbered local/GitHub evidence,
integrates latest main, and closes after PASS, merged delivery, required CI and
the published adoption evidence; verify remote CLOSED. No new results claimed
by this scope-only brief.


## Implementation checkpoint

Luna XHIGH replaces the duplicated observer loop with SDK `waitForPcmRunway`,
preserving aggregate opening/seek/feed/context/refill cleanup choreography and
translating `PcmRunwayError` with reason/source ID/original cause. README and the
existing mismatch assertion are updated. Build, types, format/source policy and
six focused session/runway tests PASS; logs `/tmp/miso-796-audit/adapter101-*`.
Only temporary accepted SDK 0.2.5 node_modules installation is used; no package,
lock or provenance pins change. Implementer reports two opening-race failures
reproducing without this patch under SDK 0.2.5; raw identification is being
collected and full integration acceptance must resolve them. Focused success
is not full-suite or registry acceptance. Root checkpoints this bounded source
tranche before independent Astra MEDIUM review and latest-main integration.

## Independent attempt 1 source review

Fresh Astra MEDIUM independently reviewed source checkpoint `37697f2` (including
implementation `74b66c9`) against the installed SDK 0.2.5 helper contract.
Source-scope verdict: PASS. No production-code correction was needed. Opening
passes source totals/rings, frame zero and generation one; seek passes the
acknowledged target/generation after awaiting producer seek and feed
`prepareSeek`. Both omit `minimumFrames` and retain the two-second timeout.
Context transitions, serialized transport, diagnostics and terminal cleanup
remain at their existing seams. Only `PcmRunwayError` is translated; its original
object is retained as cause, mismatch retains source ID, timeout retains its
separate reason, and other SDK/abort errors retain their cause chain.

The verifier strengthened existing mismatch/deadline tests to assert completed
pump/feed/host/context/lease cleanup and distinguish feed preparation timeout
from SDK runway timeout. Build, test compilation, lint and format checks PASS;
15 focused session tests PASS, including full-generation runway, tail/EOF,
prepare ordering, running restoration, cancellation and terminal cleanup.
Logs: `/tmp/miso-796-audit/verify-adapter101-{build,test-compile,focused,lint,format}.log`.

This is one attempt-1 source verdict, not final package acceptance. Full
`npm run check`, packed-browser, publish-dry-run and fresh-consumer gates remain
pending the combined #95 candidate and published dependency/provenance pins.
The two SDK console-map opening-race tests belong to #95's correction
`9666188`; they must be included in the final full suite. Metadata/lock still
name SDK 0.2.4 at this review checkpoint; no published-adoption claim is made.


## Combined candidate acceptance — 2026-09-14

Fresh Astra MEDIUM independently accepts #101 in the combined adapter 0.5.7
candidate at verification checkpoint `3746df9`: PASS. Registry SDK 0.2.5 is now
pinned exactly; fresh normal-installed tarball resolves one SDK with the archive
integrity recorded in #95. The full `npm run check` passes all 380 tests,
including the formerly failing single-console opening-map races. Corrected
packed-browser and publish-dry-run gates PASS, as do strict fresh-consumer types
and imports. No #101 production fix was needed; SDK runway errors retain their
cause/reason/source and aggregate opening/seek cleanup remains intact. Logs and
candidate archive identity are recorded in #95's independent candidate review.
This completes source/package candidate verification, not release completion:
merged required CI and actual adapter 0.5.7 publication/attestation and issue
synchronization remain required before claiming published adoption or closure.
