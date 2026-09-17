# @misofm/engine-web-adapter

Headless, framework-neutral browser session hosting for
`@misofm/engine@0.4.2`. Version 0.5 identifies canonical PCM with BLAKE3-256 and streams standards-compliant native FLAC
through bounded HTTP ranges and a one-stem universal `@misofm/codec@0.1.1`
Wasm Worker, verifies
canonical PCM into OPFS, then feeds the Engine through bounded shared-memory
rings. URL, authentication, and request mapping remain caller-owned.

## Install

```sh
npm install @misofm/engine-web-adapter@0.5.12 @misofm/engine@0.4.2
```

The package is ESM-only and remains pinned to exactly Engine `0.4.2` and
`@misofm/codec` `0.1.1`. The codec currently supports Node `>=22.23.2 <23`
and Bun `>=1.4.2 <1.5`; browser consumers use the bundled public codec asset.
The integration uses the published Engine 0.4.2 archive
from commit `13351fe71c7d4594e5ff6ea170c2839514cb243e`, SHA256
`8f28af09f1fb6f31295e82ba9cb97350cb2f56be21e1db1c5bb028d9e128880d`.
This release adds indexed full-response stem acquisition: active FLAC chunks are
decoded once into verified sparse PCM, and timeline gaps are generated as zeroes
when the Engine reads them. The existing native-FLAC path remains available.

## Open a native-FLAC session

```ts
import { openEngineWebSession } from "@misofm/engine-web-adapter"

const engine = await openEngineWebSession({
  document: sessionBuilder,
  flac: {
    // Called for every physical range attempt. Return a URL or a bodyless GET
    // Request carrying caller-owned credentials and authentication headers.
    locate(identity, attempt) {
      return new Request(myStemUrl(identity), {
        headers: { Authorization: freshTokenFor(attempt) },
        credentials: "include",
      })
    },
  },
})

// Call inside the playback user gesture; resume() starts synchronously.
await engine.play()
await engine.seekFrames(48_000)
await engine.pause()

// A suspended seek prepares the consumer and waits for target-generation PCM.
// This also works before the first play. After it resolves, call play() from
// a playback gesture; play rejects session.busy while any seek is pending.
await engine.seekFrames(24_000)
// A running seek suspends during preparation, then restores playback once ready.
// Failed preparation or a context transition closes the session; open anew to retry.

// One strict SDK transaction. Inspect the exact whole-batch admission report.
const kick = engine.console.edit.track("kick")
const report = await engine.console.submit(kick.faderDb(-6), kick.mute(false))
if (!report.ok) console.warn(report.reasonName, report.rejectedIndex)

// A subscription, keyed by track id. The returned function unsubscribes; the
// lease is taken on the first listener and released after the last.
const stopMeters = await engine.meters((update) => {
  for (const [trackId, meter] of update.tracks) draw(trackId, meter.peak)
  draw("master", update.master.peak)
})

stopMeters()
await engine.close()
```

That is the whole documented path. `leaseId` is generated per open, the stem
declarations are derived from the session document that already states them,
and the Engine's published default console words are attached, so a first
console command and a first meter subscription both work immediately and in
either order. Everything remains overridable: pass `sources` to assert the
declarations a second time, `leaseId` to name the store pin, and `policy` to
set boot words -- an explicit `policy.console` size wins field by field over the
default.

For a playback-only session, opt out with `console: false`. Accessing
`console`, `meters` or `telemetry` on one then reports `console.not_attached`
with a remedy, rather than letting an ordinary command look like an unknown
command kind.

The adapter overwrites `Range`, owns the operation signal, and otherwise
preserves applicable caller `Request` policy on the platform `fetch`. Pass
`flac.fetch` to supply a different one; no Effect type appears in the public
API. The package never derives a filename, embeds a host, or owns credentials.

For already-decoded canonical PCM, explicitly select the advanced escape hatch:

```ts
import type { StemResolver } from "@misofm/engine-web-adapter/stems"

const resolver: StemResolver = {
  async resolve(identity, { signal } = {}) {
    return { stream: await myCanonicalPcmStream(identity, signal) }
  },
}

await openEngineWebSession({ document: sessionBuilder, resolver })
```

Exactly one of `flac` or `resolver` is required. TypeScript rejects both/neither,
and JavaScript receives `session.input_path`.

## Failures

Every rejection a consumer can observe is `EngineWebAdapterError`. It carries a
stable `code`, the `phase` the adapter was in, a nonempty `remedy`, whether the
identical operation is `transient`, frozen `details`, and the underlying
`cause`. No Engine host object, Worker message or Effect value reaches a caller
through it.

Console submission returns the SDK `CommandReport` unchanged. A semantic
refusal has `ok: false`, `admitted: 0`, and its original reason, rejected index,
and application sample; transport failures reject. Request identifiers are
allocated by the raw host, so direct `session.host` calls no longer collide with
console, meter, or telemetry operations. Prefer the typed adapter surfaces when
possible.

## Use the SDK Engine directly

`session.engine` is a borrowed view of the same SDK Engine that owns the
session's host, console, measurements, response queries, spectrum queries, and
managed observation subscriptions. It is object-identical to the Engine used
for playback; the adapter only retains `session.close()` as the aggregate close
operation. Do not call `session.engine.close()` or start new work after closing
the session.

```ts
const sdk = session.engine
const stopMeters = await sdk.subscribeMeters((update) => {
  for (const [trackId, meter] of update.tracks) draw(trackId, meter.peakLeft)
})
const response = await sdk.queryTrackResponse({
  trackId: "kick",
  grid: { kind: "linear", points: 256, minimumHz: 20, maximumHz: 20_000 },
})
const spectrum = await sdk.querySpectrum({
  target: { kind: "output", outputId: "master" },
})
stopMeters()
await session.close()
```

Pass SDK `spectrum`, `spectrumCollection`, and observation, response, or
spectrum subscription limits in the open options when those capabilities are
needed. The values are snapshotted before source preparation begins and are
forwarded to this same Engine. The older `session.meters` and
`session.telemetry` methods remain deprecated compatibility paths; their meter
updates add only the legacy `peak` field while retaining the SDK generation,
validity, loss, span, and nullable master gain-reduction fields.

## Deployment requirements

Serve over HTTPS (or localhost) with cross-origin isolation enabled:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The browser must provide OPFS, Web Locks, module Workers, AudioWorklet,
WebAssembly SIMD128, and WebAssembly for a cold FLAC open. Canonical PCM is
written to OPFS through `FileSystemFileHandle.createSyncAccessHandle()` in a
package-owned Worker, never `createWritable()`. The published codec module is
the only decoder path. The server must expose exact `Content-Range` and `Content-Length`,
return status 206, avoid `Content-Encoding`, and keep total size and any visible
ETag stable across attempts.

Supplying an existing `store` selects caller-owned persistence for either the
dense or sparse session entry point. The adapter still checks the shared Engine
runtime requirements, while the store owns its own persistence and locking
requirements. Omitting `store` selects the default OPFS path and runs the typed
OPFS and Web Locks preflight before scratch boot or source resolution begins.

### Safari floor

The **decoder** is universal: Chromium, macOS Safari, and mobile Safari run the
same published codec Wasm module and the same error path, with no platform codec
fallback, from Safari 15.

The **session** floor is higher, and it is the one that decides whether
`openEngineWebSession` succeeds. It is set by the strictest capability gate,
not by the decoder:

| Requirement | Safari / iOS Safari |
| --- | --- |
| OPFS write (`createSyncAccessHandle`) | 15.2 |
| `SharedArrayBuffer`, cross-origin isolation | 15.2 |
| Web Locks | 15.4 |
| WebAssembly SIMD128 (Engine `simd128` backend) | **16.4** |

**A session therefore requires Safari 16.4 or newer**, on macOS and iOS.
Chromium requires 102 or newer and Firefox 111 or newer, both for the same
OPFS write method. Any browser that cannot write to OPFS is refused at the
capability boundary with `EngineWebAdapterError` code `capability.opfs`, whose
`details.missing` and `details.remedy` name the missing method and the versions
that provide it; it is never an untyped `TypeError` from inside the store.

Package-relative asset URLs and overrides are exported from
`@misofm/engine-web-adapter/assets`. They cover the scratch Worker, FLAC Worker,
codec Wasm, PCM pump Worker, feed worklet, and Engine assets. The scratch and
feed compatibility URLs alias the SDK's packaged assets. The adapter compiles
shape once through the SDK before delivery, then injects that shape when it opens
the SDK engine after every stem is verified and stored. Context/host boot and PCM
ring/feed implementation belong to the SDK; delivery, leases and pump scheduling
remain here. Explicit factory and asset overrides retain precedence.
SDK scratch start/load errors map to `capability.module_worker`; its shared
`scratch-deadline` operation maps to `session.open` for either handshake or request
expiry, retaining the typed SDK cause. Feed errors map by their SDK operation.
Common `assets.flacWorkerUrl` and `assets.createWorker` overrides apply to the
high-level FLAC path. A nested `flac.assets` field overrides matching common
asset fields without discarding the other common fields; the low-level
`flac.createWorker` hook has highest precedence when supplied.

## Bounds and integrity

- Exact HTTP range buffers and the sole compressed input slot are each at most 256 KiB.
- Canonical output blocks are at most 384 KiB.
- Each Worker has one synchronous decoder call and two decoded-output credits.
- Each admitted FLAC slot has a conservative 8 MiB ingest reservation.
- The decoder memory is fixed at 2 MiB; package-owned buffers are independent of
  compressed-stem duration. Browser network, Worker, and compiled-code memory is
  opaque and excluded.
- Legacy defaults share one FIFO width. Opt-in processing separates decode/hash,
  physical FLAC delivery, and warm-cache verification.
- PCM is not leased or pumped until exact byte count and incremental BLAKE3-256
  verification succeeds and the staging file is promoted.
- Indexed sparse chunk `flacSha256` and `pcmSha256` fields remain SHA-256
  transport checks; the complete reconstructed stem identity is BLAKE3-256.
- Canonical PCM is headerless interleaved little-endian PCM16 or PCM24 at
  44.1, 48, 88.2, or 96 kHz; there is no implicit sample-rate conversion.

`close()` is idempotent. The `./stems` entry exports what a caller can supply
or replace: the canonical-PCM resolver seam, the verified store and its storage
backends, the FLAC resolver, the pump, and the ring control words a `createPump`
override reads. The existing ring control exports are SDK re-exports. Digests,
admission width, the decoder pool and adapter Worker protocols remain internal;
PCM ring arithmetic is owned by the SDK.

## Verified source progress

Sparse opens forward `onProgress(progress)` through the response, resolver, and
verified store. `probing` and `fetching` use `byteKind: "flac"`; their cumulative
`bytes` count is the actual container bytes consumed from one full sparse GET,
including its header and manifest. `decoding` uses `byteKind: "pcm"` and counts
packed active PCM cumulatively across every chunk against the complete canonical
PCM length. Cold `ingesting` and warm `verifying` also use canonical PCM bytes;
both include implicit zero gaps and advance only after the corresponding hash
work (and, for ingest, staging writes) succeeds. Counters are finite,
nonnegative, safe integers, monotonic per identity/stage/kind, and never exceed
their totals. Fast byte notifications are coalesced per operation while stage
starts and terminal boundaries remain observable.

`source-ready` means that complete canonical shape, byte count, digest, and
marker ownership have passed. It is emitted once for each declared source ID,
so aliases receive separate readiness events even though they share one verified
descriptor. The aggregate `ready` event follows the all-declaration barrier and
cancellation check; normal engine `prefilling` follows source preparation and
still completes before the session is returned. A progress callback is
observation only: synchronous throws and rejected thenables are contained, and
cannot turn valid content into `stem.corrupt` or mask an operation cleanup
failure. Failed verification or cancellation emits no readiness proof for that
source or aggregate open.

## Per-open ingest diagnostics

Create a collector before opening and pass it as `ingestDiagnostics`:

```ts
import { createIngestDiagnostics, openEngineWebSession } from "@misofm/engine-web-adapter";

const ingestDiagnostics = createIngestDiagnostics();
const opening = openEngineWebSession({ document, flac: { locate }, ingestDiagnostics });
const duringOpen = ingestDiagnostics.snapshot();
const session = await opening;
const afterOpen = ingestDiagnostics.snapshot();
```

The collector belongs to one open invocation, including a failed invocation;
reuse rejects. Every snapshot is a fresh readonly value. Live values drain as
their owners finish, while peaks remain readable after ready, cancellation, or
failure. Before the participating pipeline initializes, `residency`,
`reservation`, and `processing` are `null`. Arbitrary injected producers or stores retain that
unknown result. Package FLAC resolvers paired with `VerifiedStemStore` or
`OpfsStemStore` participate, including injected stores using an existing folder.
An empty package FLAC session initializes known zero counters and its limit.

`residency` contains `limit`, `deliveredBytes`, `deliveredPeakBytes`,
`decodedBytes`, `decodedPeakBytes`, `containers`, `containersPeak`, `active`,
and `activePeak`. Delivered bytes count actual exact-range allocations through
parsing or copying into the input SAB, including physical retry attempts.
Containers count distinct stems currently retaining those ranges. Decoded
backing buffers stay counted through queueing and enqueue until the awaited
store write settles; discarded queued buffers are released on cancellation or
failure. Active counts admitted, unfinished stem operations, including warm
verification and trailing writes after a decode Worker finishes.

`reservation` reports fixed `components`, their `fixedBufferBytes` sum,
`slotBytes`, `headroomBytes`, and selected `limit`. Each 8,388,608-byte slot
includes 4,984,848 named bytes: the exact range, input SAB, one reusable
262,144-byte public-codec input bridge, fixed 2,097,152-byte codec memory,
two output credits, one 393,216-byte codec-owned pending PCM event, one
393,216-byte in-flight store write, one 393,216-byte OPFS write-clone
allowance, two fixed 64 KiB SHA Wasm realm reservations, and metadata/control.
The remaining 3,403,760 bytes are headroom.
This reservation is a policy envelope, not a measurement of total
browser/process memory.

`processing` is also `null` before initialization or for an unknown producer.
It reports `downloadLimit`, `workerLimit`, and `verificationLimit`, plus numeric
`downloads`, `downloadQueue`, `workers`, `verification`, and `writes` counters
(`active`, `peak`, `count`, aggregate completed `milliseconds`). `workers` counts
physical decoder lifetimes; it does not imply simultaneous CPU execution.
`runnablePeak` measures overlapping runnable decode/hash sections with shared
atomic worker ownership, excluding input and output-credit waits. Termination
clears the retired worker's ownership. Legacy widths above 32 do not collect
runnable overlap; the opt-in policy is capped at 16.

`decodeMs` is summed elapsed time inside decoder calls excluding explicit input
waits; it is not operating-system CPU time. `hashMs`, `inputWaitMs`,
`outputWaitMs`, and `blocks` are worker-reported completed-block totals (a failed
block may contribute no final timing). Queued and active I/O timing is reported
separately. These counters are bounded numbers, with no retained event history.

## Adaptive processing

Use the public processing policy to qualify larger decode/hash concurrency:

```ts
const session = await openEngineWebSession({
  document,
  flac: {
    locate,
    processing: { maximumWorkers: 8 },
  },
});
```

`maximumWorkers` accepts 1–16 and defaults to 16 when `processing` is supplied.
The actual processing width is the minimum of that ceiling, logical CPU count
minus one (at least one), and the memory budget divided by 8 MiB per worker.
The automatic processing budget is 16 MiB without a valid device-memory hint;
otherwise it is device-memory GiB ×16 MiB, clamped to 8–128 MiB. Consequently an
8 GiB hint and at least 17 logical CPUs can admit 16; missing CPU hints still
admit only one. `processing.memoryBudgetBytes` explicitly replaces the memory
budget, while the CPU and 16-worker limits still apply. Browser hints can be
coarse or absent. Benchmark the policy on target devices before choosing a cap.

Physical HTTP admission retains the legacy device/memory-derived width and is
capped at four when processing is enabled. The legacy top-level
`maximumWorkers` and `memoryBudgetBytes` do not raise that four-request ceiling.
Every probe, metadata range, audio range and retry holds one permit through
body consumption or cancellation; no permit is held while awaiting decoding
or storage. The cap belongs to a resolver/session, not the entire browser.
A custom `fetch` must honor its abort signal and serialize any internal
fallback, fully disposing the previous response before starting another
physical request. An indeterminate fetch/cancellation cleanup closes that
resolver's download admission without retries or reuse of uncertain capacity.

Warm verification keeps the legacy width, independently capped at four;
`processing.maximumVerifications` can reduce it to 1–4. Cached sources perform
no FLAC HTTP or decode/hash-worker work. The package store uses the processing
width for cold scheduling, including when paired directly with
`createFlacStemResolver`. Omitting `processing` preserves legacy sizing and
main-realm hashing. A supplied shared `admission` can reduce an opt-in processing
width, but cannot exceed its CPU/memory policy.

With processing enabled, the immutable package decoder Worker hashes the exact
canonical bytes before transferring them. Only its private result handoff can
replace store hashing; byte/frame counts, expected digest, EOF, successful
writes and promotion remain required. Custom worker factories or decoder/worker
asset overrides retain store hashing. Options and asset URLs are snapshotted
before lazy worker construction, so later caller mutation cannot change digest
provenance. Generic PCM resolvers always retain store hashing and read deadlines.

Waiting for a download/worker permit does not consume the active I/O/decode
no-progress deadline. The one OPFS write worker reports when a request starts;
healthy progress refreshes queued requests while each started operation retains
its own timeout. The standard OPFS backend owns those write deadlines; a tighter
explicit store deadline remains a ceiling. Generic storage retains store
watchdogs. Storage and two-output-credit backpressure remain bounded; additional
decoders may wait for the shared writer, so a higher cap need not be faster.

These live counters measure owned main-realm buffers, not allocator or total
heap residency. Shared buffers, decoder memory, browser fetch/Blob internals,
GC timing, and the OPFS worker-side clone are not live counters; custom storage
backends may retain additional unknown copies. An HTTP response chunk's internal
buffering is not bounded by the requested range. The reservation already
includes the dynamically counted buffers: do not add the live snapshot to it
again, or add transient ingest slots to the steady-state playing budget.

## Shared cache ownership

`OpfsStemStore` defaults to the algorithm-qualified
`miso-engine-web-stems-blake3-v1` folder and accepts `folderName` for an
application-owned namespace. `store.read(identity)` returns its stored Blob;
`await store.setOfflinePin(identity, pinId, true)` adds durable `offline:<pinId>`
intent, and `false` removes only that pin. Repeating the same operation is a
no-op. Adding a missing identity rejects with `stem.not_found`; removing a
missing pin does nothing. Persistence failures reject.

Each `openSession` owns a unique session pin even when caller `leaseId` values
repeat. Each successfully verified source is pinned before its stem lock is
released, including while the rest of a multi-source open is unfinished. Failed
opens remove only their own pins. Closing one lease leaves every other session
and offline pin intact.
Failed close persistence retains ownership and can be retried. Pinning never
skips byte-count or digest verification, and successful repair retains pins.

For cache overlap, mutations take the prior adapter's global resource lock
first (`miso:engine-web:v1:index` or `:stem:<digest>`), then the historical
folder resource lock (`miso:stem-store:v1:<folder>:index` or
`:ingest:<digest>`). Ingest may acquire index locks; index work never acquires
ingest locks. Each lease also holds its historical folder-qualified
`:pin:<session-pin>` lifetime lock so existing app recovery recognizes it.
Recovery preserves ambiguous session pins and offline pins; it leaves the
historical `staging/` directory alone. Explicit unsupported index versions
refuse with `stem.corrupt` before recovery changes any file.

When a known storage estimate cannot fit a cold source, the store reclaims
unpinned indexed entries by oldest `lastUsedAt`, breaking ties by identity,
until the estimate shows enough space. It rechecks ownership under the victim's
stem and index locks before deletion. Live leases, unfinished opens, offline
pins, and ambiguous session pins remain protected. Reclamation never waits for
a victim while holding the ingest stem lock. Insufficient reclaimable space
rejects with `stem.quota`; unavailable estimates retain normal write behavior,
and actual storage quota failures remain typed.

## Verification

`npm run test:browser` builds a fresh consumer from the packed tarball and runs
the deterministic local FLAC fixture in Chromium. `npm run test:browser:live`
is the explicit networked acceptance profile: it binds the configured CORS
origin at `http://127.0.0.1:5173`, performs a cold packed-package ingest, and
then proves that a warm reopen uses no additional locator, Worker, or network
work. The live profile is intentionally not part of `npm run check`.

`npm run test:browser:opfs` runs the packed OPFS write path in **both** Chromium
and WebKit. It proves a cold ingest verifies into OPFS, that the same ingest
still verifies with `FileSystemFileHandle.prototype.createWritable` deleted (the
Safari 17/18 shape), that the store never calls `createWritable`, and that a
browser without OPFS handles is refused with a typed `capability.opfs` error
carrying a remedy. It needs a Chromium binary plus
`node node_modules/playwright-core/cli.js install webkit`, so like the browser
gates above it is not part of `npm run check`.

## Source spectrum and buffer diagnostics

`session.observeSource(sourceId)` returns an independent read-only source observer with
`sampleRateHz`, `channels`, `pull(callback, maximumChunks?)` and `close()`. The callback receives
the SDK's `PcmSourceChunk`: metadata and planar scratch are borrowed until return, and `frames`
bounds valid samples. Keep FFT and display work in the app. Pull is bounded (default at most 32
chunks, explicit integer 1–32), skips missed/reused data and never consumes audio. Close the
observer when the focused source view deactivates; session close also closes every observer.
Unknown IDs refuse with `stem.not_found` and sourceId details; calls on closed sessions refuse
with `session.closed`. A previously closed observer's pull returns zero.

`session.feedDiagnostics()` returns source-ID keyed SDK counter records and buffer allocations:
actual feed SAB `ringBytes`, host `engineMemoryBytes`, and `observationBytes` for reusable scratch
owned by one counter observer per source plus each open source observer. Counter observers are
reused across snapshots. `allocation.pump` contains `windowFrames` and the Worker-reported
`maximumWindowBytes`; a custom pump without allocation facts returns `null`. The default pump
uses up to two 8192-frame canonical windows per source: the current window and bounded local
read-ahead. At most four physical Blob reads run together, including obsolete reads that have
not settled after a seek. Custom window sizes round down to a render-quantum multiple for I/O;
the allocation bound conservatively retains the requested size. Worker ticks contain at most
eight fair passes and yield between ticks so seek and close do not wait behind storage I/O.
These are bounded buffer facts, not JS-object/browser-heap measurements or an atomic multiword
snapshot. The app owns diagnostic aggregation; opening still verifies/stores all PCM and prefills
before ready. Initial opening and seek completion require a contiguous full-generation runway
across every source's 64 shared-ring slots, or that source's exact shorter remaining tail. At
48 kHz with 128-frame quanta this is about 171 ms. Seek preparation remains suspended, including
running seeks; the adapter restores running state only after every source passes that gate.
The generic ring proof is delegated to the SDK's `waitForPcmRunway`; source preparation, feed seek
preparation, refill and context lifecycle remain owned by the adapter.

Pass `onError(error)` to observe a terminal playback-worker failure after opening. The adapter
marks the session closed immediately, interrupts pending lifecycle calls, and completes cleanup
before notifying once with `session.playback` and the original `cause`. Opening failures reject
`openEngineWebSession` instead. Explicit close/abort and ordinary console backpressure do not
invoke this callback. Keep the callback scoped to the application's current session generation
so a replaced session cannot overwrite newer UI state. Callback exceptions do not escape cleanup.
Advanced custom pumps may forward the optional `failure` promise from `PcmPumpWorkerClient`;
it fulfills once with an unexpected terminal cause and never rejects. Wrappers that omit that
optional capability cannot provide automatic runtime-failure propagation.
