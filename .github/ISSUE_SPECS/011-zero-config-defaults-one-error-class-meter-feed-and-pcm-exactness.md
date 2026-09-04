# Input to #8: zero-config defaults, one error class, meter feed, and the PCM exactness trap

GitHub: https://github.com/misofm/engine-web-adapter/issues/11

## Context

This pre-existing issue collects follow-up API findings from the first app
integration. It is not part of the universal-Wasm decoder correction and must
not expand that launch-critical slice. Issue #8 already moved caller-owned
float-to-integer conversion out of the default path.

## Proposed product decisions

1. Make the documented zero-configuration path deliberate: default the Engine
   console from published Engine ABI constants, generate `leaseId`, derive
   source declarations from the canonical session, and retain explicit
   overrides. If no-console remains supported, expose an explicit opt-out.
2. Add subscription-oriented meter and telemetry feeds while preserving host,
   context, and output escape hatches. Callers must not coordinate private
   request identifiers.
3. Normalize every adapter-boundary failure into one typed error carrying a
   stable code, phase, remedy, details, transience, and cause. Console
   backpressure should be absorbed/coalesced while semantic refusal stays
   visible.
4. Keep Effect internal; no Effect type enters the public API. Record the
   measured bundle cost.
5. Preserve the exact PCM rule for any advanced float input: multiplying by
   `2^(depth - 1)` must produce an in-range integer. Never round. Include both
   positive and negative full-scale samples in the corpus.
6. A narrow declarative strip-state facade may follow once the common error and
   console-writer boundary exists; it is optional and must not broaden the
   decoder issue.

## Objective gates

1. A packed consumer can open the documented minimal session and use its first
   console command and meter subscription in either order without retry.
2. An explicit no-console session reports `console.not_attached` at first
   console access with a useful remedy.
3. Every thrown/rejected consumer error is the single public error class with a
   nonempty remedy; raw Engine host objects never leak.
4. Semantic console refusal throws accurately; transient backpressure is
   coalesced and the final staged value lands.
5. Full-scale PCM fixtures prove exact conversion and reject a non-integral
   sample.
6. Caller-supplied policy, identifiers, declarations, assets, host/context,
   store, pump, output, scratch, and capability overrides remain supported.
7. README, public types, package checks, and packed-consumer tests agree.

## Dependencies and non-goals

Coordinate with the Engine request-id/error work tracked in
`misofm/engine#379`. Do not change the Rust ABI, implement a new meter queue,
alter FLAC preparation/delivery, or fold this API redesign into the universal
Wasm decoder successor issue.

## Status

Open and unimplemented. This local spec synchronizes the pre-existing GitHub
issue at the issue boundary.
