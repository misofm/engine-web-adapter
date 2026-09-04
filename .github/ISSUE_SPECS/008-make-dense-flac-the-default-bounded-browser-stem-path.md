# Make dense-FLAC the default bounded browser stem path

## Objective

Update `@misofm/engine-web-adapter` so the normal
`openEngineWebSession()` path accepts correctly prepared, fixed-block FLAC
through caller-owned URL/auth resolution. The adapter owns Effect HTTP range
orchestration, incremental metadata validation and frame packetization,
Worker-side WebCodecs decode, streaming canonical-PCM verification and OPFS
promotion, verified leasing, and the existing bounded PCM pump.

No stage may buffer a whole FLAC or decoded stem in RAM. The engine may consume
only a fully verified OPFS lease: bytes stream network -> decoder -> staging
file, then the existing pump streams the promoted PCM file into the engine.

Keep the canonical-PCM `StemResolver` as an explicitly selected advanced escape
hatch. The adapter must never know R2, hardcode a host, derive a filename/key, or
own product UI.

## Approved baselines and ruling

- Adapter baseline: `d008544`.
- App implementation evidence: `misofm/app@7485693e9bbcf2f65a91a4e5950e22d678d99062`.
- CLI preparation contract: `misofm/cli@94d94be1e858d01453ad4242e061ef2984502a00`.
- Live acceptance host: `stems.miso.fm`, supplied only by the test/caller.
- Known bass identity:
  `sha256:ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1`.

This issue supersedes issue #1's pre-FLAC governance ruling. Dense native FLAC
is now the first-party browser path. Transport policy remains caller-owned and
raw PCM remains supported through resolver injection. `AGENTS.md` and source
policy are amended in the issue checkpoint before implementation.

Do not copy the app parser's assumption that STREAMINFO is immediately followed
by the final SEEKTABLE. The CLI preserves ordered legal non-SEEKTABLE metadata;
the adapter must scan bounded metadata blocks, locate exactly one dense
SEEKTABLE, and calculate the true audio suffix offset.

The HTTP pipeline must use Effect v4 `HttpClient`; its default layer is
`FetchHttpClient.layer`, and callers may inject an `HttpClient` or layer for
testing/custom transport. Raw `fetch` is not the pipeline implementation.

## Public contract

Use a discriminated union so callers select exactly one input path:

```ts
export type EngineWebSessionOptions = EngineWebSessionCommonOptions &
  (
    | { readonly flac: FlacDeliveryOptions; readonly resolver?: never }
    | {
        /** Advanced escape hatch: already-decoded canonical PCM. */
        readonly resolver: StemResolver
        readonly flac?: never
      }
  )
```

`FlacDeliveryOptions` supplies a `locate(identity, rangeAttempt)` callback that
runs for every physical attempt and may return a string, URL, or bodyless GET
`Request`. It may also supply an Effect `HttpClient` or layer, read deadline,
maximum attempts, and admission limits. The adapter overwrites `Range`, attaches
the operation signal, and otherwise preserves caller request policy. No package
code derives `/<digest>.flac`.

Export `createFlacStemResolver()` and FLAC progress/error/admission types from
`./stems`. Add package-relative FLAC Worker construction and override support to
`./assets`. Existing `resolver` callers remain source-compatible.

Supplying both or neither path is a TypeScript error and a typed runtime usage
error for JavaScript callers.

## Smallest closable implementation

1. Normalize document bytes once and run the existing scratch Worker before
   OPFS or delivery. Reuse that exact result for Engine construction rather than
   booting scratch twice. Cross-check compiled source IDs, rates, channels,
   frames, bit depths, and byte counts before delivery.
2. Incrementally parse FLAC metadata. Require first/unique 34-byte STREAMINFO,
   exactly one dense SEEKTABLE, fixed nonzero block size, launch rate,
   mono/stereo, PCM16/24, positive samples, and nonzero frame-size bounds. Allow
   other legal metadata in order without retaining comments/art. Refuse excess
   metadata with typed `stem.flac.resource_limit`.
3. Require the dense table to cover every frame in sample order: entry `i`
   starts at `i * blockSize`, has the exact full/final sample count, begins at
   byte offset zero then strictly increases, and yields compressed frame lengths
   within declared and package bounds.
4. Drive Effect HTTP ranges from Worker credit. Probe only required metadata
   bytes and request no audio before metadata/declaration validation. Require
   exact 206, visible/exact Content-Range and Content-Length, stable total size,
   no Content-Encoding, and a stable ETag when exposed. Retry only transient
   network/no-progress/5xx failures and resume at the first byte not accepted by
   Worker credit; never replay or skip an accepted byte.
5. Admit lazy one-stem-per-Worker decode jobs through one bounded FIFO pool.
   Remove queued cancellations and terminate physical Workers after success,
   error, or cancellation.
6. In each Worker, packetize from dense offsets and give WebCodecs exactly one
   FLAC frame per `EncodedAudioChunk`. Bound decoder submissions and require
   output credits before decode. Convert supported `AudioData` layouts into
   source-depth interleaved little-endian PCM and close every `AudioData`.
   Validate output rate, channels, frame count, and byte count.
7. Stream decoded blocks into the existing `VerifiedStemStore`; its incremental
   SHA-256 and exact byte-count gate stays authoritative. No final/index entry,
   pin, lease, or pump becomes visible before verification and promotion.
8. Bound both cold ingestion and warm OPFS verification with the same admission
   width; remove duration/track-count-dependent pending work.
9. After leasing, retain the existing fail-closed `PcmPumpWorkerClient`, MSB1
   ring, seek semantics, reverse cleanup, and late-message inertness.
10. Update README, package description, NOTICE/provenance, packed-asset policy,
    and fresh-consumer browser harness. Ship the reviewed feature as `0.2.0`;
    publication is a separate synchronized release issue.

## Frozen bounds and admission

- Delivery chunk: 256 KiB maximum.
- Compressed FLAC frame: 524,320 bytes maximum.
- Canonical output block: 384 KiB maximum.
- Decoder submissions: 4 maximum.
- Decoded output credits: 2.
- App-owned reservation: 8 MiB per active FLAC Worker.
- Aggregate default: clamp usable `navigator.deviceMemory * 8 MiB` to 8-32
  MiB; otherwise 16 MiB.
- Width: `max(1, min(hardwareConcurrency - 1, floor(memoryBudget / 8 MiB),
  configuredMaximum))`; missing/invalid hardware concurrency is 2.

Browser decoder/network implementation memory is opaque and must be reported
separately. Every package-owned queue is credit-driven and its bound is
independent of stem duration and total track count.

## Progress and stable failures

Progress stages are a discriminated union over `loading`, `queued`, `probing`,
`fetching`, `decoding`, `ingesting`, `verifying`, `ready`, and `prefilling`.
Byte events identify `byteKind: "flac" | "pcm"`; queue events expose active,
queued, and limit counts. Never compare FLAC bytes with canonical PCM totals.

Stable codes include capability failure for WebCodecs audio; delivery address,
HTTP, range, stall and retry failures; FLAC invalid/resource/shape failures;
decode output/Worker failures; and the existing final `stem.corrupt` identity
failure. Details include identity, phase, range, attempt, status, and retryable
where applicable.

## Objective gates

1. CLI-format fixtures cover exact-multiple, partial-final, single-frame,
   intervening legal metadata, placeholders/gaps/shifted offsets, truncation,
   bad frame bounds, unsupported shapes, and resource refusal.
2. Wrong rate/channels/bit depth/frame count fails before an audio range request.
3. Deterministic delivery tests cover exact ranges, hidden/malformed/moving
   headers, encoding, short/long bodies, transient retry, timeout/exhaustion,
   and resume with no duplicate or skipped accepted bytes.
4. Credit/admission tests prove fixed input, decoder, output, store, core and
   memory bounds, FIFO fairness, unknown browser hints, and one-stem Worker
   disposal while consumers stall.
5. Cancellation tests cover queued, metadata, download, decoder output, OPFS
   write and session close. Termination precedes rejection; late work is inert.
6. PCM conversion covers planar/interleaved s16, left-aligned s32 PCM16/24,
   exact f32, invalid padding/non-integral floats, and mandatory close.
7. Store tests prove no visibility before exact size/SHA-256 and no whole FLAC
   or PCM `arrayBuffer()` path. Warm verification is bounded.
8. A warm packed-browser open makes zero locator calls, network requests, or
   FLAC Worker constructions while fully verifying OPFS before leasing.
9. Packed Chromium performs cold FLAC open, play, pause, unaligned seek, close,
   and warm reuse with zero refused/torn/feed errors.
10. Current stable macOS Safari performs a one-stem cold/warm packed-consumer
    flow. Unsupported Worker FLAC is reported as a platform blocker; no
    unbriefed Wasm fallback is added.
11. Opt-in live acceptance against the caller-derived
    `https://stems.miso.fm/<identity>.flac` proves root-key 206 delivery,
    exposed exact range headers, final canonical SHA-256, and warm zero-network
    reuse. The domain appears only in the opt-in test/evidence.
12. A fresh packed consumer imports/types/builds all entries and emits the FLAC
    Worker, PCM pump Worker, scratch Worker, feed worklet, and Engine worklet
    with correct MIME.
13. `npm run check`, packed Chromium, Safari evidence, publish dry-run, and
    `git diff --check` pass.

## Non-goals and successors

No codec Wasm, other codec, R2 SDK/helper, fixed delivery mapping, React/UI,
stream-before-integrity playback, Service Worker cache, signed-URL policy,
background prefetch, eviction UI, hot replacement/crossfade, implicit SRC,
Firefox/device-farm matrix, or extended metadata profile. Those require bounded
successor issues.

## Review workflow

A fresh Sol-high agent produced the brief. Root corrected its raw-fetch proposal
to the user's explicit Effect HTTP requirement and froze this contract. A fresh
Sol-medium agent implements the slice. A separate fresh Sol-high agent reviews
an immutable implementation checkpoint adversarially. Findings are corrected
within the repository's three-attempt rule; gates are not weakened.

## Evidence and decisions

Attempt 1 was reviewed at immutable adapter commit `64d8572`. The adversarial
review found six release-blocking gaps: the Engine `SessionShape` could not
prove content/bit-depth equality, shared flights coupled independent abort
domains, Worker terminal paths did not join range continuations, processed
metadata stayed live, Request construction lacked stable diagnostics, and
several proportional cancellation/memory gates were absent. Attempt 2 corrects
those findings without changing the frozen product scope.

Decisions in attempt 2:

- Scratch compilation remains authoritative for Engine shape. After scratch
  succeeds, the adapter strictly extracts only the normalized Session V1
  `sample_rate_hz` and source tuples, then compares source ID, content identity,
  channels, bit depth, frames, and derived canonical bytes against caller
  declarations before store, locator, or network work.
- Shared ingest flights were removed. Existing per-identity locks serialize
  ingest; an independent opener subsequently performs warm verification in its
  own abort domain.
- Worker termination first stops message admission, aborts active delivery,
  joins the serialized input tail, and lets the pool terminate the physical
  Worker before the PCM stream observes rejection. Successful completion does
  not abort the delivery controller.
- The metadata parser tracks absolute input offsets while compacting every
  processed block. It retains parsed STREAMINFO and bounded seek-point records,
  not raw comments, artwork, or SEEKTABLE bytes. The cumulative one-MiB metadata
  ceiling remains absolute despite compaction.
- The 8-MiB per-Worker reservation now has executable conservative live-buffer
  and exact typed-table accounting: 7,864,486 bytes for exact range, metadata
  compaction with one possible delivery-chunk remainder, packetizer peak,
  decoder submissions, and two
  decoded output credits, plus 18 typed-array bytes per maximum
  metadata-permitted dense seek point, leaving 524,122 bytes for bounded
  wrapper/bookkeeping overhead. Browser network and WebCodecs internal
  memory remains opaque and is not claimed by this figure.

Locally demonstrated evidence for attempt 2:

- 73 deterministic tests pass after the corrections. New cases cover every
  document/caller tuple mismatch before store/locator, independent same-stem
  cancellation without contamination or hang, metadata cancellation, active
  range cancellation on Worker failure, decoder-output cancellation, OPFS
  writer cancellation/cleanup, no post-termination messages, mid-body retry
  with a repeated physical range but no duplicated Worker-accepted bytes,
  large processed metadata lifetime/cumulative refusal, stable address details,
  and worst-case fixed-buffer accounting.
- Existing tests continue to cover queued cancellation, session close/reverse
  cleanup, fail-closed sibling cleanup, parser/packetizer geometry, PCM layout
  conversion, SHA-256 promotion, warm verification bounds, and pump late-message
  inertness.

Final attempt-2 gates: `npm run check` passes with 73/73 tests, source policy
over 34 files, and packed policy over 140 files / 100,560 bytes. The packed
Chromium fresh consumer passes cold decode/play/pause/unaligned-seek/close and
warm reuse: locator calls 8 -> 8, FLAC Workers 1 -> 1, network requests 8 -> 8,
32 Engine submissions, one applied seek, and zero refused, torn, or feed errors.
All eight expected JS/Wasm assets were observed.

Root independently reran `npm run check` and the packed Chromium fixture on the
final correction tree with the same results. The opt-in live-host profile also
passes against `stems.miso.fm`: 21 cold locator/range requests and one FLAC
Worker decoded the 4,198,461-byte Bass object with ETag
`"5cc22b5075610fc68f75247c7d135dd9"`; the warm reopen left all three counters
unchanged at 21/21/1, applied one seek, submitted 122 PCM chunks, and reported
zero refusals, torn feeds, or errors.

Native Safari has not been run in this attempt because Safari Remote Automation
is disabled on the test Mac. Safari support therefore remains candidly
unverified; unsupported Worker FLAC must remain a typed platform blocker rather
than gain a codec-Wasm fallback.

Attempt 3 is the final implementation attempt. It corrects the second review's
four release-blocking findings without relaxing any bound or product boundary:

- The real Worker protocol now uses one bounded mailbox with a resolving
  cancellation notification and stored reason. Decoder errors, PCM conversion
  failures, input waits, decoder-submission waits, and exhausted output-credit
  waits share one terminal race. Terminal output is closed and ignored, and the
  resolver still joins delivery before the pool physically terminates the
  Worker and exposes rejection.
- Session document bytes are always copied into a fresh owned `ArrayBuffer` and
  caller source/spec records are copied before the first await. That same
  document and source snapshot drives scratch compilation, strict JSON
  extraction, declaration cross-check, store requirements, FLAC expectations,
  `createEngine`, feed, and pump construction.
- Common FLAC Worker asset overrides now reach the default high-level FLAC
  resolver. Nested `flac.assets` overrides matching common asset fields while
  retaining unrelated common fields; the direct low-level `flac.createWorker`
  hook remains highest precedence.
- The session-level expected tuple is now exercised through the resolver,
  Effect HTTP fixture, production ingest core, and Worker mailbox. Wrong
  STREAMINFO sample rate, channels, bit depth, and frame count each permit only
  metadata ranges and reject before any requested range touches audio bytes.

Final attempt-3 local evidence: `npm run check` passes 78/78 tests, source
policy over 35 files, and packed policy over 144 files / 102,200 bytes. Focused
three-frame regressions exhaust both initial PCM credits before asynchronous
`AudioDecoder.error` and PCM conversion failure; both reject within a bounded
deadline, close terminal `AudioData`, physically terminate the Worker, and
emit no late reply. A deferred-scratch regression mutates the caller's original
document and every source-spec field while suspended and proves scratch,
boundary extraction/store requirements, and `createEngine` still observe the
pre-await snapshot.

Packed Chromium passes cold decode/play/pause/unaligned-seek/close and warm
reuse with counters unchanged at 8 locator calls, 8 network requests, and one
FLAC Worker; it reports 32 Engine submissions, one applied seek, eight emitted
assets, and zero refusals, torn feeds, or errors. The opt-in live Chromium
profile also passes at the exact configured origin: 21 cold locator/range
requests and one Worker ingest the 4,198,461-byte object with ETag
`"5cc22b5075610fc68f75247c7d135dd9"`; warm counters remain 21/21/1, with one
applied seek and zero refusals, torn feeds, or errors. The number of pump
submissions is scheduling-dependent and is not an acceptance claim.

Native Safari remains unrun because Safari Remote Automation is disabled on
the available Mac. Its status is therefore still an environmental evidence
gap, not a claimed pass and not grounds for adding an unbriefed codec fallback.
