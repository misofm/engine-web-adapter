# Preserve the Engine host module closure in the packed browser gate

## Product outcome

Make the adapter's existing fresh packed-browser consumer exercise the published Engine host exactly as a deployable browser bundle. The built consumer must serve `prepared-control.js` beside the raw Engine AudioWorklet host so its relative import resolves in Chromium.

## Bounded implementation

Change only `scripts/browser-packed.mjs`, this numbered issue spec, and a focused harness test only if the implementation cannot be directly proved by the existing browser gate. Preserve adapter and Engine package/runtime sources, public APIs, package identities, release workflow, and issue #117.

The harness may emit or copy the installed Engine host closure into its temporary Vite output. It must retain the Engine host and worklet asset observations and fail if the required relative companion is absent.

## Objective gates

From synchronized adapter main `1a97a7e2a5c8747996388fdf412d82e32156fa15`, reproduce the ordinary packed Chromium failure before the correction. Then prove `npm run test:browser`, the indexed-sparse Chromium gate, `npm run check`, and package/dry-run gates pass. Confirm no generated evidence or dependencies remain untracked. Record exact commands and outcomes below.

## Workflow

One bounded Sol implementation round owns this harness-only correction. Root owns checkpoint commit, push, PR, CI, merge, and any release integration. No publication or change to issue #117 is authorized here.

## Evidence

Starting source is clean synchronized adapter main `1a97a7e2a5c8747996388fdf412d82e32156fa15` in isolated worktree `/tmp/miso-adapter-packed-closure`. The primary checkout and `/tmp/miso-adapter-0511-release` are untouched.

### Bounded implementation and local acceptance

Baseline `CHROME_EXECUTABLE=/home/bl/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome npm run test:browser` reproduced the defect on Chromium `153.0.8010.12`: Vite emitted the raw host at a hashed asset URL, the host requested its relative `/assets/prepared-control.js`, that request returned 404, and session open failed with `Engine host module could not load`.

The harness now writes a temporary consumer Vite config that derives a content-addressed directory from the installed SDK asset manifest, emits the host module and ABI layout there under their original filenames, and emits the installed `prepared-control.js` beside them. The ordinary browser lane explicitly requires requests for both relative companions. No adapter/Engine runtime source, public API, package identity, release workflow, or issue #117 changed.

Local acceptance on Node `22.23.2`, npm `10.9.8`, and Chromium `153.0.8010.12`:

- `npm ci --ignore-scripts`: PASS, 31 packages, zero vulnerabilities.
- `CHROME_EXECUTABLE=/home/bl/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome npm run test:browser`: PASS, full packed playback/control/seek/fault assertions, 15 observed JS/Wasm assets, zero request failures and zero console errors.
- `CHROME_EXECUTABLE=/home/bl/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node scripts/browser-packed.mjs --indexed-sparse`: PASS, cold/warm/three-worker/serial/concurrent/all-silent/tail proofs, all physical workers terminated, zero request failures and zero console errors.
- `npm run check`: PASS, including format, reproducible SHA-256/BLAKE3 Wasm, types/source policy, decoder policy, the complete test suite, and package policy.
- `npm run check:package`: PASS, `247` files and `474766` packed bytes.
- `npm run publish:dry-run`: PASS for unpublished action only, `@misofm/engine-web-adapter@0.5.10`, `247` files, package SHA1 `39cb19c1f312af81c9905d4f50811107d093d3ee`.
- `git diff --check`: PASS. Generated `.adapter-71-evidence/` was removed; final status contains only this issue spec and `scripts/browser-packed.mjs`.

Verdict: **PASS** for the smallest packed-browser harness correction. Root retains ownership of checkpointing, remote delivery, review, and release sequencing.
