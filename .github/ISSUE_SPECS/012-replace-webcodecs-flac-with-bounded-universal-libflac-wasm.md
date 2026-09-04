# Replace WebCodecs FLAC with bounded universal libFLAC Wasm decoding

## Objective

Make dense-FLAC ingestion work consistently in Chromium, macOS Safari, and
mobile Safari by replacing the adapter's WebCodecs FLAC decoder with one
package-owned, bounded libFLAC WebAssembly decoder.

Preserve the existing architecture:

`caller locator -> Effect exact-range HTTP -> bounded metadata validation ->`
`dense frame packetizer -> one decoder Worker per admitted stem -> OPFS staging`
`+ incremental SHA-256 -> verified promotion/lease -> bounded PCM pump -> Engine`

No stage may buffer a whole compressed or decoded stem. The Engine consumes
only a fully verified OPFS lease. The existing prepared stems and object keys
are unchanged and require no reupload.

This issue succeeds #8 and begins a fresh three-attempt workflow. It is not a
fourth revision of #8. `@misofm/engine-web-adapter@0.2.0` must not publish until
this issue passes.

## Evidence and release blocker

Baseline: merged `main` commit `25a278c10b132846ec869204a0aa7d02799825a1`
from PR #10.

Issue #8 qualified packed Chromium against the local fixture and live
`stems.miso.fm`, including exact Effect HTTP ranges, metadata/declaration
validation, dense packetization, OPFS staging, SHA-256 promotion, warm reuse,
cancellation, and pumping. Native Safari 26.3.1 reaches the Worker and reports
the standard FLAC `AudioDecoderConfig` supported, but asynchronously closes
the decoder before emitting PCM for both the packaged 206-byte fixture and the
live 4,198,461-byte object. The identical W3C STREAMINFO description and
one-frame-per-chunk contract passes in Chromium. A product integration also
reproduced no mixer output in Safari.

## Architecture ruling

Use universal Wasm decoding. Remove WebCodecs rather than keeping it as a
preferred path or fallback.

Each admitted stem owns one ordinary module Worker and one single-threaded
libFLAC Wasm instance. Concurrency occurs across stems through the existing
bounded Worker admission pool. The decoder uses no Wasm threads, pthreads,
shared Wasm memory, nested Worker, filesystem, network, or WASI.

This deliberately trades a small fixed asset and possibly lower peak Chromium
throughput for identical Chromium/WebKit behavior, bit-exact integer PCM, an
enforceable memory ceiling, and one decode/error/cancellation matrix. A
WebCodecs fast path requires a future issue backed by measured need and fixed
Safari conformance.

## Decoder source, provenance, and build

Build a narrow private wrapper around official libFLAC 1.5.0 stream decoding.
Pin the release source and official `flac-1.5.0.tar.xz` SHA-256:

`f2c1c76592a82ffff8413ba3c4a1299b6c7ab06c734dee03fd88630485c2b920`

Keep the required source, wrapper, reproducible toolchain/build command, and
generated Wasm provenance in this repository. Include Xiph's license and
attribution in NOTICE. Ordinary TypeScript/package builds must not download a
compiler or source. A focused rebuild gate compares the generated artifact to
the checked-in pin.

Compile only the native FLAC decoder subset: no encoder, CLI, Ogg, metadata
editor, stdio filesystem, sockets, or pthreads. Do not depend on a generic
browser-decoder npm package or restore `engine/sidecars/flac-decoder`.

Primary references:

- https://xiph.org/flac/api/group__flac__stream__decoder.html
- https://github.com/xiph/flac/releases/tag/1.5.0
- https://www.w3.org/TR/webcodecs-flac-codec-registration/
- https://emscripten.org/docs/tools_reference/settings_reference.html

## Private frame decoder contract

The Wasm wrapper is package-internal, not a public npm ABI. It must:

1. Initialize from the normalized terminal STREAMINFO already validated by
   `DenseFlacMetadataParser` and enable libFLAC MD5 checking.
2. Accept at most one complete packetized FLAC frame per decode call and use
   `FLAC__stream_decoder_process_single()`.
3. Keep one bounded input arena, libFLAC state, and one canonical output block
   in fixed non-shared linear memory.
4. Handle read/write/error callbacks in C; never cross into JavaScript per
   sample.
5. Interleave signed libFLAC integer channels directly into canonical
   little-endian PCM16/PCM24 without float conversion or rounding.
6. Return exactly one output block for one accepted frame and invalidate its
   view before the next call.
7. Validate callback rate, channels, bit depth, block size, frame/sample
   position, output length, cumulative frames, and bytes against STREAMINFO and
   the dense SEEKTABLE.
8. Treat decoder error callbacks, CRC failure, invalid state, allocation
   failure, trap, unexpected callbacks/counts, or MD5 mismatch as terminal.
   Corrupted-frame concealment/silence is never accepted.
9. Verify final counts and decoded MD5, then destroy state. Destroy is safe
   after partial initialization or failure.

The Worker copies one compressed frame into Wasm, decodes synchronously, copies
the exact PCM block into one transferable buffer, and posts only after checks
pass.

## Streaming, concurrency, and backpressure

Retain the metadata parser, dense SEEKTABLE validator, Effect `HttpClient`
ranges, verified store, and PCM pump.

Within one Worker: instantiate the decoder before stem input credit; validate
metadata and compiled declarations; initialize STREAMINFO; request audio only
after those checks; packetize at dense offsets; acquire one PCM output credit;
decode exactly one frame; post exact PCM; finish MD5/count verification; emit
completion. Do not request more compressed input while a complete frame waits
for output credit.

Remove the four-entry asynchronous WebCodecs submission queue. Exactly one
decoder call is active per Worker. Decode never runs on the window/main or
AudioWorklet thread. One Worker uses one core; multiple admitted stems run on
separate Workers using the existing `hardwareConcurrency - 1`, memory-budget,
and configured-maximum admission formula. The browser value remains a
privacy-reduced hint. Do not split a frame/stem or add Wasm threads. Warm OPFS
hits construct no FLAC Worker and perform no decode.

## Frozen bounds

- delivery chunk: 256 KiB;
- compressed frame: 524,320 bytes;
- canonical output block: 384 KiB;
- decoded output credits: 2;
- active decoder Worker reservation: 8 MiB;
- decoder linear memory: exactly 32 initial and maximum 64-KiB pages (2 MiB),
  non-shared, growth disabled;
- decoder `.wasm`: at most 256 KiB uncompressed.

Replace 2,097,280 bytes of WebCodecs submission accounting with 2,097,152
fixed Wasm bytes. Existing non-decoder buffers are 5,767,206 bytes, total
accounted memory is 7,864,358 bytes, and reservation headroom is 524,250 bytes.
Browser Worker/compiler/network internals remain opaque and separately stated.
The maximum stereo PCM24 frame must fit. If libFLAC cannot meet the 2-MiB bound,
stop and amend/rebrief rather than enabling growth or silently enlarging it.

## Assets and public API

Keep the public session choice unchanged: normal `{ flac }`, advanced
`{ resolver }`, caller-owned `locate(identity, attempt)`, and no host/key/auth/
R2/UI/React policy.

Add:

```ts
ADAPTER_ASSET_FILES.flacDecoderWasm
ADAPTER_ASSETS.flacDecoderWasm
AdapterAssetOverrides.flacDecoderWasmUrl
```

The default Worker resolves the package asset without configuration. Overrides
reach both `openEngineWebSession()` and `createFlacStemResolver()`. The packed
consumer serves it as `application/wasm`. There is no public backend switch.

## Failures, cancellation, and cleanup

Retain existing transport/parser/store/pump errors. Add/normalize:

- `stem.decode.asset`: load/MIME/compile/instantiate/ABI failure;
- `stem.decode.flac`: libFLAC init/process/CRC/state/MD5 failure;
- `stem.decode.output`: shape/count/canonical byte mismatch;
- `stem.decode.stall`: no Worker progress before deadline;
- `stem.decode.worker`: crash/clone/unexpected termination.

Where applicable details include identity, phase (`decoder-load`, `metadata`,
`frame`, `finish`), frame index/sample number, decoder state, expected/actual
counts, and `retryable: false`, never credentials or signed URLs. Remove
WebCodecs-only capability/failure codes from unpublished 0.2.0.

Retain #8's resolving mailbox and terminal race. Cover cancellation while
queued, loading/compiling Wasm, probing metadata, downloading, waiting for
output credit, between bounded synchronous calls, writing OPFS, finishing MD5,
and closing. On terminal paths: stop admission, abort Effect HTTP, ignore late
output, physically terminate Worker, reject consumer, and delete staging. No
failure promotes, leases, pins, or pumps PCM.

## Migration/removal

Remove all dormant WebCodecs alternatives: `AudioDecoder`,
`EncodedAudioChunk`, probing/configuration, async submission accounting,
`audioDataToCanonicalPcm`, public WebCodecs audio types, WebCodecs-only tests,
capability text, failures, and provenance. Replace them with the private
libFLAC wrapper/asset, direct integer output, tests, attribution, and browser
qualification. Update AGENTS.md/README to the canonical sequence:

`dense FLAC -> bounded universal Wasm -> canonical PCM -> verified OPFS -> Engine`

## Objective gates

1. Pinned libFLAC 1.5.0 source rebuilds reproducibly to the checked-in artifact;
   upstream checksum, license, and attribution are present.
2. Static inspection proves exactly 32 initial/maximum non-shared pages, no
   growth, and no WASI/filesystem/network/pthread or encoder/Ogg/CLI surface.
3. Packed decoder asset is at most 256 KiB and served as `application/wasm`.
4. Real Wasm fixtures cover mono/stereo, PCM16/24, 44.1/48/88.2/96 kHz,
   one frame, exact and partial final blocks, and maximum supported output.
5. Every fixture produces exact canonical bytes and PCM SHA-256.
6. Corrupt header/CRC, truncation, reorder/duplication, unexpected callbacks,
   wrong shape, memory exhaustion, trap, and final MD5 mismatch fail closed
   without OPFS promotion.
7. Wrong declared rate/channels/depth/frames still rejects before any requested
   audio range.
8. Instrumented long streams prove package memory/queues independent of duration
   and forbid whole-FLAC/PCM `arrayBuffer()` paths.
9. At least two admitted stems demonstrably overlap across Workers; one Worker
   has only one decode call and at most two transferable PCM outputs.
10. Cancellation covers every named phase; physical termination precedes
    rejection and late work is inert.
11. Asset 404/wrong MIME/malformed Wasm/wrong ABI or memory/load stall/Worker
    crash produce stable typed errors.
12. Packed current Chromium passes cold decode/play/pause/unaligned seek/close
    and warm reuse with zero refused/torn/feed errors.
13. Native macOS Safari 26.3.1 passes the same packed cold/warm flow.
14. Current physical-iPhone mobile Safari passes one-stem cold decode, canonical
    verification, play/pause/seek/close, and warm zero-network reuse.
15. Warm reuse makes zero locator/stem-network/FLAC-Worker/decoder-asset work
    while fully verifying OPFS before leasing.
16. Live caller-derived `https://stems.miso.fm/<identity>.flac` acceptance passes
    in Chromium and macOS Safari with exact 206/range/ETag and warm zero-network.
17. Packed consumer observes decoder Wasm, FLAC/pump/scratch Workers, feed and
    Engine worklets, and Engine Wasm at package URLs with correct MIME.
18. `npm run check`, browser/live/reproducibility gates, publish dry-run, and
    `git diff --check` pass from an immutable clean commit.

Decode throughput/cold timing on Chromium, macOS Safari, and physical iPhone is
descriptive unless a named product budget exists, but overlap across two stems
is mandatory.

## Non-goals

No WebCodecs path, Engine/CLI/stem/reupload change, fixed delivery host/key,
credentials, React/UI/app state machine, pre-verification playback,
`decodeAudioData`, Wasm threads, SIMD optimization pass, Worker reuse, service
worker cache, prefetch, SRC, or other codec. App upgrade and npm publication
remain separate synchronized release steps after Sol PASS.

## Review workflow

A fresh Sol-high agent produced and approved this brief. A fresh Sol-medium
agent implements attempt 1. A separate fresh Sol-high agent adversarially
reviews an immutable checkpoint. This issue has its own three-attempt budget;
gates are not weakened to preserve #8's merged implementation.
