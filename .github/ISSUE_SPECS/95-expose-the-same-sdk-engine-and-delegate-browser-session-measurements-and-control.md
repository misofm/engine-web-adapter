# Expose the same SDK engine and delegate browser-session measurements and control

Supersedes the former three-analysis-delegate plan in this issue. Depends on
misofm/engine#796 for the frozen SDK API and misofm/engine#794 for final published
SDK provenance. Downstream: misofm/app#210. PCM readiness and backend capability
successors are separate and are not prerequisites for this issue.

## Outcome and baseline

An adapter session supplies FLAC/sparse storage and PCM while its consumer uses
one SDK engine directly for controls, observations, meters, response and spectrum.
Expose the existing playback engine; a getter alone is insufficient if adapter
`HostFeed`, canonical measurement types or a second console remain.

Current main: `f833303f146de7cbe1705fe88ae68a6d6e0d4e45`, adapter 0.5.4,
SDK 0.2.4 and codec 0.1.1. Engine accepted main is
`69c268f240bf30b2a43b43dd521120cd89dcc0b9`; misofm/engine#793 is CLOSED and its SDK 0.2.5
metadata is merged but the registry still reports 0.2.4 on 2026-09-13.
These are inspection facts; recheck before implementation and release.

## Frozen implementation contract

1. Export `SessionEngine = Omit<BrowserEngine<EngineAudioContext>, "close">`
   and add `readonly engine: SessionEngine` to `EngineWebSession`. Return the
   identical existing engine object, retaining receivers. This is a borrowed
   TypeScript view, not runtime isolation. The composition session owns close:
   consumers call `session.close()` and must not close its host/context/engine
   separately or start work after requesting aggregate close. Accessing the
   getter during closing/closed rejects with existing `session.closed`.
2. Obtain `await engine.console()` in `attachSessionControl(engine)`, preserving
   its managed-observation hook. An existing narrow `session.console` guard may
   delegate `edit`/`submit`; it must not call `createBrowserConsole(host)` or
   construct another console. Preserve exact SDK command reports and typed
   semantic failures. Ordinary aliases refuse once aggregate closing begins.
3. Delete adapter `HostFeed`. SDK `subscribeMeters`/`subscribeTelemetry` own
   leases, listener multiplexing, errors and engine disposal. Keep `session.meters`
   and `session.telemetry` as deprecated compatibility paths to those methods.
   Telemetry is an SDK-type alias and returns the SDK update unchanged.
4. The sole temporary meter compatibility projection may add legacy
   `peak = Math.max(peakLeft, peakRight)` to track/master records. Define its
   types as SDK types extended with that field, never a second canonical model.
   Spread all canonical update/record fields so generation, validity, loss,
   spans and future fields survive; preserve master `gainReductionDb: null`.
   Correct old null-to-zero types/tests/docs deliberately. This stateless
   per-callback projection adds no subscription owner, timer, cache or Worker.
   New consumers use `session.engine.subscribeMeters` and app-owned display math.
5. Both dense and sparse opens accept SDK-typed `spectrum`,
   `spectrumCollection`, `observationSubscriptionLimits`,
   `responseSubscriptionLimits` and `spectrumSubscriptionLimits` and forward
   them to that one `createEngine`. Keep singular/collection exclusivity and
   exact prepared target/mask/budget semantics. Snapshot mutable options before
   the first opening await, using public SDK copying helpers where available
   or only the small declared structure. Preserve scratch-compiled module reuse; the accepted SDK owns preparation
   validation and its boot contract.
   No adapter-specific target policy or broad `CreateEngineOptions` spread.
6. Do not add `session.subscribeTrackResponse`, `session.queryTrackResponse`
   or `session.subscribeSpectrum` mirrors. Use the same SDK engine for all
   those operations; their failures are optional analysis failures, outside the
   source seek/transport queue. Document native SDK errors on direct engine
   calls and legacy adapter errors only at existing convenience boundaries.
   `console: false` retains adapter console/meter/telemetry refusals; the exposed
   engine retains its own SDK policy semantics, without a new adapter facade.
7. Keep aggregate cleanup order, retries and late acquisition handling.
   SDK `engine.close()` closes SDK-owned leases/subscriptions/Workers; adapter
   closes producer, feed, output and source/store lifetime through its existing
   cleanup. No second engine, context, Worker pool or disposer registry.

## Preserve launch source behavior

Do not alter FLAC/sparse resolution, BLAKE3 identities/cache namespace, canonical
count/digest verification, integer PCM conversion, OPFS, ring/feed/scratch
protocol, seek/prefill algorithm, prefetch or Effect control pipelines. Preserve
the current preparation-owned warm pool: at most three workers, further bounded
by concurrency/funded 2 MiB slots; one current 512 KiB payload per worker,
interval-local reads, 128 KiB ingest bound, 64 KiB zero checkpoints, consumed
buffer disposal, warm MessageChannel yields and main-realm fallback. Keep cold
capacity, Blob/index identity, cancellation/physical cleanup before locks and
readiness, diagnostics and packaged verification assets. No new source format,
IndexedDB backend, selector, storage framework or performance experiment.

## Locations and checkpoints

`src/session-types.ts`, `src/session.ts`, `src/console.ts`, public exports,
`tests/console.test.ts`, `tests/session.test.ts`, README, existing packed consumer.
Refresh/integrate latest main in the isolated worktree; do not touch unrelated
primary changes. Source implementation can use an exact accepted SDK tarball
before registry publication, with temporary installation state outside commits.
Final dependency pins/package acceptance require the registry SDK from misofm/engine#794.

1. Same engine/control/measurement ownership and option forwarding; focused
   types/tests green, then root commits exact paths.
2. Upgrade the exact SDK dependency and adapter release identities using existing
   scripts/workflow; packed qualification, fresh review and merged delivery.

## Focused gates and publication

- Both open paths expose object-identical `engine`/host/context; repeated console
  acquisition uses the SDK's existing owner hook. A managed observation/manual
  console conflict retains SDK behavior. Multiple direct and compatibility
  measurement subscriptions share one host lease; all canonical fields and null
  survive legacy projection. `console: false`, late acquisition and close retain
  existing contracts; no callbacks survive completed aggregate close.
- Mutate input preparation/limits across an opening await and prove snapshotted
  values reach the existing engine. Preserve ordinary no-analysis opening.
- Extend `scripts/browser-packed.mjs` and its strict consumer, using one existing
  packed Chromium scenario: actual sparse session/pump/Worklet/response Worker,
  real SDK meters, one managed response and spectrum, atomic target switch
  while context/pump remain running, refused target preserving the old stream,
  close and no asset failures. Reuse existing fixture and cold/warm assertions.
  This tests delegation; the app owns full numerical plotting acceptance.
- Run `npm run check`, `npm run test:browser` and `npm run publish:dry-run` on
  the final candidate. The browser runner copies locked dependencies; also
  install the tarball normally in a fresh directory and compile/import its
  public surface to prove registry dependency resolution. No new harness/matrix.
- Choose an unused adapter version at release time. Update existing package/
  lock, `src/provenance.ts`, `scripts/check-package.mjs`, README and workflow
  exact-version/SDK guards from actual registry bytes. Preserve legal/codec
  assets and trusted release checks. Use existing `npm-publish.yml`
  `publish|verify` with exact merged main SHA, OIDC and existing attestation
  checks; an ambiguous publish is recovered with verify, never republishing.

## Workflow and completion

Luna XHIGH implements; a fresh Astra MEDIUM verifies and fixes concrete bugs
within this brief only; the fresh Astra MEDIUM coordinator is distinct. Maximum
five coherent attempts, one verdict each; stop/rebrief after the fifth failure.
Checkpoint focused-green tranches, run required CI, preserve exact source/package
evidence and synchronize local/GitHub state. Completion requires independent
PASS, merged source, published package and exact registry SDK dependency,
archive integrity and provenance/attestation proof, then verified issue closure.
A source PASS or tarball alone does not establish published app dependencies.

## Decision record

Scope amendment only. The old three-method delegation and instruction to retain
adapter measurement ownership are superseded. No new runtime result is claimed.

Coordination entry point: https://github.com/misofm/engine/issues/796 . Independent follow-ups https://github.com/misofm/engine/issues/797 , https://github.com/misofm/engine-web-adapter/issues/101 and https://github.com/misofm/engine-web-adapter/issues/102 do not block this issue or app misofm/app#210.


## First source checkpoint

Luna XHIGH implements borrowed `session.engine`, SDK-owned console/meter/telemetry
paths, removal of adapter HostFeed, the sole legacy peak display projection with
canonical metadata/null preserved, and snapshotted spectrum/collection/limits
forwarding. Build, typecheck and focused compiled console suite 22/22 pass.
The exact accepted local SDK tarball is installed temporarily in node_modules
only; package metadata/lockfiles remain unchanged pending registry #794.
Root checkpoints the six source/test/README paths before final session/packed
proof and published dependency adoption. No independent verdict/publication
is claimed yet. Current adapter main f833303 remains included.
