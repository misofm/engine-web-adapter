# Open sparse engine sessions through the existing controller

Stateless smallest-slice brief approved by non-implementing Astra medium after read-only inspection of accepted #62 implementation1cc6f2eb07c90fde8ca6124ce01db857eaa99f8a and evidence checkpoint cdc327ce900a2cf6f72a1ec8932cbae83676f048. The shared session controller and sparse pump come from merged #60 ea19c2b381b2d2e82f50b53589df4b5349ea4392. Accepted predecessor #62 is closed and merged through PR63 in5bdd093517027c24f82b1ea0c1f6d1306e689f79. Root authorizes implementation only after creating and synchronizing the matching numbered issue on this baseline.

## Smallest public capability

Export `openSparseEngineWebSession(options: SparseEngineWebSessionOptions): Promise<EngineWebSession>` from the existing root entrypoint. Keep `openEngineWebSession` and its dense/native-range options compatible. Sparse options are:

```ts
type SparseEngineWebSessionOptions = Omit<
  EngineWebSessionCommonOptions,
  "store" | "createPump" | "ingestDiagnostics"
> & {
  readonly store?: Pick<VerifiedSparsePcmStore, "openSession">;
  readonly resolver?: SparsePcmSessionOptions["resolve"];
  readonly maximumMetadataBytes?: number;
  readonly createPump?: (options: {
    readonly lease: SparsePcmSessionLease;
    readonly sources: readonly SparsePcmPumpSource[];
    readonly signal: AbortSignal;
  }) => Promise<EnginePump>;
};
```

Use actual exported SparsePcmSessionOptions, SparsePcmSessionLease, SparsePcmSessionSource and SparsePcmExpectation from /stems; the resolver option maps to openSession.resolve (not resolver). Forward maximumMetadataBytes only when supplied so #62 retains its accepted default/accounting policy. Omit absent optional fields rather than sending explicit undefined through strict boundaries. No flac option or automatic transport selection is introduced in this slice. An omitted resolver means preinstalled verified sources only; a supplied resolver produces #62's sparse span source. Unknown injected dense/flac input paths must refuse, never trigger fallback. Existing document/sources assertions, console, observation, seek, output and general loading/prefilling progress remain available; do not invent sparse per-chunk diagnostics that #62 does not supply. leaseId is a label, not a pin name, for this entrypoint.

## One private seam, one controller

Keep one existing session controller. The two public entrypoints select one private source-preparation function after common canonical document normalization, scratch compilation and crossSessionDeclarations. Its result needs only:

```ts
interface PreparedSources {
  close(): Promise<void>;
  createPump(sources: readonly PcmPumpSource[], signal: AbortSignal): Promise<EnginePump>;
}
```

Dense preparation retains its existing FLAC expectation/admission/store behavior and captures the correctly typed dense lease/createPump in this closure. Sparse preparation captures #62's sparse lease, authoritative compiled sample rate and correctly typed sparse createPump. It augments each final ring declaration with required sampleRateHz before invoking the custom hook or #60 PcmPumpWorkerClient.createSparse. No union lease cast, fake dense Blob, mode-aware controller class, second scheduler, factory framework or copy of session.ts.

Common code replaces its direct lease variable with PreparedSources, registers its close at the existing lease-cleanup position, and asks it to create the pump once feed rings exist. Everything after that uses the existing EnginePump/controller. Retain the same feed, console, prefill, meter, seek and failure behavior. Narrow shared helper parameter types only where needed to remove their accidental dependence on dense-only option fields.

## Authority and complete readiness

Use normalizeDocument/extractDocumentDeclaration, existing engine scratch validation and crossSessionDeclarations before source preparation. Derive #62 requirements from ALL ordered source IDs plus the exact authoritative content/channels/depth/frames/canonicalBytes and compiled sampleRateHz; existing cross-check binds that rate to the document. Keep every ID/ring when identities converge. #62 dedupes only storage assets. Optional caller declarations remain assertions checked against the document, not replacement authority.

No cache marker, delivery metadata, projection or resolver can change source shape. Await the complete #62 lease before creating a ready engine session. A missing/corrupt final source fails even if earlier sources succeeded. Preserve exact document bytes through engine boot, including -0 and arbitrary existing graph/channel maps; no new session parser, SDK importer, mono transform or schema is part of this integration.

## Minimal Effect ownership and teardown

Compose NEW sparse source acquisition/ownership with Effect.fn/gen and scopes; reuse the actual #62 store public boundary without another long-lived runtime or placeholder dependency service. An injected store remains caller-owned. If store is omitted, create one OpfsStorageBackend with existing defaults and pass it explicitly into new VerifiedSparsePcmStore({backend}); retain both handles in PreparedSources. This is necessary because accepted VerifiedSparsePcmStore.close disposes only its runtime and intentionally does not close any backend, while OpfsStorageBackend.close releases its write Worker. No factory/runtime framework is needed. Failure closes all resources acquired so far; successful session teardown closes the map, then the owned store, then the owned backend. Never close an injected store or its backend. Keep cleanup active even if construction or an earlier close fails.

The underlying openSession Promise must physically settle before an abandoned opening removes its cleanup owner. Pass the actual session AbortSignal and retain a scoped finalizer through that settlement; do not use a generic race that abandons a late returned lease. A small uninterruptible Promise bridge plus explicit cancellation forwarding/check before handoff is sufficient because #62 already owns bounded cancellation and settlement. Effect scope transfers ownership only on success; failed/cancelled acquisition closes any returned map and the owned default store. Do not wrap the whole existing controller in one tryPromise and call that an Effect migration.

Register PreparedSources cleanup immediately on return, before later engine/feed work. Existing reverse ordering must terminate/close pump before feed/engine and before descriptor-map close; owned default store closes after the map, and its explicitly owned backend closes last. Close remains idempotent. Cleanup attempts all owned resources even when one close rejects, preserving the primary refusal and cleanup cause at the new acquisition edge. Keep existing shared controller error policy; this slice does not authorize an unrelated rewrite of all historical cleanup paths. No aggregate session/source-count deadline is added.

Preserve existing signal semantics: session.ts detaches the parent abort listener before successful return, so the signal governs opening, not post-open lifetime. After handoff the caller must call session.close (the separately scoped app lifetime owner does this on Clear Data/caller abort). Do not claim automatic post-open cancellation or expand this issue to change dense behavior. The existing controller owns terminal pump failure cleanup. A store facade closing separately cannot substitute for session.close because #62 maps deliberately outlive their facade. Standalone callers must exclude external deletion through actual pump/session teardown. The app's library shared lock and Clear Data signal remain a separate required app-adoption issue; no owner/pin files are introduced here.

## Representative gates and exact boundary

- Existing dense session tests stay green. New synthetic sparse open with one unique asset plus two source IDs uses one complete lease, correctly typed sparse pump inputs/rate, both rings and existing prefill/seek/console behavior. No network or codec needed.
- Document/caller/compiled shape or rate disagreement fails before resolver. Last-source failure produces no ready session; already committed valid assets survive.
- Abort during preparation and immediately after lease/pump acquisition cannot leak late resources or return success. Pump failure/explicit close proves pump-before-map-before-owned-store ordering. Injected store is never closed; default store and explicitly owned OPFS backend close on failure and normal teardown, even if map cleanup rejects. Tests distinguish facade disposal from actual backend Worker release; an injected store has neither called.
- Use the existing packed browser harness for one synthetic sparse session open/prefill/seek/close proof and exported root API resolution, reusing existing assets and fixture infrastructure. This is the actual shared-session seam, not another transport/browser matrix.
- Focused session tests, typecheck/format/source policy and one full package check; no benchmark or new harness.

Expected changes: session.ts, session-types.ts, index.ts, focused session tests and the existing packed browser fixture; one small private preparation file only if it makes the two closures clearer. Do not change #62 storage format/lifetime policy, #60 scheduler, acquisition/codec code, Rust/SDK, CLI, app database or service worker. This independently closes synthetic/preinstalled sparse engine-session integration; full-stream acquisition and deployed offline app adoption remain required successors.

## Workflow

Astra medium supplied and rechecked this brief against accepted exports. Luna xhigh implements in one dedicated worktree; a fresh non-implementing Astra medium gives one adversarial PASS/FAIL per coherent attempt, maximum five attempts. Root owns exact-path checkpoints, pushes, matching GitHub issue evidence/closure and merged delivery. Pause at a compiling focused-green tranche before adding more work; no coherent tranche may span more than30 minutes without a checkpoint. CLI preparation and app lifetime review continue independently against fixed dependencies. The final user-requested Astra xhigh simplification follows the full functional flow, not this intermediate feature.

## Attempt 1, shared-controller implementation checkpoint

Luna xhigh added the sparse public opener/options, one shared PreparedSources seam, authoritative compiled-rate/source-shape preparation and Effect-scoped map/store/OPFS-backend ownership. The controller retains existing opening-only abort behavior and normal feed/prefill/seek/terminal cleanup. One synthetic sparse test checks source ordering, both aliases, mono16/stereo24 shapes, sample rates, omitted-resolver behavior, seek and pump-before-map cleanup with a caller-owned store. Product files are session.ts, session-types.ts and index.ts.

Build, test compilation and34 session tests PASS. Root independently ran typecheck, all34 session tests and format policy successfully; logs: `/data/sparse-pcm-launch/tooling/adapter-64/attempt1-tranche1/`. This is an intermediate compiling checkpoint, not an independent verdict or complete qualification. Remaining discriminators include malformed dense/flac path refusal, late source failure and shape refusal before resolution, abort around acquired maps/pumps with physical settlement, default backend Worker disposal even if prior cleanup rejects, preservation of acquisition plus cleanup causes, and actual installed-package browser sparse session open/prefill/seek/close. A full package check follows that bounded qualification tranche. No acquisition codec, registry or app delivery claim is made.

## Attempt 1, qualification implementation checkpoint

Luna xhigh added early dense/FLAC input refusal, full Effect Cause mapping at both sparse Promise boundaries, focused failure/cleanup/cancellation tests and a sparse open/prefill/seek/close scenario in the existing installed-package browser harness. The full package check passes265 tests and package policy. Browser launch initially failed discovery of a Chrome executable; a `/bin/true` shim exercised consumer generation/typecheck/bundling only and is explicitly not browser evidence. Root located installed Chromium and actual browser qualification is now running with an explicit executable. This checkpoint is not an independent verdict or completed browser qualification. Registry/app delivery remains out of scope.
