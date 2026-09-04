# Publish `@misofm/engine-web-adapter` 0.1.0 via npm trusted publishing

GitHub: https://github.com/misofm/engine-web-adapter/issues/4

## Outcome

Publish the already-qualified `@misofm/engine-web-adapter@0.1.0` package through
npm trusted publishing from GitHub Actions, without a long-lived npm token or a
bootstrap package version.

## Scope

- Add the exact public repository metadata required by npm OIDC provenance.
- Add one manually dispatched, OIDC-only npm publish workflow.
- Configure npm trust for `misofm/engine-web-adapter` and the workflow filename.
- Dispatch publication once and verify the registry artifact.

This issue does not reopen the qualified adapter implementation or add product
features.

## Gates

- The existing adapter qualification remains green.
- A clean package dry run succeeds.
- The workflow rejects non-`main` dispatches and a mismatched commit or package
  identity.
- The publish step refuses npm token fallback and uses a blank user config.
- npm reports version `0.1.0`, public access, and the expected dependency pin.
- A fresh consumer can import every public entry point.
- npm reports a provenance attestation tied to this repository and workflow.

## Decision record

- npm CLI 11.19.0 reports the `createPackage` permission for the trusted-publisher
  configuration. Use that capability instead of publishing an inert bootstrap
  version.
- This is a bounded release operation. The implementation passed its separate
  adversarial qualification in issues #1 and #2, so no additional product review
  cycle is required here.

## Evidence

- Local `npm run check`: PASS (33/33 tests plus format, type, source, and package
  policy gates).
- Isolated-cache `npm publish --dry-run --json`: PASS (100 files, 66,373-byte
  archive, 308,062 bytes unpacked).
- npm CLI 11.19.0 trusted-publisher dry run: `createPackage` for
  `misofm/engine-web-adapter` / `npm-publish.yml` with publish permission.
- Registry publication, fresh-consumer import, and provenance: pending workflow
  dispatch.
