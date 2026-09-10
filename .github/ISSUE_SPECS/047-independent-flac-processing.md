# Separate bounded FLAC downloads from adaptive processing

Base: adapter main `2c0d7928395db82744733d3dd5c045545eb366e9` (0.3.3), exact registry engine 0.2.1. App analysis: `/home/bl/misofm/app/docs/analysis/mixer-ingest-concurrency.md`, app source `8588fbdd68d21b1de9edbf2c5a940112df775081`. No copied engine/app source and no legacy engine inspection.

User authorizes Astra xhigh implementation, independent verification, package release after review, and app integration. Root owns app benchmarking/integration and release coordination; this slice owns adapter code/tests. Do not publish or merge before review.

## Problem and intended behavior

The current device-derived maximum four admits whole cold/warm pipelines, coupling network width, decoding and cache verification. Opt-in processing must allow up to sixteen device/memory-bounded decode+hash workers while physical FLAC Range requests retain the prior device-derived maximum (at most four). Existing defaults and lower-level resolver behavior stay compatible.

## Implementation scope

- Add explicit bounded processing policy and separate verification admission; scheduler must admit actual cold tasks up to processing width.
- Acquire FIFO download permits before every physical attempt, hold through consumed/cancelled response body, release before retry backoff or downstream processing. Include probe/metadata/audio, HTTP retries and caller transport fallback inside each attempt.
- Preserve exact ranges, ETag/native shape checks, bounded 256 KiB input/two 384 KiB output credits, verified canonical PCM and atomic OPFS promotion.
- Move cold incremental SHA-256 into existing dedicated decode workers, retaining package-private verification handoff and generic-resolver hashing. Keep bounded single OPFS write worker until measurement justifies changing storage ownership.
- Keep scheduler waiting outside no-progress deadlines; preserve timeout/cancellation on genuinely stalled network, decoder and storage paths.
- Expose diagnostics distinguishing live processing workers, actual runnable decode intervals, HTTP active/queued, CPU/input/output wait, hashing and writes. Do not equate admitted workers or wall-clock process duration containing Atomics.wait with CPU utilization.

## Objective gates

Policy tests for conservative missing/low hints and capable 4/8/16; delayed-body and retry tests prove physical cap across headers/body cancellation; queued cancellation and wait-aware timeouts; existing malformed ranges/ETag, corruption/truncation, quota/storage error gates stay green. Sixteen unique native-FLAC sources verify byte counts/digests, with measured real processing above four when runnable work exists, bounded buffers, warm cache zero network/decode and cleanup to zero active/queued. Full npm check and fresh packed browser consumer gates required. Root owns repeated 4/8/16 desktop and real-mobile benchmarking; missing real-device evidence must be recorded as a release-policy limitation.

## Release

Preserve existing main-only exact-SHA OIDC workflow and immutable registry version checks. Root coordinates new version, reviewed main integration, one publication, provenance/payload verification and app registry adoption. No publication in this implementation checkpoint.

## Implemented 0.3.4 candidate

Public opt-in: `flac.processing: { maximumWorkers?: 1..16, memoryBudgetBytes?: number, maximumVerifications?: 1..4 }`. Processing selects CPU-minus-one, the maximum, and 8 MiB reservations. Automatic processing memory is a conservative 16 MiB without a valid device-memory hint, otherwise device GiB ×16 MiB clamped to8–128 MiB. Physical FLAC admission independently preserves the old device-derived width, capped at4. Legacy omission preserves legacy sizing and main-realm hashing. The package store discovers processing/verification scheduling even with the advanced resolver/store pairing.

Cold SHA-256 runs inside immutable package decode workers over canonical bytes before transfer; exact byte/frame counts and the matching worker digest precede EOF and promotion. Private WeakMap provenance cannot be supplied as public resolver fields. Custom worker/decoder assets retain store hashing. Snapshotting policy, factory methods and URL values prevents caller mutation changing lazy worker provenance; custom factory receivers are preserved.

Each physical attempt owns a scoped FIFO permit through full response consumption or bounded cancellation. The Effect stream releases its reader before package-owned cancellation. Cancellation rejection, cancellation stall, or an abort-ignoring unsettled fetch quarantines the admission without retry/reuse of indeterminate capacity; late responses are disposed. Caller fetch overrides must serialize their own internal fallback and await body disposal. Queue wait does not consume active HTTP/decode deadlines. Generic PCM streams keep store deadlines.

The single OPFS writer now acknowledges actual operation start. Healthy replies refresh queued-request timers, while started operations keep strict independent deadlines. Default package OPFS write deadlines replace the outer store timer; a deliberately tighter store deadline remains a ceiling, and arbitrary storage keeps store timers. Cancellation forwards to the writer generation before awaiting cleanup. Per-worker atomic bit ownership measures runnable overlap excluding input/output waits and is cleared after physical termination, before re-admission. Numeric diagnostics include download/worker/verification/write activity and summed decode/hash/input/output timings. They are wall-time evidence, not OS CPU measurements.

## Candidate validation and exact packed artifact

`npm run check` PASS:175/175 tests, format/types/source policy, decoder gate,158-file package policy. Final log `/tmp/miso-processing-check-final.log`. Coverage adds device/memory4/8/16 policy, delayed-body physical cap/retries, queued cancellation, wait beyond store/decode deadlines, mixed warm/cold auto-scheduling, mutated PCM/forged custom-worker proof, wrong completion/early EOF, cancellation before promotion, mutable factory/URL snapshots, stalled/rejecting cancellation and late headers without overlapping retry, and healthy queued OPFS versus genuinely stalled started operations. Existing range/ETag, integrity/quota, cache leases, generic resolver, storage generation/lock and playback tests remain green.

Fresh packed Chromium session gate PASS (`/tmp/miso-processing-browser-final.log`): real package worker SHA-256, actual native decode, warm zero downloads/workers, all11 asset checks, exact first target PCM for initial/paused/running seeks, unchanged suspended clocks, zero new playback errors/underruns. Immutable browser-tested archive `/tmp/miso-adapter-0.3.4-reviewed/misofm-engine-web-adapter-0.3.4.tgz`:151089 bytes; SHA256 `35e8cff54155fa8cea8e0a83f77398f4bb6d729192e2c0ed08191d07cdc5eaec`. All158 payload files independently byte-equal current build/source; complete hashes `/tmp/miso-adapter-0.3.4-reviewed/manifest.json`.

Independent review reproduced and rechecked worker-option provenance and all transport cleanup races, plus mixed32-source cache scheduling; fixes pass. Additional two-engine OPFS gate passes Chromium cold/warm/physical-lock/deadline cleanup cases, then stops on installed Linux WebKit: `window.FileSystemFileHandle` is absent before ingest (`/tmp/miso-processing-opfs-browser.log`). No objective was weakened or marked passed for this unsupported environment. Actual Safari/mobile OPFS qualification remains an explicit limitation.

Pre-existing cancellation during an asynchronous final-file move can leave verified but unindexed late PCM after rejection; no incorrect PCM/readiness was accepted. Root excluded a transaction redesign from this slice and tracks it separately in issue48 and its synchronized spec.

Registry lookup for0.3.4 returned parsed E404 before version preparation. Package/lock/README/workflow now name0.3.4; exact engine0.2.1 dependency and all main-only exact-SHA/OIDC/immutable-version guards remain unchanged. No main integration or publication performed by this implementation task.

Root owns final controlled32-stem4/8/16 benchmark on this exact artifact, app cap selection, source/package acceptance, main merge and one existing-workflow OIDC release. This candidate makes no speedup or real-mobile performance claim before those measurements.
