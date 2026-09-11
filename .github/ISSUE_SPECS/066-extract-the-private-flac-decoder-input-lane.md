# Extract the private FLAC decoder input lane

## Attempt 1 intermediate implementation checkpoint

Luna xhigh extracted the private byte source and provided range Effect, replaced inputTail with a capacity-one Effect Queue, and added a synthetic sequential source through the existing controller. Producer reports typecheck, compiled focused resolver/cancellation/watchdog/source tests, lint and format checks passing. This is recoverable implementation groundwork, not an independent verdict. Root identified remaining contract work before full qualification: controller-side credit validation before source invocation, input admission shutdown at completion, cancellation/borrow handoff ownership, preserving complete Effect failure/cleanup causes at the existing edge, and delayed/rejecting finish plus invalid-credit/overflow/cancellation discriminators. Avoid an unnecessary extra copy of every legacy range. Full package and actual packed Chromium native decode checks remain. No acquisition/indexed install or public API is claimed by this checkpoint.

## Attempt 1 review candidate

Luna added controller credit validation, terminal input admission, a runPromiseExit edge with teardown-cause preservation, removed redundant range copying, suspended the watchdog during source operations and added delayed/rejecting finish plus invalid/stale-credit, overflow and cancellation discriminators. Source/test type compilation, lint and format checks pass; root independently reran all29 delivery/worker tests successfully (`/data/sparse-pcm-launch/tooling/adapter-66/attempt1/root-focused.log`).

This is a frozen review candidate, not acceptance. Root flags the new range handoff arrangement for independent scrutiny: its ensuring cleanup runs inside the range Effect while the caller invokes the handoff marker only after that Effect returns, which appears to release the borrow before acceptance. Full package and actual packed Chromium evidence remain pending. The independent review must assess actual ownership/finalizer ordering and complete causes rather than infer correctness from the happy-path bytes. The legacy API and accepted resource contracts remain mandatory; no broader acquisition work starts before this issue passes.

## Independent attempt 1 FAIL; bounded attempt 2

Fresh Astra medium reproduced five defects in the actual compiled controller at16398f16a3e1bbaa59a6cb6c8bca9a0014ef6e3d despite all272 package tests passing. Review and executable repro are retained at `/data/sparse-pcm-launch/tooling/adapter-66/review-attempt1.md` and `attempt1/adversarial.{mjs,log}`. Findings: legacy delivered-byte ownership is already released at slot copy; synchronous cancellation in a successful read loses its release; late PCM during delayed finish bypasses completed counters and reaches successful EOF; two legacy FLAC error codes changed; flattened Cause mapping loses typed operation/message and explicit undefined failure evidence. Actual packed Chromium was deferred because this candidate requires correction.

Attempt 2 corrects only the existing ownership, terminal admission and error mapping. Establish one operation-local current-borrow owner or an equivalently bounded source-owned scope, with cleanup registered before acquisition callbacks can cancel, adoption before yielding, and release/clear after actual slot copy or failed/interrupted settlement. Keep asynchronous source waits interruptible; do not accumulate one finalizer per historical range, add another resource framework or use copying to hide ownership. Sources must retain ownership before interruption can discard a returned lease. Stop all new worker production at first completion while draining already accepted outputs and awaiting finish. Restore exact legacy stem.flac.invalid and stem.flac.shape errors, and retain typed source context plus complete Fail/Die/Interrupt reasons including undefined values and cleanup errors at the existing edge.

Required discriminators are the retained copy-boundary and successful-read/abort races, late PCM/duplicate completion/readiness during delayed finish, exact old error codes and the compact full-Cause cases in the review. Run focused tests then the full package and actual packed native Chromium on the corrected frozen candidate; receive one fresh independent Astra medium verdict. This is attempt2 of at most5, not a reset. No indexed acquisition or release begins from the failed candidate.

Astra medium scope, rechecked by root against merged adapter d23f98579c8cf59e8e8109bf1d864ac62f730b3d after issue64 acceptance. The FLAC resolver/delivery source is unchanged from the planner baseline. This is acquisition slice A only, after accepted store/session integration. No public API, indexed parser, full GET, sparse install, codec ABI or app change.

## Smaller than the acquisition umbrella

Do NOT move/rewrite the whole ~350-line resolver controller as a prerequisite. The concrete coupling is flac-resolver.ts's range(), prepare() and handleCredit(): ranged metadata reads establish STREAMINFO/audio offset, then worker credits cause exact ranged suffix reads. Extract these into one private encoded source, and replace only the Promise inputTail lane with one composed Effect input lane. Preserve the existing single worker pool, PCM output queue/credits, stream adapter, diagnostics registration and legacy watchdog behavior. No duplicate controller.

Private source shape, not exported from package entrypoints:

```ts
interface DecoderByteSource {
  readonly prepare: Effect.Effect<{
    readonly streamInfo: NativeFlacStreamInfo;
    readonly expectedFrames: number;
    readonly totalPcmBytes: number;
  }, EngineWebAdapterError>;
  readonly read: (maximumBytes: number) => Effect.Effect<{
    readonly bytes: Uint8Array;
    readonly end: boolean;
    readonly release: () => void;
  }, EngineWebAdapterError>;
  readonly finish: Effect.Effect<void, EngineWebAdapterError>;
}
```

Use actual existing STREAMINFO type spelling at implementation. The source is scoped and operation-local. prepare occurs once; reads are sequential, produce1..maximumBytes up to FLAC_INPUT_SLOT_BYTES, and explicitly mark encoded EOF. Controller validates credits before source invocation and validates returned length before slot publication. Release each borrowed range after slot copy even on failure/cancellation. Source metadata establishes expected decoded shape; no source/cache routing or PCM identity authority is transferred to this interface.

Legacy implementation retains existing readExactFlacRange request phases and offsets, probe42 bytes, NativeFlacMetadataScanner header reads, skipped metadata bodies, request normalization/retry/ETag/extent checks and download admission. It owns its existing offset/totalBytes/deliveryState; controller no longer needs them. Its finish is a no-op preserving legacy behavior, not a new assertion that legacy ranges hash every metadata/payload byte. Future finite full-response sources will implement finish as their exact byte/hash drain barrier.

## Effect boundary and resource ownership

Expose the existing flac-delivery.ts provided/scoped range Effect through a PRIVATE module export used by the new source. Preserve readExactFlacRange's existing Promise wrapper if needed by current callers/tests. Do not wrap that runPromise function in another Effect.tryPromise and run it per credit. Keep its transport cleanup/admission semantics; this slice is not a rewrite of delivery retries or its historical cleanup timer.

At the existing pool work boundary, run ONE scoped Effect input program. It consumes ready/credit events sequentially and calls source.prepare/read directly. Replace inputTail; do not leave the old Promise lane active beside a new Effect lane. A tiny bounded Effect Queue or callback bridge is sufficient; pinned rc112 has Queue.bounded, offerUnsafe and take. Worker listener enqueue is synchronous host interop. Capacity needs only one pending input command beyond the active command because one input slot supplies the backpressure; refuse unsolicited overflow with the existing worker protocol error rather than creating unbounded fibers or queued Promise continuations. Do not add another processing admission controller.

Scoped source acquisition/finalization and borrowed-byte release are real composed Effects, not one tryPromise around the old controller. Existing networkPending/watchdog activity hooks can remain narrow callbacks invoked around Effect source operations: network waiting and two-full-output backpressure must still suspend decode watchdog counting. Keep inherited numeric/slot/metadata kernels unchanged. This slice need not migrate unrelated pool/output scheduling or every legacy timer to Effect.

On worker complete, prevent further input, settle the current input operation, then await source.finish before declaring the workflow ended/closing the consumer stream. Do not interrupt a successful source before finish can drain its future bounded remainder. Pending PCM outputs may drain under existing credits, but output-stream EOF cannot precede finish. On cancel/error, abort the actual source signal/input slot, terminate via existing pool ownership, stop input admission and await scoped source cleanup. Preserve physical range settlement/quarantine semantics and no late slot publication. New expected failures use existing adapter error mapping; retain causal cleanup information rather than silently discarding a new source-finalizer failure.

No new ManagedRuntime/service catalog, source registry, worker reset protocol, HTTP emulation or custom stream framework. No per-helper runPromise. Runtime entry belongs at the existing resolver/pool callback edge. A private test injection of DecoderByteSource is sufficient to prove reuse; no public generic decoder interface is required. Expected per-decode digest versus whole-source identity can remain the current identity policy in this slice; the installer will supply the concrete chunk-integrity adaptation when it has a consumer.

## Discriminating gates

- Existing native ranged resolver request trace remains the same, including metadata skips, inclusive audio ranges, caller Request policy and short/mismatched range refusal. Existing metadata, retry, deadline and cancellation tests remain green.
- One synthetic sequential encoded source drives the SAME existing controller without fetch/Range/Response emulation. Use existing worker fixture and small encoded bytes, not another decoder harness. Assert prepare once, no overlapping reads, maximum requested/returned slot bytes, exact EOF publication and release once.
- Preserve two output credits/queue cap and output buffers, fixed shared input slot and worker-pool admission. Stale request IDs/invalid credits never access the source; bounded input-command overflow refuses.
- Delayed/rejecting finish proves decoded completion cannot produce successful output EOF early. Cancellation while prepare/read/finish is pending produces no late slot writes and settles the owned source/worker. Output backpressure and source-read wait do not trigger an unrelated decoder stall.
- Run focused resolver/delivery/input-slot/pool tests and one full package check. Existing packed browser native decode smoke proves package-private extraction still bundles/loads correctly. No sparse OPFS, new browser matrix or transport benchmarks.

Expected files: flac-resolver.ts, one small private decoder-byte-source module, the minimal private Effect export in flac-delivery.ts, existing focused tests and issue evidence. Keep public exports/types unchanged. Prefer reduced lines in resolver over new reusable layers. Full-stream cursor, format dispatch, compressed/chunk/full-canonical hashing, span mapping and sparse cache commit remain slice B/C; none is hidden in this extraction.

## Delivery and typed boundary

New expected Effect failures use small private Schema.TaggedError values retaining original causes, with public EngineWebAdapterError codes/details preserved at the existing Promise edge. Do not leak arbitrary unknown into the new source/input Effect failure channel or migrate unrelated historical dense code. Pure byte kernels remain ordinary functions.

Luna xhigh implements one coherent attempt, then a fresh non-implementing Astra medium supplies one adversarial PASS/FAIL; maximum five attempts. Root owns exact-path compiling/focused-green checkpoints, prompt pushes and matching GitHub synchronization. Pause at the first coherent tranche and within30 minutes before layering more implementation. Full package and actual Chromium packed native decode checks follow the bounded change. Final user-requested Astra xhigh simplification occurs after the full functional flow, not as this extraction's acceptance.

## Attempt 2 recoverable correction checkpoint

Luna corrected the five bounded attempt 1 findings: operation-local pre-registered borrow ownership, terminal production refusal while finish drains, original legacy error codes, and full source/Cause context. Focused regressions cover synchronous successful acquisition with cancellation, live ownership at slot copy, terminal races and typed/undefined cleanup causes. Build, format and 34 focused delivery/worker tests pass. This checkpoint preserves the candidate before full package and actual packed Chromium qualification and a fresh independent Astra medium verdict. Root has not accepted the candidate or started indexed acquisition.
