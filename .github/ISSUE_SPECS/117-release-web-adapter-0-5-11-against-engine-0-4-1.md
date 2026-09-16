# Release web adapter 0.5.11 against Engine 0.4.1

## Product outcome

Publish one immutable dependency-only `@misofm/engine-web-adapter@0.5.11` release that pins exactly the verified public `@misofm/engine@0.4.1` package. The adapter already exposes the same borrowed SDK engine; this release carries the accepted Engine update into a package the testnet app can consume without changing adapter runtime behavior.

This slice is blocked until Engine 0.4.1 is publicly available and independently verified. Record its exact source commit, registry archive SHA256, npm integrity, trusted publication workflow/run, and successful fresh-consumer verification before changing adapter release identities. On 2026-09-16 UTC, public registry lookups returned parsed E404 for both Engine 0.4.1 and adapter 0.5.11.

## Smallest bounded implementation

Starting source is synchronized adapter `main` at `1a97a7e2a5c8747996388fdf412d82e32156fa15`, where adapter 0.5.10 pins Engine 0.4.0. After the Engine precondition passes, update only this issue spec and the following release-identity surfaces:

- `package.json`: adapter version `0.5.10 -> 0.5.11` and exact Engine dependency `0.4.0 -> 0.4.1`.
- `package-lock.json`: the two root adapter-version literals, root Engine dependency, and the installed `node_modules/@misofm/engine` version/resolved/integrity metadata generated from the verified public 0.4.1 package.
- `.github/workflows/npm-publish.yml`: `PACKAGE_VERSION`, publish job display version, guarded package dependency, and verified registry dependency only.
- `src/provenance.ts`: Engine package version, verified public archive SHA256, and exact Engine source commit.
- `scripts/check-package.mjs`: adapter package-version and Engine dependency assertions only.
- `tests/foundation.test.ts`: exact Engine source commit and archive-SHA assertions only.
- `README.md` and `NOTICE`: adapter/Engine install identity and the same verified Engine source/archive provenance only.

Preserve codec `0.1.1`, Effect, hash-wasm, toolchain pins, historical `safeBaselines`, copied-source attribution, package exports, and publisher semantics. Do not edit production TypeScript behavior, public APIs, decoder/codec, storage/cache, Worker or AudioWorklet code, generated binary assets, browser harnesses, or unrelated evidence. No adapter feature implementation belongs in this release.

## Objective gates

Before implementation, prove public Engine 0.4.1 registry identity and trusted provenance, and repeat the parsed-E404 absence check for adapter 0.5.11. Then:

1. Install with the repository-pinned Node/Bun constraints and locked npm graph using `npm ci --ignore-scripts`.
2. Run `npm run check` and `npm run publish:dry-run`.
3. Run the existing packed fresh-consumer browser gate and indexed-sparse gate: `npm run test:browser` and `node scripts/browser-packed.mjs --indexed-sparse`.
4. Install the exact candidate tarball in a clean consumer. Import the package root, `/stems`, and `/assets`; strict-typecheck those public entries with `skipLibCheck: false`; prove exactly one physical `@misofm/engine@0.4.1`.
5. Freeze the candidate archive identity and have a fresh Sol adversarially verify the complete diff, lock/registry integrity, candidate contents, provenance, public imports/types, and one-engine resolution.
6. Require the existing pull-request `Packed OPFS qualification` workflow to pass actual macOS OPFS plus indexed-sparse Chromium and WebKit lanes before merge.

## Delivery and publication sequence

Merge only the reviewed identity-only candidate with required CI green. Hold the resulting adapter `main` SHA unchanged and dispatch the existing OIDC workflow in `publish` mode once with that exact `expected_sha`. The workflow must observe parsed E404 immediately before publication, reject token fallback, run the full package check, publish through trusted OIDC, and verify the registry dependency is exactly Engine 0.4.1.

If publication succeeds but registry or attestation propagation makes the run fail later, do not republish. Dispatch the existing `verify` mode against the same immutable main SHA. Independently compare the public registry archive with the reviewed candidate, verify all public imports and strict types in a clean registry consumer, prove one physical Engine 0.4.1, and verify npm signatures/SLSA provenance bind adapter 0.5.11 to this repository, workflow, main ref, source SHA, and original publication run.

Record candidate hashes, CI/review results, merged SHA, workflow IDs, registry metadata, and attestation acceptance in this issue before closing it. App adoption and testnet deployment may start only from the verified public Engine 0.4.1 and adapter 0.5.11 identities.

## Workflow

A Sol owner scopes and implements this launch release at the requested effort. A fresh Sol adversarially verifies the frozen candidate. Root owns the checkpoint, pull request, immutable publication, registry acceptance, evidence synchronization, and issue closure.
