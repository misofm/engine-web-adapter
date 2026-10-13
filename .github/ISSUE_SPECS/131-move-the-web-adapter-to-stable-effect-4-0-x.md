# Move the web adapter to stable Effect 4.0.x (0.6.0)

GitHub: https://github.com/misofm/engine-web-adapter/issues/131

## Product outcome

Release `@misofm/engine-web-adapter@0.6.0` on stable Effect `4.0.x` with `@misofm/codec@0.2.0`, so an application on the Effect 4.0.4 train decodes FLAC in the mixer. `0.5.13` depends on `effect@4.0.0-rc.112`; when the codec resolves the application's Effect 4.x copy while the adapter keeps its nested rc.112 copy (codec 0.2.0, or codec 0.1.1 under bun's loose peers or `npm --legacy-peer-deps`), the adapter's `Layer.build(makeFlacDecoderLayer(bytes))` fails with `TypeError: Cannot read properties of undefined (reading 'scheduler')` and no stem decodes. Unit tests resolve one Effect copy and did not catch it.

Base: origin/main `602b7c7` (adapter 0.5.13). Branch `effect-4.0.4`, draft PR https://github.com/misofm/engine-web-adapter/pull/130. Codec prerequisite: https://github.com/misofm/codec/issues/10 (PR https://github.com/misofm/codec/pull/9). Effect guidance: [skills revision 0507930](https://github.com/unconfirmedlabs/skills/tree/0507930b6dd13f39739aba40b86a6afb63d32e09/effect-ts) (`references/migration.md`, "Effect v4 release candidates to 4.0.x").

## Smallest bounded implementation

- `package.json`: version 0.6.0; `effect` moves from a dependency (exact rc.112) to a peer `>=4.0.3 <4.1` with exact dev dependency 4.0.4, so the adapter, codec, and application share one copy; `@misofm/codec` exact `0.2.0`; `CHANGELOG.md` in `files`. Engine stays `0.4.3`.
- Codec 0.2.0 was published (https://github.com/misofm/codec/releases/tag/v0.2.0, registry integrity `sha512-nbhiEKPB…ksUmqGA==`), so the dependency is the registry package and the lockfile resolves its registry tarball with that integrity; during development it was a git ref to the throwaway branch `misofm/codec:effect-4.0.4-ci-dist`. `npm-publish.yml` refuses to run unless `dependencies['@misofm/codec'] == "0.2.0"` and the peer range matches, and repeats both checks against the registry artifact.
- `effect/unstable/http` becomes `effect/http` (three modules). No other compile change. Built `.d.ts` differ only in that import in `stems/sparse-response.d.ts`.
- Preserve rc.112 behaviour: `preflightExpected` and `preflightSpan` check `Reflect.ownKeys` because Effect 4.0.x (#8423) strips non-enumerable extras under `onExcessProperty: "error"` (tests added).
- Deliberate behaviour change: the sparse full GET disables `HttpClient.TracerPropagationEnabled`, as the FLAC range lane does, so `b3`/`traceparent` headers no longer force a CORS preflight (test added).
- Browser gate scripts no longer copy `fast-check`/`pure-rand`/`msgpackr`; `NOTICE` names the codec decoder asset hash instead of codec 0.1.0; workflow job name and `PACKAGE_VERSION` are 0.6.0; `CHANGELOG.md` records the audit and migration note.
- Do not change exports, workers, AudioWorklet code, delivery policy, or the Wasm assets.

## Objective gates

1. `npm ci --ignore-scripts` and `npm run check` (383 tests, SHA-256/BLAKE3 Wasm reproducibility, package policy). Also the full suite with `effect@4.0.3` installed.
2. `npm run test:browser`, `node scripts/browser-packed.mjs --indexed-sparse`, and the Chromium part of `npm run test:browser:opfs` with the installed Chromium; PR workflow Packed OPFS qualification (macOS Chromium and WebKit) green.
3. Crash repro in a consumer with `effect@4.0.4`: codec 0.1.1 with adapter 0.5.13 fails with the `scheduler` TypeError; codec 0.2.0 with the packed adapter 0.6.0 compiles the decoder module. `npm install --strict-peer-deps` and `npm ls` valid on 4.0.4 and 4.0.3; 4.0.0-rc.115 rejected.
4. Release only from `main` with the published codec 0.2.0 dependency.

## Release contract and blockers

Run `.github/workflows/npm-publish.yml` on `main` (`mode=publish`, the exact 40-character merge SHA); the workflow publishes through OIDC only, refuses an existing version, and verifies the registry artifact. Record the run URL, registry integrity, and archive hashes here. Publication is complete; see Public delivery evidence below.

## Public delivery evidence

PR #130 passed required Packed OPFS qualification run 38431747425 on macOS for Chromium and WebKit at head `d7b7e2dc6b6c91cc9fd607442b15e56f95e01a59`, then merged as exact `main` SHA `5a2fa1953558fbe572ab5bd5433061769b4862ce`. The single publish dispatch, run 38432201391, checked out that SHA, passed the release-identity guard, qualification, and the immutable-version refusal, published through OIDC once, and passed the public registry artifact verification step.

The registry artifact for `@misofm/engine-web-adapter@0.6.0` has `gitHead` `5a2fa1953558fbe572ab5bd5433061769b4862ce`, 248 files, 482,652 packed bytes, SHA-1 `c9c5201da831ed11d751cde115720767c081b149`, SHA-256 `5aae26f66695f4e7998a38203fac094fe2435648c4de1b313bfc751140353cde`, and integrity `sha512-WUFAl4xzabJ0+IOmxVvsUd6Y7WDPCV2f2WyfoM1IIPa/SxSzX8sFLBqAkIAgyiUcnmLfjIA0P/1Pr9Om6vw/ww==`, with two registry signatures and a SLSA provenance attestation. Registry `latest` is `0.6.0`; its dependencies are `@misofm/codec` `0.2.0`, `@misofm/engine` `0.4.3`, and `hash-wasm` `4.12.0`; its peer is `effect` `>=4.0.3 <4.1` (dev dependency `4.0.4`). Identity is retained in `.github/RELEASE_EVIDENCE/131/registry-release.json`.

An independent application consumer (`misofm/app` PR #304) resolves exactly one `effect@4.0.4`, `@misofm/codec@0.2.0` and this adapter with no nested Effect copy. The adapter's own decoder loader compiles the packaged FLAC decoder there, whereas the same application with adapter 0.5.13 and codec 0.1.1 fails with `TypeError: Cannot read properties of undefined (reading 'scheduler')`. In headless Chromium the application's mixer opens, decodes eight FLAC stems through this adapter, and plays with an audible master meter.

The adapter release contract is complete. Application adoption is tracked in `misofm/app` PR #304.
