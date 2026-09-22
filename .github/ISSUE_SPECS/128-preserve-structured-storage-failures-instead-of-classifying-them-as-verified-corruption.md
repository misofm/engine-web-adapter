# Preserve structured storage failures instead of classifying them as verified corruption

## Problem

The app investigation in `misofm/app#294` found that adapter 0.5.13 maps sparse
storage-open failures to `stem.corrupt`, before any download. UnknownError,
InvalidStateError, NotAllowedError, and NoModificationAllowedError injected at
root/open must not be reported as verified audio corruption. The original
device exception was not captured; injection does not establish that device's
root cause.

Base: upstream main `602b7c7b77d6228a73a0b9932a8809a8933ba692`, package
`@misofm/engine-web-adapter@0.5.13`, Engine `0.4.3`, Effect `4.0.0-rc.112`.

## Bounded T2 implementation

This issue owns only the upstream adapter's public storage-error contract and
the sparse-store/worker boundaries that implement it. It does not change app
code, the sparse format, shutdown ownership, or close retry policy.

- Introduce the documented public `storage.io` code for storage failures with
  additive operation/resource/granular-phase details.
- Preserve unknown browser exception names and causes without guessing from
  message text.
- Keep `stem.invalid_declaration` and `session.declaration_mismatch` for
  declaration/metadata failures, and reserve `stem.corrupt` for actual digest
  or byte-length verification evidence (`kind`, `expected`, `observed`, and
  `algorithm` where applicable).
- Preserve typed failures, Effect interruptions, defects, and every finalizer
  reason through the public edge and relevant Worker transports.
- Document supported close/cancellation semantics, add regression tests and an
  unreleased changelog/evidence entry, and qualify public exports on a packed
  artifact.

## Acceptance

- Inject root/open/read/write/close failures, including UnknownError,
  InvalidStateError, NotAllowedError, and NoModificationAllowedError; none is
  reported as verified integrity.
- Root-open refusal happens before resolver/network work and produces zero stem
  fetches.
- Genuine wrong digest and wrong length remain `stem.corrupt` with structured
  verification evidence.
- Invalid metadata/declaration remains distinct from storage and integrity
  failures.
- Worker round trips preserve nested causes, interruption/defect distinctions,
  and finalizer failures rather than flattening to the first reason.
- Public exports and package tests pass against a fresh packed artifact.

## Workflow and boundaries

Implementation is Luna reasoning=max followed by a fresh independent Astra
reasoning=medium verification. No spawning, push, PR creation, merge, or
publication is authorized here; coordinator owns reviewed integration.

The release metadata remains at version 0.5.13. Do not copy app sources,
patch `node_modules`, rewrite the sparse format, force shutdown, or invent a
retry of a failed physical close. Record exact commands, results, candidate
SHA, package provenance, fixture shape, close/cancellation semantics, and
browser capability limitations below.

## Implementation evidence

Pending until the bounded implementation and verification are complete.
