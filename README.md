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

// One transaction. A fader drag stages latest-wins, so what lands is the
// position the hand stopped at; engine backpressure never reaches the caller.
const kick = engine.console.edit.track("kick")
await engine.console.submit(kick.faderDb(-6), kick.mute(false))

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

Console refusals split along the line the Engine itself draws: flow-control
backpressure is absorbed and coalesced, and a semantic refusal -- an unknown
address, a malformed record -- rejects with `console.refused`, because it will
not succeed on retry.

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
libFLAC Wasm, PCM pump Worker, feed worklet, and Engine assets.
Common `assets.flacWorkerUrl` and `assets.createWorker` overrides apply to the
high-level FLAC path. A nested `flac.assets` field overrides matching common
asset fields without discarding the other common fields; the low-level
`flac.createWorker` hook has highest precedence when supplied.

## Bounds and integrity

- Delivery chunks and the sole compressed input slot are each 256 KiB.
- Canonical output blocks are at most 384 KiB.
- Each Worker has one synchronous decoder call and two decoded-output credits.
- One active FLAC Worker reserves 8 MiB of package-owned memory.
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
override reads. Ring arithmetic, digests, admission width, the decoder pool and
the Worker wire protocols are package-owned and are not exported.

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
