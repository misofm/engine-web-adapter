# Publish indexed sparse ingestion

Status: scoped release of the accepted issue #71 capability from main commit `b3571ecf786f3db6b8e733194a9298b16221847f`.

## Outcome

Publish `@misofm/engine-web-adapter@0.3.7` so the existing app audio-open seam can consume `createSparseStemResolver` and `openSparseEngineWebSession` from the registry. This issue changes package/lock version, release workflow pin, and current README release text only. It adds no runtime behavior, app work, UI, offline feature, codec, cache format, or framework.

## Gates

- Registry preflight proves 0.3.7 is unpublished.
- Package and lock versions plus the publish workflow agree on 0.3.7; dependencies remain unchanged.
- `npm run check` and `npm publish --dry-run` pass.
- Merge required CI, dispatch the existing exact-main OIDC publication workflow once, then verify registry imports and provenance.

## Evidence

Registry preflight returned parsed `E404` for 0.3.7. With the frozen lockfile installed, `npm run check` passes all 304 tests plus format, type, source, decoder, and package guards; package policy reports 190 files / 232,846 bytes. `npm publish --dry-run` succeeds with 190 files, 232.8 kB packed. PR #74 passed the required browser check and merged as `68e197a990f2afe9dc705a86d9c7339e4c71d12f`. Existing OIDC workflow run 34662795626 published and verified the public artifact: shasum `00030673838ac63d54d74d63497e39c8f65792e4`, integrity `sha512-8U5g6/zUASKwVa264yq/jpNi7kJYuLk6nA9xP2aMvx/+DH0PUHiIWbOvS6znKHaW0YiC4FVL1eF9sThhJtWWcQ==`, exact Engine dependency 0.2.3. Registry import and signature/attestation verification passed. Release complete.
