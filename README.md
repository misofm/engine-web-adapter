# @misofm/engine-web-adapter

Headless, framework-neutral browser session hosting for
`@misofm/engine@0.1.0`. Version 0.2 streams standards-compliant native FLAC
through bounded HTTP ranges and a one-stem universal libFLAC Wasm Worker, verifies
canonical PCM into OPFS, then feeds the Engine through bounded shared-memory
rings. URL, authentication, and request mapping remain caller-owned.

## Install

```sh
npm install @misofm/engine-web-adapter@0.2.0 @misofm/engine@0.1.0
```

The package is ESM-only and remains pinned to exactly Engine `0.1.0`.
The current integration was qualified with the reviewed archive from Engine
`79900f3f1d296b2b9af215e2a87acf1628fadb06`, SHA256
`28492361d76a6a0815302d756c98003b202155691ab9011c7884fac377deb587`.
This is archive provenance; registry publication is a separate delivery step.

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

## Deployment requirements

Serve over HTTPS (or localhost) with cross-origin isolation enabled:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The browser must provide OPFS, Web Locks, module Workers, AudioWorklet,
WebAssembly SIMD128, and WebAssembly for a cold FLAC open. Canonical PCM is
written to OPFS through `FileSystemFileHandle.createSyncAccessHandle()` in a
package-owned Worker, never `createWritable()`. The package-owned
libFLAC module is the only decoder path. The server must expose exact `Content-Range` and `Content-Length`,
return status 206, avoid `Content-Encoding`, and keep total size and any visible
ETag stable across attempts.

### Safari floor

The **decoder** is universal: Chromium, macOS Safari, and mobile Safari run the
same libFLAC Wasm module and the same error path, with no platform codec
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
libFLAC Wasm, PCM pump Worker, feed worklet, and Engine assets. The scratch and
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
- Cold decode and warm OPFS verification share one FIFO admission width.
- PCM is not leased or pumped until exact byte count and incremental SHA-256
  verification succeeds and the staging file is promoted.
- Canonical PCM is headerless interleaved little-endian PCM16 or PCM24 at
  44.1, 48, 88.2, or 96 kHz; there is no implicit sample-rate conversion.

`close()` is idempotent. The `./stems` entry exports what a caller can supply
or replace: the canonical-PCM resolver seam, the verified store and its storage
backends, the FLAC resolver, the pump, and the ring control words a `createPump`
override reads. The existing ring control exports are SDK re-exports. Digests,
admission width, the decoder pool and adapter Worker protocols remain internal;
PCM ring arithmetic is owned by the SDK.

## Verified source progress

The package store emits `onProgress({ stage: "source-ready", identity, bytes })`
once per unique identity during each open, for cold ingest and warm verification.
`bytes` is the verified canonical PCM length. This event follows exact length and
SHA-256 verification and successful persistence of the opening's ownership pin.
It lets a caller mark that source complete while other sources are still loading;
duplicate source declarations sharing an identity do not duplicate the event.

`source-ready` does not make the session playable. The unchanged aggregate
`ready` event waits for every declaration, and the session still completes its
normal prefill before returning. Failed verification or pin persistence emits no
source proof. Cancellation from a progress callback rejects the open and releases
its ownership without aggregate readiness. If a later source fails, earlier
verified files can remain cached, but the failed opening releases its pins.

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
failure. Before the participating pipeline initializes, both `residency` and
`reservation` are `null`. Arbitrary injected producers or stores retain that
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
includes 4,198,416 named bytes: the exact range, input SAB, fixed 2,097,152-byte
libFLAC memory, two output credits, one 393,216-byte in-flight store write,
one 393,216-byte OPFS write-clone allowance, and metadata/control. The remaining
4,190,192 bytes are headroom. Admission sizing is unchanged.

These live counters measure owned main-realm buffers, not allocator or total
heap residency. Shared buffers, decoder memory, browser fetch/Blob internals,
GC timing, and the OPFS worker-side clone are not live counters; custom storage
backends may retain additional unknown copies. An HTTP response chunk's internal
buffering is not bounded by the requested range. The reservation already
includes the dynamically counted buffers: do not add the live snapshot to it
again, or add transient ingest slots to the steady-state playing budget.

## Shared cache ownership

`OpfsStemStore` accepts `folderName` so an application can continue using its
existing version-1 cache. `store.read(identity)` returns its stored Blob;
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
retains its exact requested window (4096 frames by default) and validates initialization bounds.
These are bounded buffer facts, not JS-object/browser-heap measurements or an atomic multiword
snapshot. The app owns diagnostic aggregation; opening still verifies/stores all PCM and prefills
before ready.
