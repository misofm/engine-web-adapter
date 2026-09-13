# Forward managed engine response and spectrum through browser sessions

## Requirements and smallest closable outcome

Unblock misofm/app #210 with a published adapter that exposes the accepted
engine's focused analysis APIs through its existing session. This is a thin
forwarding and release slice, not a new analysis implementation.

1. Both `openEngineWebSession` and production `openSparseEngineWebSession`
   accept the SDK's approved spectrum preparation options. Preserve existing
   no-analysis opens. Pass the accepted #793 multiple-target collection and
   its explicit aggregate capture budget to the same `createEngine` call that
   owns playback. Each entry retains its target kind, stable ID and exact
   channel mask. Forward the existing optional response/spectrum subscription
   limits so the app can bound delivery and retained results. Use SDK types and
   validation; do not introduce adapter capacities or duplicate ABI layouts.
2. Add these methods directly to `EngineWebSession`, typed from the matching
   `BrowserEngine` members: `subscribeTrackResponse`, `queryTrackResponse`,
   `subscribeSpectrum`. Forward to the existing engine with its receiver and
   return its results/handles unchanged. Consumers call the returned spectrum
   handle's `update(request)` for the accepted atomic target/channel/config
   update, and `readLatest()`/`close()` normally. Preserve all identities,
   L/R vectors, units, availability, epochs, spans and loss accounting.
3. Selection changes must use that SDK transaction without reopening the
   session, rebuilding preparation, changing the pump or suspending/resuming
   audio. Invalid selection leaves the existing stream intact according to
   #793. Paused subscriptions/updates do not start audio. Analysis operations
   remain outside the transport/seek queue and do not become terminal playback
   failures merely because a query or selection is refused.
4. New entry calls reject while the session is closing/closed, and a
   `console: false` session reports the existing `console.not_attached`
   refusal. SDK `engine.close()` remains responsible for its subscriptions,
   response/spectrum Workers and pending operations; reuse the current adapter
   cleanup ordering and cancellation. No second subscription registry, timer,
   result cache, Worker owner or callback multiplexer. After physical close
   completes, no live handle/callback/Worker from that engine may survive.
5. Preserve the current adapter snapshot-at-open behavior for added mutable
   preparation/limit inputs before deferred opening work. Reuse SDK copying
   helpers if public; otherwise copy only the small declared option structure.
   Do not broaden the API to all `CreateEngineOptions` or expose raw internals.
6. Preserve existing console edits, meter/GR projection, telemetry, source
   observation, source diagnostics, loading/progress and seek/close semantics.
   Keep canonical `blake3:` identities and cache namespaces, codec 0.1.1 and
   current decoder pooling. Warm verification remains sequential 512 KiB reads
   bounded by each sparse interval; the separate ingest-span limit remains
   128 KiB. Preserve hashing of implicit zero gaps and split PCM frames, exact
   byte-count/digest checks, short-read rejection, deadlines/cancellation, and
   success-only readiness/verification timing. No source-store, codec, pump,
   Effect-pipeline or UI changes belong here.

   Also preserve adapter 0.5.2's verifier-scoped warm task yields from #93:
   unchanged 64 KiB zero-gap checkpoints resume through one lazily allocated,
   reused MessageChannel with at most one pending continuation. All-active
   verification allocates no channel; cold yielding and the absent-capability
   fallback remain unchanged. Cancellation settles without awaiting message
   delivery, stale callbacks are harmless, and ports/listeners are finalized
   before readiness and identity-lock release. Retain its existing tests; do
   not rerun the accepted performance experiment or move this resource into
   the new analysis/session ownership.

## Dependency and public contract binding

Read-only refresh against merged PR #94 confirms adapter main
`e8b119cc013b205be18f5273bd66ece944b787ad`, version 0.5.2 with SDK 0.2.4.
This supersedes the earlier 0.5.1 / `cced684b` inspection baseline. The only
runtime change is #93's bounded warm zero-gap task continuation; session and
managed-analysis forwarding seams are unchanged. Main's version declaration
alone is not a claim that registry publication completed. Read its `AGENTS.md`.
App #210 is OPEN and explicitly depends on this publication. Fetch again at
implementation start and before landing; preserve primary/unrelated work.
Root has created spec-only worktree `/tmp/miso-adapter-engine-analysis-integration`
on `codex/engine-analysis-forwarding` from this main and matching adapter #95.

Engine #793 is still in progress in `/tmp/miso-engine-spectrum-switch`;
inspection at HEAD `ab2484ca4e802b78a8cf25025451dcff73ae3844` is not acceptance.
Current shared source declares `SpectrumCollection` with `entries` of
`{ target, channels? }` and aggregate `maximumCaptureBytes`. Current managed
handles already expose `update`, but browser `CreateEngineOptions` still only
declares singular `spectrum`; browser collection forwarding is unfinished.
Therefore implementation waits for #793 PASS and its published SDK. Record
the accepted browser option name/type and exact registry SDK version/source/
archive integrity before coding. Do not infer a browser field from the
headless implementation or forward unfinished host messages manually.

The three session method names above are existing public SDK names. Preparation
and subscription-limit option names/types must follow the accepted
`CreateEngineOptions` exactly; singular and collection preparation retain the
SDK's exclusivity rules. App #210 uses both lanes of `trackPostMatrix` for all
selectable tracks and one active panel, but the adapter must not hardcode that
app policy or narrow the SDK's supported targets. No one-shot spectrum,
resident-observation migration or additional discovery forwarding is required.
Paused requested-configuration previews use the SDK's existing public preview
API directly in the app; no adapter preview service is needed.

## Implementation locations and checkpoints

1. **Forwarding checkpoint.** In `src/session-types.ts`, extend the common
   options shared by dense/sparse opens and `EngineWebSession`; use SDK indexed
   member/option types where practical. In `src/session.ts::openSessionCommon`,
   snapshot/pass the approved options through the existing `engineOptions`
   construction and add the three guarded delegates to the returned session.
   Keep the current scratch Worker/prepared module reuse; adapt that boundary
   only if the accepted SDK's public preparation contract requires it. Existing
   `src/index.ts` already exports both common options and the session type, so
   no duplicate SDK type facade is necessary. `src/console.ts` needs no change.
   Add focused coverage in `tests/session.test.ts` and one README example.
2. **Package/release checkpoint.** After SDK publication, update exact SDK and
   adapter versions in `package.json`, `package-lock.json`,
   `scripts/check-package.mjs`, `src/provenance.ts`, README and release workflow
   pins. Derive provenance from the actual registry SDK archive; retain existing
   source-adaptation provenance and codec/legal assets. Choose an unused adapter
   version at delivery time rather than assuming a future version now. Qualify
   the final package and publish with the existing workflow below.

New wrapper lifecycle/console-opt-out errors remain `EngineWebAdapterError`;
forwarded SDK semantic failures and returned handle methods preserve the SDK's
own typed contract. Document this boundary rather than claiming all delegated
handle errors are adapter errors, wrapping every handle, or changing existing
delivery errors. Document that analysis is optional and source observation
remains available; remove any blanket README implication that all FFT work must
be implemented by app consumers.

## Smallest discriminating gates

- Extend existing session tests to prove both open paths preserve preparation
  options/limits and all three public delegates, including option mutation
  across an opening await, console opt-out and close. Reuse existing hooks and
  actual SDK wherever they already exist; do not add a create-engine abstraction
  just for testing. Test late completion at the existing close seam only as
  needed to prove adapter forwarding does not extend engine lifetime.
- Extend `scripts/browser-packed.mjs` and its generated strict TypeScript
  consumer. In one existing packed Chromium run, open a sparse session with
  two prepared tracks and actual packaged pump, engine Worklet and response
  Worker. Obtain one managed response, one one-shot response and a ready spectrum;
  update the spectrum handle to the second stable track and observe its new
  metadata/result while the same context/host/pump remain running. One rejected
  target must leave the valid selection usable; close must terminate delivery.
  Reuse existing local PCM/sparse fixture and asset-request instrumentation;
  distinct spectrum tones and the full DSP accuracy corpus are not needed to
  test adapter forwarding. Require the SDK response Worker asset to load from
  the packed consumer with correct MIME and no failed asset requests. Existing
  cold/warm, meter/console and cleanup assertions remain in the run. No new
  harness, browser matrix, remote live profile or OPFS qualification campaign.
- Run `npm run check` and the existing `npm run test:browser` on the final
  candidate, then `npm run publish:dry-run`. The packed browser runner copies
  exact locked registry dependencies into its isolated tarball consumer; record
  that fact honestly. Also install the tarball using ordinary npm in a fresh
  directory for strict public-type/import verification, so copying dependencies
  does not substitute for dependency-resolution proof. Use the runner's existing
  consumer-check source, not a second test framework. No tarballs/caches/dist
  output committed.

## Publication and completion

Use `.github/workflows/npm-publish.yml`, not a new release mechanism. It is
manual `workflow_dispatch`, accepts `mode: publish|verify` and exact 40-character
`expected_sha`, runs on main, pins Node 22.23.2/npm 11.19.0 and Emscripten 6.0.9,
and publishes through OIDC only. Update its package-version display/env and
both exact SDK dependency guards. Preserve immutable-version refusal, registry
verification, fresh registry import checks and `npm audit signatures
--include-attestations`. Never retry publishing an existing immutable version;
use verify mode after an ambiguous publication outcome.

Root synchronizes numbered local/GitHub issue #95 before implementation,
records coherent checkpoints and the requested implementer/reviewer workflow,
and merges only after independent PASS and required CI on current main. Dispatch
publication for the actual merged SHA. Completion requires the registry version
and exact SDK dependency, source/provenance, package integrity and signature/
attestation evidence, then synchronized issue closure. Report that package pair
to app #210; a source-only PASS or local tarball does not unblock app delivery.
