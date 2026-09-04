# @misofm/engine-web-adapter

Headless, framework-neutral browser session hosting for
`@misofm/engine@0.1.0`. The adapter verifies canonical PCM in origin-private
storage, streams it through bounded shared-memory rings, and exposes the
Engine semantic console. It contains no decoder, transport client, URL policy,
or user interface.

## Install

```sh
npm install @misofm/engine-web-adapter@0.1.0 @misofm/engine@0.1.0
```

The adapter release is bound to exactly Engine `0.1.0`. It is ESM-only and its
qualified browser target is Chromium.

## Open a session

```ts
import { openEngineWebSession } from "@misofm/engine-web-adapter"
import type { StemResolver } from "@misofm/engine-web-adapter/stems"

const resolver: StemResolver = {
  async resolve(identity, { signal } = {}) {
    // Transport and decoding belong to the caller. Return headerless,
    // interleaved little-endian 16-bit or 24-bit canonical PCM.
    return { stream: await myCanonicalPcmStream(identity, signal) }
  },
}

const engine = await openEngineWebSession({
  document: sessionBuilder,
  leaseId: crypto.randomUUID(),
  sources: declaredSources,
  resolver,
  onProgress(progress) {
    console.log(progress.stage, progress.bytes)
  },
})

// Call inside the playback user gesture. resume() is invoked synchronously.
await engine.play()
await engine.seekFrames(48_000)
await engine.pause()
await engine.close()
```

`close()` is idempotent. A v0.1 session is one-shot: close it and construct a
new instance to switch documents.

## Deployment requirements

Serve over HTTPS (or localhost) with cross-origin isolation enabled so
`SharedArrayBuffer` is available:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The browser must also provide OPFS, Web Locks, module Workers, AudioWorklet,
and WebAssembly SIMD128. Missing capabilities fail with a typed
`EngineWebAdapterError` before resolver or large-allocation work. The default
path loads and handshakes its scratch module Worker before opening OPFS or
calling the resolver, so a blocked Worker deployment fails early.

Bundlers resolve the package-relative Worker and worklet URLs exported from
`@misofm/engine-web-adapter/assets`. Deployments with a custom asset pipeline
may override each URL and the Worker factory through `options.assets`.

## PCM contract and limits

- Canonical PCM is headerless, interleaved, little-endian signed integer PCM.
- V0.1 accepts mono or stereo 16-bit and 24-bit sources.
- Session rates are the Engine launch rates: 44.1, 48, 88.2, and 96 kHz.
- There is no implicit sample-rate conversion.
- Memory is bounded by fixed MSB1 rings and configured per-source windows,
  independent of stem duration.
- Callers own decoding, authentication, retries, and transport addressing.
- Firefox, WebKit, and iOS are not qualified in v0.1.

The `./stems` entry exports the resolver, verified-store, lease, ring, and pump
contracts for testing and advanced deployment. Worker/worklet protocols remain
internal package assets.
