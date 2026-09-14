# Apply OPFS capability requirements only to the selected storage path

Independent of adapter misofm/engine-web-adapter#95/misofm/engine-web-adapter#101 and engine/app analysis work.
This issue does not implement IndexedDB, WAVPACK or another backend.

## Outcome and source evidence

A caller supplying an existing custom dense or sparse store can open a session
without unrelated OPFS/Web Locks browser APIs. Default OPFS sessions retain
their current early, typed capability refusals and Worker-side write probe.

At adapter main `f833303f146de7cbe1705fe88ae68a6d6e0d4e45`,
`src/session.ts::openSessionCommon` unconditionally calls
`assertEngineWebCapabilities` before selecting a store. That checker in
`src/capabilities.ts` requires `navigator.storage.getDirectory`,
`FileSystemFileHandle` and Web Locks even when `options.store` supplies the
whole storage service. `OpfsStorageBackend.open()` in `src/stems/storage.ts`
already probes actual Worker-only write support before source resolution.
This establishes an unnecessary source-level gate, not a demonstrated production
incident. Refresh latest main and read its AGENTS before implementing.

## Frozen correction

1. Separate the existing runtime predicates (cross-origin isolation, SAB,
   Worker, AudioContext/AudioWorklet and Wasm SIMD128) from OPFS persistence
   predicates in `src/capabilities.ts`. Reuse existing errors/remedies.
2. Preserve the existing module-level `assertEngineWebCapabilities(scope?)` as the comprehensive
   default-FLAC/OPFS preflight for compatibility. Use two small internal/exported
   module helpers, `assertEngineRuntimeCapabilities(scope?)` and
   `assertOpfsStorageCapabilities(scope?)`, to compose its existing behavior.
   Export from the package only if a current public use requires it; no new
   capability registry, backend descriptor or plug-in protocol.
3. Both open entry points snapshot whether a store was supplied before awaiting
   work. `openSessionCommon` always runs runtime checks; run OPFS checks only
   for the default store path, before creating it or invoking resolver/network
   work. Sparse opening currently removes `store` from `commonOptions`, so pass
   the selected-path fact explicitly; do not accidentally treat it as default.
4. A supplied store owns its persistence/locking requirements. Do not inspect
   its class name, assume all custom stores use OPFS, or disable actual backend
   errors. Injected OPFS still executes its own `open()`/Worker support checks.
   Default OPFS retains window-visible file handles/getDirectory and Web Locks
   checks, Worker write handshake and existing typed failures/remedies.
5. Preserve source validation/admission ordering, BLAKE3/count verification,
   current locking and cleanup contracts, warm/cold paths and output behavior.
   There is no promise that a custom store is safe on multiple tabs without its
   own coordination. Do not modify locks, storage algorithms or source policy.

## Small proof and completion

Change `src/capabilities.ts`, the common-open selected-path argument and focused
`tests/session.test.ts` cases plus concise API docs. Existing memory/custom-store
fixtures must reach normal opening for dense and sparse paths with valid runtime
capabilities but no OPFS/file handles/Web Locks. Missing runtime requirements
must still refuse before store/resolver work. Default-store cases must still
refuse missing persistence APIs before source work and retain the existing
Worker write-support failure/cleanup case. A supplied store's own failure must
propagate. Reuse the existing default OPFS packed smoke; no new browser/backend
matrix or IndexedDB test framework.

Run focused tests and `npm run check`, then current required CI. One coherent
checkpoint should suffice; root commits focused-green exact paths before more
implementation. Luna XHIGH implements, a fresh Astra MEDIUM verifies and may
fix concrete in-scope bugs only, and a separate fresh Astra MEDIUM coordinates.
At most five coherent attempts/one verdict each; after five failures stop and
rebrief. Root records the source/evidence and closes local/GitHub state after
independent PASS, merged delivery and required CI; verify remote CLOSED.
If package publication is deferred, explicitly record the ordinary release
successor and do not claim registry availability. It may share a ready adapter
release cut, but misofm/engine-web-adapter#95 and app misofm/app#210 do not wait for this independent correction.

Decision record: scope-only; no implementation or fresh runtime result yet.


## Implementation checkpoint

Luna XHIGH implemented the frozen selected-path correction in isolated
`codex/backend-capabilities`: runtime and OPFS preflights compose the existing
comprehensive checker; dense and sparse opens snapshot whether a store was
supplied and skip persistence predicates only for that selected custom path.
Default-store refusal order and actual backend failures remain intact.
Implementer reports focused session 45/45, full `npm run check` 367/367 with
package policy, and whitespace checks PASS. Root checkpoints the four intended
source/test/README paths; no release pins changed. Independent fresh Astra
MEDIUM verification and required merged CI remain pending. This is attempt 1;
no published capability or final acceptance is claimed yet.
