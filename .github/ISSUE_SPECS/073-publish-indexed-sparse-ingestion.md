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

Pending.
