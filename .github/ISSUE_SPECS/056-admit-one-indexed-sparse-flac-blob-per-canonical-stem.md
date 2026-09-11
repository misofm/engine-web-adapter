# Admit one indexed sparse FLAC blob per canonical stem

Status: Astra medium scope-approved; matching GitHub issue is misofm/engine-web-adapter#56. Base: accepted adapter #54 at 001208f81a2b95fffa8f67ecebe06070d49fb8df. User explicitly approved one ordinary indexed Walrus blob PER STEM with a 16-byte header, variable canonical JSON manifest and payload-relative offsets. This supersedes unreleased recording-wide MISOSPC1 and the unimplemented native-quilt proposal. Luna xhigh implements; Astra medium adversarially reviews, maximum five coherent attempts. Engine #744 received attempt-2 PASS with upstream evidence bb316c8e and is closed; PR #745 is in CI. This is now the sole active implementation tranche.

## Smallest closable outcome

Replace the unreleased recording-package format with a strictly bounded single-stem format and derive the existing sparse PCM index from independent timeline intervals. Provide pure header/index admission needed by a future full-response streaming installer. Keep the already accepted bounded PCM window reader and its allocation/lookup gates. No networking, decoder workers, OPFS lifecycle, app, CLI, publication, CDN code, or Rust changes in this slice.

Own src/stems/sparse-format.ts, src/stems/sparse-pcm.ts, their exports, focused tests, and package documentation/spec references affected by this unreleased API replacement. Do not maintain old wire exports as compatibility adapters. Preserve accepted #54 evidence historically; state clearly which wire choice was superseded.

## Exact wire

An ordinary immutable blob contains exactly HEADER || MANIFEST || PAYLOAD.

Header is exactly 16 bytes: bytes 0..7 ASCII `MISOSTM1` (8 bytes including V1 identity); bytes 8..11 unsigned little-endian manifest byte length; bytes 12..15 all zero. Manifest length is positive and <=8388608. Payload starts at exactly 16+manifestLength. No alignment padding, fixed-size reserved manifest area, magic auto-detection fallback, trailing padding, or recording wrapper. Reject old `MISOSPC1` and all unknown magics. Total object size <=8589934592 bytes.

Manifest is UTF-8 canonical JSON using #54’s existing recursive lexicographic-key canonical writer, after strict bounded admission:

    {"bitDepth":24,"channels":2,"chunks":[{"bytes":123,"flacSha256":"<64 lowercase hex>","frames":200,"offset":0,"packedStartFrame":0,"pcmSha256":"<64 lowercase hex>"}],"format":"miso_sparse_stem_v1","frames":123456,"identity":"sha256:<64 lowercase hex>","intervals":[{"frames":200,"packedFrameOffset":0,"startFrame":100}],"sampleRateHz":44100}

The example illustrates shape, not real hashes or encoded bytes. Every object’s keys are recursively lexicographically sorted, including nested interval/chunk records; arrays retain their admitted order. Reuse #54’s existing canonical writer on reconstructed admitted records, with no whitespace/BOM/final LF. Do not introduce a schema-order JSON.stringify convention. Parser requires the exact canonical UTF-8 bytes, so duplicate keys, alternate number spellings and noncanonical ordering cannot be accepted ambiguously. No artist/session/recording IDs, source array, source-ID routing, URLs, file names or codec alternatives occur in the manifest. Hash fields use exactly the specified spelling; whole-source identity retains the engine prefix, per-chunk hashes are raw lowercase hex.

Every numeric value is a safe nonnegative integer; count/length fields specified positive must be >0. Reject negative zero and unsafe additions/multiplications. Supported native shape: rates 44100/48000/88200/96000, channels 1 or 2, depth 16 or 24; source frames follow the existing session admission bounds (positive safe integer). Frame-to-byte products and endpoints must stay safe. There is exactly one source shape in the manifest.

Intervals: <=65536 records, each positive length, ascending and nonoverlapping in [0,frames). Require maximal retained spans: adjacent timeline records are coalesced, hence later start must exceed previous end. packedFrameOffset starts at zero and equals the sum of previous retained lengths. Omitted timeline gaps are exact all-channel integer zeros; short retained zeros can remain in active spans. Empty intervals encode an all-silent source, with zero active frames. Silence threshold is producer policy, not a claim the pure parser can verify without samples.

Chunks: <=65536 records, positive frames and encoded bytes; packedStartFrame starts at zero and exactly follows previous chunk end. Final packed endpoint equals sum(interval.frames). offset starts at zero and exactly follows previous offset+bytes; final payload endpoint is the exact payload length. No gaps, overlaps, duplicate coverage, trailing bytes or unreferenced bytes. Each chunk contains one independent native FLAC stream, <=30*sampleRateHz packed frames and <=33554432 encoded bytes. A chunk can cross any number of interval boundaries; intervals and chunks need not have equal counts or boundaries. All-silent means both arrays empty and zero payload. Manifest/index and total object caps still apply even if individual records pass.

The producer's fixed policy fills 30 seconds of packed active frames per chunk, except the last. Parser may accept shorter positive chunks within the same ceilings; it does not require a particular encoder partition. These caps support offline preparation, not realtime access: the later worker consumes bounded stream credits and <=8192-frame PCM windows, never an entire chunk-sized PCM allocation. No benchmarking or codec sweep belongs here.

## Admission, serialization and streaming seam

Retain ordinary Blob package parsing/serialization for bounded local producer qualification, but never call whole-blob arrayBuffer. Read exactly the header, then bounded manifest; payload stays a Blob view. Validate header caps before any index read/allocation. Given actual Blob.size, enforce exact final payload endpoint and total object size.

Also expose the smallest pure streaming admission seam: a function admitting an exactly 16-byte header and returning bounded manifest length/payload start, and a function admitting exactly that many manifest bytes plus optional known payload length. Concrete export names may follow the existing naming style; document their responsibilities. Header admission alone never means source acceptance. A caller can consume a full GET sequentially without first obtaining a whole Blob or issuing Range requests. If total response length is unavailable, admitted metadata predicts the exact payload length and the future streaming installer must verify EOF at that endpoint. Reject an available conflicting Content-Length upstream. This slice provides admission functions only; no HTTP reader/resume machinery.

Direct object validators must check shape/known keys/count caps before map/clone/stringify. Reject oversized arrays before traversing late elements. Check interval/chunk arithmetic before derived allocations. Return normalized immutable admitted structures, as #54 does; branded validated indexes permit the PCM reader to avoid revalidating/cloning all intervals per window. Do not recreate the preflight regressions found during #54 review.

Bind an admitted manifest to one expected canonical session identity+shape (native fields including full frames and root rate). Never let manifest metadata override the session. Existing session aliases sharing identity must have the same shape; consumer normalization happens by identity+shape, preserving source IDs/tracks. Remove recording-wide exact-source-set semantics from this per-stem binder. Source-set completeness is the later session readiness coordinator’s gate.

Derive SparsePcmIndex from intervals: active byte offset = packedFrameOffset*channels*(bitDepth/8), timeline positions unchanged, packed byte length = total active frames*frameBytes. Chunk offsets/hashes/partition never enter the PCM index. Preserve the accepted sparse PCM schema, strict validation, maximum8192-frame windows, O(1) brand check, binary-search interval lookup and window-sized scratch. Existing readSparsePcmWindow works identically for a chunk crossing a gap and many chunks inside one interval. Do not read FLAC payload in derivation. Direct derivation receives bounded admitted/validated singular metadata, not a recording source with rebased offsets.

Parser/serializer acceptance validates metadata/extent, not FLAC authenticity. Clearly name that limit: subsequent preparation verifies each compressed hash, exact STREAMINFO, decoded chunk length/hash and full canonical source hash including implicit zero samples before cache readiness. No parser result may be named a verified cache lease or certify decoded identity.

## Objective gates

- Table-driven raw wire: exact header, old/unknown magic, short header, nonzero reserved bytes, zero/8MiB+1 manifest length rejected before body read; malformed UTF-8/JSON, duplicate keys, unknown/missing fields, noncanonical ordering/numbers/whitespace, noninteger/negative-zero/unsafe arithmetic, wrong schema, forbidden source array.
- Count/byte/object endpoints: 65537 arrays rejected before a late ordinary element getter; manifest size cap on direct serialization; exact object/payload end, truncated/trailing payload, chunk gaps/overlaps, interval overlap/adjacency, packed endpoint mismatch and per-chunk caps. No hostile Proxy contract or large fixture corpus.
- Single expected-source binding rejects every shape/hash mismatch and cannot accept a second source in the wire. Matching aliases are normalized by the consumer rather than deleting source declarations or requiring a recording source set.
- Synthetic accepted all-silent, all-active, leading/interior/trailing gaps, one chunk spanning multiple intervals, and several chunks in one interval. Parser/serializer canonical roundtrip. Header/index admission works without a payload Blob; final known extent binding rejects mismatch.
- Derive index independent of chunk partition and compare bounded read windows against a small dense integer PCM oracle around every gap/active boundary, seek, EOF and oversize request. Preserve #54 no-index-clone/no-full-array-traversal per-window evidence and read byte bounds.
- Existing adapter tests once after focused gates, typecheck, formatting/source policy, package check, and a fresh packed consumer import/roundtrip demonstrating no browser globals required by pure exports. Do not add worker/OPFS/browser harness merely for a pure format correction. Actual decoded browser proof belongs to the preparation successor.

## Release and scope boundary

No recording package compatibility parser, native-quilt reader, session bundler or silent fallback is added. This API is unreleased, so replace the old wire contract directly; no artificial version-2 suffix. Root publishes the final adapter after required core integration gates, then downstream manifests/locks resolve its registry version. A retained packed candidate with source/tarball hashes can qualify CLI/app work before publication, without claiming registry availability. Public issue/evidence use synthetic source identities only. Close this issue on one coherent adversarial PASS plus upstream synchronized evidence; it does not claim deployed sparse playback.

## Issue boundary and implementation handoff

Root audited all 26 existing numbered adapter specs against GitHub: no missing issues or title mismatches; prior owned #54 is closed. This local #56 title/body is synchronized before implementation. Luna xhigh owns one coherent pure-format tranche and must pause when focused-green so root commits and pushes the exact paths before further changes. Astra medium supplies one adversarial verdict per attempt using the non-implementing planning thread; the session thread limit prevents a fresh-context reviewer, and evidence must disclose this. No network/publication or storage-pump work belongs in this issue.


## Attempt 1 evidence (Luna, 2026-09-11)

Implemented the first singular-stem tranche in src/stems/sparse-format.ts,
src/stems/sparse-pcm.ts, src/stems/index.ts, tests/sparse-stems.test.ts and
docs/sparse-stem-contract.md. The old MISOSPC1 recording shape and source-set
binder were replaced directly by the MISOSTM1 one-stem manifest, bounded
header/manifest admission seams, exact canonical JSON serializer, payload
extent checks, one-source identity/shape binding and interval-derived PCM
index. The accepted branded PCM reader remains bounded and chunk-agnostic.
No HTTP, OPFS, worker, store, session, codec, native or package-version change
was made.

Focused command:

    npm run build && node scripts/clean-test-dist.mjs && npm exec -- tsc -p tsconfig.test.json && node --test .test-dist/tests/sparse-stems.test.js

Result: 16 tests passed, 0 failed.

Proportional gates:

- npm run typecheck passed.
- npm run format:check passed.
- npm run lint passed (source-policy: 40 files).
- npm run check:decoder passed (56762 bytes, fixed 32/32 pages).
- npm test passed: 207 tests, 0 failed.
- npm run check:package passed (package-policy: 166 files, 168045 bytes).

A fresh packed candidate was imported and round-tripped with the pure stems
entrypoint in Node 22.23.2 and Bun 1.x, both without browser globals. The
Node and Bun checks each reported packed-*-: import/roundtrip PASS with
payload start 481 and payload bytes 8. No browser harness was run because this
slice contains pure format/index helpers only. Parser admission verifies shape,
canonical metadata and extents; it does not authenticate FLAC or decoded PCM.

## Attempt 1 adversarial verdict — FAIL

Root checkpointed and pushed attempt 1 as `4df22404c45d33c686ec47746dc250fcf34cd0ca`.
Independent Astra medium review found one bounded admission defect: the exported
streaming `admitSparseStemManifest` checks manifest and payload extents but omits
the 8 GiB total-object ceiling enforced by Blob parse/serialize wrappers. A
metadata-only fixture with 256 chunks of 32 MiB and a 59,497-byte manifest admits
8,589,994,105 total bytes, exceeding the 8,589,934,592-byte ceiling, both with and
without a supplied payload length. No large payload allocation is necessary to
demonstrate the failure.

Attempt 2 must enforce the same checked `16 + manifestBytes + declaredPayloadBytes`
ceiling in common streaming manifest admission, before it returns an admitted
descriptor. Preserve exact known payload-length matching. Add small boundary
tests for both optional-length modes and an admitted below-limit case, without
an oversized body or new harness. This revision is confined to admission
arithmetic/tests and its evidence; storage/network work remains out of scope.

The reviewer independently passed the 16 focused tests and confirmed the
65,537-item ordinary-array late getter is never touched. No other blocking
finding was identified. Review uses the independent non-implementing Astra
medium planning thread, not a fresh context, as disclosed in the brief. Root
authorizes the bounded second attempt after this evidence is upstream.


## Attempt 2 evidence (Luna, 2026-09-11)

Corrected the shared singular admission boundary in
src/stems/sparse-format.ts. Both the optional known payload path and the
metadata-derived payload endpoint now enforce
16 + canonical manifest bytes + payload bytes <= 8 GiB, while preserving exact
known-payload endpoint equality. serializeSparseStemPackage uses the same
checked helper. Added a metadata-only boundary regression in
tests/sparse-stems.test.ts for totals 8 GiB - 1, exactly 8 GiB and 8 GiB + 1,
with and without known payload length, using 256 chunk records at the 32 MiB
per-chunk ceiling and no large payload allocation.

Focused command:

    npm run build && node scripts/clean-test-dist.mjs && npm exec -- tsc -p tsconfig.test.json && node --test .test-dist/tests/sparse-stems.test.js

Result: 17 tests passed, 0 failed. The build and test TypeScript compilers
completed successfully. The broader adapter/package gates remain as recorded
for attempt 1 and were not rerun for this bounded arithmetic-only revision.
