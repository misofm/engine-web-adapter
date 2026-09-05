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

## Attempt 1 implementation evidence (Astra medium, 2026-09-05)

Implementation checkpoints `f9884ea` and `09b71ef` delegate the existing adapter
choreography to the reviewed SDK. The supplied archive was installed only in
this isolated checkout with `--no-save --package-lock=false`; registry package
metadata and lockfile are unchanged. Archive provenance:

- SDK source: `79900f3f1d296b2b9af215e2a87acf1628fadb06` (reviewed #405/#428).
- Archive: `/private/tmp/dx-reviewed-sdk428/misofm-engine-0.1.0.tgz`.
- SHA256: `28492361d76a6a0815302d756c98003b202155691ab9011c7884fac377deb587`.

The adapter calls SDK `scratchBootWithWorker` once before delivery and injects
its compiled shape into SDK `createEngine` after the verified lease arrives.
SDK defaults now construct the context and host; the adapter loads the SDK feed
prelude before host registration. Its feed wrapper only delegates and translates
`PcmFeedError.operation`, retaining the typed cause. Ring/writer exports refer to
the exact SDK objects. The copied scratch Worker, feed prelude, ring layout/writer
implementation and internal test reader are removed. The pump regression now
uses the SDK's actual worklet reader instead of a second implementation.

Existing scratch/feed asset names alias SDK URLs. Explicit Worker URL/factory,
Wasm/worklet/host/prelude URLs, scratch/context/host/node/output/pump injections,
abort reasons and one-scratch ordering remain covered. The approved deadline
normalization above maps SDK `scratch-deadline` to `session.open`; start/load map
to `capability.module_worker`. Translation uses discriminants, not message text.
The adapter still owns delivery verification, leases, scheduling and prefill.
Store/storage/decoder and pump production source have no changes in this issue;
there is no progressive or second-engine path.

Validation:

- `npm run typecheck` and build: PASS.
- Initial focused session/feed/pump/foundation run: **30/30 PASS**.
- `npm run check`: **PASS**, including format, type/source policy, decoder,
  **128/128 tests**, and packed package policy. Log `/private/tmp/dx24-check.log`.
  Package policy reports 150 files / 124,583 bytes. It requires SDK ring/writer
  identity and SDK scratch/feed asset aliases and rejects copied scratch/feed
  Worker assets in the adapter archive.
- Added focused regressions cover both deadline phases, explicit Worker URL
  identity/Wasm URL and caller abort, all five SDK feed error operations with
  typed causes, a delayed verified lease before context construction, default
  host URL/options/prelude forwarding, and no repeated scratch boot.
- `npm run test:browser`: **PASS** with loopback/browser permission, using the
  existing packed fresh-consumer Vite fixture and Google Chrome
  **152.0.7977.76** (Playwright Chromium launcher). The initial sandbox invocation
  failed only on `listen EPERM 127.0.0.1`; the normal-permission run passes.
  Logs `/private/tmp/dx24-browser.log` and `/private/tmp/dx24-browser-escalated.log`.
- The packed browser gate verifies native FLAC, exact remote bytes/ETag,
  cold/warm cache behavior, PCM playback, console-first and meters-first control,
  telemetry/seek/close and the expected package asset responses/MIME types.
  Observed: 4 cold locator/network requests and no additional warm requests;
  one cold FLAC Worker and no additional warm Worker; **32 submitted PCM chunks,
  one applied seek, zero refused/torn/errors**, both sessions closed, both control
  subscription orders deliver track-keyed meters, playback-only refusal preserved.
  No console/page errors. This invocation qualifies Chrome only; no other browser
  or unsupported browser skip is claimed.
- Direct comparison: all six installed SDK generated artifacts match the
  approved `/private/tmp/dx-393-current-artifacts` bytes; their six-entry manifest
  lengths/digests match. No Wasm rebuild, artifact repin or SDK mutation occurred.

Dedicated independent review and final remote synchronization remain pending.
This evidence proves the adapter delegation against the reviewed SDK archive;
it does not claim registry publication or completion of app/offline/spectrum/
diagnostics preservation, which remains downstream work.

## Dedicated Astra medium PASS

Independent review atf457202 passes focused35 tests, package policy and actual packed Chromium playback/control/seek/close. All77 installed SDK files match the reviewed archive. The adapter has one SDK startup/PCM authority, no duplicate scratch/prelude implementation, and preserved readiness/override/error boundaries including the explicitly approved deadline mapping. Report attached to the consumer PR. This completes delegation; cache/spectrum/diagnostics/app adoption remain their bounded consumers.
