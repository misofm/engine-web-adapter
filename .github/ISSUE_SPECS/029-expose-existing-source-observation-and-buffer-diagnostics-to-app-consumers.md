# Expose existing source observation and buffer diagnostics to app consumers

## Existing app behavior and ownership

App#101 needs its existing focused input-source spectrum and feed/buffer diagnostics. Reviewed SDK#434 supplies a bounded read-only observer and existing wire counters. Adapter owns mapping compiled source IDs to feed rings and pump allocations; app keeps FFT/display and diagnostic aggregation. Expose these facts without private app ring arithmetic, new telemetry, graph taps or a diagnostics framework.

## Minimal public contract

Add EngineWebSession.observeSource(sourceId): SourceObservation with sampleRateHz, channels, pull(consume:(chunk:PcmSourceChunk)=>void,maximumChunks?:number):number and close():void. Validate source ID; unknown source uses existing stem.not_found with sourceId detail, closed session uses session.closed. Delegate to a fresh SDK observer for independent cursors, track lifetime, and close all on session close. Callback planes remain borrowed and frames is authoritative. App retains its2048 FFT and focused-view activation.

Add EngineWebSession.feedDiagnostics() returning a read-only snapshot {sources: readonly (Msb1RingCounters & {sourceId:string})[], allocation:{sources:number,ringBytes:number,engineMemoryBytes:number,observationBytes:number,pump:null|{windowFrames:number,maximumWindowBytes:number}}}. Read counters through SDK observers, never duplicate offsets or ring arithmetic. Reuse one counter observer per source; do not create them per snapshot. Include their fixed reusable scratch buffers plus registered source observers honestly in observationBytes (channels*quantum*4 per observer), so this small duration-independent allocation is visible rather than hidden. Close/release adapter-owned observer references at session cleanup. Do not claim JS objects, browser heap or atomic multiword snapshots are measured by this buffer projection.

Extend existing EnginePump with optional readonly allocation:{windowFrames,maximumWindowBytes}. Default PcmPumpWorkerClient retains and validates its existing initialized bounds reply and exact requested/default windowFrames; wrong reply/invalid bounds fails with owned cleanup. Existing protocol already carries windowBytes/ringBytes, so no new messages/worker protocol needed. Actual feed SAB byteLength sum and host.memoryBytes are authoritative. A custom pump with no allocation returns null; never fabricate zeros/default estimates. Preserve all startup/prefill/play/seek/close behavior.

## Scope and provenance

Start isolated codex/dx-app-projections from reviewed adapter#24 +#25. Consume reviewed SDK#434 source8a19a848 archive /private/tmp/dx-reviewed-sdk434/misofm-engine-0.1.0.tgz SHA2565694c21f1e4eb99f6366d7bcc0330f0af06744768810edc3cc6e0e186df09488 using local no-save install. Preserve dependency metadata until exact vendored app adoption; no fake registry version. Update source provenance/NOTICE only to actual SDK ownership as needed.

Allowed src/session.ts, src/session-types.ts, src/index.ts, src/stems/worker-client.ts, src/provenance.ts/NOTICE, README, existing session/pump-worker/public-type tests and packed browser/package gate only for narrow assertions, this spec. No store/storage/decoder/ingest changes (quota#27 independent), no SDK source edits, no generated artifact, ring/prelude or schema change. Per-open ingest retention remains its own bounded slice.

## Evidence

Existing tests prove source mapping, unknown/closed errors, independent bounded observer cursors and session-close cleanup; compare observer/counters against actual SDK rings, never a copied layout. Allocation snapshot uses actual odd-source mono/stereo SAB sizes, default pump requested frames/reported bounds, and custom-pump null. Verify wrong/invalid initialized reply cleanup with existing worker fixture. Read-only observation cannot move playback indices or change prefill ordering. Run type/focused first, pause rootcheckpoint; full npm run check and existing packed browser playback/seek/close with source observation afterward. No new matrix/framework or performance benchmark. Astra medium implements; a dedicated independent Astra medium reviewer checks final source/evidence.

Matching issue misofm/engine-web-adapter#29.

## Attempt 1 focused checkpoint

Astra adds the public SourceObservation, FeedDiagnostics and PumpAllocation projections. Sessions reuse one SDK counter observer per compiled source and create independent observers for each source subscription; snapshots count both kinds of scratch, actual SAB bytes and host.memoryBytes. Closing observations releases their allocation count; session cleanup closes all remaining observers. Existing startup/prefill and lifecycle sequencing remain intact. Default pump clients retain requested/default windowFrames and the initialized Worker window bound, validate reply kind and safe nonnegative bounds (positive window for nonempty sources), and compare reported ringBytes with actual source SAB sizes. Invalid replies terminate and detach owned listeners before rejection; custom pumps without facts project null.

Reviewed SDK434 archive hash matched the frozen digest. Its local no-save/no-lock/offline installation used an isolated temporary npm prefix, then the installed SDK package was copied into this checkout's own dependencies; package.json/package-lock.json are unchanged. The initial direct install could not write the default npm cache, and whole-checkout offline resolution requested uncached registry metadata; no other checkout or SDK source was changed. NOTICE/provenance now name the consumed 8a19a848 SDK source and exact archive.

`npm run typecheck`: PASS (`/private/tmp/dx29-typecheck.log`). Build + existing session/pump/public-type suites: PASS, 27 tests (`/private/tmp/dx29-build.log`, `/private/tmp/dx29-focused.log`). The three-source mono/stereo fixture compares counters with real SDK observers, preserves all shared bytes during observation, traps counter-snapshot scratch allocations, and proves observer cleanup. Pump fixtures cover requested/default frames, retained reported bounds, invalid replies and owned cleanup. The existing packed consumer/browser gate now includes narrow source observation and buffer assertions; full/package/browser validation follows root's exact-path checkpoint and is not yet claimed.
