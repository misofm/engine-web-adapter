# Release the web adapter against engine SDK 0.4.0

## Product outcome

Publish one immutable dependency-only `@misofm/engine-web-adapter` release that pins the verified public `@misofm/engine@0.4.0` package. This lets the app resolve one physical SDK containing engine #844 and the accepted ordinary-host observation closure. The adapter already lends callers the same SDK engine; no runtime wrapper, codec, storage, cache, control, or protected-EQ behavior changes are required.

Engine 0.4.0 is public from source `89288333961713b3adaea0ad3050fcbb5e35d748`. Its registry archive SHA256 is `5ca46401c29b8206cea348be811ad30623c43807dbe1b33935d57534185e2744`, npm integrity is `sha512-UZVdQrqJWUZVd07F0OkW3kCFeUrjMDc4ZM2/eEq83NHG2EMwvfxrjyRIWpyDNRWGSW9kPsQMAp2xHzbnLssymw==`, and verify-only workflow 35084369532 passed after the single publish request's delayed propagation.

## Bounded implementation

Freeze unused adapter patch 0.5.10 after live registry absence proof. One Luna MAX tranche may update only this issue spec, `package.json`, `package-lock.json`, `.github/workflows/npm-publish.yml`, `src/provenance.ts`, identity-only assertions in `scripts/check-package.mjs` and `tests/foundation.test.ts`, plus exact dependency/release prose in `README.md` and `NOTICE`. Preserve historical `safeBaselines` and copied-source attribution.

No production TypeScript/runtime, API, decoder, codec 0.1.1, OPFS/cache, Worker/AudioWorklet, test harness, generated binary, or publisher redesign. The adapter contract remains compatible; the release patch changes its exact engine dependency and authenticated provenance only.

## Objective gates and delivery

Run locked install, full `npm run check`, `npm run publish:dry-run`, and existing packed indexed-sparse browser proof with the pinned browser toolchain. Prove an ordinary fresh tarball consumer can import runtime and TypeScript public entries with exactly one installed engine 0.4.0. Fresh Astra MEDIUM must PASS the frozen candidate. Required macOS packed OPFS/Chromium/WebKit CI must pass before merge.

Hold the accepted merged adapter main SHA unchanged through the existing OIDC publish workflow and any verify-only recovery. Publish once, independently compare registry archive to the reviewed tarball, verify exact engine dependency/provenance, one SDK resolution, public imports/types, and trusted source/workflow attestation. Only then synchronize evidence and close this issue. App adoption starts only from verified public engine and adapter identities.

This is ordinary-host adoption. It does not claim combined protected/ordinary preparation, protected-EQ coexistence, or repair of app fixture #231.

## Workflow

Fresh Astra XHIGH scope and adversarial review approved this second slice. One fresh Luna MAX owns the bounded dependency/provenance tranche; after two unsatisfactory Luna rounds escalate once to Sol HIGH, then Astra XHIGH. Root owns checkpoints, GitHub delivery, publication and evidence synchronization.

## Evidence

Starting source is synchronized adapter main `4dd1cefbe20842892ce96b45da929b6cc3b69144`. The primary checkout remains on unrelated research branch `research/77-lossless-delivery` and is untouched. Public adapter 0.5.9 pins engine 0.3.0; live registry lookup returns parsed E404 for adapter 0.5.10. No adapter source, package or external publication has changed.

### Luna round 1 implementation tranche

Frozen adapter `0.5.10` to exact `@misofm/engine@0.4.0`, with provenance bound to
source `89288333961713b3adaea0ad3050fcbb5e35d748` and archive SHA256
`5ca46401c29b8206cea348be811ad30623c43807dbe1b33935d57534185e2744`.
Updated only the release identity/provenance surfaces listed above; codec `0.1.1`,
safe baselines, copied-source attribution, runtime/API, and publisher semantics
remain unchanged. `npm ci --ignore-scripts` PASS; focused package policy PASS
(`247` files, `474766` bytes); focused foundation identity PASS (`7/7`); full
`npm run check` PASS (`380/380` tests, package policy `247` files/`474766`
bytes); `npm run publish:dry-run` PASS (`0.5.10`, `247` files). No publication,
browser qualification, or GitHub state change was performed in this tranche.


### Root qualification and independent candidate review

Root checkpointed the identity-only tranche at
`29c84f0e12df1212e8fb686549460af9eb914418`. The packed indexed-sparse
Chromium gate passed with Chromium `151.0.7922.34`, including cold ingest,
warm verified reuse, three concurrent warm workers, serial/concurrent cold
paths, exact sparse windows, clean worker termination, and no request or
console errors. The retained package archive is
`misofm-engine-web-adapter-0.5.10.tgz`: SHA256
`d87a8f59b322e84fb4bfa1770b41803ce800bea52501c474ddc398ffc226bf7f`,
SHA1 `39cb19c1f312af81c9905d4f50811107d093d3ee`, npm integrity
`sha512-ZzVf9FsEK3tJXZo8zxcWQlVgp3/0omvvJhvQDnyqdYDFjcHfQ1kPZkob4qrHJ6zz61hHq3dwswWDoTQGcnO95A==`,
`247` files, `474766` packed bytes, and `2636641` unpacked bytes.

A fresh consumer installed only that archive, imported the package root,
`/stems`, and `/assets`, passed strict TypeScript declaration checking with
`skipLibCheck: false`, and proved exactly one physical
`@misofm/engine@0.4.0`. Fresh Astra MEDIUM adversarial review independently
verified the complete diff, public Engine archive and lock integrity, all 247
candidate archive files, foundation tests (`7/7`), strict consumer imports and
types, one-engine resolution, and provenance. Verdict: **PASS**, with no
candidate blockers. Remaining delivery gates are the required macOS packed
OPFS/Chromium/WebKit CI, immutable OIDC publication, registry/archive and
attestation verification, then remote issue synchronization and closure.


### Published release and registry acceptance

PR #115 merged the accepted candidate to immutable main SHA
`75201e0728b5ce67eeba1a2230d013e835578845` after required macOS packed OPFS,
Chromium, and WebKit qualification passed (run `35085931638`). Single OIDC
publication run `35086137654` succeeded against that exact SHA; the prepublish
registry guard observed parsed E404, and no second publish was attempted.

The public `@misofm/engine-web-adapter@0.5.10` registry archive is byte-equal
to the reviewed candidate: SHA256
`d87a8f59b322e84fb4bfa1770b41803ce800bea52501c474ddc398ffc226bf7f`,
SHA1 `39cb19c1f312af81c9905d4f50811107d093d3ee`, npm integrity
`sha512-ZzVf9FsEK3tJXZo8zxcWQlVgp3/0omvvJhvQDnyqdYDFjcHfQ1kPZkob4qrHJ6zz61hHq3dwswWDoTQGcnO95A==`,
247 files and 2636641 unpacked bytes. A fresh registry consumer imported all
three public entry points, resolved exactly one physical Engine 0.4.0, and
matched the accepted adapter provenance. npm 11.19.0 signature audit passed:
13 verified registry signatures and 7 verified attestations. The package and
SLSA v1 subjects bind adapter 0.5.10 and its SHA512 to repository
`misofm/engine-web-adapter`, workflow `.github/workflows/npm-publish.yml`, main
ref, source SHA `75201e0728b5ce67eeba1a2230d013e835578845`, and publication run
`35086137654`. All product, remote, publication, and registry gates pass.
