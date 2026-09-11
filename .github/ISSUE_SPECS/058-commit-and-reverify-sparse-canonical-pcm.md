# Commit and reverify sparse canonical PCM without storing implicit gaps

Status: Astra medium scope approved; matching issue is misofm/engine-web-adapter#58; this file is its authoritative synchronized brief. Luna xhigh implementation, independent Astra medium verification (actual reviewer context disclosed); maximum five coherent attempts. Depends on accepted #56 singular-format/interval derivation plus retained #54 sparse PCM index/window helpers. Accepted #56 implementation is9474ed6a34175e78c8be2d3c9b42cb60b211a855 with independent PASS; merged baseline is8409f89f212368cf07137766f773f030856a56d4 (PR57, issue56 closed). The final transport is one ordinary indexed blob per stem, but this API has no transport, bucket or domain policy. This issue is deliberately storage-only; pump/session leases and complete HTTP/FLAC preparation follow in separately bounded issues.

## Effect v4 implementation direction (user-requested amendment)

Apply the pinned effect-ts skill at [effect-ts/SKILL.md](https://github.com/unconfirmedlabs/skills/blob/5d24b996b95511183e3f9da6b9aeda8eac3aa9c8/effect-ts/SKILL.md), source5d24b996b95511183e3f9da6b9aeda8eac3aa9c8, with its services/schema/state/migration/streams guidance. Adapter remains exactly effect4.0.0-rc.112; verify APIs against installed declarations. This is an incremental migration of the NEW capability, not a rewrite of dense store, accepted pure format validators, PCM window math, worker protocols or public adapter error ABI.

Implement operations with named Effect.fn and Effect.gen; dependencies are Context.Service classes with static live/test Layers. Keep the service set small: sparse backend operations, shared source coordination, and the sparse-store program. Wrap existing Promise backend/writer calls once in the backend service using typed Effect.tryPromise/callback bridges. Compose once at the Promise facade edge, preferably one ManagedRuntime per store with explicit close/dispose lifecycle (no data deletion, caller-owned backend not implicitly closed). Public openSource/installSource run effects through that edge only. No runPromise/runSync in helpers, service callbacks, lock callbacks, hash loops or inside another Effect; no giant tryPromise wrapping an otherwise unchanged async store.

New operational failures are uniquely tagged Schema.TaggedError values (boundary/corruption/quota/read-deadline/cancellation/I/O categories, with bounded details and causes). Catch/map known tags, preserve unexpected defects as defects internally, and map final outcomes/interruption to the existing EngineWebAdapterError contract only at the public Promise bridge. Existing pure helpers can throw their existing error: wrap their invocation as an Effect.try boundary and classify known errors; do not migrate their exported ABI. Do not swallow arbitrary unknown causes as missing cache or successful cleanup.

Use Schema.decodeUnknownEffect for NEW options/expectation/span and on-disk marker boundaries, with excess properties explicitly rejected. Existing byte/array-count/scalar-size preflight MUST run BEFORE Schema traversal, JSON decoding/clone, or record construction. Schema.Array max-length refinement after traversal is not a resource preflight. Preserve accepted validateSparsePcmIndex for its bounded arithmetic/brand semantics after new record Schema admission; a narrow Schema refinement/wrapper around the existing validator is allowed, not a second independently maintained interval validator. No trim/coercion or JSON serialization can change identity-bearing numeric values. Schema guards do not replace actual Blob length or canonical hash.

Represent NEW control lifecycle (opening/streaming/data-closed/marker-writing/committed/aborting/closed as needed) by a small tagged union in Ref and explicit transitions. Do not add an event journal or one Effect/Ref transition per sample. Numeric SHA state, packed interval accumulation, borrowed PCM buffers and pure counted loops stay local bounded kernels. Read clock/deadlines via Effect Clock/TestClock; generation/random IDs use an injected Random-backed service or preserved instanceId seam, not new module-global counters/Date.now/Math.random.

Use scoped acquireRelease/finalizers for source locks, iterator/stream, writers and owned files. rc112 acquireRelease acquisition is uninterruptible by default; choose its interruptible acquisition option or an explicitly bounded acquisition strategy that preserves OPFS create abort/late-settlement cleanup. Never assume the default permits prompt cancellation during writer creation. Bridge cancellation into the actual AbortSignal accepted by backend and resolver. Interrupting an Effect.tryPromise alone does not prove physical I/O stopped: finalizers must abort/settle the owned writer/worker and iterator before deleting generation files or releasing source ownership. Keep marker-last visibility. Only small resource acquisition/release/commit transitions may be uninterruptible; never mask an entire source install or zero hash. Tests must prove cancellation while writes/close are pending cannot acknowledge a cache and cannot let a late physical operation recreate a removed accepted marker.

Coordination compatibility is deliberate: existing historical Web Locks and shared same-backend fallback registry remain the SINGLE authority. Expose that small unchanged helper behind the coordination service; do not allocate an independent Ref/Map/partitioned semaphore per ManagedRuntime or change lock names/order. A narrow acquire/release lock bridge shared with the old runner is root-approved. Acquire a scoped lock lease via callback/Deferred coordination and release it in a finalizer; do not run a nested Effect runtime inside the legacy async lock callback. Root explicitly approves the inherited module WeakMap as a narrow compatibility exception until the old dense store is migrated, not permission for new global mutable state. A wholesale Ref conversion of that shared legacy registry is NOT required by this slice. This exception is an explicit incremental application of the skill, preserving already required interop.

Adapt lazy AsyncIterable at the public boundary into a scoped pull-based Effect Stream; no runCollect, unbounded queues, background prefetch or parallel PCM writes. Keep128KiB event and64KiB zero-hash bounds. Cooperative yields/interruption checks occur between bounded hash chunks. Use Effect timeout/Clock for logical progress while retaining backend-owned physical teardown; a timeout is not permission to release the source lock before finalizers settle.

Gates additionally cover injected service layers, Schema excess-key/late-getter preflight, TestClock progress timeout, interruption/physical-close ordering, public legacy error mapping, and no duplicate locks across two facade runtimes. Keep existing test runner/package gates; no new testing framework or broad migration. Stateful runtime close must settle in-flight operations/finalizers and reject new operations without deleting committed assets.

## Problem and smallest closable capability

The existing VerifiedStemStore assumes dense canonical bytes for file size, hash, index rebuild and read. Its version1 index rows cannot safely be broadened in place: older clients accept extra row keys and may interpret sparse entries as dense files. Add a sibling per-source verified sparse persistence API that accepts active PCM streams, commits a data/index pair with atomic verified visibility, and reopens only after bounded full canonical verification. It reuses StemStorageBackend and#54's validated index, but does not alter old dense row semantics or require dense-cache fallback.

Public capability: install/verify/open one sparse source under explicit canonical expectation, returning a `{kind:'sparse-pcm',data:Blob,index}` descriptor only after verification. This is a prepared-source primitive, not a session-ready signal. No acquisition/FLAC decode, pump worker, Rust, app policy, registry publish, artist package or network code changes. Do not copy the entire700-line dense store and its unrelated recovery/eviction policy. If existing lock/timeout helpers require reuse, extract only the small unchanged utilities needed by this sibling; existing regression gates must cover the refactor.

## API and ownership boundary

Concrete public surface: export `VerifiedSparsePcmStore` from `/stems`, constructed with injectable `backend`, `locks`, `instanceId` and `readDeadlineMs` using existing option types where applicable. `openSource(expected, {signal}?)` returns a verified sparse descriptor or `undefined` ONLY when the commit is missing; malformed/corrupt/conflicting committed data throws. `installSource(expected, {resolve, signal}?)` requires a lazy resolve callback and returns either reverified warm data or a newly committed descriptor. Resolve receives the operation AbortSignal and returns `{spans: AsyncIterable<{startFrame:number,bytes:Uint8Array}>, index?: SparsePcmIndex}`. Invoke it only on a cold path under source lock; propagate cancellation and settle iterator.return/owned source teardown. The descriptor is `{kind:"sparse-pcm",data:Blob,index:SparsePcmIndex}`. This is not StemStore/openSession and does not return a session lease. Keep missing-open distinct from corruption and never retry a corrupt open as a cold resolver call.

Expected declaration includes canonical identity plus sampleRateHz/channels/bitDepth/frames/canonicalBytes. Install input is a lazy bounded span stream: each event carries `{startFrame, bytes}` where bytes is a positive, frame-aligned Uint8Array of active canonical PCM. Events advance monotonically without overlap; adjacent events are coalesced into one cache interval. Absence between events (and before the first/after the last) declares implicit zeros. An all-silent source is an empty stream. Cold per-stem indexed-blob adapters may additionally supply their already-known validated sparse PCM index derived by #56 from timeline intervals as an assertion; native FLAC adapters discover the same spans while decoding and need no upfront map or second decode. Both normalize into the same storage loop, with AbortSignal. Untrusted types are validated at runtime: nominal TypeScript typing is not proof. The full shape must match expected; shape aliases under the same PCM digest fail explicitly. Chunk/compressed transport metadata is absent from this cache API. Delivery adapter splits decoded packed PCM at timeline interval boundaries before emitting spans; this store never decodes FLAC or sees manifest chunks.

Use a lazy resolver callback for cold installs so verified warm open never invokes codec/network work. Snapshot/validate authoritative shape before consuming the stream. Derive interval offsets/counts/activeBytes incrementally from admitted spans, enforcing the retained sparse PCM interval and8MiB index limits throughout; freeze the final index at EOF. Never require a complete native-FLAC map before its first decode output. An optional upfront index is validated before consumption and must match the final derived index exactly. Freeze/copy only bounded metadata; consume each borrowed PCM event before releasing its decoder credit. Store consumes a single source at a time per identity. Returned descriptor is immutable metadata and a Blob handle for the final packed payload; callers must not treat the raw commit marker as verified evidence. No public method synthesizes a dense persistent Blob.

This primitive intentionally does not own session pins, global cache eviction or source-count fanout. Completed data files are immutable and retained; there is no automatic deletion of committed sources. Quota pressure refuses rather than deleting another client's committed bytes. A successor adds required session leases and durable offline pins under the same retain/refuse policy before app adoption. Automatic eviction and dense-cache migration are outside that launch slice. This avoids inventing a second conflicting ownership index here. Explicit app Clear Data can later remove the entire existing folder under the app's established lifecycle lock.

## Separate cache identity and commit protocol

Use the same injectable backend/folder as callers select, with unambiguous new prefixes that do not begin `sha256-` or `staging-` (old dense cleanup owns those): e.g. `sparse-pcm-v1-data-<identityhex>-<generation>`, `sparse-pcm-v1-stage-...`, and `sparse-pcm-v1-commit-<identityhex>.json`. These filenames are examples; freeze actual names in evidence. Commit record carries exact tag `miso_sparse_pcm_commit_v1`, expected identity/fullshape, the#54 sparse index, payload name, activeBytes and an immutable generation. Payload-name validation must derive from the identity/generation and forbid arbitrary paths. No FLAC offsets, channel maps or old index.json rows.

Cache record JSON has a concrete byte ceiling (8MiB) checked from Blob.size before decoding; use strict known-key validation and checked arithmetic. Known upfront indexes are size-preflighted before payload writes; unknown indexes enforce count/serialized-size bounds incrementally and refuse before committing if the final record would exceed the ceiling. Partial owned staging is cleaned on refusal. Data names include generation so a later explicit repair cannot replace bytes behind another immutable Blob descriptor. Same-identity install holds an exclusive resource lock through verification and commit. Use the current folder-specific/historical stem lock order or an explicitly documented compatible lock name so concurrent instances/cross-tab writes cannot race. In-process fallback must share ownership for the same backend object as the existing store does. Prefer lock helper extraction over duplicated subtle synchronization code.

### Audited reuse and narrowly scoped implementation

Use accepted `SparsePcmIndex`/`SparsePcmIndexDraft`, `validateSparsePcmIndex`, `SPARSE_PCM_FORMAT` and its count/byte caps from sparse-pcm.ts. Build incrementally from spans; do not synthesize dummy transport chunks or depend on a FLAC manifest to validate a cache record. Known input indexes may originate from #56 deriveSparsePcmIndex, but store shape/index checks are transport-neutral. Reuse `StemStorageBackend` and its existing Memory/OPFS implementations; `IncrementalSha256`, `deadline`, and `ownsOpfsWriteDeadlines`; existing error codes and canonical identity validation. Read bounded cache records with `backend.read` -> Blob.size preflight -> bounded bytes, never the unchecked `readText` helper. IncrementalSha256 hashes bytes but does not yield; add a small cooperative checkpoint between <=64KiB hash blocks, not another hashing framework.

A small unchanged extraction of the private recursive canonical JSON writer from sparse-format.ts into an internal helper is allowed so marker encoding does not duplicate or alter canonicalization; retain #56 byte-roundtrip tests. No new public generic serializer.

Extract only the shared WeakMap ownership and named-lock runner from `store.ts` into a small internal helper, and use it from both stores. Preserve the existing WebLockProvider surface and exact global-then-historical-folder ordering: `miso:engine-web:v1:stem:<hex>` followed by `miso:stem-store:v1:<folder>:ingest:<hex>`. The existing index/pin lock methods stay in the dense store. Same backend object fallback instances must share that lock map; unrelated backend objects without Web Locks are not a claimed cross-tab coordination mechanism. No broad dense-store rewrite, eviction reuse, resolver instrumentation copy, or global catalog.

The audited `backend.move` has no AbortSignal; its copy fallback creates a second writer and a late move can complete after caller timeout. Avoid introducing this unnecessary promotion hazard: write data once under its final unique generation name, which remains UNPUBLISHED without the commit marker. Close/hash it, then write the fixed per-identity marker last with the existing cancellable worker-backed writer. Publication is marker acceptance, not physical data rename. Old clients ignore both names. Readers and installers hold the same source lock, so no live reader observes an in-progress marker; after a crash an incomplete marker is malformed and never ready. This retains logical staging/promotion and atomic verified visibility without assuming atomic multi-file rename or adding a move framework.

Use only the established cancellable writer lifecycle and physical teardown semantics. Avoid an outer timeout race that abandons a backend-owned write generation; use ownsOpfsWriteDeadlines as the dense ingest does. Generic injected backends must honor their writer abort contract, and failure tests explicitly prove teardown before owned-file removal.

Install transaction:

1. Hold the source locks, read any marker, and verify its exact identity/shape/index and reconstructed hash. Warm success returns without resolver. Corrupt committed marker/data or conflicting shape rejects; no automatic erase/repair. Missing marker is cold. No unrelated source scan is required.
2. Resolve the lazy span source after expectation validation. A known PCM index is admitted before writing and later checked against the derived result. The index is derived ONLY from #56 timeline intervals, never FLAC chunks or compressed offsets; chunks may cross gaps and have unrelated boundaries.
3. Create one unique unpublished data generation using a cancellable writer. Preflight activeBytes + bounded marker/scratch when size is known, not 2*activeBytes: there is no data copy. For unknown native maps, query available space before each write and reserve only the next write plus remaining metadata/scratch; existing usage already accounts for accumulated data, so do not count it twice. Exact final marker space is rechecked. Missing quota estimates do not promise capacity; actual quota failures abort correctly. Never reserve canonical dense size. All-silent data is a real zero-byte generation plus marker.
4. For each bounded event, admit runtime startFrame/byteLength/alignment/endpoint/monotonicity before writing or hashing. Max event128KiB, no empty events or queue fanout; adjacent events coalesce. Hash gaps with one <=64KiB zero block and active bytes incrementally, write ONLY event bytes, and update count/size-bounded intervals. Consume borrowed bytes before releasing decoder credit. At EOF hash trailing zeros and require complete canonical byte count/digest, final validated PCM index, and optional-index equality. Missing samples cannot masquerade as gaps because the authoritative full hash must match.
5. Close the data writer physically before marker creation. Recheck cancellation, create the per-identity marker writer, write the bounded complete canonical record, close physically, and check cancellation before returning an immutable descriptor. Both writer lifetimes use the existing teardown mechanism. A raw valid marker is never sufficient for open: all opens rehash under the source lock.
6. Failure/cancellation aborts and settles owned writer handles before removing the owned marker and unpublished generation, still under the source lock. Delete a marker only if this transaction created it; warm opens never write/remove. Preserve any pre-existing committed generation. No false descriptor and no blanket prefix cleanup. If the process dies, unique orphan generations remain unready; automatic orphan reclamation is explicitly a lifecycle successor. Do not weaken integrity merely to recover disk space.

Marker JSON uses the existing recursive lexicographic canonical writer after strict shape/count/size admission. Exact record maximum remains8MiB including wrapper; enforce serialized growth incrementally without repeatedly serializing the entire index after every event (track record lengths or another bounded linear accounting method). Known maximum index size alone does not guarantee wrapper size fits. Reject before final publication if the complete marker exceeds its ceiling. Strict payload-name derivation prevents arbitrary-path reads/deletes.

## Bounded canonical verification

Reopen verifies record shape/index against expected identity, exact active Blob length and then the full reconstructed canonical SHA256. Stream only the packed payload in<=128KiB reads, walking the finite admitted interval list. Feed implicit zeros with a reusable<=64KiB zero block; never allocate gaps or write zeros. Compare canonical byte count exactly, including leading/interior/trailing gaps. Yield/check cancellation between bounded hash chunks so very long silent sources cannot monopolize the main thread or make cancellation wait for song duration. Prefer existing async hash utility with an explicit cooperative checkpoint; no new worker framework is required in this issue.

Do not implement reopen by reading8192-frame logical windows across a many-hour sparse timeline: one sequential active stream plus zero-hash blocks avoids repeated local I/O. All-silent source performs no payload reads beyond obtaining its zero-byte Blob handle. Corrupt/short active bytes, altered interval metadata, mismatched identity/shape or unknown tag reject; none can be reclassified as silence. Cache verification does not call FLAC and does not trust a resolver-provided digest to skip recomputation.

Logical operation bound is explicit: at most one active ingest/read stream and one writer per source operation, one admitted input chunk, one<=64KiB zero block, bounded index/record storage and existing worker credits. Global concurrency belongs to the session admission successor, not an unbounded Promise.all here. Warm verification opens no writer.

## Objective gates

- Synthetic successful install/reopen for all-silent and all-active sources, native mono16/stereo24, leading/interior/trailing gaps, many short active spans and source trailing partial sample-block windows. PCM index deliberately has offsets unlike compressed chunk offsets; use a #56 fixture with one chunk crossing several timeline intervals. Reopen descriptor windows via the accepted bounded PCM reader equal independent dense oracle bytes.
- Writer spy totals equal exactly activeBytes (plus separately identified bounded metadata writes), never canonicalBytes when gaps exist. Zero-byte all-silent payload, no gap-sized allocations, bounded stream/zero buffers, warm path resolver count0, decoder count0 and data-writer count0.
- Full canonical identity catches one-LSB sample tamper, changed gap position with same active size, reordered intervals and wrong terminal frame count. Reject malformed/oversized/unknown cache records, missing/short/long active data, shape alias, wrong identity and a resolver result claiming a wrong preverified hash.
- Cold span stream includes consecutive split active spans (coalesced), long gaps discovered after prior writes, and an empty all-silent stream. Assert identical committed bytes/index for known-per-stem-interval-map and unknown-native-map ingestion. Non-frame-alignedPCM24, overlap, extra/out-of-source/oversized/empty events, early EOF falsely declaring trailing silence and optional-index disagreement reject without commit. Simulate a mostly-silent unknown-map source with free space enough for actual active payload but less than dense logical PCM; rolling admission succeeds without zero writes.
- Failure injections at data writer create/write/close, marker create/write/close, cancellation before/after asynchronous commit boundaries and quota refusal. No false ready descriptor; owned output is removed only after physical teardown. Assert backend.move is never called, including copy-only backends. A crash-shaped partial marker/data generation never opens as verified; ambiguous orphan reclamation is not implemented here.
- Two store instances with same backend/locks and simultaneous same-source install invoke the cold resolver once, return equivalent verified descriptors, and leave one admitted commit. A failed competing install cannot remove winner's generation. Unknown lock-liveness preserves ambiguous staging.
- Compatibility fixture seeds current dense index.json/final files: new sparse operation never interprets, modifies or deletes them. Seed a sparse record and run old store startup: its cleanup leaves sparse files intact.
- Focused tests, typecheck, existing store/storage/OPFS deadline/cancellation tests, source/format gates and package checks. Add one small real OPFS worker test to existing browser-OPFS harness proving close/reopen+atomic marker failure behavior; do not build a new harness. No codec/network/browser playback benchmark.

## Successor boundary and acceptance

PASS proves verified sparse persistence, not playback or session readiness. Next issue must add lease/pin/quota ownership and pass sparse descriptors to existing bounded pump/worker (binary-search reader, exact gaps, seeks/stale generations/EOF, accurate read-scratch bounds). Then complete package HTTP/FLAC preparation, authoritative-session offline app adoption, registry release and authorized publisher/R2/reference/deploy verification remain required. No dense fallback is introduced by any successor. Human/mobile timing qualification is separate and cannot become an unevidenced speed claim.

Luna records exact accepted #56/#54 APIs/baselines, touched paths, checks, runtime memory/file-byte bounds and any explicit orphan-lifecycle limitation. Independent Astra records one PASS/FAIL with actual context disclosed. Root commits only the coherent storage tranche and synchronizes GitHub evidence before the next implementation edits begin.


## Decision record — Effect amendment before attempt 1

User explicitly requested Effect throughout the new SDK work and supplied the
Effect v4 skill. Astra medium revised this brief before implementation; Luna
confirmed the worktree remained at the clean brief checkpoint with no
implementation changes. Root approved incremental reuse of existing pure
validators/error facade and the single shared historical lock registry. New
operations, resource scopes, boundary schemas and lifecycle state follow the
skill. This is attempt 1 against the amended contract; no failed attempt is
being relabeled. The existing substantive integrity and teardown gates remain.


## Attempt 1 compiling checkpoint — not accepted

Luna xhigh supplied the first storage implementation with shared canonical JSON
and historical lock helpers. `npm run typecheck -- --pretty false`, build,
test TypeScript compilation, four focused sparse-store tests and
`git diff --check` passed. Focused cases cover silent/active install, warm
no-resolve, gaps/tamper, malformed span/index disagreement, and same-backend
coalescing. Root checkpoints this exact tranche before further edits.

This is not completion evidence. Luna disclosed that main storage loops remain
async functions inside broad Effect.tryPromise wrappers, contrary to the
amended Effect-first contract. Root inspection also finds no active-space
estimate admission, unqualified outer writer deadline races, and insufficient
failure/browser evidence. Independent Astra review will issue one verdict
against the full brief before the next bounded correction. Full package and
OPFS/browser gates have not run on this tranche. No registry release or app
adoption is authorized from this unaccepted checkpoint.

## Attempt 1 independent verdict — FAIL

Astra medium independently reviewed pushed implementation59b7b47 using the
existing non-implementing planning/review thread (not fresh context). The four
focused tests passed independently. The reviewer demonstrated a late complete
commit after store.close with a caller signal, an owned partial marker surviving
write failure, cancellation stuck behind iterator.next, unsupported-rate work
before rejection, absent quota estimates, and overwrite of a pre-existing
generation when instanceId repeats. No full/browser gates were run around these
known defects. Full review is retained outside the worktree by root.

Attempt 2 is one bounded correction of this same persistence contract:

- Compose actual Effect services/programs, scoped source coordination and resource
  finalizers. Combine caller and runtime interruption into physical cancellation;
  close must wait for teardown and forbid late commits. Preserve the single shared
  historical lock registry and public error facade.
- Settle writer creation/write/close and iterator ownership before deleting owned
  files or releasing locks. Respect OPFS-owned deadlines, track marker ownership
  from acquisition, use real cooperative hash yields, and report cleanup failures.
  Random-backed generations must also refuse existing-name collisions; never
  overwrite or remove an ambiguous pre-existing orphan.
- Admit supported shape/products/options and known indexes before resolver/writer
  work. Apply strict new Schemas after hard preflight; enforce incremental interval
  and complete marker budgets before writes. Add known/rolling active-space quota
  admission and exact final-marker admission. Remove the unjustified metadata-
  derived8GiB active-PCM cap; the compressed transport cap is a separate boundary.
- Add discriminating regressions for those findings, service-layer/TestClock and
  writer-stage failures, dense isolation, and the required small existing real
  OPFS close/reopen/marker-failure case before one final attempt-2 verdict.

Intermediate compiling/focused-green correction tranches must pause for exact-path
root checkpoints. Such checkpoints do not substitute for the final complete
contract review or create additional attempts. Pump, session lifecycle and
acquisition implementation remain paused until this issue passes. Maximum five
coherent attempts remains unchanged; one has received FAIL.

## Attempt 2 intermediate core checkpoint — contract still incomplete

Luna replaced the broad async store orchestration with Effect backend,
coordination and program services, scoped lock/writer calls, pull Stream,
Ref lifecycle, supported-rate admission and generation collision checks.
The shared fallback lock now retains a cancelled waiter's predecessor until
the chain settles; both historical lock levels are released on failure.
Typecheck/build and the four existing focused cases pass. Root independently
confirmed typecheck and focused cases. No new failure/browser tests are claimed.

This is a recoverable compiling checkpoint within attempt2, not its final review.
Root inspection still finds unresolved requirements from the first verdict:
generic writer timeout/create promises can be abandoned, abort/remove/lock
failures are swallowed, resolver and Blob-read deadlines remain incomplete,
and iterator cleanup synthesizes an abort event instead of owning cancellation.
Rolling quota still counts accumulated bytes and a fixed allowance instead of
the physical-backend/current-marker contract. Known-index admission, complete
incremental marker accounting, option preflight and post-close cancellation
must also be completed with their discriminating tests. In particular natural
iterator EOF must not abort the still-owned data writer, and cold commit must
not be accepted before the final cancellation/physical-settlement boundary.

Root checkpoints these exact paths before Luna continues the remaining coherent
correction/test tranche. No independent attempt2 verdict yet; all later features,
full package and browser gates remain pending the completed focused contract.

## Attempt 2 second correction checkpoint — 12 focused tests

Luna added physical Promise observation bridges for writer and lock operations,
separate resolver cancellation, normal-EOF handling, bounded source/read progress,
prospective marker accounting, known-map admission and post-close cancellation
checks. Cold success now returns the committed data handle without a redundant
second canonical hash. New focused cases cover marker-close cleanup, quota refusal,
collision/orphan preservation, unsupported-rate preflight, existing capability
error preservation, resolver cancellation, dense coexistence and cancelled lock
waiters. Typecheck/build/test compilation and12/12 focused tests pass. Root
checkpoints the compiling tranche before more edits.

Still pending before the single final attempt2 review: delayed create/write/close
and partial-create cleanup regressions, cleanup-failure retention, external-signal
runtime close, injected service layers/TestClock, strict option/late-getter and
physical-usage quota tests, full proportional package gates and the existing real
OPFS close/reopen/marker-failure browser case. Root inspection notes source progress
currently uses raw timers and file ownership still begins after create returns;
these must satisfy the already-frozen Effect Clock and partial-create contracts.
Quota accounting must not infer estimate semantics from ownsOpfsWriteDeadlines:
that flag concerns writer termination, not whether a backend reports persisted
usage. This checkpoint makes no claim that those remaining requirements pass.

## Attempt 2 third correction checkpoint — 20 focused tests

Luna replaced the raw-timer source controller with an Effect-owned pull stream,
registered file ownership before create, and added delayed create/write/close,
partial-create, cleanup-failure, TestClock, physical-usage quota, option preflight
and cold payload-size regressions. Typecheck and the 20 focused cases pass;
root independently reran the 20 compiled cases. The full package check passed
227 cases before the final size guard and must run again on the completed slice.

The unchanged existing packed OPFS harness reached Chromium checks but failed
in WebKit at its direct FileSystemFileHandle prototype access. This is not a
sparse browser PASS: the required sparse close/reopen and marker-failure case
has not yet been added. Diagnose that existing harness failure and add the small
required case before the single final independent attempt2 verdict. No subsequent
feature implementation or release is authorized from this intermediate checkpoint.

## Qualification environment amendment — approved by Astra medium

Root isolated the existing WebKit failure from the cache implementation. Installed
Linux Playwright WebKit2336 (26.5, WPE and GTK) and2248 (26.0, WPE) expose neither
navigator.storage nor FileSystemFileHandle in a secure, isolated persistent
profile. Attempted MiniBrowser feature flags did not expose storage to inspector
pages; upstream Playwright issue31185 describes that flag limitation. No working
OPFS-without-constructor behavior was observed, so the original capability
assertions remain mandatory.

Run the same existing packed OPFS harness on macos-15 through one small repository
PR/manual workflow using the locked npm/Playwright dependencies. No second harness,
storage mock or capability relaxation. Record exact tested checkout versus PR
event SHA, runner image/OS, Node/npm, Playwright and actual browser versions. Test
failure fails the job; upload diagnostics even on failure. This proves macOS
Playwright Chromium/WebKit storage behavior, not iOS Safari. Final attempt2 review
awaits both the corrected sparse fixture and the actual remote result.

## Attempt 2 completed local correction — remote WebKit and verdict pending

Luna added scoped iterator ownership before upfront admission and cleanup after
downstream failure, corrected prospective marker brackets, settled physical
writes despite abort rejection, and released a lock granted concurrently with
caller cancellation. Four additional regressions bring the focused suite to
24/24; root independently reran those compiled cases. Luna reports the complete
package check passing all232 cases. This is a checkpoint awaiting review, not PASS.

The existing packed OPFS harness now includes sparse close/reopen without a warm
resolver and injected marker-close cleanup. Local Chromium151.0.7922.34 passes
every assertion, including those sparse cases. Linux WebKit26.5 fails the retained
FileSystemFileHandle assertion as diagnosed above. The new macOS workflow runs
that same harness with exact checkout and browser provenance; its actual result
and the one independent Astra medium attempt2 verdict remain required.

## Attempt 2 independent verdict — FAIL; macOS OPFS passed

Astra medium independently reviewed3867778 and reran the full package check:
232/232 tests and package policy pass. The delayed-write/abort-failure and
post-grant lock-cancellation probes now pass. One remaining blocker is confirmed:
makeSourceLease.close converts iterator.return rejection into successful cleanup,
so the public error loses the cleanup failure. Review and reproducer are retained
by root outside the worktree. This is the single attempt2 verdict.

The real macOS OPFS workflow subsequently passed for this exact feature SHA:
run34609974781, macOS15.7.9 arm64 (image20260907.0337.1), Node22.23.2,
npm10.9.8, locked Playwright1.62.1, Chromium and WebKit26.5. Both engines passed
the existing physical-lock/cleanup assertions plus sparse close/reopen and
marker-failure cleanup. Artifacts record feature SHA separately from the PR event
merge SHA. This does not waive the source cleanup blocker or claim iOS evidence.

Attempt3 is a narrowly bounded correction: preserve/report asynchronous return
rejection and synchronous return throw alongside the original failure through
the existing public error boundary, retaining exactly-once finalization and
physical settlement order. Verify downstream admission/write failure and early
optional-index rejection. Do not add a new error ABI or framework. Effect's
Promise runner can squash a multi-reason Cause to its first reason, so removing
the local rejection swallow alone is insufficient without a discriminating
public-boundary test. Keep all accepted cancellation, normal EOF and store tests.
Checkpoint the coherent correction, rerun proportional package/browser gates on
that source, then obtain one independent Astra medium attempt3 verdict. Two
attempts have received FAIL; the maximum remains five.

## Attempt 3 local checkpoint — independent review pending

Luna stopped discarding return rejection and added local Cause-aware source
cleanup handling that retains cleanup errors with primary sparse failures.
The new public-API regression covers synchronous throws and asynchronous
rejections after span admission, writer failure and early index admission;
iterator.return runs once. The focused suite passes25 cases (root rerun retained),
and Luna reports the full233-test package check passing. The independent reviewer
must assess the completed error policy and final physical ordering before a
verdict; this checkpoint is not acceptance. The existing macOS workflow will
recheck the same packed storage fixture against this corrected source.

## Attempt 3 independent verdict — FAIL; corrected macOS gate passed

Astra medium independently built f617396 and passed25 focused tests, then
confirmed three related error-policy failures: undefined return rejection is
treated as absence; a primary span-getter defect loses cleanup failure when the
combined Cause is squashed by runPromise; and an existing capability.opfs error
changes to stem.corrupt after local error mutation. One consolidated FAIL is
recorded. Full checks were not repeated around those confirmed blockers.
The exact-source macOS gate separately passed in run34611079201; retained browser
artifacts still prove the unchanged physical storage fixtures, not error-policy
acceptance.

Attempt4 must carry the complete Effect Exit/Cause to ONE public Promise boundary
using the installed ManagedRuntime.runPromiseExit or equivalent full-Cause edge.
Preserve every failure/defect/interruption reason, including undefined values,
without mutating a primary error or losing an existing adapter classification,
message or details. Use the existing public error/cause surface; AggregateError
may retain multiple underlying reasons. A presence discriminant, rather than
undefined as an absence sentinel, is required wherever cleanup state is necessary.
Prefer removing the attempt3 per-source error bookkeeping and local primary-error
mutation in favor of Effect's existing Cause ownership. Keep one scoped iterator
ownership path and physical writer/source/lock ordering. No nested runtime, new
error ABI or general error framework is authorized.

Gates add the review's three public-API reproducers and preserve the prior async/
sync cleanup, normal EOF, cancellation and existing capability-error cases.
Checkpoint the smallest coherent correction, then run proportional final package
and macOS gates and one independent attempt4 review. Three attempts have received
FAIL; the maximum remains five. Global simplification remains a later user-requested
pass once the complete delivery flow works.

## Attempt 4 local checkpoint — full-Cause boundary

The public facade now runs one complete Effect Exit and maps its Cause once,
preserving existing adapter classification/details and every cleanup value,
including undefined, defects and interruption. The source-specific failure
tracker and primary-error mutation were removed. Luna reports the focused26-test
suite and complete234-test package check passing; root independently reran26
focused cases. Retained review probes for the previous error-path defects pass.
This coherent checkpoint awaits its own macOS gate and independent attempt4
verdict; no acceptance, release or subsequent feature implementation is claimed.

## Attempt 4 independent verdict — FAIL; attempt 5 is final

Astra medium independently confirms the complete error-boundary corrections and
26 focused cases pass at17bf6c2. One consolidated FAIL covers the remaining
cancellation/progress boundary: abort inside a quota observation is missed by the
subsequently registered physical-write listener, leaving an already-settled write
pending until the generic deadline and returning stem.read_deadline instead of
stem.cancelled. OPFS-owned writes have no duplicate generic timer. Additionally,
the write-deadline exemption incorrectly suppresses logical metadata deadlines
for exists/estimate, neither of which supplies its own bound in the actual OPFS
backend. Exact-source macOS OPFS run34612429686 passed its existing assertions;
that does not cover or waive these reproduced cases.

Attempt5 is the final permitted coherent attempt. Admit an already-aborted signal
before starting a new physical mutation, and close the registration window when
an invoked backend synchronously aborts before listener installation. Preserve
idempotent completion, pending physical settlement and cleanup/lock ordering.
Limit the OPFS-owned deadline exception to the writer operations it actually
owns; metadata observations retain Effect Clock progress bounds. No new helper
framework, storage API or broader architecture change is needed.

Gates cover abort during quota observation before write, abort during physical
call registration, and stalled exists/estimate while the backend actually
satisfies ownsOpfsWriteDeadlines. Verify cancellation classification, no ready
descriptor, no late marker and lock release after physical settlement. Add the
small late-cancel case to the existing real OPFS harness. Preserve all prior
error/Cause, writer/source lifecycle, quota, canonical and coexistence cases.
Run the complete package check and exact-source macOS gate, then obtain ONE
independent Astra medium attempt5 verdict. A fifth FAIL stops this implementation
shape; preserve evidence and rebrief a smaller scope rather than retrying it.

## Attempt 5 local checkpoint — final independent verdict pending

The physical writer bridge now refuses an already-cancelled operation and handles
cancellation during synchronous startup while retaining actual mutation/abort
settlement. Metadata observations keep their Effect Clock deadlines independently
of OPFS writer-owned deadlines. Luna reports the complete237-test package check
passing; root independently reran29 focused cases. The packed Chromium151 fixture
observes the real OPFS data generation before rolling quota cancels the write,
then verifies cancellation classification and removal after close. Its resolver
has no upfront index, so it exercises the reviewed post-acquisition race.
Linux WebKit retains the documented missing-storage limitation. Acceptance still
requires the exact-source macOS gate and one independent Astra medium attempt5
verdict. No subsequent feature, release or deployment is claimed.
