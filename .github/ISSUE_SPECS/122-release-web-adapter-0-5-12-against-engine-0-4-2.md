# Release web adapter 0.5.12 against Engine 0.4.2

## Product outcome

Publish one immutable, dependency-only `@misofm/engine-web-adapter@0.5.12` release pinned exactly to the verified public `@misofm/engine@0.4.2`. Engine 0.4.2 carries the managed-spectrum publication-metadata fix required by app issue #262. The adapter already exposes the borrowed SDK engine, so this release changes package identity, dependency, and provenance metadata only. It must not change adapter runtime behavior.

## Preconditions

Starting source is synchronized adapter `main` at `cdda801342663c74ba88471604b6f1bf8fbae922`, where adapter 0.5.11 pins Engine 0.4.1.

Do not begin implementation until public Engine 0.4.2 is independently verified. Record its source SHA, qualification/publish/verify run IDs, registry archive URL, shasum, SHA-256, SHA-512/integrity, file count and unpacked size. Require fresh public imports, strict types and CLI; `npm audit signatures --include-attestations`; SLSA provenance bound to `misofm/engine`, `.github/workflows/npm-publish.yml`, `refs/heads/main`, the accepted source SHA and original publication run; payload equivalence with the reviewed candidate; and a public-package H256 proof where a ready/available publication remains ready/available with the same result identity after a later nonpublishing pending read. A parsed registry lookup must also confirm adapter 0.5.12 is unused.

As of 2026-09-17 01:42 UTC, both Engine 0.4.2 and adapter 0.5.12 returned parsed E404. Engine publication is the current blocker.

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
