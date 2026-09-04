# Package a codec-neutral engine Web session adapter

## Objective

Ship `@misofm/engine-web-adapter` v0.1.0 as a headless,
framework-neutral browser adapter that opens an Engine session from canonical
PCM stem streams, verifies/caches them in OPFS, and feeds the AudioWorklet from
bounded shared-memory rings.

The package must not contain FLAC, WebCodecs, Effect, R2, fixed URLs, delivery
filename policy, React, or product UI. Callers own transport and decoding through
the generic `StemResolver` contract.

## Safe source baseline

- Stem-store and pump sources: `misofm/engine` commit
  `bd7f330a9773ce43bb077f0e6d5c8fc30fe9e27c`, matching the app's pinned
  vendor provenance.
- Browser feed/composition lessons: `misofm/app` commit
  `7485693e9bbcf2f65a91a4e5950e22d678d99062`.
- Engine browser contracts/assets: `@misofm/engine@0.1.0`, published through
  GitHub OIDC from `misofm/engine` commit
  `5360874854f47e3dbfa2279ec6c57174e5ca018e` and released as `sdk-v0.1.0`.

Engine issue #352 commits `3ab49a3d`, `bf1a6672`, and `6a08315c` are explicitly
quarantined and must not be copied. Parallel/off-main-thread warm verification
is deferred.

## Smallest publishable slice

Export `openEngineWebSession(options)` from the package root. Inputs are an
Engine session document, caller-owned `leaseId`, declared sources using Engine
`SourceSpec`, a codec-neutral resolver producing canonical PCM byte streams,
optional progress, and test/deployment overrides for store, Worker, worklet,
AudioContext, and output construction.

The returned one-shot `EngineWebSession` exposes its compiled shape, context,
host, semantic console, output node, state, and serialized `play`, `pause`,
`seekFrames`, and idempotent `close` operations. A caller closes and constructs a
new instance to switch sessions in v0.1.

Open order is validate/capabilities; load and handshake the scratch module
Worker; OPFS verify-or-ingest and lease; scratch boot; rate-matched
AudioContext; adapter feed prelude before engine worklet;
engine host; one MSB1 ring per compiled source; self-driving PCM pump; bounded
prefill; output connection; semantic console; ready. Failure cleanup and close
run in reverse, keeping the lease until all readers stop. `play()` invokes
`AudioContext.resume()` before its first await.

Public subpaths:

- `.`: high-level session API, lifecycle types, typed errors.
- `./stems`: resolver/store/gate contracts and safe OPFS primitives.
- `./assets`: package-relative Worker/worklet URLs and override types.
- `./package.json`.

Worker/worklet protocols remain internal deployment assets. Use literal
bundler-recognizable `new Worker(new URL(..., import.meta.url), { type:
"module" })` construction, plus explicit factory/URL overrides.

## Dependency and release contract

- No React, Effect, noble hash, codec, or HTTP dependency.
- Depend on one exact compatible `@misofm/engine` release; do not embed its
  tarball or copy a second host implementation unless packed-consumer evidence
  proves its exported host asset cannot load.
- Depend exactly on the now-public `@misofm/engine@0.1.0`; its npm integrity,
  provenance, public entry imports, and `enginectl` executable passed release
  workflow `33867057291`. Engine-first sequencing is satisfied.
- ESM only, Apache-2.0, Node-supported build/test tooling, reproducible lockfile,
  explicit `files`/exports, side-effect declarations for deployable assets, and
  provenance/NOTICE for copied source.

## Objective gates

1. Safe baseline stem-store tests cover full verify-on-open, corruption and
   truncation self-heal, crash/index recovery, quota, locks, cancellation,
   deadlines, and multi-tab single flight.
2. No stem is ready/pinned/pumped before byte-count and SHA-256 verification;
   duplicate content identities single-flight while distinct source IDs may
   safely share a cached Blob.
3. PCM memory is bounded by fixed rings plus per-source windows, independent of
   duration; no whole-stem `arrayBuffer()`.
4. Unaligned seeks emit full quanta except the legal tail, preserve generation,
   and do not grow submission-refusal counters.
5. A deterministic Worker gate proves the pump is self-driving while the main
   realm is blocked.
6. Capability failures occur before network/large allocation and are typed for
   OPFS, Web Locks, module Worker, AudioWorklet, SIMD, cross-origin isolation,
   and SharedArrayBuffer.
7. Engine-reported source order/shape is crossed against declarations before
   pumping; the adapter neither parses the document independently nor guesses
   sample rate/render quantum.
8. Every partial-open failure releases pump/feed/node/host/context/lease;
   `close()` is idempotent and safe during an in-flight operation.
9. Semantic console commands observe real acknowledgements; ordinary flow
   control is not converted to fatal session failure.
10. Chromium under COOP/COEP passes cold/warm open, play, pause, unaligned seek,
    and close with accepted submissions and no torn/feed errors.
11. An extracted `npm pack` tarball imports every public entry, strict-typechecks
    a fresh consumer, builds under Vite, emits both Workers and the worklet, and
    serves every generated asset URL with the intended bytes/MIME.
12. Tarball inventory contains no node_modules, file/absolute dependencies,
    secrets, FLAC, R2, WebCodecs, Effect, or fixed delivery-name policy.
13. Format, lint, typecheck, unit/browser tests, `npm publish --dry-run`, and
    `git diff --check` pass.

## README contract

Document installation/release compatibility, canonical PCM resolver examples,
caller-owned decoding, HTTPS/localhost plus COOP/COEP requirements, browser
capabilities, asset overrides, user-gesture playback, teardown, supported PCM
formats/rates, lack of implicit SRC, Chromium qualification, and v0.1 limits.

## Deferred

FLAC/other codecs; transport helpers and URL conventions; warm verification
workers and hardware-concurrency policy; hot replacement/crossfade; document
fetching; UI/loading policy; offline-library clearing policy; 32-bit-float
pumping; postMessage fallback; and Firefox/WebKit/iOS qualification.

## Review workflow

A fresh Sol xhigh produced this brief. Sol medium implements the smallest
publishable vertical slice. A fresh Sol high then reviews it adversarially.
Failed gates are recorded; no gate is weakened to declare readiness.

## Attempt evidence and decisions

Attempt 1 (`8fea81a`) failed adversarial review. The release blockers were
real implementation gaps, not qualification exceptions: pump ticks could race
seek, worklet seek backpressure was marked applied, lifecycle close could sit
behind a hung operation, Worker RPCs had no failure/deadline path, crash
recovery ignored live Web Locks, a typed-array view and tail subview could be
created in `process()`, declarations were order-coupled, and the packed browser
path had not been exercised.

Revision attempt 2 fixes those findings with one serialized Worker queue;
retry-without-mutation for seek backpressure; synchronously aborting close and
last-call lifecycle ordering; bounded Worker RPC; an early scratch Worker
handshake; held/pending Web Locks recovery protection with conservative
query-unavailable behavior; attach-time views and full pre-zeroed plane copies;
ID-based compiled ordering; and a persistent extracted-tarball Vite/Chromium
COOP/COEP harness. Live browser qualification also found that the low-level
Engine host asset requires `toWebBootOptions(request.options)`; the adapter now
uses the Engine package's own conversion, matching the authorized app
baseline. The harness records cold/warm cache reuse, play/pause, an unaligned
seek, close, accepted submissions, zero refused/torn/feed errors, and emitted
asset MIME.

The subsequent clean-checkout audit made the package gate build before
inventory, separated source lint from built-artifact policy, and pinned Vite
plus Playwright Core as development-only harness dependencies. The browser
gate now resolves those tools locally and discovers Chrome/Chromium from an
explicit environment override or standard installation paths. Query-less Web
Locks recovery keeps ambiguous staging and final files, and the prepared
scratch Worker is terminated immediately after Engine construction instead of
living for the playback session.

`BigInt` is a JavaScript primitive and the language specification does not
promise whether a particular engine allocates for its operations. No parallel
ABI was invented. Measuring the shipping worklet's BigInt behavior under the
qualified Chromium runtime remains a performance follow-up; it is not asserted
as allocation evidence by source inspection.
