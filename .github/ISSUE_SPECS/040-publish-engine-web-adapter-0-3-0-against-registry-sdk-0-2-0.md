# Publish Engine Web Adapter 0.3.0 against registry SDK 0.2.0

Read-only preparation against clean `/private/tmp/miso-dx-adapter-seek-ready` HEAD `78918cf0a700c9c6c3bb9889f27f927a7e8de5df`. Local ancestry proves known main `63b4ee6212287000ff85e1cfa969d385f6246d2d` is an ancestor with 75 reviewed commits ahead. This clone has no `origin/main` tracking ref; root must freshly fetch/audit actual main before integration. No implementation, install, registry request, issue creation or publication was performed.

## Authorized smallest slice and prerequisites

User requires SDK publication, then adapter publication, then app direct npm dependencies, then website integration. Create a matching numbered adapter release issue before edits. Use Astra medium implementation and independent Astra review under the user's workflow override.

Start only after SDK `@misofm/engine@0.2.0` is publicly installed and independently verified: exact registry tarball SHA256/SHA512/shasum, public access/latest, authenticated SLSA source/workflow identity and public imports/enginectl. Root must verify adapter0.3.0 is unused; failed authentication/network lookup is not version absence. The old reviewed adapter archive7e21711e and SDK175755/archive0df6 remain historical evidence, never identities of newly versioned packages. SDK0.2.0 includes the freshly integrated main source/new Wasm; run the existing behavioral gates against those actual bytes.

## Exact minimal edit paths

1. `package.json`: adapter version0.3.0 and dependency `@misofm/engine: "0.2.0"`; preserve Effect4.0.0-rc.112 and all other metadata/exports/scripts.
2. `package-lock.json`: corresponding top/root versions/dependency and actual registry SDK entry resolved URL/integrity obtained by normal npm installation. Use a fresh task-owned cache and committed registry lock, not `--no-save`, file override, local archive or manual integrity fabrication. Preserve unrelated resolutions; run fresh `npm ci --ignore-scripts` afterward.
3. `src/provenance.ts`: `engine.package`, `engine.commit`, `engine.archiveSha256` from the authenticated SDK0.2.0 release receipt. Preserve safeBaselines, copiedSources, decoder lineage and licenses.
4. `tests/foundation.test.ts`: existing exact package/commit expectations follow that release. There is currently no archive hash assertion; do not invent a new metadata-only test. Preserve all substantive tests.
5. `scripts/check-package.mjs`: exact dependency policy0.1.0→0.2.0 only. Preserve required packed worker/Wasm/license files, excluded legacy modules and product-policy rejection, SDK ring/asset identity assertions.
6. `.github/workflows/npm-publish.yml`: PACKAGE_VERSION0.2.0→0.3.0; correct stale job label0.1.0→0.3.0; SDK guard and registry dependency assertion0.1.0→0.2.0. Preserve main-only precheckout dispatch and exact SHA checks, npm11.19.0, OIDC-only token rejection, empty userconfig, serialized non-canceling publication, existing verify mode and fresh consumer imports/signature checks. Tighten the existing absent-version check to allow publication only after parsed registry E404; retain stderr/status evidence and fail closed on auth/network/malformed errors. This is one existing guard correction, no alternate publisher or qualification framework.
7. `README.md`: opening package version/pinned SDK and install coordinates only, plus concise publication provenance wording if needed; preserve API/behavior documentation.
8. New numbered `.github/ISSUE_SPECS/...` release body/evidence.

No runtime/store/pump/protocol/SDK/decoder edits are authorized. Report a concrete incompatibility before expanding the slice. No source-ready, memory or transport redesign.

## Existing gates and timing authority

Focused types/build, foundation/package policy and version/lock/provenance consistency first; pause a coherent checkpoint for root commit before further source changes. Existing full `npm run check` covers format, types/source policy, decoder, tests and package checks (reviewed baseline158 tests/154 files; counts describe evidence, not fixed acceptance targets).

Run the existing `npm run test:browser` once with authorized localhost access against the freshly registry-installed SDK. Its packed consumer copies the installed SDK and Effect closure; independently verify that installed SDK closure equals the actual registry archive before running. Preserve the existing initial/paused/running nonzero first-target PCM cases,64 stale slots/full internal queue, unchanged suspended clocks, exact target observation synchronously BEFORE resume wrapper's first await, zero added underruns and all native-FLAC/cache/control/assets assertions. No new browser matrix or fixture framework; no script changes unless an actual release incompatibility requires a separately reviewed bounded correction. Capture exact candidate source, dependency receipt and packed payload manifest/digests for review.

## Normal main integration and one OIDC publication

Root freshly checks remote main ancestry and protection. If known ancestry still holds, normal fast-forward reviewed history plus release checkpoint into main preserves all75 commits; otherwise stop for a normal reviewed merge of actual new changes. Never reset/rewrite main or remove precheckout main-only guards. Dispatch the existing publish workflow at the exact integrated main SHA only after dedicated source/package PASS. Do not use local npm credentials/token fallback.

The existing adapter workflow rebuilds and `npm publish` runs prepack; it does not publish the earlier reviewed tarball. Therefore verify the actual public0.3.0 tarball against the reviewed built payload (all files, allowing no unexplained difference), record its actual size/SHA256/SHA512/shasum, and authenticate registry signatures/SLSA subject digest plus source repository/commit and trusted workflow/ref. Existing `npm audit signatures --include-attestations` supplies cryptographic verification; inspect the authenticated statement, not untrusted metadata alone. Verify version/latest/public access and exact SDK0.2.0 dependency, fresh root/stems/assets imports and one SDK closure. These release receipts can be gathered with existing npm/tooling; no new CI subsystem is needed.

If dispatch/publication response is ambiguous, preserve the run and inspect registry; use existing mode`verify`, never publish again blindly. Only after public artifact verification, independent PASS and upstream evidence does root close the issue and authorize app adoption. No website edits or app vendored-archive refresh in this slice.

## Release prerequisite evidence

SDK 0.2.0 is published by existing main-only OIDC run [33968931904](https://github.com/misofm/engine/actions/runs/33968931904), following successful exact-main qualification 33968584388 at `bb5ed498a2c0934498d964befb2cd5b7c2a45264`. The published archive matches the qualified 964,480-byte archive with SHA256 `77a2c78046428db40e3a9408c3a35ba1a05b3905a2595838fadf423631e92981`. Registry public access/latest, integrity, fresh imports/CLI and cryptographic provenance checks passed. Retained evidence: `/private/tmp/dx468-npm-published-33968931904`. Independent registry review is required before source/dependency edits.

Fresh root audit confirms adapter remote main remains `63b4ee6212287000ff85e1cfa969d385f6246d2d`, unprotected. Official registry lookup for adapter 0.3.0 returned parsed E404 (no matching version); other failures are not treated as absence. Release checkout `/private/tmp/miso-dx-adapter-npm-release`, branch `codex/release-adapter-0-3-0`, begins at reviewed `78918cf0a700c9c6c3bb9889f27f927a7e8de5df`. No adapter source or dependency change has begun. Dedicated Astra medium approved the bounded brief before issue creation.

## First release tranche — focused gates PASS

Independent SDK registry acceptance PASS `/private/tmp/dx468-astra-registry-acceptance.md` authorizes adoption of exact SDK source `bb5ed498a2c0934498d964befb2cd5b7c2a45264` and published archive SHA256 `77a2c78046428db40e3a9408c3a35ba1a05b3905a2595838fadf423631e92981`. Astra medium updates only the eight briefed paths: package/lock version 0.3.0, exact registry SDK dependency 0.2.0, engine provenance and existing foundation expectations, package policy, release workflow identities/absence guard, README coordinates and this record. Effect and all unrelated lock resolutions remain unchanged. No runtime, decoder, asset, browser script or behavioral test changes.

Normal registry `npm install --ignore-scripts` used fresh task cache `/private/tmp/dx40-npm-cache`, followed by successful fresh `npm ci --ignore-scripts --offline` from that populated registry cache. The initial restricted-network install failed DNS and made no lock change; the authorized network install succeeded. The resulting lock uses the official registry URL and published SHA512 integrity. Independently compared every installed SDK file with the authenticated archive: exactly 77 files, all bytes equal (`/private/tmp/dx40-sdk-closure.json`).

Types, build, existing foundation 7/7, package policy (154 files), format and diff checks PASS; logs `/private/tmp/dx40-{typecheck,build,foundation,package,format}.log`. The existing immutable-version guard now retains stdout JSON, stderr and exit status in RUNNER_TEMP and allows only a nonzero lookup with parsed `error.code === "E404"`; existing versions, E401, ENOTFOUND, malformed JSON and missing error codes fail closed. Executed the exact extracted shell guard against these six outcomes, retaining stderr/status in each case: `/private/tmp/dx40-guard-check.json`. All existing dispatch/OIDC/verify guards remain intact.

Pause this coherent focused-green tranche for root checkpoint. Full 158-test qualification, existing three-mode packed browser gate against registry SDK bytes, dedicated release review and publication remain pending; this record claims no adapter publication.

## Registry-SDK full and packed qualification — PASS

At pushed source checkpoint `72d45bb518659f974ad8333e33838d090fbd1b4c`, the existing full `npm run check` passes 158/158 tests, format/types/source policy, decoder and 154-file package policy. Log `/private/tmp/dx40-full-check.log`. The existing packed `npm run test:browser` was invoked once with authorized localhost/Chromium access and passes unchanged against the exact installed registry SDK closure. Log `/private/tmp/dx40-packed-browser.log`; complete captures `/private/tmp/dx40-packed-browser.json`.

Initial, paused/resumed and running seeks each release 64 stale shared slots with actual internal backpressure 6, preserve both clocks during suspended preparation, produce the exact nonzero first stereo target quantum against the public SDK offline oracle, and add zero underruns/refused/torn/errors. Running restores exactly once and resolves running; initial and paused remain suspended with no automatic resume. The unchanged fixture observes fresh target-generation PCM synchronously before the resume wrapper's first await. All existing native-FLAC cold/warm cache, control, metering and 11 requested asset assertions pass. No source or test correction was needed.

Retained the actual browser-tested packed archive, without repacking: `/private/tmp/dx40-reviewed-package/misofm-engine-web-adapter-0.3.0.tgz`, 138,228 bytes, 154 files, SHA256 `3cf62f3346600dbc098e716c8899adb0192bc4af8c90a8120172223b3b5ce6be`, SHA1 `a3b9227226da3e79b005fca4d9ac5e65b2911445`. `/private/tmp/dx40-reviewed-package/manifest.json` records SHA512/integrity and every payload's size/SHA256. Every packed file independently byte-equals the final current build/source. This is a reviewed candidate identity, not a claim about the future publisher's rebuilt public tarball; publication must compare that actual artifact with this complete payload.

Only this evidence record changes after the source checkpoint. Pause for root docs checkpoint and dedicated source/package review. Main integration, OIDC publication, authenticated registry artifact acceptance and issue closure remain root-owned and pending.

## Dedicated review documentation correction

Dedicated review identified one missed current-integration README paragraph still naming an older SDK archive despite the corrected opening/install coordinates and runtime provenance. Root authorized the bounded documentation correction: it now names published SDK 0.2.0, authenticated source `bb5ed498a2c0934498d964befb2cd5b7c2a45264` and archive SHA256 `77a2c78046428db40e3a9408c3a35ba1a05b3905a2595838fadf423631e92981`, explicitly distinguishing the SDK identity from pending adapter publication. No runtime, dependency or test changes.

Preserved browser-tested archive `3cf62f33` unchanged. One final pack after the README correction produced `/private/tmp/dx40-final-package/misofm-engine-web-adapter-0.3.0.tgz`: 138,224 bytes, 154 files, SHA256 `d8acc918941033780ca9d99b4a764819ad6ca6f754841af1731124d0e412387a`, SHA1 `337f8c0d63f25d98889caf66fdc0f1f2233c0584`; complete file manifest/SHA512 `/private/tmp/dx40-final-package/manifest.json`. Exact payload comparison proves README.md is the sole changed file from the actual browser-tested archive; all 153 other files are byte-identical, and all 154 final files match current source/build. Prepack build, format and diff checks pass. Full/browser behavior was not repeated for prose: the existing 158-test and one-invocation three-mode evidence remains valid for unchanged executable bytes.

Pause README plus this accumulated evidence record for root checkpoint and independent final archive acceptance. The final documentation-corrected archive is the comparison reference for subsequent public artifact verification; neither candidate has been published by this implementation task.
