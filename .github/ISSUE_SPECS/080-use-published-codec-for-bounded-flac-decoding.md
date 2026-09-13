# Use published @misofm/codec for bounded FLAC decoding

GitHub: https://github.com/misofm/engine-web-adapter/issues/80

## Objective and immutable baselines

Replace the adapter-owned libFLAC decoder ABI/backend with the public reusable codec while retaining dense and indexed sparse delivery, canonical PCM verification, browser admission, caching, playback, cancellation, and worker reuse. Do not add product delivery policy or inspect engine/app implementation. User-selected workflow is Astra medium scope, Luna xhigh implementation, fresh Astra medium verification; this supersedes the local Sol launch default.

Implementation base: misofm/engine-web-adapter main b13f06e2fa5d72a76957593cc0b7db13d4ea993e, package 0.3.8, engine 0.2.3, Effect 4.0.0-rc.112. The original cwd is research/77-lossless-delivery at 73e891df62375d1ee45d8228029796ef9597cb43 and MUST remain untouched. Implementation worktree: /home/bl/misofm/engine-web-adapter-codec, branch feat/80-codec-decoding, created from that main commit after fetching origin. Issue 77 research remains separate.

Dependency/API provenance: @misofm/codec@0.1.0 published from 12f54c988a2df319064e6ca3885268d976319cc1. Install this exact registry version and retain lock/integrity evidence. Root verifies registry propagation and publisher provenance. Do not copy codec implementation or use a local path dependency.

## Actual API contract

Public root exports decodeFlac(input: Stream.Stream<Uint8Array,E,R>, options?: FlacDecodeOptions): Stream.Stream<FlacDecodeEvent,E|FlacDecodeError,R|FlacDecoder>. Options are expectedFormat (sampleRate/channels/bitsPerSample), expectedFrames bigint, maxInputChunkBytes and maxMetadataBytes. Metadata gives format and block/count information; Pcm gives packed interleaved signed LE bytes, bigint frameOffset, and number frames; Complete gives bigint frames/bytes and MD5 status. Only Complete certifies codec verification. decodeFlac scope finalization must finish before worker reset acknowledgement.

The root exports makeFlacDecoderLayer(bytes: Uint8Array), FlacDecoder service with {module: WebAssembly.Module}, FLAC_DECODER_WASM_URL and FLAC_DECODER_WASM_SHA256. Byte loader helpers are NOT root exports. Root and ./wasm/flac-decoder.wasm are public; ./node provides FlacDecoderLive/loadFlacDecoder for Node tests only. Public layer hashes bytes and validates ABI. Decoder fixed memory is 2 MiB, input element <=256 KiB, output block <=384 KiB; asset <=256 KiB. SHA-256 is 5e282f9874ecb3f49b8ee8437efc318ec14ef5cff5b7580da9d875f94e5c5925. Codec Effect peer accepts rc.112 and rc.115, so keep adapter rc.112.

## Smallest coherent implementation

1. Exact codec dependency and lock update. Replace native-flac-decoder.ts raw ABI wrapper with a thin adapter integration using public codec APIs. Compile and integrity-validate once per existing decoder URL/pool ownership lifecycle, preserving concurrent waiter cancellation and retry. Preserve WebAssembly.Module structured cloning and independent per-job instances. Do not import codec internals or replicate ABI validation.
2. Preserve the host metadata scanner, including 128-block limit, declared-format policy and range-skip behavior. Current decoder receives a synthetic 42-byte STREAMINFO header with final flag, then only audio frames. Feed that existing decoderDescription first to decodeFlac, then the bounded shared-slot audio stream. This retains metadata range budgets and avoids rereading/skipping policy regressions; it does not claim codec verifies skipped metadata payloads. Pass expected format/frame count, retain zero/unknown STREAMINFO handling. Host verifies source delivery and canonical SHA-256 exactly as before.
3. Keep one fixed 256 KiB SharedArrayBuffer input slot and two PCM output credits. Bridge shared-slot consumer into a demand-pulled Effect Stream with no background/unbounded queue and no whole source collection. A bounded temporary copy is allowed only with explicit retention accounting; do not claim zero-copy. Consume codec events under output-credit backpressure. Preserve exact input credits/EOF/abort semantics and input/output/decode timing and runnable accounting. Do not emit PCM after terminal failure. Keep decode off render thread.
4. Adapt engine-web-flac-worker.ts to Effect stream/scoped execution, typed adapter error mapping, codec finalization and existing pool reset protocol. Emit complete/reset only after verified Complete AND finalization, then canonical hash completion and job-state clearing. Cancellation/failure poisons/terminates unsafe realms; healthy sequential jobs retain reusable physical workers. Destroy traps must still block reset even though old fake-ABI tests need new public-boundary fault injection.
5. Preserve public ADAPTER_ASSETS/ADAPTER_ASSET_FILES flacDecoderWasm key and override behavior. Recommended smallest compatibility path: build copies the exact installed codec-exported Wasm to the existing dist/internal/engine-web-flac-decoder.wasm URL; audit its hash against codec public constant. Adapter owns deployment layout, codec owns bytes/build. Bundle FLAC worker imports (as OPFS already does) so direct public Worker URLs do not contain unresolved bare Effect/codec imports. Packed Vite/factory-override tests must decide correctness. No Node imports in browser graph.
6. Delete redundant decoder/flac_decoder.c, private decoder hash, private build script, checked-in private Wasm, and vendored libFLAC source tarball only after migration tests pass and rg proves no active use. Replace check:decoder with installed-codec asset/hash/fixed-memory/integration audit, not a removed gate. Keep third-party license/NOTICE entries needed for redistributed codec Wasm and adjust package files/docs/AGENTS mission to codec-owned implementation accurately. Tests of old ABI allocator internals may migrate to codec public behavior/memory bounds; do not weaken behavioral tests.

## Compatibility blockers to resolve explicitly

Codec engines declare Node >=22.23.2 <23 and Bun >=1.4.2 <1.5, whereas adapter says Node >=20. Record the effective narrower dependency support and use Node 22.23.2 for gates; align adapter runtime declarations/docs/CI truthfully or obtain broader upstream support before claiming Node20. No speculative Node24 support. Public asset overrides now require the pinned codec asset; old private-ABI override bytes are incompatible and must fail typed. Document this migration limitation without silently accepting old ABI.

The codec's async decoder cannot simply substitute for the old processSingle synchronous wrapper. Input demand, output credits, resource scopes, cancellation and reuse must be adapted together. Do not cut a partial tranche that emits reset before stream-scope release. Existing private allocator/destroy-trap fixtures and policy scripts must be ported rather than blindly deleted.

## Objective gates and evidence

Run focused tests after coherent changes, then npm run check (format, types/source policy, decoder audit, full tests, package), npm run build. Add meaningful actual codec coverage: non-silent mono/stereo16/24 and variable/reordered fixtures; exact PCM bytes/digest; metadata mismatch, unknown count, truncation, CRC/MD5 mismatch, trailing bytes, corrupt/wrong Wasm; no successful completion/reset on failure. Exercise cancellation during load/input/output stalls, stale messages, sequential reuse, independent memory, poisoned-worker disposal, shared admission, and finalization failure. Preserve readiness only after full byte-count/SHA verification and OPFS commit.

Run actual packed fresh consumer ordinary and --indexed-sparse browser profiles. Prove playable output/seek, canonical PCM, warm/no-network and all-silent paths, exact asset fetch/compile counts, physical worker reuse and positive runnable overlap where current gates require it, no Worker/bare-import/MIME failures, and complete physical cleanup. Use archive-installed public exports; retain tarball SHA, revision/tree, install lock, browser versions and JSON/logs outside tracked paths. Existing harness dependency copies must be disclosed; additionally run a clean normal npm install of the archive with registry codec, public type/import and Vite production build. Run relevant OPFS browser tests; record preexisting Linux WebKit limitation only with baseline evidence and use existing macOS CI if needed for release qualification. No mobile measurements or unrelated app edits required.

Fresh Astra medium adversarially reviews frozen candidate and reruns discriminating boundary, asset, failure and reuse tests; implementation self-report is insufficient. Append exact candidate, changed paths, commands/results, artifact provenance, reviewer verdict and outstanding publish-readiness blockers to this spec and synchronize issue. Merge/publication are root-owned separate actions; do not claim either from candidate qualification.

## Related downstream assessment

Astra also inspected misofm/transcoder main `0f9f2eaf7a5f286e6d0b0b6e961dc8c4fe631549` (0.2.0). It uses FFmpeg/FFprobe for AAC fMP4 HLS and has no private FLAC backend to replace. Codec 0.1.0 cannot provide that AAC/HLS path, so this migration leaves transcoder unchanged. A future FLAC-specific feature requires its own justified spec and runtime compatibility decision.

## Implementation candidate evidence

The candidate remains based on `b13f06e2fa5d72a76957593cc0b7db13d4ea993e` in
`/home/bl/misofm/engine-web-adapter-codec` on `feat/80-codec-decoding`. It uses
the registry dependency `@misofm/codec@0.1.0` with lockfile integrity
`sha512-Oleo8mUbyNzooQIgOsdxfxBYGhBXAJyGvZCna5cTcD8vGdfgcxMTUvzbCSccEOUYQ6vg+87WbI0UYmcEQpAk0w==`
and registry resolution, with Effect `4.0.0-rc.112`. The copied decoder asset
is the installed public asset with SHA-256
`5e282f9874ecb3f49b8ee8437efc318ec14ef5cff5b7580da9d875f94e5c5925` and fixed
2 MiB memory. Runtime declarations now truthfully follow the public codec:
Node `>=22.23.2 <23`, Bun `>=1.4.2 <1.5`.

The implementation replaces the private decoder ABI with a thin public codec
layer, feeds the synthetic 42-byte STREAMINFO plus one reusable 256 KiB shared
input bridge into an Effect stream, retains two PCM output credits, transfers
codec-owned PCM blocks where ownership permits, hashes canonical PCM in the
host worker, and emits reset only after Complete and the entire scoped stream
finalization settle. Unknown codec totals are accepted while host final counts
remain mandatory. A duplicate initialize is refused. Loader responses cancel
their body on status, MIME, oversize, and read failures. The fixed admission
accounting explicitly includes the bounded bridge (`4,460,560` accounted bytes,
`3,928,048` headroom). The old private C/backend, Wasm, tarball, and build
script are removed only after the replacement tests pass. The packed adapter
retains codec third-party notices and licenses under `dist/codec-licenses/`.

Changed paths are `package.json`/`package-lock.json`, `src/internal/engine-web-flac-worker.ts`,
`src/stems/native-flac-decoder.ts`, `src/stems/flac-worker-pool.ts`,
`src/stems/flac-admission.ts`, the asset/audit/package scripts, browser harness
scripts, `README.md`, `AGENTS.md`, and `NOTICE`; focused tests are
`tests/native-flac-foundation.test.ts`, `tests/flac-worker-reuse.test.ts`,
`tests/codec-worker-integration.test.ts`, `tests/codec-worker-finalizer.test.ts`,
`tests/codec-worker-runner.ts`, and the updated session accounting assertion.
The removed paths are the adapter-owned `decoder/` C/ABI fixtures and build
script, checked-in private decoder Wasm, and `vendor/libflac-1.5.0/` archive and
license copy.

The focused public codec tests cover exact multiblock stereo-24 PCM and SHA-256,
metadata mismatch and unknown totals, reordered/truncated/invalid streams,
wrong and corrupt Wasm, bounded input/output behavior, worker reuse, module
single-flight/retry/cancellation, and admission accounting. The finalizer gate
compiles a real public decoder module whose public `codec_decoder_delete` export
traps, runs a real worker decode, and proves no Complete/reset is emitted, the
failure maps to `stem.decode.asset`, and the worker closes instead of being
reused.

Validation completed:

* `npm run format:check`, `npm run lint`, `npm run check:decoder`, and
  `npm run check:package` passed. The complete suite passed `322/322` tests.
  The package gate reports 202 packed files and requires the public codec
  notices/licenses and copied Wasm.
* `CHROME_EXECUTABLE=/home/bl/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome npm run test:browser`
  passed with Chromium `153.0.8010.12`: ordinary packed cold/warm FLAC,
  canonical digest, playback/seek, worker reuse, asset MIME, and cleanup all
  passed (cold decoder fetch/compile counts were 1; warm counts were 0).
* The same command with `--indexed-sparse` passed with Chromium
  `153.0.8010.12`: 24-bit active sparse spans, all-silent no-decode, one
  shared compile for serial/concurrent jobs, 1-worker reuse, 2-worker overlap,
  reset counts, warm no-network verification, and physical cleanup all passed.
* `CHROME_EXECUTABLE=... npm run test:browser:opfs` passed Chromium OPFS
  ingest/reopen/sparse cleanup. Linux WebKit `26.5` reaches the existing
  platform limitation because `FileSystemFileHandle` is undefined; this is
  recorded as a release qualification blocker requiring the existing macOS
  WebKit baseline/CI evidence.
* A fresh consumer copied from `/tmp/codec-adapter-consumer-template` installed
  the packed archive with ordinary npm metadata, resolving registry
  `@misofm/codec@0.1.0`, then passed strict typecheck and Vite `8.2.2`
  production build. The outside-worktree archive receipt is
  `/tmp/codec-adapter-clean-consumer-J0jseB/evidence/misofm-engine-web-adapter-0.3.8.tgz`
  with SHA-256
  `25f9b11fddd4fb7e6f19c123789744203b1a5bf542ccc4d056f7123a151b716e`.
  The packed browser harness copies the exact installed registry codec into
  its temporary consumer because it intentionally does not run a second npm
  install; the clean consumer above is the normal-install evidence.

Compatibility is intentionally narrower than the previous Node 20 declaration,
and old adapter-private-ABI asset overrides are incompatible: the loader now
requires the pinned public codec asset hash and ABI and fails such overrides
with a typed asset error. The package remains version `0.3.8` in this
candidate; the runtime and asset-override breakage should be resolved as a
release-version decision by the root owner before publication. No publication,
merge, or issue synchronization is claimed here. Fresh Astra review and the
macOS WebKit qualification remain outstanding.

The implementation checkpoint verdict is green for the listed local and packed
Chromium gates, with the independent root worker boundary check also passing
both public decode and finalizer-failure cases. Publication readiness is not
claimed until the fresh Astra adversarial review, the normal archive consumer
receipt is retained by root, and macOS WebKit supplies the required OPFS
qualification evidence.
