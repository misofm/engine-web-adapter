# Release web adapter 0.5.13 against Engine 0.4.3

## Product outcome

Publish one immutable, dependency-only `@misofm/engine-web-adapter@0.5.13` release pinned exactly to verified public `@misofm/engine@0.4.3`. Engine 0.4.3 carries the managed-spectrum gap-recovery ordering correction from engine issue #863. The adapter already exposes the borrowed SDK engine, so this release changes package identity, dependency, and provenance metadata only. It must not change adapter runtime behavior or add a spectrum workaround.

## Verified Engine prerequisite

Engine 0.4.3 was published from exact `misofm/engine` main SHA `a3d71148e4144a396aa1ceb7fb83b6e671a0eced`. Exact-main qualification run 35182753816 and manual package qualification run 35183221601 passed. The single OIDC publication step in run 35183439402 succeeded; registry propagation exceeded the bounded wait and publication was not retried. Verify-only run 35183599463 passed after convergence, including fresh public imports/CLI, signature audit, and trusted SLSA v1 provenance bound to the exact source SHA and workflow.

The public Engine archive is `https://registry.npmjs.org/@misofm/engine/-/engine-0.4.3.tgz`: 98 files, 1,331,353 packed bytes, 5,460,599 unpacked bytes, shasum `8a48c97c8f12f37b17436216552f4b259c2bbf65`, SHA-256 `0b81dc9cec57d89703e42da5da592f5cb450ffec71a980ea0c4a00517cd294a0`, SHA-512 `73b4226365f67288123599def4cf42d49f5bd279e0fc97cce901a1ce1bc7b5217492e9dc1b27189ff138a6d7fb2b3a94d104ef8c9c6d91b4163ab4f4f4c08a16`, and integrity `sha512-c7QiY2X2cogSNZne9M9C1J9b0nng/JfM6QGhzhvHtSF0kuncGycYn/E4ptf7KzqU0QTvjJxtkbQWOrT09MCKFg==`. Independent public packing was byte-identical to the reviewed candidate. The AudioWorklet remains `e18acf9ca97af137a1917e52481c4bf962943d6d755369387969f84c3e381106`. The public compiled H256 proof passed 60 forced gap recoveries with 60/60 ready callbacks, exactly two reads per capture, matching callback/result identities, and truthful loss counters. A parsed registry lookup confirms adapter 0.5.13 is unused.

## Smallest bounded implementation

Starting source is synchronized adapter `main` at `9bc3faaafa231b1caaf1355b668c8c7b59ad71b6`. Change only this issue spec and eight release surfaces:

- `package.json`: adapter 0.5.12 to 0.5.13 and exact Engine dependency 0.4.2 to 0.4.3.
- `package-lock.json`: root identities and the installed Engine version, registry URL and public integrity only.
- `.github/workflows/npm-publish.yml`: adapter/package/job version plus Engine dependency and registry guards only.
- `src/provenance.ts`: Engine 0.4.3, accepted source SHA and public archive SHA-256.
- `scripts/check-package.mjs`: adapter 0.5.13 and Engine 0.4.3 assertions.
- `tests/foundation.test.ts`: accepted Engine source SHA and archive SHA-256.
- `README.md`: adapter/Engine install coordinates and authenticated Engine identities.
- `NOTICE`: Engine 0.4.3 identity, source SHA and archive SHA-256.

Preserve codec 0.1.1, Effect, hash-wasm, toolchains, unrelated dependency integrities, safe baselines, copied-source attribution, exports, generated assets, browser scripts and publisher semantics. Do not edit runtime TypeScript, APIs, workers, AudioWorklet code, DSP, codec/decoder, storage/cache, binary assets, or test-harness behavior. Reject unrelated lockfile churn.

## Objective gates

1. Run `npm ci --ignore-scripts`, `npm run check`, `npm run publish:dry-run`, `npm run test:browser`, and `node scripts/browser-packed.mjs --indexed-sparse` with the installed Chromium executable exported.
2. With npm 11.19.0, pack exactly one frozen candidate and record file count, sizes, shasum, SHA-256, SHA-512 and integrity.
3. In a clean consumer, verify root, `/stems`, `/assets`, and `/package.json` imports; strict TypeScript with `skipLibCheck: false`; exactly one physical Engine 0.4.3; installed Engine bytes equal the authenticated public archive; built `ADAPTER_PROVENANCE` equals the package/source/archive identities; and the packaged Worklet hash remains accepted.
4. Require fresh Astra medium review of exact paths/literals, candidate bytes, one-Engine resolution, public archive equality, publisher controls, and absence of runtime changes.
5. Require the PR Packed OPFS qualification workflow to pass macOS OPFS and indexed-sparse Chromium/WebKit on the reviewed SHA.

## Candidate qualification record

Frozen implementation checkpoint `ab7d6fc347802bf4ed51bb5ea3daf87db717bf6f` changes exactly the eight authorized metadata and provenance surfaces. `npm run check` passed 380/380 tests, `npm run publish:dry-run` passed, and package policy retained the expected 247-file shape with no source or test leakage.

npm 11.19.0 packed one retained candidate at `/tmp/miso-adapter-125-candidate-5GqE8G/misofm-engine-web-adapter-0.5.13.tgz`: 474,756 packed bytes, 2,636,641 unpacked bytes, SHA-1 `63936972cf3cabd6e56689046281ad0803a6b8ff`, SHA-256 `277bbf301b1535cbbb8f3d33dd1bb43c3d6419b7c54dfb4722d419d5131981a9`, SHA-512 `e3c1d9a7fb26b8bff26be34dd8e31b8303a66f14f10d4d7494d0ce2f2230e9d2565109aa8462ae4eda811aef8262776ab05c600192a1a2a47332c056657195b7`, and integrity `sha512-48HZp/smuL/ya+NN2OMbgwOmbxTxDU10lNDOLyIw6dJWUQmqhGKuTtqBGu+CYndqsFxgAZKhoqRzMsBWZXGVtw==`.

A clean consumer imported root, `/stems`, `/assets`, and `/package.json`; passed strict TypeScript with `skipLibCheck: false`; resolved exactly one physical Engine 0.4.3; matched all 98 installed Engine files to a fresh public archive; matched `ADAPTER_PROVENANCE` to the accepted Engine package, source SHA, and archive SHA-256; and retained the accepted Worklet SHA-256. The temporary consumer's first strict compile selected `ES2022` and failed on Effect's `AsyncDisposable` declarations; selecting the package-supported `ESNext` library passed without a source or candidate change. Logs and structured evidence are retained under `/tmp/miso-adapter-125-qualify-3cSzRC/`.

Chrome for Testing 151.0.7922.34 with Playwright Core 1.62.1 passed both local browser gates against the same package source. `npm run test:browser` and `node scripts/browser-packed.mjs --indexed-sparse` completed with zero request failures or console errors; injected reject/stall/crash cases terminated cleanly, and every packed sparse worker terminated without an error. Logs are retained under `/tmp/adapter-0513-browser-2vcxVs/`. The browser run observed evidence-only checkpoint `bc52bff`; its only delta from the packed implementation checkpoint is this issue record, which is outside the npm payload.

## Fresh Astra medium review

PASS at clean checkpoint `bdb3c03`, with no implementation blocker. The reviewer independently confirmed exactly nine authorized paths and release-literal-only implementation changes, with no runtime, harness, asset, export, toolchain, or unrelated lockfile delta. All 247 candidate files, sizes, and hashes matched the checkout and retained consumer. All 98 installed Engine files matched a fresh public Engine archive; one physical Engine 0.4.3 resolved; provenance and Worklet identities matched. Independent foundation tests passed 7/7, package policy passed, strict consumer TypeScript and all four imports passed, and both browser logs were accepted. Publisher exact-main, parsed-E404, serialized OIDC publication, immutable version, and verify-only recovery controls remain intact. The reviewer classifies this as the simplest dependency-only carrier with no workaround or bandaid. PR macOS OPFS and Chromium/WebKit qualification remains before delivery.

## Immutable delivery

Merge only the reviewed candidate after PR qualification. Freeze exact main, repeat parsed E404, and dispatch the adapter publisher once. Preserve exact-main checkout, full qualification, OIDC-only publication, serialized concurrency, immutable-version refusal, and verify-only recovery. If publication may have occurred but a later check fails, never retry publish; inspect the registry and use verify mode only.

Record candidate hashes, reviews, PR/CI, merge SHA, publication/verification, public archive equality, consumer results and provenance here. Push evidence and close only after GitHub and npm are synchronized.

## Stop rules

Stop without publishing if public Engine 0.4.3 differs from the identities above; adapter 0.5.13 exists unexpectedly; runtime or harness changes are required; any package/browser/consumer/type/one-Engine/OPFS gate fails; paths exceed the allowlist; review fails; the merged SHA changes; or publication is ambiguous.

## Workflow

Sol supplied this bounded brief. One Luna max agent gets at most two rounds to implement the eight metadata surfaces. Escalate unsatisfied implementation to Sol high for one round, then Astra xhigh. A fresh Astra medium reviewer verifies the frozen candidate. Root owns checkpoints, PR delivery, the single publication dispatch, registry verification, evidence synchronization and closure.

## Public delivery evidence

PR #126 passed required Packed OPFS qualification run 35185412757 on macOS for Chromium and WebKit, then merged as exact `main` SHA `955f10befb5e6ef4172255d95e5865ae307509d4`. The single publish dispatch, run 35185586132, checked out that SHA, reran the full qualification, observed parsed E404, published through OIDC once, and passed public registry dependency, import, signature, and attestation verification.

Independent `npm pack @misofm/engine-web-adapter@0.5.13` produced a byte-identical copy of the reviewed candidate: 247 files, 474,756 packed bytes, SHA-1 `63936972cf3cabd6e56689046281ad0803a6b8ff`, SHA-256 `277bbf301b1535cbbb8f3d33dd1bb43c3d6419b7c54dfb4722d419d5131981a9`, and integrity `sha512-48HZp/smuL/ya+NN2OMbgwOmbxTxDU10lNDOLyIw6dJWUQmqhGKuTtqBGu+CYndqsFxgAZKhoqRzMsBWZXGVtw==`. An immediate independent install briefly observed npm's package read path before version resolution had converged and returned `ETARGET`; publication was not retried. A new clean consumer after convergence imported root, `/stems`, and `/assets`, resolved adapter 0.5.13 and exactly one Engine 0.4.3 with the accepted provenance, and reported 12 verified registry signatures plus seven verified attestations. Registry `latest`, dependency, shasum, and integrity all match the reviewed release.

The adapter release contract is complete. App issue `misofm/app#267` owns adoption of the two public packages, the final spectrum-path audit, app qualification, and testnet deployment.
