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


Second Luna XHIGH checkpoint closes compatibility control admission synchronously
at aggregate close start and adds captured-alias regressions. Opening map-race
tests now target the single SDK console acquisition, preserving late settlement
and original failure causes. SDK engine identity, canonical metadata/null and
mutable-option snapshot coverage are added. Compiled console/session tests
67/67, build, types, lint and whitespace checks PASS. Packed baseline passes;
the new collection proof fails before final registry pins, with the temporary
consumer reporting a zero collection-target capacity. No unsupported-product
conclusion is claimed: the runner copies locked dependencies, still 0.2.4, and
final registry 0.2.5 adoption/retest is required. Logs:
`/tmp/miso-796-audit/adapter95-focused-2.log`, `adapter95-lint.log`,
`adapter95-browser-2.log`. Latest main now includes accepted #102 and embedded
BLAKE3 SIMD; root integrates that before the release metadata/proof tranche.


## Independent attempt 1 candidate review — 2026-09-14

Fresh Astra MEDIUM independently reviewed integrated candidate `0bcc74d` and
verification checkpoint `3746df9`: **PASS for the #95 source and 0.5.7 package
candidate**, including combined #101 adoption. No production correction was
needed. The borrowed object is the existing SDK engine, the compatibility
console uses its managed owner, direct/compatibility measurements converge on
SDK leases, canonical metadata and master null survive projection, and aggregate
close preserves admission, late acquisition and source-lifetime cleanup.
Analysis preparation and all three subscription-limit families are copied before
opening awaits; the strengthened existing snapshot test proves singular and
collection forwarding and SDK refusal at original limits after caller mutation.

The verifier corrected the existing packed scenario's evidence: it previously
recorded readiness booleans without requiring delivery. It now requires real SDK
meter/response/spectrum payloads, fresh target-labelled frames after an atomic
selection and a refused selection, stable managed job ownership, running context,
and no meter delivery after completed close. A bounded three-second wait proves
fresh frames rather than assuming a fixed delay. SDK revision advances with each
capture; stable job identity is the appropriate refusal-preservation assertion.
The fixture's 65,536-byte collection budget was correctly refused with result 5:
two targets already require that much for observer and queued dual-mono PCM alone,
before states, bindings and IDs. The two-entry fixture now uses the accepted SDK
browser fixture's finite 1 MiB budget. Production policy is unchanged; native
accounting remains `host-core/src/spectrum.rs::spectrum_capture_collection_resources`.

Independent evidence on Node 22.23.2:

- Full `npm run check`: 380/380 tests PASS, both reproducible hash Wasm assets,
  source/decoder/types/package policy PASS (247 packaged files).
- Corrected `npm run test:browser`: PASS, Chromium 153.0.8010.12. Sparse session
  delivered 11 SDK meter updates, a 16-point response, and output/track/retained
  track spectrum end samples 2304, 14720, 16768. One sparse read and lease close;
  fourteen assets, zero console errors or failed requests. Existing dense
  cold/warm, seek, terminal cleanup and BLAKE3 fixture assertions also PASS.
- `npm run publish:dry-run`, fresh normal tarball dependency installation,
  strict public-surface compilation (including absent borrowed `close`) and
  imports PASS. Fresh lock resolves exactly one SDK, registry `0.2.5`, with
  integrity `sha512-cNMuslg9t7NAkBrYFMl8jcd1fOy5/fN+FEeDE+WdiMj+8+DkWTkvbWvMo1UMWgC+MrnX4BKhYz2QrKmAstIWwQ==`.
- Candidate metadata/lock/workflow consistently use adapter `0.5.7`, SDK `0.2.5`,
  full source `1646a6a1bd0011cc2b5480283bf498b27be460e5` and SDK archive SHA256
  `c26208470b5409ad789085d251d94bdf1117b32dcd3b5e544f8696dffffe3d4d`.

Logs are `/tmp/miso-796-audit/verify-adapter95-*`; the passing browser record is
`verify-adapter95-final-browser-bounded.log`. Earlier fixture/refusal diagnostics
are retained separately and are not passing runs. Final candidate archive is
`/tmp/engine-web-adapter-browser-DIvKBi/misofm-engine-web-adapter-0.5.7.tgz`, SHA256
`8a0b8ad2cc9f0973514c28b1b5d195a56485879835b5797299dc234a8e433c35`, integrity
`sha512-XXAarTN8Wh2ENIujHTCKh07a+EXYgP4hVPsW2g2KoqNHliEzmOPAXadV3BWYf4L7zy/BM8vbiJDrGLw1BTAYzQ==`.
This is candidate acceptance, not registry publication: merged required CI,
trusted publish/verify, adapter registry integrity and attestation proof, then
GitHub synchronization/closure remain coordinator-owned delivery gates.


## Published delivery and final closure

Independent Astra MEDIUM final published-adoption verdict: PASS. PR #107 merged
as `09842280710425c8ab321b97d39ecb49b5fe75cc` after required macOS Chromium/WebKit
qualification [34794520960](https://github.com/misofm/engine-web-adapter/actions/runs/34794520960)
passed. The qualified PR and merged source have the same tree
`ecbbecf4022bf5b7f559ad25b7ae5ce0cc3f59e0`. OIDC publication
[34794726491](https://github.com/misofm/engine-web-adapter/actions/runs/34794726491)
completed successfully. Public adapter `0.5.7` depends exactly on registry SDK
`0.2.5`; concurrent adapter `0.5.6` had already been published, so its immutable
identity was preserved.

The independently downloaded public archive is byte-identical to the accepted
candidate: SHA-256 `8a0b8ad2cc9f0973514c28b1b5d195a56485879835b5797299dc234a8e433c35`,
SHA-1 `eae2472b38da784fc488273588f176f579dc3c5e`, integrity
`sha512-XXAarTN8Wh2ENIujHTCKh07a+EXYgP4hVPsW2g2KoqNHliEzmOPAXadV3BWYf4L7zy/BM8vbiJDrGLw1BTAYzQ==`.
A fresh normal registry installation passes public imports and strict types,
including the borrowed engine close exclusion, and resolves exactly one SDK
0.2.5 with its verified registry integrity. npm 11.19 cryptographically verified
package signatures/attestations; the independently checked SLSA v1 DSSE binds
the exact archive, repository, npm-publish workflow, main source commit above
and publication invocation `34794726491/attempts/1`.

Durable independent report: `/tmp/miso-796-audit/verify-adapter95-published-verdict.md`;
registry archive: `/tmp/miso-796-audit/misofm-engine-web-adapter-0.5.7-registry.tgz`.
All source, package and published-adoption gates are PASS. Root synchronizes
this evidence upstream and the matching GitHub issue before verified closure.

## Exact SDK dependency correction release

Reopened after app#210's required real-browser proof established engine#801:
published SDK 0.2.5 live spectrum repeatedly gaps despite valid uninterrupted
audio. Previous adapter 0.5.7 source/provenance PASS remains valid for its bytes.
The bounded next slice changes only the exact SDK dependency to the verified
engine#794 correction release and adapter patch metadata/lock/necessary existing
guards. Candidate versions are SDK 0.2.6 and adapter 0.5.8; re-audit availability
before freezing. No adapter backend, ownership, cache, PCM or Wasm changes.

Luna XHIGH implements metadata; separate fresh Astra MEDIUM verifies. Root
checkpoints, integrates latest main, runs existing package/type/test and packed
fresh-consumer gates with exactly one SDK resolution, then required browser CI
and the existing OIDC release. Verify registry archive/integrity/provenance and
provide exact identities to app#210. Existing packed browser scenario must retain
same-engine measurements and corrected live spectrum. No republishing existing
versions, dependency overrides or deployment on local-only identities. Record
new source/run/archive identities separately, sync GitHub, close after verification.

## Adapter 0.5.8 candidate PASS

Checkpoint `d0f7db8` changes only the eight dependency/version/provenance guard
paths: adapter 0.5.8 adopts published SDK 0.2.6 from source
`cdf629d6bfd0224b3532dd0abd04b9581240da56`, SDK archive SHA256
`8219178d591c76d820d7ad2e2f7b894fe7f39185f89667f59c675fad603b81eb`.
No adapter runtime/backend/Wasm changes. Luna's terminal evidence reports full
check 380/380 tests, 247 package files, packed Chromium spectrum/response proof
and publish dry-run PASS; those implementation gate runs have no saved log files.

Fresh Astra MEDIUM independently reviewed the diff and rebuilt the same archive,
then passed normal fresh tarball installation, strict public types/imports and
exactly one registry SDK 0.2.6. Actual SDK archive/source provenance matches the
pins. Candidate adapter SHA256
`ad740867c1c80d2594d96364d646a135490e1f9a03c73fec5b9601346507d948`;
SHA1 `d8546f99d955d9687d934b0119a2d8a8b3374805`;
integrity `sha512-rWOffhfIjwquuIpnI3S3jBYdxeZYD5MqG33Y9VpRGGBaKLRsN9Gf3ci1i2peveCYuvf3HE0VH77WOitq2qHRJQ==`.
Independent report `/tmp/miso-adapter058-verifier/candidate-verdict.md` clearly
separates independent results from implementation-reported terminal gates.
Required CI, immutable publication and published archive/signature/attestation
verification remain pending; no completion claimed for corrected adapter bytes.
