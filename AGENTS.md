# Engine Web Adapter agent guide

## Mission

Build a headless, framework-neutral browser host for `@misofm/engine`. Dense,
fixed-block FLAC prepared by the Miso CLI is the first-party browser delivery
format. The adapter streams it through bounded HTTP ranges, Worker-side
WebCodecs decode, canonical PCM verification and OPFS caching, then feeds the
engine through bounded browser primitives. An already-decoded canonical-PCM
resolver remains an explicit lower-level escape hatch.

The package owns browser delivery mechanics, not product delivery policy. Do
not add R2, fixed domains, filename/key derivation, credentials, React, or
product UI. URL/auth/request mapping stays caller-owned. Do not inspect or copy
legacy engine source. Copied current-engine/app source must be explicitly
provenanced to the revisions named by the active issue.

Realtime and streaming work is bounded. Never load a whole stem solely for
playback, never perform network/storage/decode work on the audio render thread,
and never report a source ready before full byte-count and digest verification.
Use Effect for stateful HTTP/control pipelines where the active issue requires
it; do not replace those pipelines with ad-hoc promise state machines.

## Workflow

Work from a stateless numbered issue body in `.github/ISSUE_SPECS/`, synchronized
with the matching GitHub issue. Keep feature slices small and checkpoint coherent
green tranches. Do not weaken objective gates.

For launch work: Sol scopes, Sol implements at the user-requested effort, and a
fresh Sol adversarially verifies. Record evidence and publish-readiness blockers
in the issue spec. Preserve unrelated work and never commit generated caches,
dependencies, secrets, or packed tarballs unless the issue explicitly requires
an audited fixture.

Release readiness requires a packed fresh-consumer test, because Worker and
AudioWorklet URLs that succeed in the source tree can fail after packaging.
