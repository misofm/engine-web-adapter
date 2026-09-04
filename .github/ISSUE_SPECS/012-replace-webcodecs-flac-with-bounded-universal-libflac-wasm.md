# Replace WebCodecs FLAC with bounded universal libFLAC Wasm decoding

GitHub: https://github.com/misofm/engine-web-adapter/issues/12

## Objective

Make ordinary standards-compliant native FLAC ingestion work consistently in
Chromium, macOS Safari, and mobile Safari by replacing WebCodecs with one
package-owned, bounded libFLAC WebAssembly decoder.

The adapter must validate STREAMINFO early through bounded exact-range probes,
skip irrelevant metadata without downloading or retaining its payload, stream
the compressed suffix through sequential Effect HTTP ranges, let libFLAC find
frame boundaries and variable block sizes, and emit bounded canonical PCM into
the existing OPFS verification path.

Preserve:

`caller locator -> Effect exact ranges -> STREAMINFO admission -> fixed`
`compressed-input slot -> one Wasm Worker/admitted stem -> OPFS staging +`
`incremental SHA-256 -> verified promotion/lease -> PCM pump -> Engine`

No stage buffers a whole compressed frame, compressed stem, or decoded stem.
The Engine consumes only a fully verified OPFS lease.

Existing CLI-prepared dense files remain valid because they are ordinary FLAC
with extra standard metadata; they require no re-encoding or reupload. Future
files need neither a dense SEEKTABLE nor fixed block sizes. The object identity
remains `pcmSha256`, and URL/key mapping remains caller-owned.

This issue succeeds #8 with a fresh three-attempt workflow. It is not a fourth
#8 revision. Unpublished `0.2.0` must not ship until this issue passes.

## Baseline and blocker

Baseline is merged main `25a278c10b132846ec869204a0aa7d02799825a1`.
Issue #8 qualified packed Chromium and live `stems.miso.fm`, including Effect
ranges, early shape checks, OPFS staging, SHA-256 promotion, warm reuse,
cancellation, and pumping. Native Safari 26.3.1 reports the standard FLAC
WebCodecs configuration supported but closes `AudioDecoder` before PCM for
both the package fixture and live object. A product Safari run likewise
produces no mixer output.

## Architecture ruling

Use universal Wasm. Remove WebCodecs rather than retaining a fast path or
fallback. Each admitted stem owns one module Worker and one single-threaded
libFLAC instance. Separate stems run concurrently through the existing bounded
admission pool; a stem is never split across Workers. No Wasm threads, pthreads,
nested Worker, filesystem, network, WASI, or decode on the main/AudioWorklet
thread is permitted.

This trades a small fixed asset and possibly lower peak Chromium throughput for
identical WebKit/Chromium behavior, bit-exact integer PCM, enforceable memory,
and one error/cancellation/conformance matrix. A future WebCodecs path needs a
separate measured issue.

## Decoder source and provenance

Build a narrow private wrapper around official libFLAC 1.5.0. Pin the release
source and official `flac-1.5.0.tar.xz` SHA-256:

`f2c1c76592a82ffff8413ba3c4a1299b6c7ab06c734dee03fd88630485c2b920`

Keep required source, wrapper, pinned/reproducible Emscripten build, generated
Wasm provenance, Xiph license, and attribution in this repository. Ordinary
TypeScript/npm builds use the checked-in artifact and perform no download or
compiler install. A focused gate rebuilds and compares the artifact pin.

Compile only native stream decoding: no encoder, CLI, Ogg, metadata editor,
stdio filesystem, sockets, or pthreads. Do not use a generic decoder npm
package or restore `engine/sidecars/flac-decoder`.

Primary references:

- https://xiph.org/flac/api/group__flac__stream__decoder.html
- https://github.com/xiph/flac/releases/tag/1.5.0
- https://emscripten.org/docs/tools_reference/settings_reference.html

## Early metadata admission

1. Request bytes `0-41`; require native `fLaC`, a first/unique 34-byte
   STREAMINFO, supported sample rate, mono/stereo, and PCM16/24.
2. If total samples is nonzero, validate it and derived PCM bytes against the
   compiled source before requesting audio. A legal zero total or zero MD5 is
   allowed; exact session counts and PCM SHA-256 remain mandatory at finish.
3. Walk later metadata with exact four-byte header requests, checked offsets,
   and at most 128 blocks. Do not fetch comments, pictures, padding,
   SEEKTABLE, or application payloads. Stop at the final-block flag.
4. Require the calculated audio offset inside the stable Content-Range total.

Accept no, sparse, ordinary, or dense SEEKTABLE; fixed or variable blocks;
legal zero STREAMINFO frame-size fields; and legal optional metadata. Retain
only normalized STREAMINFO plus one header. Synthesize `fLaC` plus a terminal
copy of STREAMINFO for libFLAC, then supply the original audio suffix.

## Synchronous compressed-input bridge

libFLAC's synchronous read callback cannot use zero bytes for temporary network
starvation: zero means true EOF or abort. Use one 256-KiB `SharedArrayBuffer`
input slot with atomic state between the Effect HTTP owner and decoder Worker.
The Wasm memory itself remains non-shared.

The libFLAC C read callback calls one synchronous JavaScript import:

1. Copy available slot bytes into Wasm memory, at most the requested count.
2. If empty and not final, post one input-credit, block only the decoder Worker
   with `Atomics.wait`, then recheck after notification.
3. The main-thread owner performs the next sequential exact-range request,
   copies it into the slot, atomically publishes length/final state, and
   notifies.
4. The Worker returns a drained slot to EMPTY.
5. Return EOF only after the exact stable remote total is reached and the final
   slot is fully drained. Cancellation sets ABORTED and notifies; only this
   terminal state returns abort.

Acquire one PCM output credit, call `FLAC__stream_decoder_process_single()`,
and let it consume as many slot refills as the next frame needs. Once one frame
is emitted, copy exact canonical PCM into one transferable buffer and return to
the Worker loop. A main-thread watchdog physically terminates CPU/no-progress
stalls. This permits frames to span arbitrary range boundaries without false
EOF, replay, or whole-frame allocation.

## Private decoder contract

The internal Wasm wrapper must enable libFLAC MD5 when available; handle C
read/write/error callbacks without crossing JS per sample; interleave signed
integer channel buffers directly into little-endian PCM16/24; emit exactly one
bounded PCM block per successful output cycle; and validate rate, channel,
depth, block size, sample position, cumulative frames, and bytes against
STREAMINFO/session declarations.

Every libFLAC error callback, CRC/lost-sync/missing-frame error, invalid state,
allocation failure, trap, unexpected callback/output count, shape mismatch, or
final MD5 mismatch is terminal. Concealed/corrupt silence is never accepted.
Finish verifies final counts/MD5 and destroy is safe after partial init/failure.

## Bounds and concurrency

The 8-MiB Worker reservation remains. Directly named storage is approximately
3.26 MiB: one 256-KiB Effect result, one 256-KiB shared input slot, fixed 2-MiB
non-growing Wasm memory, two PCM output credits totaling 768 KiB, at most 4 KiB
metadata/control scratch, and a maximum 393,210-byte PCM block (within the
384-KiB/393,216-byte ceiling). Browser networking, Worker/runtime, and compiled
code are opaque and reported separately.

The Wasm module has exactly 32 initial/maximum 64-KiB pages, non-shared memory,
growth disabled, and an uncompressed artifact no larger than 256 KiB. Remove
dense seek arrays, packetizer buffers, and four WebCodecs submissions. Memory
high-water must be independent of song duration and track count.

Retain admission based on `hardwareConcurrency - 1`, caller memory budget, and
configured maximum. The browser value is a privacy-reduced hint. At least two
admitted stems must overlap across Workers; one stem stays single-threaded.

## Assets and public API

Keep normal `{ flac }`, advanced `{ resolver }`, caller `locate(identity,
attempt)`, and no host/key/auth/R2/UI policy. Add package assets:

```ts
ADAPTER_ASSET_FILES.flacDecoderWasm
ADAPTER_ASSETS.flacDecoderWasm
AdapterAssetOverrides.flacDecoderWasmUrl
```

Defaults work without configuration; overrides reach high- and low-level FLAC
paths. Packed consumers serve `application/wasm`. No backend selector exists.

## Failures and cleanup

Retain delivery/parser/store/pump failures and add/normalize:

- `stem.decode.asset`: load/MIME/compile/instantiate/ABI failure;
- `stem.decode.flac`: libFLAC init/process/CRC/state/MD5 failure;
- `stem.decode.output`: shape/count/canonical-byte mismatch;
- `stem.decode.stall`: decoder makes no progress before deadline;
- `stem.decode.worker`: crash/clone/unexpected termination.

Details may include identity, phase (`decoder-load`, `metadata`, `frame`,
`finish`), decoder state, expected/actual counts, and `retryable: false`, never
credentials/signed URLs. Remove WebCodecs-only failures.

Retain #8's terminal race. Cover cancellation while queued, loading Wasm,
probing metadata, fetching/refilling, blocked in `Atomics.wait`, waiting output
credit, between bounded Wasm calls, writing OPFS, finishing, and closing.
Terminal order is: stop admission; set ABORTED/notify; abort Effect HTTP; ignore
late output; physically terminate Worker; reject; delete staging. No failure
promotes, leases, pins, or pumps PCM.

## Migration/removal

Remove `AudioDecoder`, `EncodedAudioChunk`, WebCodecs probing/submission queues,
`audioDataToCanonicalPcm`, public WebCodecs types, `DenseFlacFramePacketizer`,
dense SEEKTABLE admission/types, fixed-block requirements, related tests/text/
errors/provenance, and any statement that CLI-specific preparation is required.
Rename public comments/source concepts to native FLAC. Update AGENTS/README to:

`native FLAC -> bounded universal Wasm -> canonical PCM -> verified OPFS -> Engine`

## Objective gates

1. Pinned libFLAC 1.5.0 source reproducibly builds the checked-in asset; upstream
   checksum, license, attribution, and artifact digest are present.
2. Static inspection proves 32 initial/maximum non-shared pages, no growth, and
   no WASI/filesystem/network/pthread or encoder/Ogg/CLI surface.
3. Packed Wasm is at most 256 KiB and served as `application/wasm`.
4. Real fixtures cover no/sparse/dense SEEKTABLE, fixed/variable blocks, zero
   frame-size fields, no/large optional metadata, mono/stereo PCM16/24 at all
   supported rates, single/partial/long streams, and exact canonical hashes.
5. Metadata range traces fetch only STREAMINFO, later four-byte headers, and
   audio; wrong known rate/channels/depth/frames rejects before audio.
6. Accepted audio ranges are sequential/non-overlapping; retry repeats only an
   unaccepted range.
7. Splits around frame headers/subframes/CRCs and a frame larger than the input
   slot decode exactly across refills. Delayed refill waits/resumes.
8. EOF occurs only after exact total/final drain; truncation fails rather than
   hanging. Variable blocks remain within PCM/output/cumulative bounds.
9. Corrupt header/CRC, lost sync, truncation, replay/reorder, bad callbacks,
   trap, shape/count/MD5/SHA mismatch fail without OPFS promotion.
10. Instrumentation proves one compressed slot, one decoder call, at most two
    pending PCM outputs, duration-independent memory, and two-stem overlap.
11. Cancellation covers every named phase; physical termination precedes
    rejection and late work is inert.
12. Asset 404/MIME/malformed ABI/memory/import/load stall and Worker crash yield
    stable typed failures.
13. Packed Chromium and native macOS Safari 26.3.1 pass cold decode/play/pause/
    unaligned seek/close and warm zero-network reuse.
14. Current mobile Safari on a physical iPhone passes the same functional path.
15. Existing dense live `stems.miso.fm` objects pass Chromium/macOS Safari 206,
    stable length/ETag, exact PCM hash, and warm reuse without reupload.
16. Warm reuse constructs no decoder Worker and performs no stem/decoder-asset
    request while fully verifying OPFS.
17. Packed consumer observes decoder Wasm, all Workers/worklets, and Engine Wasm
    at package URLs with correct MIME.
18. Policy proves no SEEKTABLE/fixed-block dependency, WebCodecs,
    whole-file/frame `arrayBuffer()`, `decodeAudioData`, or hidden fallback.
19. `npm run check`, browser/live/rebuild gates, publish dry-run, and
    `git diff --check` pass from an immutable clean commit.

## Non-goals

No Engine change, CLI implementation (tracked by `misofm/cli#18`), stem
reupload, fixed host/key, credentials, React/UI/app state machine,
pre-verification playback, other codec, Wasm threads/SIMD optimization, Worker
reuse, service-worker cache, prefetch, or SRC. App upgrade and npm publication
follow only after Sol PASS.

## Attempt record

Attempt 1 reached a fully streaming universal-Wasm path but review is **FAIL**.
The immutable reviewed checkpoint did not yet prove a main-realm decoder
no-progress watchdog, reclaim allocator behavior, the exact two-unconsumed-PCM
ceiling, frame-position/block-bound enforcement, or total ABI-trap
normalization. Its packed gate also conflated the decoder and Engine Wasm
observations.

Attempt 2 keeps the same architecture and corrects only those findings:

- a resettable main-thread asset/decode watchdog physically terminates before
  reporting `stem.decode.stall`;
- a bounded reclaiming allocator exposes live/peak evidence for real libFLAC;
- a zero-high-water PCM stream and output-credit checks enforce two
  unconsumed blocks;
- STREAMINFO block bounds and contiguous decoded sample positions are checked
  in the decoder wrapper while permitting one legal final partial block;
- malformed/trapping ABI surfaces normalize to `stem.decode.asset`; and
- the packed browser gate names decoder Wasm and Engine Wasm independently.

Attempt-2 implementation evidence at the uncommitted review boundary:

- strict Emscripten 6.0.9 rebuild reproduced decoder SHA-256
  `b18990c13c17d05ef1d5c337a6a21c15b731a4a3669e6ab3557b5b9bd16beabb`;
- decoder policy reports 56,762 bytes, the sole `env.miso_flac_read` import,
  and fixed 32/32 non-growing pages;
- `npm run check` passes 79/79 tests, including real allocator, variable-block,
  final-partial, reordered-frame, watchdog, output-credit, and malformed-ABI
  cases; and
- the packed Chromium fixture passes cold decode/play/pause/seek/close and warm
  reuse while independently observing decoder Wasm and Engine Wasm package
  assets.

Attempt 2 remains pending fresh adversarial review and the separately required
native Safari, mobile Safari, and live-object product gates; this local record
does not claim final PASS.

## Workflow

Fresh Sol-high produced and approved the brief and this ordinary-FLAC
amendment. Fresh Sol-medium implements attempt 1; separate fresh Sol-high
adversarially reviews the immutable checkpoint. This issue owns a fresh
three-attempt budget and does not weaken gates to preserve #8.
