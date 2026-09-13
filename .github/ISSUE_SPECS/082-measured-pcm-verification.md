# Measure and improve bounded incremental PCM verification

GitHub: https://github.com/misofm/engine-web-adapter/issues/82

## Objective and immutable scope

Reduce measured PCM verification compute with a small drop-in incremental SHA-256 compression backend. Measure scalar Wasm and SIMD separately; claim SIMD benefit only when the SIMD candidate improves on the scalar control. Preserve all compressed/chunk/canonical checks, including omitted zero gaps, exact counts, ready/commit ordering, bounded memory, synchronous hash API behavior, cancellation, physical ownership, and public APIs. No worker pool, hash batching across stems, whole-file WebCrypto, network/OPFS redesign, alternate digest, WebGPU, format change, or engine DSP work.

Published baseline / candidate base: adapter 0.4.0 `9b8172fd52746907c113442995dc7538cfe5ad13`, codec 0.1.0 `12f54c988a2df319064e6ca3885268d976319cc1`, engine 0.2.3, Effect rc.112. Candidate tree `/tmp/miso-simd-study/candidates/adapter`, branch `perf/simd-verification-82`. Preserve read-only baseline `/tmp/miso-simd-study/worktrees/adapter` and original unrelated research worktrees. Do not inspect legacy engine source.

User-selected sequence overrides local default: Sol high baseline → Astra xhigh scope → Luna xhigh implementation → fresh Astra medium independent verification → identical after benchmarks → root release/app integration if positive. Baseline and scope complete; implementation, review, positive comparison and release pending. User authorizes this conditional sequence; do not introduce an extra routine permission step.

## Measurement and actual call sites

Evidence in `/tmp/miso-simd-study/evidence/`: `representative-bun-baseline.json` and `browser-baseline.json`. Bun 1.4.2 seven-round representative PCM SHA median 395.068 ms (390.476–397.479), decode 57.345 ms (55.566–58.863), for 7,938,000 PCM bytes.

Chromium 153.0.8010.12 full Ghost r1 corpus: eight stems, 35 chunks, 249,323,400 active PCM bytes plus 48,656,904 zero-gap bytes. PCM verification hashes each chunk's active bytes and then the entire canonical timeline: 547,303,704 total hashed bytes. Three-round median 11,456.6 ms (11,428–11,464). Corresponding five-round decode medians: one worker 2,258.0 ms, eight-worker makespan 391.9 ms. All package/chunk/canonical identities pass.

The harness isolates compute using retained decoded blocks and reconstructed canonical gaps. It is not a full HTTP/OPFS install or app-open benchmark; compressed SHA checks pass but are not included in this PCM timing. Production indexed delivery uses one full HTTP 200 streamed container per stem. Compressed SHA (`decoder-byte-source.ts`), chunk PCM SHA (`flac-resolver.ts`), and canonical ingest/warm SHA including zero gaps (`sparse-store.ts`) currently use the main-thread `IncrementalSha256`. Do not change `workerHashes` or move these checks. The independent network/OPFS audit is advisory and its candidates remain out of scope.

## Smallest implementation and ownership

1. Retain `IncrementalSha256.update`, `digest`, `digestHex`, and `sha256Stream`; retain accepted ArrayBuffer/view input offsets, independent hash state, length/padding semantics, finalization errors, and streaming counts. Keep JS-owned chaining state/tail/length; route complete blocks through one private compression backend in bounded batches.
2. Add a small freestanding C SHA-256 compression kernel derived from this adapter's existing authorized algorithm, without allocator/imports/callbacks. Build scalar control and `-msimd128` candidate with the same pinned toolchain. Start with autovectorization; at most one small intrinsic refinement confined to block loading/schedule/state operations is within scope. Keep ordered compression rounds and canonical identity. No SIMD across stems or new scheduler.
3. One private lazily initialized Wasm instance per realm, fixed 64 KiB memory, input scratch <=16 KiB. Each hash keeps JS state, copied in/out for every bounded call. Never create a memory per hash or retain caller input. No reentrancy/callback/await while shared scratch is borrowed. Account conservatively for host/worker fixed scratch in existing `FLAC_PACKAGE_MEMORY_COMPONENTS` headroom while retaining 8 MiB per-worker reservations and current app concurrency/budget.
4. Embed the selected bytes in a generated private TS module, preserving current browser/worker asset deployment and inert imports. Keep C source, pinned build script, SHA manifest/provenance, licenses, and reproducible `--verify`. Keep existing JS compression as initialization/capability fallback. Do not swallow runtime hashing failures, change backend mid-digest, or expose a new public factory/configuration.
5. Compare current JS, scalar Wasm and SIMD Wasm with identical workloads including bridge copies. Retain only one measurably useful production Wasm variant plus JS fallback. If only scalar wins, report it accurately as a scalar optimization and record lack of useful SIMD evidence. If neither wins, retain existing implementation. Do not add SIMD instructions merely to satisfy a label.

Owned paths: `src/stems/sha256.ts`, one private compression/generated-byte module, `native/sha256.c`, `scripts/build-sha256-wasm.mjs` or equivalent, SHA manifest, fixed-accounting entry in `src/stems/flac-admission.ts`, focused `tests/sha256.test.ts`, build/check wiring, README/NOTICE where needed, issue/evidence files. Existing resolver/store/worker control pipelines stay unchanged except a separately explained minimal fix for a demonstrated integration bug. No new runtime dependency is expected. If Effect implementation changes become necessary, read and pin the required guidance.

If codec #6 independently qualifies, update exact codec dependency/lock and public asset hash pins in `scripts/copy-assets.mjs`, `scripts/check-flac-decoder.mjs`, and package checks. Preserve engine 0.2.3, Effect rc.112, public asset keys and Worker URLs. Use exact candidate tarballs in isolated pre-release consumers; never commit a local-path dependency. Root releases codec first, then verifies adapter using its exact registry version. A hash-only adapter release is permitted when decoder SIMD is not positive.

## Focused correctness and performance acceptance

Compare independent trusted SHA digests for empty/known messages, boundaries 55/56/63/64/65 and around the 16 KiB scratch limit, irregular partitions, nonzero-offset Uint8Array/DataView inputs, interleaved independent hashers, zero blocks and finalization errors. Force selected Wasm and JS fallback; verify fixed memory/imports and synchronous ownership of input. Keep tests small and meaningful; no new generalized fuzzing framework or corpus fixture.

Retain current compressed/PCM mismatch and canonical-gap corruption tests, warm-cache recheck, final-byte cancellation/no-ready behavior, worker reuse/finalization, bounded credits and OPFS commit/cleanup. Existing suites provide these gates; do not weaken them or rewrite unrelated pipelines.

Use identical benchmark CPU/browser/runtime, frozen corpus and fragments, warmups, seven representative Bun rounds, five full-corpus browser decode rounds, and three full-corpus SHA rounds. Harness `/tmp/miso-simd-study/harness/run-browser.mjs` accepts candidate roots. The runner now records versions and Git revisions from selected roots; keep that metadata truthful without changing timed work. Exact rerun instructions are in `/tmp/miso-simd-study/harness/README.md`. Keep original raw evidence and harness hashes. Serialize benchmarks/builds; one adjacent baseline/candidate confirmation is appropriate for noisy results, repeated attempts to find a win are not.

Positive means a repeatable whole-corpus target-stage improvement exceeding observed run variation, no material regression in supported runtimes/decoder modes, identical digests/counts, and bounded resources including declared fixed SHA scratch. Report samples, medians/ranges, percent change, Wasm scalar-versus-SIMD comparison, artifact size and compile/init cost. A representative-only win or presence of SIMD opcodes is insufficient. Claims remain compute-only until a real app before/after measurement exists.

## Existing qualification and release requirements

Run SHA reproducibility verification and `npm run check` (format/types/source policy, decoder audit, full tests, package), plus existing packed browser ordinary and `--indexed-sparse` profiles and `npm run test:browser:opfs` Chromium/WebKit qualification. Keep fresh archive-installed consumer type/import/Vite checks, real Worker asset behavior and licenses. Use established macOS OPFS CI for the known Linux WebKit platform limit rather than claiming an unrun gate passes. Verify selected hash bytes reach actual deployed main/worker bundles. Do not commit caches/dependencies/corpus/tarballs/secrets.

Fresh Astra medium reviews frozen commit/tree and independently verifies the SHA algorithm, bounded bridge/state isolation, compatibility fallback, package/build provenance, retained cancellation/readiness, meaningful tests and comparison. Record exact evidence and verdict here before release. Root owns version/lock/release workflow updates, trusted publication, registry integrity/consumer verification, then app exact dependency integration and mandated lint/typecheck/test/build. Keep app concurrency eight, maximum workers eight and 64 MiB budget unchanged. Existing app open/play/warm/seek smoke can be rerun for function; old timings using other concurrency are not a load-time baseline.

Companion plan `/tmp/miso-simd-study/simd-plan.md`; codec issue https://github.com/misofm/codec/issues/6. SHA algorithm reference: FIPS 180-4 section 6.2, https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf . No implementation or publication is claimed by this scope.

## Luna implementation evidence (candidate, not published)

The drop-in backend keeps the existing JS state, tail, length, padding, and
synchronous API. Complete blocks are copied into one private 16 KiB scratch
window and processed in bounded batches of at most 256 blocks; each hasher
copies its eight-word state in and out on every call. Backend initialization is
lazy and realm-local. Initialization failure selects the unchanged JS
compression path; a selected backend is not changed during a digest.

`native/sha256.c` is freestanding and import-free. The scalar build is 1,347
bytes (`d97b0d1b1b7f2f95895dc4228c796453fde631f993c68925c65c4a8c8cf69577`)
and the SIMD build is 957 bytes
(`4435c2078c2783a77c06532e480d195ce314f500b849688d89d494432789fc28`). Both
export only `memory` and `sha256_compress`, use one fixed 64 KiB page with no
growth, and agree with Node crypto for a 16 KiB batch plus padding. The selected
SIMD generated module records the pinned Emscripten 6.0.9 provenance and
`-msimd128`/`simd128`; its `wasm2wat` output contains 13 SIMD operations. The
single intrinsic refinement is four-at-a-time big-endian message-word loading;
compression rounds remain ordered and scalar.

Focused tests cover empty/known data, 55/56/63/64/65-byte boundaries, the 16
KiB batch boundary, irregular partitions, nonzero-offset DataViews, interleaved
hashers, zero blocks, input mutation after synchronous update, forced JS and
Wasm backends, and one-shot finalization. The existing full suite remains
unchanged apart from the fixed accounting expectation. The reservation now
charges two 64 KiB realm pages as `sha256WasmScratch`, increasing fixed bytes
from 4,853,776 to 4,984,848 and leaving 3,403,760 bytes of the 8 MiB slot as
headroom.

On the frozen full Ghost r1 corpus in Chromium 153.0.8010.12, the unchanged
baseline's adjacent PCM verification median was 11,540.5 ms (11,536.0–11,569.9).
The scalar Wasm candidate was 2,224.7 ms (2,224.7–2,225.5), and the selected
SIMD candidate was 2,190.4 ms (2,188.7–2,191.0), followed by an adjacent SIMD
run at 2,189.8 ms (2,189.8–2,194.6). SIMD is therefore 1.54–1.57% faster than
the scalar control and the scalar control is 80.72% faster than the unchanged
baseline. The representative Bun seven-round medians were 34.83 ms scalar
and 33.73 ms SIMD for the same 7,938,000-byte PCM chunk, versus 395.068 ms JS.
All 8 package, 35 compressed-chunk, 35 decoded PCM-chunk, and 8 canonical
identities passed in the browser runs; the canonical workload retained its zero
gaps and hashed 547,303,704 bytes.

Local gates passed: SHA `--verify`, `npm run check` (329 tests passed), packed
ordinary browser and `--indexed-sparse` profiles, and Chromium OPFS. The
required WebKit OPFS run is blocked on this Linux host by its known missing
`FileSystemFileHandle` global; the established macOS qualification workflow
remains the appropriate gate. Fresh independent review and root release remain
pending; this candidate does not claim publication.
