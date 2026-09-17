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

## Immutable delivery

Merge only the reviewed candidate after PR qualification. Freeze exact main, repeat parsed E404, and dispatch the adapter publisher once. Preserve exact-main checkout, full qualification, OIDC-only publication, serialized concurrency, immutable-version refusal, and verify-only recovery. If publication may have occurred but a later check fails, never retry publish; inspect the registry and use verify mode only.

Record candidate hashes, reviews, PR/CI, merge SHA, publication/verification, public archive equality, consumer results and provenance here. Push evidence and close only after GitHub and npm are synchronized.

## Stop rules

Stop without publishing if public Engine 0.4.3 differs from the identities above; adapter 0.5.13 exists unexpectedly; runtime or harness changes are required; any package/browser/consumer/type/one-Engine/OPFS gate fails; paths exceed the allowlist; review fails; the merged SHA changes; or publication is ambiguous.

## Workflow

Sol supplied this bounded brief. One Luna max agent gets at most two rounds to implement the eight metadata surfaces. Escalate unsatisfied implementation to Sol high for one round, then Astra xhigh. A fresh Astra medium reviewer verifies the frozen candidate. Root owns checkpoints, PR delivery, the single publication dispatch, registry verification, evidence synchronization and closure.
