# Preserve per-open ingest retention diagnostics for app integration

## Product contract and baseline

The existing app's memory gate observes live and peak delivered/decoded buffer ownership while opening a mixer session. Moving delivery into the adapter must preserve that evidence. This issue is limited to the existing nine residency fields and fixed reservation facts; it adds no profiler, allocator telemetry, heartbeat, Worker protocol, or test matrix. App UI and memory-gate adoption remain app#101.

Begin on isolated codex/dx-app-ready, combining independently reviewed adapter#24/#25/#27/#29 and exact reviewed SDK#434 source8a19a848. The SDK archive is /private/tmp/dx-reviewed-sdk434/misofm-engine-0.1.0.tgz with SHA2565694c21f1e4eb99f6366d7bcc0330f0af06744768810edc3cc6e0e186df09488. Preserve the actual compiled SDK bytes and dependency metadata; no registry publication claim.

All named behavior below is the frozen implementation scope. The reviewed quota implementation uses two passes: warm verification, reclamation outside the target stem lock, then reacquired verification/ingest. Active ownership belongs to that entire logical #ensure operation, begins once after its first actual admission grant, and ends once after final ingest/cleanup. Do not count the two verification passes separately, invent a loop, or overwrite the reviewed quota/lock algorithm. Astra medium implements; a dedicated independent Astra medium reviewer checks. Root checkpoints a focused-green tranche before full validation.

## Public contract

Add one factory, `createIngestDiagnostics()`, returning a read-only, single-open collector. Pass it as optional `ingestDiagnostics` to `openEngineWebSession`. The caller creates it before calling open, reads it while opening, and retains it after rejection/cancellation/ready. No reset, mutation methods, callbacks, global singleton, automatic disposal of peaks, or reference to PCM is exposed.

`collector.snapshot()` returns a fresh read-only value `{ residency: IngestResidency | null, reservation: IngestReservation | null }`. `IngestResidency` has exactly the existing nine numeric fields: `limit`, `deliveredBytes`, `deliveredPeakBytes`, `decodedBytes`, `decodedPeakBytes`, `containers`, `containersPeak`, `active`, `activePeak`. No progress totals become memory fields. `reservation` exposes the existing package component constants, total per-slot reservation, headroom, and selected admission width; it is a conservative configured envelope, not measured live heap. Both are null before the participating pipeline is initialized; unsupported injected producer/store paths remain unknown rather than manufacturing zeroes. A valid default FLAC open with an empty session initializes known zero live/peak counters and its actual limit. Early failure before initialization remains unknown. A collector may bind to only one invocation, including a failed invocation; reject reuse rather than mix sessions.

Support the package FLAC resolver plus package `VerifiedStemStore`/`OpfsStemStore`, including a caller-injected instance preserving `miso-stems-v1`. Arbitrary injected `StemResolver`/`StemStore` implementations do not automatically acquire a package retention claim. Keep `ResolvedStem`, `StemResolver.resolve`, stream chunks, Worker messages and credit protocol unchanged.

## Exact implementation paths and threading

- New `src/stems/ingest-diagnostics.ts`: public read-only types/factory, internal integer counters and idempotent ownership-release helpers. Keep mutable state behind a WeakMap keyed by collector; a WeakMap keyed by decoded backing ArrayBuffer associates numeric ownership with its collector without retaining the buffer. Do not collect chunks into a second list.
- `src/session-types.ts`, `src/session.ts`, `src/index.ts`: expose the option/factory and bind once before async boot. Thread the same collector into the package resolver and store. An internal resolver-construction helper can take the collector without expanding the public typed producer protocol.
- `src/stems/types.ts`, `src/stems/store.ts`: add only an optional collector to existing `StemStore.openSession` options. The package store acknowledges participation internally, initializes the snapshot for the package FLAC path, owns per-stem admission completion, and releases handed-off decoded ownership. A custom store that ignores the option never acknowledges participation, so its snapshot stays unknown. Use internal registration of the package resolver to distinguish it from arbitrary injected producers; the session's expectation-checking wrapper must retain that registration. No public capability registry or backend special case.
- `src/stems/flac-delivery.ts`, `src/stems/flac-resolver.ts`: instrument existing physical buffer ownership sites below, including actual queue disposal. No download/decode algorithm change.
- `src/stems/flac-admission.ts`: expose the existing reservation facts through the collector and explicitly itemize the in-flight store and OPFS clone allowances from existing headroom. Keep admission sizing and the 8 MiB reservation unchanged.
- Extend existing `tests/flac-delivery-worker.test.ts`, `tests/store.test.ts`, `tests/session.test.ts`, and `tests/public-types.test.ts`, plus the existing exact reservation assertion in `tests/native-flac-foundation.test.ts`, only where their existing fixtures exercise the corresponding contract. README documents owned main-realm bytes versus fixed reservations. No pool, Worker, codec, storage protocol, SDK, Rust, generated artifact, or app implementation change in this first slice.

## Ownership transitions that must be implemented

| Owner/site | Acquire/count | Release/decrement |
| --- | --- | --- |
| `flac-delivery.ts`, `readExactFlacRange` | The actual `new Uint8Array(expectedBytes)` after response validation, once per physical attempt; increment delivered bytes. | Failed/retried/aborted attempts release in their own finalizer. Successful range ownership follows the result to the resolver; do not finalize it merely because the Effect succeeded. |
| Resolver probe/header ranges | Keep their allocation counted while retained for parsing. | End the actual lexical/reference lifetime after STREAMINFO/header consumption; the current `probe` local spans async preparation, so scope it down or account through its last retained reference. |
| Resolver `handleCredit` audio range | Continue counting the returned exact-range buffer. | After `FlacInputSlotProducer.publish` has copied into the fixed SAB; also on cancellation, stopped-result discard, and publish failure. Clear references at that boundary. |
| A stem's delivered ranges | `containers` increments when that stem first owns a live range buffer. | Decrement when its last owned range goes away. This is distinct stems with resident container bytes, not number of chunks or lifetime workers. Track only small per-resolve numeric state. |
| Resolver `onMessage` PCM | Count the received backing ArrayBuffer when accepted into `blocks`. Keep the same ownership token through `blocks.shift()` and `enqueue(new Uint8Array(block))`. | Handed-off blocks release in the store after write settles. Queued blocks release when actually removed/dropped on failure/cancel. Validate/discard excess or stale arrivals without leaving retained queue references. |
| Store `#ingest` | Reader result takes over the already-counted backing buffer; no second decoded increment for the Uint8Array view. | Per-read `finally` after the awaited `writer.write` deadline settles, including validation/hash/write failure. Do not decrement at read, enqueue, progress, or Worker completion. Existing cancellation then drops any remaining queued blocks. |
| Store `#ensure` admission | Mark this stem active on entry to its existing admitted verification callback (`admission.run`), after grant, not while waiting for a lock/slot. Every default FLAC stem already traverses this callback, including cold misses. | End in `#ensure`'s finally, after verification or cold ingest and its cleanup settle. Keep one per-stem marker through a miss followed by decode, avoiding double count. This preserves “admitted and not finished,” including a trailing write after the physical decode worker releases its slot. |

The existing store's `runBounded` width is the same admission limit, so active stems remain bounded even while a physical worker has completed and its final write is pending. Report this open's activity, not a shared admission object's global active count. No changes to admission scheduling or lease lifetime are required. Waiting cancellation before first grant does not increment active.

Current resolver cancellation/failure leaves `blocks` references in its closure. Implement actual queued-buffer disposal as part of these ownership boundaries, not merely counter zeroing. Already handed-off chunks remain counted until store settlement. Never clear all live counters centrally when the session promise rejects: each owner must release; peaks survive. A cancelled stream retained by a caller must not retain its discarded PCM queue solely because accounting was added.

## Static facts and limits

Actual package libFLAC linear memory is **2,097,152 bytes**, not the old app decoder's historical reservation. Input SAB is 262,144 bytes plus 16 control bytes. Exact range maximum is 262,144 bytes. Maximum canonical output is 393,216 bytes; there are two output credits. Existing fixed component sum is 3,411,984 bytes within each 8,388,608-byte slot.

Returning a credit when a chunk is enqueued allows **two queued output blocks plus one awaiting a store write**. Add an explicit 393,216-byte in-flight allowance to the existing two-credit component. `OpfsStorageBackend` posts writes without transferring the source buffer, so reserve another 393,216 bytes for the bounded worker-side structured clone. These two additions make the named component sum **4,198,416 bytes**, leaving **4,190,192 bytes** of the existing slot envelope. These are ingest PCM allowances; small index/control writes and opaque browser/network overhead remain identified headroom, not measured allocations. A transport response chunk's size/internal buffering is not proven by the requested HTTP range, so do not claim an exact bound for it.

The envelope already includes the maxima for dynamically counted ranges/decoded buffers. Do not add the live snapshot a second time to that envelope. Do not add transient ingest slots to cell 10's steady-state playing budget: decoder workers finish before ready. Shared SAB, libFLAC memory, browser fetch/Blob internals, GC timing, and OPFS clone memory are not main-realm live counters. Other custom storage backends have unknown additional-copy residency.

## Minimum evidence and cell 10 discriminator

1. Extend the existing two-credit/slow-consumer fixture with a deferred store write. Assert exact received byte counts, two queued plus one in-flight when those buffers actually exist, no decrement on enqueue, and release after write settles. Exercise cancellation with both queued and handed-off blocks, write rejection, and physical range retry cleanup using existing fixtures. Assert current values drain and peaks persist without inspecting retained PCM from the collector.
2. One existing session fixture covers a collector readable before open settles, distinct collectors for independent opens, real selected limit, warm-cache active lifetime, cancellation before admission, and post-failure peaks. Public types keep snapshots immutable; unsupported custom paths are null. Consolidate cases into existing fixtures, not a new harness or matrix.
3. Focused tests plus typecheck; pause for root's exact-path checkpoint. Then normal adapter check and existing packed public-consumer gate. App adoption reruns existing memory cell 10 and its existing browser retained-memory collection; no new browser matrix or ceiling change.

Cell 10 currently uses the `mix-l` largest canonical stem, **12,288,000 bytes**, and a decoded peak ceiling of **768,000 bytes** (1/16). A retained whole canonical stem therefore remains decisively red with honest queue-plus-write counters. Its separate heap-budget self-check (`budget < playing.bytes + largestCanonicalBytes`) must remain intact. Keep the admission ceiling of four and existing container/decoded ceilings; do not absorb ingest reservations into the playing budget to make that self-check pass.

There is an explicit runtime unknown: the protocol maximum for two 384 KiB blocks is already 786,432 bytes, above this fixture's 768,000-byte ceiling, and the store can hold a third. Protocol maxima are not observed fixture block sizes. This brief cannot certify that the real fixture passes without running it after integration. Preserve the gate and inspect the actual existing fixture result; do not widen it or claim static maxima prove a PASS. The existing delivered ceiling (two whole compressed stems per admitted slot) is not itself a discriminator for retaining one whole container. The decoded live peak and independent origin-owned heap checks are the meaningful whole-PCM-stem discriminators; preserve both and report their distinct claims.

This closes only per-open ingest ownership observability. Allocator export telemetry, worker heartbeats, profiling, metadata registries, progress-as-memory, protocol changes, and additional matrices remain out of scope.

Matching issue: misofm/engine-web-adapter#32.


## Attempt 1 implementation and evidence

Astra medium implemented the frozen ownership slice; root source checkpoint
`92a5fdb` contains the collector, session/store threading, physical range and
PCM ownership sites, and focused tests. Root approved updating the existing
reservation assertion in `tests/native-flac-foundation.test.ts` because the
specified in-flight and OPFS clone allowances replace its old component list
and headroom assertion. No admission envelope, app memory ceiling, Worker
protocol, allocator telemetry, backend, or generated SDK artifact changed.

The collector binds before asynchronous session boot. Only registered package
FLAC producers paired with the package store initialize it; the expectation
wrapper preserves that registration. A per-open producer binding retains the
existing shared pool/admission, without sharing counters between opens.
Mutable numeric state and decoded ownership live in WeakMaps; snapshots expose
no retained buffer. Each logical two-pass `#ensure` acquires its active marker
at the first admitted verification callback and releases it once in its final
cleanup. Quota reclamation and lock ordering are unchanged.

Physical range attempt finalizers release failed/retried allocations; successful
ranges retain ownership through scoped parsing or the input-slot copy. PCM
queue disposal removes actual references. The same decoded backing-buffer
ownership follows the view into the store and releases in the per-read finally
after the awaited write deadline settles. Unconsumed streams are cancelled on
store failure so queued ownership drains, including when the physical Worker
already completed. Peaks are never cleared centrally on session rejection.

Validation in `/private/tmp/miso-dx-adapter-app-ready`:

- `npm run typecheck` and `./node_modules/.bin/tsc -p tsconfig.test.json`: PASS.
- Existing store/session/delivery/public-types/native-foundation focused files:
  **82 PASS**, `/private/tmp/dx32-focused.log`. The extended two-credit fixture
  observes exactly three received fixture bytes: two queued buffers plus one
  awaiting a deferred store write. It observes active=1 after the physical
  Worker releases its slot, then live counters drain with peaks retained on
  success, cancellation, and write rejection. The physical retry fixture
  observes deliveredPeakBytes=42 rather than retaining failed or parsed ranges.
  Session evidence covers warm verification while open is pending, independent
  collectors and limits, cancellation before admission, known empty-session
  zeroes, unknown custom paths, and refusal of collector reuse. Public snapshot
  methods, fields, and reservation components are readonly.
- `npm run check` at `92a5fdb`: PASS, including format/type/source policy,
  decoder audit, all **145 tests**, and the existing fresh-consumer package
  validation. Log: `/private/tmp/dx32-check.log`.
- Dependencies were copied into this checkout and populated with the exact
  reviewed SDK #434 archive named above; its SHA256 matched
  `5694c21f1e4eb99f6366d7bcc0330f0af06744768810edc3cc6e0e186df09488`.
  No SDK rebuild, package metadata edit, or registry publication occurred.

The configured component sum is 4,198,416 bytes and headroom is 4,190,192 bytes
inside the unchanged 8,388,608-byte slot. These are reservations, not observed
live allocations. Actual app fixture peaks, memory cell 10, and the separate
origin-owned heap discriminator remain app #101 integration evidence; this
adapter gate does not certify their PASS or alter their ceilings.

Root committed the attempt 1 README/spec evidence at `c3b99a4`. Its dedicated
independent review returned the bounded failure recorded below.


## Attempt 2: range ownership across the outer Promise handoff

Dedicated independent Astra medium review of `c3b99a4` returned **FAIL**, one
P2: synchronous cancellation from the existing range-completion progress
callback could interrupt the outer Effect operation after its physical attempt
had marked ownership transferred. The resolver received no result to release,
leaving deliveredBytes=42 and containers=1 after the package store rejected.
The first report remains `/private/tmp/dx-32-astra-medium-review.md`; its
reproducers are `/private/tmp/dx32-review-range-cancel.mjs` and
`/private/tmp/dx32-review-store-cancel.mjs`. No other blocker was identified.

Root checkpoint `973b38d` contains the bounded correction in
`src/stems/flac-delivery.ts` and the existing delivery test file. A produced
physical result remains owned by delivery until successful outer Promise
handoff. Outer failure/interruption releases the unhanded result. Failed
physical attempts retain their own finalizers; successful resolver ownership,
retry behavior and peaks remain intact. No central counter reset or other
source scope was added.

The focused regression cancels synchronously from `probing` progress through
the public package store and collector. It observes 42 live delivered bytes in
the callback, then zero delivered bytes, containers and active operations after
`stem.cancelled`, retaining peaks of 42 bytes, one container and one active
operation. It also verifies no initialize/ready acknowledgment or final/staging
file, and termination of the physical Worker.

Validation at `973b38d`:

- `npm run typecheck` and `./node_modules/.bin/tsc -p tsconfig.test.json`: PASS.
- Existing five focused files: **83/83 PASS**;
  `/private/tmp/dx32-attempt2-focused.log`.
- `npm run check`: PASS, including format/type/source policy, decoder audit,
  all **146 tests**, and fresh-consumer package validation (154 files,
  136245 bytes). Log: `/private/tmp/dx32-attempt2-check.log`.

Attempt 1's FAIL is retained. This final spec evidence awaits root checkpoint
and the same reviewer's bounded correction recheck; attempt 2 does not yet
claim independent approval. App cell 10 and its existing ceilings remain
unchanged and require downstream integration evidence.
