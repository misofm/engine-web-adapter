# Release web adapter 0.5.12 against Engine 0.4.2

## Product outcome

Publish one immutable, dependency-only `@misofm/engine-web-adapter@0.5.12` release pinned exactly to the verified public `@misofm/engine@0.4.2`. Engine 0.4.2 carries the managed-spectrum publication-metadata fix required by app issue #262. The adapter already exposes the borrowed SDK engine, so this release changes package identity, dependency, and provenance metadata only. It must not change adapter runtime behavior.

## Preconditions

Starting source is synchronized adapter `main` at `cdda801342663c74ba88471604b6f1bf8fbae922`, where adapter 0.5.11 pins Engine 0.4.1.

Do not begin implementation until public Engine 0.4.2 is independently verified. Record its source SHA, qualification/publish/verify run IDs, registry archive URL, shasum, SHA-256, SHA-512/integrity, file count and unpacked size. Require fresh public imports, strict types and CLI; `npm audit signatures --include-attestations`; SLSA provenance bound to `misofm/engine`, `.github/workflows/npm-publish.yml`, `refs/heads/main`, the accepted source SHA and original publication run; payload equivalence with the reviewed candidate; and a public-package H256 proof where a ready/available publication remains ready/available with the same result identity after a later nonpublishing pending read. A parsed registry lookup must also confirm adapter 0.5.12 is unused.

As of 2026-09-17 01:42 UTC, Engine 0.4.2 and adapter 0.5.12 returned parsed E404. Engine 0.4.2 is now public and the adapter 0.5.12 lookup remains parsed E404.

## Engine 0.4.2 verification record

The public Engine 0.4.2 release was independently verified before this adapter tranche. The accepted source is `misofm/engine` commit `13351fe71c7d4594e5ff6ea170c2839514cb243e`. Qualification run `35171757674` passed. The single publication step in run `35172001155` succeeded, after which that run timed out waiting for registry propagation; publication was not retried. Verify-only recovery run `35172167003` passed once npm converged. The registry archive is `https://registry.npmjs.org/@misofm/engine/-/engine-0.4.2.tgz` with shasum `bf17c31d80129264bcc8d885b27818b7f8958c9b`, SHA-256 `8f28af09f1fb6f31295e82ba9cb97350cb2f56be21e1db1c5bb028d9e128880d`, and SHA-512/integrity `sha512-+wx0YgvvaDeKO50pPY4uHuNdAMMJOyrVf0fm3Hxazve1+w1YvJXD+wQkQeA06D06nOciXuoNydohe4Xo27F2Zg==`. The public package contains 98 files, is 1,331,339 bytes packed, and has an unpacked size of 5,460,488 bytes.

Fresh public root, `/browser`, `/assets`, and CLI imports, strict TypeScript, signature/attestation verification, SLSA provenance binding to `misofm/engine`, `.github/workflows/npm-publish.yml`, `refs/heads/main`, the accepted source SHA and the original publication run, candidate payload equivalence, and the public H256 coalescing proof passed. A parsed registry lookup confirms `@misofm/engine-web-adapter@0.5.12` is unused.

## Smallest bounded implementation

Change only this issue spec and these eight release surfaces:

- `package.json`: adapter 0.5.11 to 0.5.12 and exact Engine dependency 0.4.1 to 0.4.2.
- `package-lock.json`: both root adapter versions, root Engine dependency, and the installed Engine version, registry URL and integrity generated from the public 0.4.2 package.
- `.github/workflows/npm-publish.yml`: package/job version and Engine dependency guard/registry assertion only. Preserve exact-main, parsed-E404, OIDC-only, concurrency, immutable-version and verify-recovery behavior.
- `src/provenance.ts`: Engine 0.4.2 package, authenticated source SHA and public archive SHA-256.
- `scripts/check-package.mjs`: adapter 0.5.12 and Engine 0.4.2 assertions.
- `tests/foundation.test.ts`: accepted Engine source SHA and public archive SHA-256.
- `README.md`: adapter/Engine install coordinates, exact Engine pin, accepted Engine source SHA and archive SHA-256.
- `NOTICE`: Engine 0.4.2 identity, source SHA and archive SHA-256.

Preserve codec 0.1.1, Effect, hash-wasm, toolchains, unrelated dependency integrities, safe baselines, copied-source attribution, exports, generated assets, browser scripts and publisher semantics. Do not edit runtime TypeScript, APIs, workers, AudioWorklet code, DSP, codec/decoder, storage/cache, binary assets or test harness behavior.

Implementation record: the adapter release tranche updates only package identity, the exact Engine 0.4.2 dependency, registry-generated lock metadata, release guards, and the recorded Engine provenance/source/archive identities across the eight authorized release surfaces. Runtime TypeScript, APIs, workers, AudioWorklet code, DSP, codec/decoder, storage/cache, binary assets, and test harness behavior remain unchanged.

Fast tranche validation passed under Node `v22.23.2` and npm `10.9.8`: `npm ci --ignore-scripts`, format check, TypeScript typecheck, `git diff --check`, and an exact-path/literal audit. The audit found exactly the issue spec plus the eight authorized release surfaces and verified the lockfile's registry URL, Engine 0.4.2 version, and published integrity.

## Candidate qualification record

Frozen checkpoint `f85fb6dc5ab550268b1690754cb7f0b94b218c61` passed the complete `npm run check` suite (380 tests), `npm run publish:dry-run`, fresh install, package policy and clean-consumer verification under Node 22.23.2. npm 11.19.0 packed exactly one 474,775-byte, 247-file candidate at `/tmp/adapter-0512-candidate-20260917/misofm-engine-web-adapter-0.5.12.tgz`: shasum `c2436ee1d2226e741eeda9e8ff3b10dee1977267`, SHA-256 `65ff94fde2799d379fcece2dd4c9c8e2872c0bac753ae9fac63c7cf2d71a6f95`, SHA-512 `53cae9c10f9aa110d08dde0180aaa3f6677599c9bc6a8425a78a1696721558aade1d7cfc1bb99c4a2a313eddbdda7aee974746f44ea50dbb85c8a99b63e7de20`, and integrity `sha512-U8rpwQ+aoRDQjd4BgKqj9md1mcm8aoQlp4oWlnIVWKreHXz8G7mcSioxPt292nrul0dG9E6lDbuFyKmbY+feIA==`.

The clean consumer imports root, `/stems`, `/assets` and `/package.json`; strict TypeScript with `skipLibCheck: false` passes; one physical Engine 0.4.2 is installed; its payload equals the independently verified public Engine archive; and built `ADAPTER_PROVENANCE` exactly identifies Engine 0.4.2, source `13351fe71c7d4594e5ff6ea170c2839514cb243e` and archive SHA-256 `8f28af09f1fb6f31295e82ba9cb97350cb2f56be21e1db1c5bb028d9e128880d`.

The first browser invocations failed before launch because `CHROME_EXECUTABLE` was unset; this consumed Luna's two allowed rounds and was classified as infrastructure-only. One bounded Sol high escalation used the matching executable `/home/bl/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` (Chrome for Testing 153.0.8010.12). Both `npm run test:browser` and `node scripts/browser-packed.mjs --indexed-sparse` then passed with no request failures or console errors and all workers terminated. No source, harness, archive or package correction was made. Logs are retained under `/tmp/adapter-0512-qualification-20260917/`, `/tmp/adapter-0512-test-browser.log` and `/tmp/adapter-0512-browser-packed-indexed-sparse.log`.

## Fresh Astra medium review

PASS at frozen clean checkpoint `d350547`, with no blockers. The reviewer independently confirmed the exact nine permitted paths; no runtime, asset, unrelated dependency or publisher-semantic changes; every candidate archive hash/count; frozen-tree payload equality; fresh public imports; strict TypeScript; exact provenance; one physical Engine 0.4.2; byte-for-byte Engine payload equality with the public archive; accepted signature/SLSA evidence; and the public H256 retained-publication behavior. Foundation tests passed 7/7 from the repository root. The recorded first foundation invocation used the clean consumer as its working directory and failed cwd-dependent assertions; the correct repository-root invocation passed without a source or archive change. Prior 380/380 tests and both successful browser logs were inspected. Exact-main, parsed-E404, OIDC-only, serialized publication and verify-only recovery controls remain intact. PR macOS OPFS and Chromium/WebKit qualification remains before publication.

## Public delivery evidence

PR #123 passed the required macOS OPFS qualification for Chromium and WebKit in run 35173287696 and merged as exact `main` commit `f8ae7b7884198660d20fd499eeedcdf25ad5c361`. A final parsed registry lookup confirmed adapter 0.5.12 was unused. The single publish dispatch, run 35173419809, checked out that exact SHA, reran the complete qualification, observed parsed E404, published once through OIDC, and passed public registry dependency, import and signature/attestation verification.

Independent public verification under `/tmp/adapter-0512-registry-verify-20260917/` confirms adapter 0.5.12 is public and `latest`. The public archive is byte-identical to the reviewed candidate: 474,775 bytes, 247 files, and the same SHA-1, SHA-256 and SHA-512 recorded above. A clean install imports root, `/stems`, `/assets` and `/package.json`; strict TypeScript with `skipLibCheck: false` passes; exactly one physical Engine 0.4.2 resolves; Engine payload/provenance matches the authenticated public archive and source commit; and `npm audit signatures --include-attestations` reports seven verified packages with no invalid or missing entries. Adapter SLSA provenance binds source `f8ae7b7884198660d20fd499eeedcdf25ad5c361` to publication run 35173419809; Engine provenance binds source `13351fe71c7d4594e5ff6ea170c2839514cb243e` to publication run 35172001155.

The adapter release contract is complete. App issue `misofm/app#262` owns exact package adoption, the packaged H256 continuity/decay trace and testnet deployment.

## Objective gates

1. Under Node 22.23.2, run `npm ci --ignore-scripts` and `npm run check`.
2. Run `npm run publish:dry-run`, `npm run test:browser`, and `node scripts/browser-packed.mjs --indexed-sparse`.
3. With npm 11.19.0, pack exactly one frozen candidate and record size, file count, shasum, SHA-256, SHA-512 and npm integrity.
4. Install that exact archive in a clean consumer. Verify root, `/stems`, `/assets` and `/package.json` imports; strict TypeScript with `skipLibCheck: false`; exactly one physical Engine; declared and installed Engine 0.4.2; installed Engine payload equality with the accepted public archive; and built provenance equality with the dependency, source SHA and archive SHA-256.
5. Obtain fresh adversarial review of the frozen commit/archive for exact paths/literals, registry integrity, package contents, public imports/types, one-Engine resolution, publisher controls and absence of runtime changes.
6. Require the PR `Packed OPFS qualification` workflow to pass macOS OPFS and indexed-sparse Chromium/WebKit on the reviewed SHA.

## Immutable delivery

Merge only the reviewed candidate after PR qualification. Freeze the resulting main SHA, repeat the parsed-E404 check for adapter 0.5.12, then dispatch `.github/workflows/npm-publish.yml` in `publish` mode exactly once from main with that exact SHA. Require exact checkout and identities, full qualification, parsed E404 immediately before publication, OIDC-only publication, exact Engine 0.4.2 registry dependency, public imports and signature/attestation verification.

If publication may have succeeded but a later check fails, never retry publish. Inspect the registry and use only `verify` mode against the same SHA. Independently verify the public archive byte-for-byte against the reviewed candidate, imports, strict types, one physical Engine 0.4.2, metadata, signatures and SLSA provenance.

Record candidate hashes, review, PR workflow, merge SHA, publication/verification run IDs, public registry metadata, archive comparison, consumer results and provenance acceptance here. Push the evidence, synchronize GitHub and close only after registry acceptance.

## Stop rules

Stop without publishing if Engine 0.4.2 is absent/untrusted, fails H256, or differs without explained payload equivalence; adapter 0.5.12 exists unexpectedly; runtime or harness changes are required; any full/browser/consumer/type/one-Engine/OPFS gate fails; paths exceed the allowlist; review fails; the merged SHA changes; or publication is ambiguous.

## Workflow

One bounded Luna max agent implements the eight metadata files and evidence. A fresh Astra medium reviewer verifies the frozen candidate. Root owns checkpoints, PR delivery, the single publish dispatch, registry verification, evidence synchronization and closure.
