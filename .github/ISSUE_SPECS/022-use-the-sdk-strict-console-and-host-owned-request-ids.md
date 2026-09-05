# Use the SDK strict console and host-owned request IDs

**Status:** Sol brief approved by root; matching GitHub issue misofm/engine-web-adapter#22. Implementation starts after the active PCM test tranche is checkpointed.  
**Dependency:** engine issue #393 must pass Astra review first. Adapter validation uses an exact locally packed SDK from that reviewed commit.  
**Independence:** this is a control-consumer migration. It does not depend on or overlap the PCM-ingress ownership draft.

## Smallest closable slice

Replace the adapter's parallel browser-control implementation with the reviewed engine package's existing control surfaces:

- `createBrowserConsole(host)` owns semantic edit mapping and returns the SDK `EngineConsole`.
- The host from #393 owns every request ID; meter, telemetry, status, session-map, and console calls pass payloads without IDs.
- `EngineWebConsole.submit(...edits)` becomes the strict SDK submission and resolves to the exact existing `CommandReport`. A semantic engine refusal resolves as that report with `ok: false`, `result`, reason/name, rejected index, admitted count, and application sample intact. Transport/usage failures continue to reject.

Delete the adapter `HostRequests` counter/serialization chain, 48-byte `decodeLaneRecords`, `ConsoleWriter`, retry timers, pending coalescing, and escalation state. Do not replace them with a broker, a new coalescer/gesture API, or another request abstraction. The prior `Promise<void>` contract that could resolve on supersession/background ownership is removed rather than renamed.

Retain the adapter's current meter and telemetry value: one host lease shared across multiple listeners, existing frame-to-`MeterUpdate`/`TelemetryUpdate` projection, first-listener arm, last-listener release, unsubscribe idempotence, and session-close cleanup. These leases call payload-only `host.meters({enabled,onFrame})` and `host.telemetry({enabled,onFrame})` directly. Their existing typed adapter refusal remains unchanged where the host answers nonzero.

`attachSessionControl` may call `host.sessionMap()` for the projection map and `createBrowserConsole(host)` may make its own existing map request. Host-owned IDs make this safe. Do not add an SDK map getter or new SDK API merely to remove that small duplicate read.

## Frozen behavior and limits

- Preserve SDK whole-batch validation: a report claiming success without admitting every edit is rejected by existing `EngineConsole`; an engine refusal admits zero and cannot become success.
- `appliedAtSample` remains the engine's admission/application schedule, not a render fence. No suspended-context completion promise is added.
- Adapter close does not promise to retract an admitted command. A control call already pending settles through the existing host response or host disposal/failure path. Do not introduce cancellation, a drain fence, or independent pending ledger.
- Preserve console opt-out, meter/telemetry availability checks, projections, subscription fan-out, session lifecycle ordering, and public raw `session.host` access. Update the stale host documentation: raw calls no longer collide because the host allocates IDs.
- No readback, revision, automation, routing discovery, stable handles, object model, agent API, source/session parsing, PCM, storage, decoder, or boot-default change.

## Exact allowed paths

- `.github/ISSUE_SPECS/022-use-the-sdk-strict-console-and-host-owned-request-ids.md`
- `src/console.ts`
- `src/session-types.ts`
- `tests/console.test.ts`
- `tests/public-types.test.ts`
- `tests/session.test.ts` only for fixtures/type expectations directly changed by the strict return type or payload-only host
- `README.md` only where it documents console submission outcome or raw-host ID collision
- `src/provenance.ts` only at the release-integration checkpoint described below
- `package.json` and lockfile only after the required SDK version is actually published

No SDK/engine repository file is part of this issue. No adapter `src/stems/**`, `src/session.ts` production logic, asset, worker, feed, error vocabulary, or package script may change unless a focused compile failure proves a direct type-only migration need and Sol amends the issue first.

## Objective gates

1. **No shadow transport.** Static evidence finds no adapter `HostRequests`, request counter, `run(requestId)`, `requestId` construction, command-record decoder, `ConsoleWriter`, retry timer/ceiling, pending coalescer, or background escalation in `src/console.ts` or packed output.
2. **Exact strict receipt.** A multi-edit `session.console.submit(...)` returns the SDK `CommandReport` fields unchanged. Assert full success (`admitted === edit count`), semantic refusal (`ok === false`, `admitted === 0`, exact result/reason/reasonName/rejectedIndex/appliedAtSample), and recovery on a later valid submit.
3. **Acked-batch invariant.** Inject reports for partial/torn success and prove existing SDK validation rejects them. Queue backpressure returns the exact strict refusal/report behavior supplied by the SDK/host; it is never converted into resolved `void`, a retry, a staged edit, or a later silent drop.
4. **Payload-only interleaving.** On one #393 host fixture, interleave SDK console submissions with meter arm/release, telemetry arm/release, direct status/sessionMap, and raw-host command. All complete without caller IDs, retries, collision, or adapter serialization; acknowledged IDs are host-generated and strictly increasing.
5. **Meters preserved.** Multiple meter listeners cause one arm; multiple telemetry listeners cause one arm. Projection values, track IDs/order, gain-reduction/master handling, sequence/window/sample fields, unsubscribe behavior, last-listener release, and lease refusal retain current tested behavior. Do not add a new listener-error policy in this slice.
6. **Close/failure.** Closing control prevents new submit/subscription with the existing `session.closed` behavior and clears listeners. An already pending arm/submit settles once when the existing host later answers or is disposed; no late answer re-arms a closed feed. Repeated unsubscribe/control/session close remains safe. This gate adds no stronger immediate-cancellation guarantee.
7. **Public types.** `EngineWebConsole.edit` remains the SDK edit builder; `submit` is statically `Promise<CommandReport>`. A consumer must inspect `ok`/receipt fields. Compile-time probes reject treating it as `Promise<void>` and confirm meter/telemetry signatures are unchanged.
8. **Console opt-out/session integration.** Existing `console: false` behavior remains, and normal `openEngineWebSession` returns strict console plus the existing meter/telemetry projections without changing verified-all/prefill/play/pause/seek/close ordering.
9. **Exact packed SDK integration.** Build and pack the Astra-approved engine #393 commit, record commit and tarball SHA-256, install it into an isolated adapter copy without committing a file dependency, then run adapter type, unit, package, and packed-browser checks. Tests must exercise payload-only host declarations from that tarball, not a source-path alias.
10. **Repository gates.** Run focused console/session/type tests, then `npm test`, `npm run check`, `npm run check:package`, and the existing packed browser test. Attach exact pass counts and browser versions. No PCM/OPFS/decoder campaign beyond the repository's normal `npm run check` is added.
11. **Scope and release truth.** Diff contains only approved paths. Engine/SDK, PCM, storage, workers, and session orchestration are unchanged. The PR states that registry adapter installation remains pinned to published engine `0.1.0`; local tarball compatibility is evidence, not publication. Do not commit an unpublished version or claim ordinary installability. After the reviewed SDK release exists, update the adapter's exact dependency and provenance in a separate coherent release-integration checkpoint before merge/release.

## Review questions

- Can any adapter path still allocate or supply a host request ID?
- Can `submit` resolve without an exact engine/SDK `CommandReport`, or can backpressure be hidden behind retry/coalescing?
- Are semantic refusals returned intact while transport and malformed-report failures reject?
- Do meter and telemetry still share one lease per feed and preserve projections without a private ledger?
- Does close rely only on existing host disposal semantics, without claiming retraction or render completion?
- Was the adapter tested against the exact packed reviewed SDK while accurately recording the unpublished release blocker?

## Delivery

Root creates and synchronizes one new adapter issue/spec after approval. Luna implements attempt 1 only after adapter issue #19 and engine #393 have reached their required checkpoint/review boundaries; Astra performs the adversarial review under the user's explicit role override. The normal three-attempt stop remains in force.

## Decision record

- 2026-09-05: Root approved this existing control-boundary migration after engine #393 passed Astra. Isolated adapter checkout /private/tmp/miso-dx-adapter-control starts from main `63b4ee6212287000ff85e1cfa969d385f6246d2d`, branch codex/dx-sdk-console. It excludes the unqualified OPFS timeout changes. Exact SDK consumer package is built from reviewed `bed7634c7bb86ede24b577dc09ab9895208d803f`; tarball digest is recorded before implementation. Luna implements; dedicated Astra reviews. No implementation overlaps the active PCM test tranche.

- Reviewed SDK package: `/private/tmp/dx-reviewed-sdk393/misofm-engine-0.1.0.tgz`, SHA-256 `ef9186209056170db272eec6e2bee03a8347449eaf5cf5012498c252c72f25e7`, source commit `bed7634c7bb86ede24b577dc09ab9895208d803f`. Build used the unchanged reviewed six-artifact directory and passed 11 CLI package-build tests. This is a local integration artifact, not a registry release.

## Attempt 1 implementation evidence (Luna, 2026-09-05)

Installed the reviewed tarball with `npm_config_cache=/private/tmp/dx-22-npm-cache npm install --no-save --ignore-scripts ...`; package metadata and lockfiles remain unchanged. Replaced the adapter's private console transport with the SDK's `createBrowserConsole(host)`, changed `submit` to return the exact `CommandReport`, and retained one host-owned payload-only lease per meter/telemetry feed with existing projections and refusals. Removed the adapter request ledger, binary command decoder, `ConsoleWriter`, retry/coalescing, and escalation paths.

Validation: `npm run typecheck` passed; `npm test` passed 100/100, including full success/refusal/torn-report, payload-only interleaving, and meter/telemetry lease coverage. `npm run check` and `npm run check:package` passed. The existing packed browser gate passed in Chromium with the fixture report (`submitted: 32`, `refused: 0`, `torn: 0`, `errors: 0`); its log is `/private/tmp/dx-22-browser-escalated.log`. Registry publication and ordinary dependency installation remain release blockers as specified; this checkpoint proves the exact local tarball integration only.

## Dedicated Astra attempt 1 verdict — FAIL (2026-09-05)

Astra independently passed the 100-test repository check and verified all 65 installed and packed-consumer SDK files against the exact reviewed tarball. The implementation nevertheless has a real meter/telemetry lifecycle defect: resubscribing during pending release receives result6 and permanently caches the rejected arm promise. Frozen interleaving, strict receipt, fan-out and pending-close regressions also remain incomplete. The full review is attached to PR #23. Root approves the following Sol-authored bounded attempt2 brief; no other product boundary changes are authorized.

## Attempt 2 authorization — per-feed lifecycle correction

**Verdict basis:** Attempt 1 at `1005224cc70ff83d76361b67873f00a6ba6f3dec` is a useful checkpoint but FAILS Astra review. Preserve its SDK console migration, strict `CommandReport`, payload-only calls, host-owned IDs, and deleted shadow transport. Attempt 2 is limited to the confirmed lease defect and the frozen #22 test gaps below.

## Smallest closable correction

Correct `HostFeed` so each meter/telemetry feed has at most one unsettled host lease call. When the last listener unsubscribes, retain the pending disable transition. If a listener resubscribes before that acknowledgement, wait for the disable to settle and then arm once; do not overlap it and receive host result 6. A rejected arm must be cleared after settling so it cannot poison later subscriptions.

Use only a bounded per-feed lifecycle transition. It may remember acknowledged armed state, one current lease operation, desired listener state, and close state. It is not a global request serializer, request ledger, retry loop, coalescer, or transport broker. The host still allocates every request ID.

Close clears listeners immediately and prevents new calls. If an arm is already pending, let it settle through the existing host response/disposal path and, if it succeeded after close, issue the ordinary disable after it; never re-arm. This is ordered cleanup, not stronger cancellation. Repeated unsubscribe/control/session close remains safe.

Do not change public types, projections, refusal vocabulary, session orchestration, SDK code, or package dependencies.

## Exact implementation constraints

- One first listener starts one arm; concurrent listeners share that arm. One last unsubscribe starts one release.
- A resubscribe during release awaits that exact transition, then starts at most one arm for all waiting listeners.
- A nonzero arm acknowledgement rejects current subscribers with the existing `console.lease_refused` fields and leaves no cached rejected promise. A later subscription makes a fresh host call. Do not automatically retry the refused call.
- A late arm acknowledgement after listener removal or close cannot leave a live lease: reconcile once to disabled. A late release acknowledgement may lead to one arm only when live listeners still require it.
- Continue to call only `host.meters({ enabled, onFrame })` and `host.telemetry({ enabled, onFrame })`. No caller ID, timer, backoff, queue, or new cancellation primitive is allowed.

## Required regressions and frozen evidence completion

1. Convert `/private/tmp/dx-22-astra-probe.mjs` into a focused regression using the exact installed reviewed packed SDK host implementation unchanged. For both meters and telemetry: acknowledge an initial arm, hold the last-listener disable, resubscribe, acknowledge disable, then acknowledge the single new arm. Prove no result-6 overlap, the later listener receives frames, request IDs are host-generated/strictly increasing, and close during the same transition produces no late re-arm. This boundary must not be proved only with `FakeHost`.
2. Add one multi-edit success assertion over the exact full `CommandReport`. Add one semantic refusal with nonzero schedule/rejected index and exact `result`, `code`, `reason`, `reasonName`, `admitted`, and `appliedAtSample`, followed by a valid successful submit. Add exact backpressure-report coverage and retain torn/partial-success rejection; assert no retry or later hidden submission.
3. On the real reviewed-host fixture, interleave console command, meter/telemetry arm and release, `status()`, `sessionMap()`, and a raw-host command. Assert payload-only requests, strictly increasing host IDs, and one settlement each.
4. Add focused fan-out/projection coverage: two listeners share one arm per feed; first unsubscribe keeps the lease; last unsubscribe releases once; meter updates retain track order/IDs, L/R/peak, track/master gain reduction, sequence, windows, first/end sample; telemetry retains every published field. Exercise the existing typed nonzero lease refusal and fresh recovery.
5. Cover a pending arm and pending submit across control close with delayed host response/disposal, no late re-arm, and one settlement. Prove a cached console reference rejects post-close submission/subscription with existing `session.closed`. Do not promise immediate cancellation or command retraction.

## Allowed paths and gates

Allowed: `src/console.ts`, `tests/console.test.ts`, and `.github/ISSUE_SPECS/022-use-the-sdk-strict-console-and-host-owned-request-ids.md` for candid attempt-2 evidence. Use another already-approved #22 test path only if a compile-time assertion cannot live in `console.test.ts`; no production path beyond `src/console.ts` may change.

Run the focused console test first, then `npm test`, `npm run check`, `npm run check:package`, and the existing packed-browser check. Reuse and re-verify SDK tarball SHA-256 `ef9186209056170db272eec6e2bee03a8347449eaf5cf5012498c252c72f25e7`; do not rebuild or replace it merely for another run. Record exact pass counts/browser version and correct the attempt-1 evidence claim. Registry engine `0.1.0` remains the merge/release blocker; local tarball success is compatibility evidence only. A fresh dedicated Astra review is required before PASS.
