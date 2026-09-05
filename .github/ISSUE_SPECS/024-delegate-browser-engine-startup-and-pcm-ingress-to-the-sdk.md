# Delegate browser engine startup and PCM ingress to the SDK

## Product outcome and ownership

The adapter uses the reviewed SDK for scratch compilation, browser context/host construction, PCM ring/writer layout and feed worklet lifecycle. It retains FLAC delivery, canonical byte/hash verification, storage leases, bounded pump scheduling, readiness, seek orchestration and control projections. This finishes the existing layer-boundary move; no new audio or storage feature.

## Dependencies and execution

Begin from reviewed adapter control #22 plus reviewed OPFS #19/#21. Consume exact reviewed engine #405/#428 archive, record source commit and SHA256. Root creates an isolated integration branch, preserves original worktrees, checkpoints coherent tranches, and assigns Astra medium implementation plus a separate Astra medium reviewer. Never copy unreviewed source into the dependency. App intentionally vendors archives; registry publication is separate, and existing semver must not be fabricated.

## Frozen behavior

- Compile shape once before delivery using SDK scratchBootWithWorker. Keep abort/deadline and caller factory/URL overrides. Inject the already compiled shape into createEngine after all stems are verified/stored, avoiding a second scratch boot.
- Delegate host construction to SDK createDefaultHost. A thin wrapper may suspend a running context and load SDK feed prelude before host worklet registration. Preserve createContext/createHost/scratchBoot overrides and exact source/rate/quantum refusals and owned cleanup.
- Replace adapter ring implementation with SDK exports; preserve existing stems public exports as re-exports when necessary. Pump owns scheduling and consumes SDK writer without local layout constants/arithmetic copies.
- Replace feed implementation with a thin SDK delegate and exact typed error translation. Default feed and scratch asset URLs come from SDK; existing adapter asset names may alias SDK URLs for compatibility, but no duplicated worker/prelude implementation ships.
- Preserve verified-all/stored-all -> context/host/feed -> pump -> initial-generation prefill -> output/control -> ready order. No progressive playback. Play/pause/seek/control/meters/telemetry keep existing semantics and bounded cleanup.
- Preserve explicit module/worker/node/pump overrides. Translate operation discriminants at boundary, never parse error strings. No new request IDs, console queue, codec, storage backend, schema, Rust ABI, or introspection.

## Allowed paths

src/session.ts, src/session-types.ts, src/feed.ts, src/scratch.ts (remove/delegate), src/stems/ring.ts (re-export), src/stems/index.ts, src/assets.ts, src/internal/engine-web-scratch-worker.ts (remove), src/internal/engine-web-feed-worklet.js (remove), src/provenance.ts, NOTICE, README.md, corresponding existing session/feed/pump/foundation/public-types tests, scripts/check-package.mjs, scripts/browser-packed.mjs, scripts/copy-assets.mjs only to stop copying removed assets, this spec. Update any exact referenced old asset filename to its actual tracked equivalent before implementation. Tests asserting implementation copies should instead assert public delegated behavior. No store/decoder or unrelated tool changes.

## Required evidence

1. Existing focused session/feed/pump/types tests prove one scratch, preserved overrides, typed failures, verified lease before context, prelude before host, prefill before ready, seek generations and idempotent cleanup on cancel/failure.
2. Full npm run check (includes test/package) against the exact SDK archive passes. Packed public consumer has one SDK authority and no copied ring/feed/scratch implementation. Generated six SDK engine artifacts remain untouched.
3. Existing packed real-browser test proves default session open, native FLAC delivery, playback/control/seek/close and all expected asset responses from the package URLs. Record actual browsers and distinguish unsupported skips from passes. Reuse existing gate; no extra framework or benchmark matrix.
4. Record tarball/source provenance and dedicated Astra review before issue completion. Downstream offline/spectrum/diagnostics compatibility and app integration are separate bounded consumers; this issue cannot claim full app success.

Matching issue: misofm/engine-web-adapter#24. Implementation awaits reviewed SDK #428 and OPFS #19/#21 checkpoints.

### SDK deadline translation decision

The reviewed SDK uses scratch-deadline for both handshake and request deadlines. Map this discriminant to existing adapter session.open and retain the SDK error as cause. Map scratch-start/load to capability.module_worker. This intentionally normalizes the former handshake-timeout classification; do not parse messages, observe a duplicate handshake or extend SDK errors merely to preserve that incidental distinction. Existing timeout bounds and fail-close behavior remain. Focused tests and README describe the exact mapping.
