# @misofm/engine-web-adapter

Headless, framework-neutral browser session hosting for
`@misofm/engine@0.1.0`. Version 0.2 streams CLI-prepared fixed-block FLAC
through bounded Effect HTTP ranges and a one-stem WebCodecs Worker, verifies
canonical PCM into OPFS, then feeds the Engine through bounded shared-memory
rings. URL, authentication, and request mapping remain caller-owned.

## Install

```sh
npm install @misofm/engine-web-adapter@0.2.0 @misofm/engine@0.1.0
```

The package is ESM-only and remains pinned to exactly Engine `0.1.0`.

## Open a dense-FLAC session

```ts
import { openEngineWebSession } from "@misofm/engine-web-adapter"

const engine = await openEngineWebSession({
  document: sessionBuilder,
  leaseId: crypto.randomUUID(),
  sources: declaredSources,
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
await engine.close()
```

The adapter overwrites `Range`, owns the operation signal, and otherwise
preserves applicable caller `Request` policy on its default
`FetchHttpClient.layer`. Callers may inject an Effect `HttpClient` or layer;
an injected client owns transport-specific policy beyond normalized GET URL
and headers. The package never derives a filename, embeds a host, or owns
credentials.

For already-decoded canonical PCM, explicitly select the advanced escape hatch:

```ts
import type { StemResolver } from "@misofm/engine-web-adapter/stems"

const resolver: StemResolver = {
  async resolve(identity, { signal } = {}) {
    return { stream: await myCanonicalPcmStream(identity, signal) }
  },
}

await openEngineWebSession({
  document: sessionBuilder,
  leaseId: crypto.randomUUID(),
  sources: declaredSources,
  resolver,
})
```

Exactly one of `flac` or `resolver` is required. TypeScript rejects both/neither,
and JavaScript receives `session.input_path`.

## Deployment requirements

Serve over HTTPS (or localhost) with cross-origin isolation enabled:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The browser must provide OPFS, Web Locks, module Workers, AudioWorklet,
WebAssembly SIMD128, and Worker-side WebCodecs FLAC for a cold FLAC open.
Unsupported FLAC fails with a typed capability error; there is no codec-Wasm
fallback. The server must expose exact `Content-Range` and `Content-Length`,
return status 206, avoid `Content-Encoding`, and keep total size and any visible
ETag stable across attempts.

Package-relative asset URLs and overrides are exported from
`@misofm/engine-web-adapter/assets`. They cover the scratch Worker, FLAC Worker,
PCM pump Worker, feed worklet, and Engine assets.
Common `assets.flacWorkerUrl` and `assets.createWorker` overrides apply to the
high-level FLAC path. A nested `flac.assets` field overrides matching common
asset fields without discarding the other common fields; the low-level
`flac.createWorker` hook has highest precedence when supplied.

## Bounds and integrity

- Delivery chunks are at most 256 KiB; compressed frames at most 524,320 bytes.
- Canonical output blocks are at most 384 KiB.
- Each Worker has four decoder submissions and two decoded-output credits.
- One active FLAC Worker reserves 8 MiB of package-owned memory.
- Conservatively accounted live buffers and exact typed dense seek tables total
  7,864,486 bytes per Worker; 524,122 bytes remain for bounded wrapper/bookkeeping
  overhead. Browser
  network and WebCodecs implementation memory is opaque and excluded.
- Cold decode and warm OPFS verification share one FIFO admission width.
- PCM is not leased or pumped until exact byte count and incremental SHA-256
  verification succeeds and the staging file is promoted.
- Canonical PCM is headerless interleaved little-endian PCM16 or PCM24 at
  44.1, 48, 88.2, or 96 kHz; there is no implicit sample-rate conversion.

`close()` is idempotent. The `./stems` entry exports the FLAC resolver,
admission, verified-store, lease, ring, and pump contracts for advanced use.

## Verification

`npm run test:browser` builds a fresh consumer from the packed tarball and runs
the deterministic local FLAC fixture in Chromium. `npm run test:browser:live`
is the explicit networked acceptance profile: it binds the configured CORS
origin at `http://127.0.0.1:5173`, performs a cold packed-package ingest, and
then proves that a warm reopen uses no additional locator, Worker, or network
work. The live profile is intentionally not part of `npm run check`.
