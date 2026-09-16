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

## Evidence

### Attempt 1 implementation tranche — 2026-09-16 UTC

The Engine precondition is satisfied by public `@misofm/engine@0.4.1`: source/merged
main SHA `1f754cb415e5f39123333c526c75110e33ad24df`, registry archive SHA256
`251ba94b46cfc648ff867a1191e3d28e1cf18b910fc651c0c87de3d18111a7bc`, npm integrity
`sha512-hTRdb1SOyRngbnte21QwaSMiPZ1Y90FgXkehSDG2Hk37hBZQ2qtgIZL0H2s1NtpgZ+8pd4AsmhdLneBjj6IgOw==`,
and shasum `dedf9cf506205b628e1966b0fa08b8cd7c387523`. Engine qualification run
`35158339020` and verify run `35158837207` passed. The prepublication registry
lookup for adapter `0.5.11` returned parsed E404.

The identity-only candidate updates adapter `0.5.10 -> 0.5.11`, pins exactly
Engine `0.4.1`, updates the lockfile to the public Engine tarball/integrity, and
binds provenance, package assertions, workflow guards, README, and NOTICE to the
Engine source/archive above. Codec `0.1.1`, Effect, hash-wasm, toolchain pins,
safe baselines, copied-source attribution, exports, runtime TypeScript, browser
harnesses, and publisher semantics are unchanged. Changed paths are exactly:
`.github/workflows/npm-publish.yml`, `NOTICE`, `README.md`, `package-lock.json`,
`package.json`, `scripts/check-package.mjs`, `src/provenance.ts`, and
`tests/foundation.test.ts`.

The local gates used Node `v22.23.2`, npm `10.9.8`, and the public npm registry:

- `npm ci --ignore-scripts`: PASS; 31 packages added, 0 vulnerabilities.
- `npm run check`: PASS; 380 tests passed, 0 failed; source policy 56 files;
  decoder policy 75,923 bytes with fixed 2 MiB memory; package policy 247 files,
  474,772 bytes.
- `npm run publish:dry-run`: PASS; adapter `0.5.11`, 247 files, 474,772-byte
  package, 2,636,641-byte unpacked size, shasum
  `4a46b3ea465e1c205c502319211dd867f20ee273`.
- `node scripts/browser-packed.mjs --indexed-sparse` with Chromium
  `151.0.7922.34`: PASS; cold, warm, concurrent, sparse-gap, worker cleanup,
  and MIME/request assertions passed with no request failures or console errors.
- `npm run test:browser` with the same Chromium: FAIL before playback. The packed
  page requests the hashed Engine host module, but the harness's static server
  returns 404 for its relative `prepared-control.js` asset, so Engine host startup
  rejects with `session.open`/`BrowserBootError`. The failure reproduces on two
  runs; the candidate source/runtime was not changed to hide it. A bare run
  without `CHROME_EXECUTABLE` also stops at the documented missing-Chrome check.

A fresh consumer installed the exact candidate tarball
`misofm-engine-web-adapter-0.5.11.tgz` and passed runtime imports for `.`,
`/stems`, and `/assets`; strict TypeScript checking with `skipLibCheck: false`;
and one-engine resolution. Candidate archive identity is SHA256
`ee2ed1a0a3fb81e8275a9cbefd5d1d932a77ecb08f7fb1946edb905493be6e7a`, shasum
`4a46b3ea465e1c205c502319211dd867f20ee273`, 247 files, and 2,636,641 unpacked
bytes. The consumer reported one physical `node_modules/@misofm/engine`, version
`0.4.1`, with adapter `0.5.11` depending on exactly `0.4.1`.

This is a coherent attempt-1 checkpoint. No commit, push, pull request, workflow
dispatch, publication, or GitHub state change was performed. The ordinary packed
browser failure and required macOS OPFS/Chromium/WebKit qualification remain root
delivery/review gates.

### Harness recovery and rebased candidate

Issue #118 isolated the pre-existing packed-consumer closure failure from this identity-only release. PR #119 merged its reviewed harness correction to adapter main as `f835cff1d94321d8d7b74bf4cdb0bdf0d4792b90` after macOS Chromium/WebKit OPFS run `35160391206` passed. The #117 commits were rebased onto that synchronized main without conflicts; release identities and package bytes did not change.

On the rebased candidate, the formerly blocked ordinary packed Chromium 153 gate now passes complete playback/control/seek/fault handling with 15 observed assets and zero request or console failures. The indexed-sparse Chromium gate also passes its full cold/warm/serial/concurrent/all-silent/tail/worker matrix with zero request or console failures. A fresh candidate pack retains exactly the accepted attempt-1 identity: 247 files, 474,772 bytes, SHA-256 `ee2ed1a0a3fb81e8275a9cbefd5d1d932a77ecb08f7fb1946edb905493be6e7a`, shasum `4a46b3ea465e1c205c502319211dd867f20ee273`, and integrity `sha512-jUKaUSlhFvSH/1X6vDMxs2tkcEjl7zpEdYcj9cwOogv6QvQPHd2XH3Wx4A2ppwdTVDILCW/LvJl+AhkCyxzapA==`. The candidate is ready for fresh release review.
