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

- npm CLI 11.19.0's dry run reported `createPackage`, but the live trust endpoint
  returned `404` because the package did not yet exist. npm's documented
  existing-package requirement was satisfied with an inert
  `0.0.0-bootstrap.0` prerelease under a non-default `bootstrap` tag. After the
  OIDC release, that version was deprecated and the tag was removed.
- This is a bounded release operation. The implementation passed its separate
  adversarial qualification in issues #1 and #2, so no additional product review
  cycle is required here.

## Evidence

- Local `npm run check`: PASS (33/33 tests plus format, type, source, and package
  policy gates).
- Isolated-cache `npm publish --dry-run --json`: PASS (100 files, 66,373-byte
  archive, 308,062 bytes unpacked).
- Trusted publisher created for `misofm/engine-web-adapter` /
  `npm-publish.yml`; no npm token is present in the release workflow.
- OIDC publish step: PASS in GitHub Actions run 33876527800. npm published a
  signed SLSA v1 provenance statement to transparency-log index 2711613053.
- Registry: `latest` is `0.1.0`, access is public, the runtime dependency is
  exactly `@misofm/engine@0.1.0`, and the 100-file archive has SHA-512 integrity
  `TtmXwR9+Lhl4LCSsPe6GWuIe1Bd1eq31cX/dSSFZ6u6o2OcoJliUXhEgUSAC6eVPsqt1JeoOyxJHV10lkLY0mg==`.
- Fresh registry consumer: PASS importing the root, `stems`, and `assets` entry
  points. `npm audit signatures --include-attestations` verified registry
  signatures and attestations for both installed packages.
- The initial workflow's post-publish check timed out after 60 seconds while npm
  was still processing the accepted release. Add a verify-only recovery mode and
  allow five minutes for future registry propagation; never retry an immutable
  publish after this class of failure.
