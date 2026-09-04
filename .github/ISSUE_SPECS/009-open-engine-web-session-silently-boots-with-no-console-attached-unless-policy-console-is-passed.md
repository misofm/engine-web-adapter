# openEngineWebSession silently boots with no console attached unless policy.console is passed

GitHub: https://github.com/misofm/engine-web-adapter/issues/9

## Problem

`openEngineWebSession()` currently forwards `policy` only when supplied. The
Engine SDK interprets an absent `policy.console` as a request to attach no
semantic console. The adapter still reaches `ready` and plays audio, but every
later `session.console.submit(...)` resolves with `unsupportedKind`. That
reason describes the submitted command rather than the actual missing-console
condition, and the README quickstart does not warn callers that controls are
opt-in.

The current application workaround is to pass
`ABI_LAYOUT.constants.defaultCommandQueueRecords` explicitly.

## Smallest product decision

Decide whether the adapter should attach the Engine SDK's published default
console unless a caller explicitly opts out, or retain opt-in attachment with
an immediate, accurately typed diagnostic and documented quickstart. Keep the
decision in the adapter; do not duplicate or invent a queue-size constant.

## Objective gates

1. A default session's console behavior is deliberate, documented, and tested.
2. An explicit playback-only/no-console request remains possible if the public
   contract chooses default attachment.
3. A session without a console cannot make ordinary commands look like unknown
   command kinds; it fails at boot or at the console boundary with the actual
   cause.
4. Existing caller policy fields and explicit console sizes are preserved.
5. README examples match runtime behavior, and package/type/packed-consumer
   gates pass.

## Non-goals

No Rust ABI change, new queue implementation, mixer UI change, or unrelated
policy defaults belong in this issue. The companion Engine diagnostic gap is
tracked separately in `misofm/engine`.

## Decision

The adapter attaches the Engine SDK's published default console unless the
caller explicitly opts out with `console: false`.

`policy.console.commandQueueRecords` and `policy.console.meterBlocks` default to
`ABI_LAYOUT.constants.defaultCommandQueueRecords` and
`ABI_LAYOUT.constants.defaultMeterBlocks`. No queue-size constant is invented or
duplicated. The remaining two words have no published default and stay at the
documented off value of `0`, which is also what the Engine's own
`toWebBootOptions` writes for an absent word. A caller's explicit `policy.console`
wins field by field over the defaults; every other `policy` field is untouched.

`console: false` writes no console words at all and never opens a control
channel. `session.console`, `session.meters` and `session.telemetry` then refuse
with `EngineWebAdapterError` code `console.not_attached`, phase `console`, and a
remedy naming the opt-out.

## Evidence

- `tests/console.test.ts`
  - "the default session attaches the Engine's published console words"
  - "explicit console sizes and other policy fields survive the default"
  - "an explicit no-console session names the missing console at first access"
- `npm run test:browser` (packed tarball, Chromium, real Engine worklet) reports
  `"notAttached":"console.not_attached"` and
  `"meterNotAttached":"console.not_attached"` for a `console: false` session, and
  real admitted console transactions plus real meter frames for a default one.
- README "Open a native-FLAC session" and "Failures" match runtime behavior.

## Correction to the problem statement

The app workaround claimed all four console words must be stated or every
command fails `invalidArgument`. That is not what the SDK does:
`@misofm/engine/browser` `toWebBootOptions` maps an absent `observationTaps` or
`masterTrackPlusOne` to `0n`. Only `commandQueueRecords` and `meterBlocks`
actually had to be supplied, and both now come from the published constants.

## Status

Implemented on `feat/zero-config-console-and-feeds`.
