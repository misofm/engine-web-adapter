# Feed verified sparse PCM through the existing bounded pump

Status: Astra medium scope approved after independent #58 attempt5 PASS, no implementation authorization before root numbers/synchronizes the successor. Accepted storage implementation is80a980154b985953805d488b51546d580aefed57; inherited pump/worker code remains from merged #56 (8409f89). Actual exported descriptor is SparsePcmDescriptor from /stems. This issue can close independently of durable session ownership using synthetic verified descriptors, but app launch must use the lifetime successor. No acquisition, codecs, app, session parser, Rust or cache-policy code.

## Effect-first amendment

Apply Effect4rc112 to NEW worker-client/control-plane ownership, request/deadline/stop operations and Schema message boundaries after size/count preflight. Context.Service/static layers supply worker creation and read services; scoped fibers/finalizers own client resources and tagged control state. Preserve accepted bounded pure ring/deinterleave/index/window kernels and the existing pump numeric scheduling inner loop; do not add Effect allocations or Schema parsing per sample/render quantum. Keep the old dense path as an incremental compatibility edge. Runtime execution occurs only at the public client/worker message edge, never inside a pump read helper. Typed new errors map to existing public adapter errors. This amendment does not authorize a wholesale pump scheduler rewrite.

## Smallest capability and concrete seams

Add explicit sparse entrypoints while retaining the existing dense API during migration. Proposed `PcmPumpWorkerClient.createSparse` accepts a read-only sparse lease seam `read(identity): Promise<SparsePcmDescriptor>` and the existing per-source ring declarations. `CanonicalPcmPump` uses the same scheduling/deinterleave implementation with an explicit sparse mode/constructor factory; a sparse mode accepts only `{kind:"sparse-pcm",data:Blob,index:SparsePcmIndex}`, never a dense Blob. Do not fake a dense Blob with sparse slice behavior or rewrite StemSessionLease.read’s existing Blob contract. No parser failure chooses the dense mode.

A narrow discriminated internal readable-source union is sufficient to share the existing readWindow scheduler. Dense mode retains current Blob slicing. Sparse mode calls accepted readSparsePcmWindow(index,data,start,count), then uses the existing integer deinterleaver/ring writer. Cache acquisition and full-hash verification belong to the lease/store, not pump initialization. The pump validates descriptor/index shape but does not rehash entire source payloads.

Add an explicit `initialize-sparse` worker request carrying `sources` (one ring declaration per engine source ID) and a unique identity-keyed asset list (one Blob+index per canonical asset). Existing initialize remains dense. Deduplicate only descriptor transport/read acquisition by identity+shape; retain every source ID/ring/cursor. Reject duplicate source IDs, conflicting shapes, duplicate/conflicting asset entries, missing/extra assets and invalid rings before initialized acknowledgement. Two session source IDs sharing one identity use one descriptor with two independent ring states.

Structured clone drops private index brands. At the receiving worker boundary, run validateSparsePcmIndex once per unique cloned descriptor against data Blob.size, producing an admitted local index. Bind identity/channels/depth/frames to every referring source; include explicit source sampleRateHz or an initialization-wide expected rate so index rate cannot escape validation. Source validation is metadata-only; no per-window revalidation/clone, no cast pretending a cloned index is branded. Source states reference the shared admitted immutable descriptor. Client also rejects invalid sparse kind/shape early; receiving worker is the independent trust boundary.

## Preserve existing scheduling and disclose scratch

Keep8192-frame maximum logical windows, current/next windows, four shared active read operations, generation-tagged seeks, no stale-generation writes, 5-second read deadline, finite eight-pass worker ticks and existing ring EOF behavior. Sparse mode rejects configured windowFrames>8192 before engagement; existing dense mode behavior is unchanged. Windows round down to ring render quantum exactly as today. Sources at EOF mark finished, including seek to/beyond source end; final partial window has only remaining source frames.

A pending read occupies its scheduler slot until its physical promise settles, even after seek or deadline. Do not release the slot early and start an unbounded train of stale reads. Stop releases rings and clears owned timers; late read results cannot restore windows, write a ring, emit success or schedule new work. Worker termination is authoritative for client close/failure. Client/failure handling must reject a missing/malformed initialization bounds reply.

readSparsePcmWindow allocates one logical output window plus one contiguous active-read scratch buffer of at most the same byte count. Current maximumWindowBytes counts only current+next/pending destinations. Preserve that meaning and add `maximumReadScratchBytes` to pump/worker/client allocation facts (dense0; sparse sum of the largest min(4,sourceCount) per-source window byte bounds, since one read/source and four shared reads). Total PCM buffer upper bound is maximumWindowBytes+maximumReadScratchBytes; report/check safe arithmetic. Rings, index metadata, JS objects/browser internal caches remain separately stated. One all-silent read has zero active I/O/scratch in observations, though the published conservative maximum can remain source-shape based. No chunk-duration-dependent allocation or FLAC worker exists in this path.

Keep worker reply/client PumpAllocation propagation consistent. A backwards-compatible optional allocation field may preserve external implementors, but sparse client must require a valid reported scratch bound rather than silently defaulting missing sparse evidence to0.

## Representative gates

- Direct sparse pump mono16/stereo24, all-active/all-silent, leading/interior/trailing gaps, gap crossing, partial tail and long seek: ring PCM equals a small dense oracle and precise EOF/generation metadata. No dense persistent Blob, full-source reads or codec calls.
- Two source IDs share an identity: one descriptor read/admission, both rings remain independently populated. Reject conflicting alias shape, missing data, wrong kind, forged/cloned malformed index and wrong Blob size before initialization success.
- Real structured-clone worker proof in existing packed browser harness: cloned valid index admitted once, playback/gap/seek works. Preserve #54/#56 binary-search/no-freeze-per-window tests; no second harness.
- Slow pending sparse reads across repeated seeks retain four-read ceiling and per-source ownership; completions from old generations never write. Deadline, stop and late result cases preserve existing tests. Include finite driver ticks while storage stalls.
- Scratch/read spies prove destination+active-scratch bounds and no I/O for pure gaps; allocation reply/client includes the extra scratch. Test mixed source sizes for largest-four conservative bound, and reject unsafe/window-too-large requests.
- Run focused pump/worker/ring tests, typecheck/format/source policy, then full adapter check once and one packed browser sparse-worker smoke. No acquisition or broad browser matrix.

This issue proves bounded sparse pumping, not asset lifetime. Callers hold the source/session lease until worker termination and do not delete data underneath it. The lifecycle issue provides that concrete owner; no new full session-open API is hidden in this pump change.

## Concrete implementation boundary

Accepted storage exports are `SparsePcmDescriptor`, `SparsePcmExpectation` and
`VerifiedSparsePcmStore` from `/stems`. Pump source rate should be a required
field on a new `SparsePcmPumpSource` extending the unchanged dense source shape,
so existing dense callers need no migration and sparse source binding is complete.
Implement only `src/stems/pump.ts`, `worker-client.ts`, `worker-protocol.ts`,
`src/internal/engine-web-pcm-pump-worker.ts`, related exported/allocation types,
focused tests and the existing packed-browser fixture. Reuse the existing pure
scheduler and validation helpers; do not duplicate the worker-client class or
create parallel request/termination state machines for dense and sparse modes.
Effect owns the new control path through one client edge and the worker message
edge. Existing public Promise methods remain compatible. Runtime services should
represent an actual dependency or resource, not a wrapper around a pure function.

## Attempt 1 intermediate checkpoint — focused PCM slice

The shared pump can read admitted sparse windows and report active-read scratch;
the explicit sparse worker message and client path retain source aliases as
independent rings. Seven new cases and20 existing pump/worker cases pass27/27
(root rerun retained), with Luna's typecheck/format/source-policy checks passing.
The Node worker test exercises structured clone; it does not replace the required
packed browser gate. This is a recoverable intermediate checkpoint, not the
completed attempt or an independent verdict.

Completion still requires the specified Effect control/resource ownership and
Schema boundary work, remaining cancellation/seek/bounds regressions, and packed
browser qualification. A descriptor-loop-only Effect wrapper is not completion
of the Effect amendment. Preserve the existing post-await dense stop/generation
guard, validate each unique sparse descriptor once, and avoid redundant receiving
constructors or placeholder dense lease functions. Do not broaden the scheduler
rewrite. Root checkpoints this tranche before additional implementation.

## Attempt 1 completed checkpoint — independent review pending

The client now shares an Effect callback request map and Clock deadlines across
dense/sparse requests, composes sparse initialization through one scoped program,
and checks worker replies against computed window/ring/scratch bounds. Receiving
worker admission uses Schema and existing pure sparse validators; the redundant
constructor, placeholder dense lease and repeated alias admission were removed.
The existing post-await dense generation/stop guard is restored. Source counts
are not capped by the unrelated per-stem interval limit.

Luna reports all245 package tests and format/typecheck/source/decoder/package
checks passing. Root reran28 focused pump/worker tests. The packed Chromium
consumer passed its new sparse worker/gap/seek smoke (one asset read, generation2,
512-byte conservative scratch for its mono16 fixture), alongside existing checks.
This is the completed first attempt, awaiting one independent Astra medium
verdict; no session-open integration, registry release or deployment is claimed.
