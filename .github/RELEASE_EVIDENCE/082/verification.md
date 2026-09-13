# Independent verification — 2026-09-13

Updated verdict: implementation and targeted CI repair pass independent review; no remaining implementation blocker found. The original CI finding below is resolved by the addendum. No production/spec edits, pushes, publication or performance campaign by this reviewer.

Reviewed frozen identities:

- Codec HEAD `8c2823b041594a38284b01b5a39d77a6b515716e`, tree `0028688d80b1baf794508340bc477da590be4b38`; implementation `6265973b730230009b6d07705f1641a948120105`, base `970119ce723666267aa28856f315d7b702945a93`.
- Adapter HEAD `41fb6cd6f1c87d69e68717be18ab64ba18a5e1a1`, tree `296474913d9bded5fcc59780cd66388593a8dc20`; implementation `faf88955fd5c35282c0123554a475bed853014e6`, base `9b8172fd52746907c113442995dc7538cfe5ad13`.

## Required repair

Adapter package.json makes `build:sha256:wasm` mandatory in `npm run check`. Its npm-publish workflow runs that check after installing only Node/npm. It does not install Emscripten or set CODEC_EMSCRIPTEN_ROOT; the SHA build script defaults to `/data/codec-tooling/emsdk/upstream/emscripten`. Both hosted publish and verify dispatches therefore fail before qualification. Independently reproduced missing-toolchain `spawn .../emcc ENOENT` with a nonexistent toolchain override. Provision the pinned toolchain in that workflow and retain reproducibility verification. This is the sole implementation blocker found.

## Correctness and bounds

Decoder changes are compiler flags, feature/provenance metadata, generated asset/hash and documentation. Decoder source/control flow and encoder source remain unchanged. Disassembly confirms 222 SIMD instruction lines, only codec.read import, unchanged exports and fixed 32-page (2 MiB) memory. Asset: 75,923 bytes, SHA-256 `70caf38185675dff89498e89f98171d49ec6f143a56c6895088d93c35e2018cd`. Existing input/output caps, stacks and ABI remain intact.

SHA C preserves the existing constants, unsigned 32-bit schedule/round arithmetic and ordered chaining. SIMD reverses bytes within four independent big-endian words. Selected module: 957 bytes, SHA-256 `4435c2078c2783a77c06532e480d195ce314f500b849688d89d494432789fc28`. It contains 12 SIMD instruction lines (the spec's 13 appears to include the v128 local declaration), no imports, only memory/compression exports, fixed 64 KiB memory, 4 KiB stack and 256-byte schedule. State at 0 and input at 16 KiB do not overlap emitted stack/schedule/constants. Input batches stay within 16 KiB/256 blocks. Independent memory growth attempt throws RangeError.

Each hasher retains JS-owned state, tail, length and finished flag. Synchronous bridge copies state in/out and retains no caller view; no callbacks/await while scratch is borrowed. Initialization selects once and capability failure uses JS; runtime compression failures propagate. Padding/finalization are unchanged. The 131,072-byte accounting addition retains 8 MiB reservations. Resolver/store/worker readiness, integrity, cancellation and backpressure pipelines have no production edits. Existing NOTICE identifies the authorized SHA source; this C port introduces no separately borrowed algorithm/license dependency.

## Independently executed checks

- Adapter `npm run check`: passed SHA reproducibility, formatting, types/source policy, decoder audit, all 329 tests, build and package policy (208 files, 352,214 bytes). Log: verification-adapter-check.log.
- Codec `bun run check`: 40 passed, 5 expected native-only skips. Log: verification-codec-check.log.
- Codec `CODEC_NATIVE_FLAC=/data/codec-tooling/flac-scalar/src/flac/flac bun run test:integration`: 5 passed. Log: verification-codec-native.log.
- Codec `bun run build:wasm:verify`: encoder and decoder reproduced exactly. Log: verification-codec-rebuild.log.
- Independent Node crypto checks at lengths 0/3/55/56/63/64/65/16320/16383/16384/16385/16448/32768/49153/1000001, with offset DataViews and 113-byte streaming partitions. Fresh-module scenarios: WebAssembly absent; Module throws CompileError; normal accelerated backend. All passed. Instrumented normal path created one module/instance and performed 18,297 compression calls; capability failure attempted compilation once. An injected compression trap propagated without JS retry. Existing tests cover independent interleaved states, input mutation and finalization. Initial review instrumentation needed correction to preserve nonenumerable WebAssembly properties; these are the corrected results with explicit backend call counts.
- Packed rebuilt adapter with `npm pack --ignore-scripts`. Archive `/tmp/miso-simd-study/misofm-engine-web-adapter-0.4.0.tgz`, SHA-256 `df522f6e9d408f255d03e35c764f2da61680b911c693cfb180ab9b2284f851f1`. Extracted main dist/stems/sha256-wasm.js and bundled dist/internal/engine-web-flac-worker.js each contain exactly one payload with the selected SHA hash. No external SHA fetch is needed. This archive retains declared published codec 0.1.0; joint codec dependency/version qualification remains root-owned.

Implementation-reported gates, not redundantly rerun: codec packed Bun/Node and Chromium/Firefox/WebKit consumers with both Effect peers; adapter ordinary/indexed sparse packed browser profiles and Chromium OPFS. Root independently reports actual macOS Chromium/WebKit OPFS passing frozen adapter HEAD: https://github.com/misofm/engine-web-adapter/actions/runs/34750387870 . This resolves the Linux WebKit capability limitation for that revision.

## Measurement and release limits

Reviewed baseline/scalar/SIMD/adjacent/final evidence with matching totals: 35 chunks and 547,303,704 indexed PCM hash bytes including canonical zero gaps. Final record identifies frozen implementation commits and selected decoder hash. Preliminary evidence uses precommit HEADs with working changes; final postcommit evidence is the provenance anchor. Approximately 80% hash reduction is predominantly JS-to-Wasm; SIMD-versus-scalar adds approximately 1.5%. Decoder improvement is modest. These are isolated compute results, not app-open/network/OPFS speedups. Official post-verification comparison remains pending and determines which candidates ship.

After CI repair, perform targeted verification and record its revision. Root owns official measurements, version/dependency changes, publication and registry/app qualification. Tracked frozen source stayed unchanged; transient adapter SHA build cache created by verification was removed afterward.


## Targeted CI repair recheck — 2026-09-13

Reviewed adapter `088a14f57a945e6feb93145f3338943276a335dc`, tree `d453f0937c99954bd7a8917cec06ce2682f77ee5`; working tree clean. Diff from frozen `41fb6cd` contains only npm-publish workflow provisioning and issue-spec evidence. Runtime source and generated bytes are unchanged.

The workflow now clones Emscripten SDK tag 6.0.9, asserts SDK commit `5eb0bde7585670252e8ba05e9d361627bffd08b5`, installs/activates 6.0.9 and writes CODEC_EMSCRIPTEN_ROOT to GITHUB_ENV before the subsequent npm run check step. Its path resolves to the SDK root expected by the SHA build script, including sibling wasm-ld/wasm-opt and SDK release mapping. Provisioning is unconditional for both publish and verify modes. It matches the codec's existing pinned provisioning recipe. The build script continues verifying compiler commit, SDK commit/release mapping and Binaryen version; no gate was weakened.

Original CI blocker is resolved by inspection. Luna reports npm run check passing again (329 tests); full suites were not repeated because this repair changes no runtime/build-script bytes. Hosted execution of the repaired release workflow is still a release gate, not claimed as performed here. Independent verification is complete; hand off to the official after measurements and root-owned release qualification.
