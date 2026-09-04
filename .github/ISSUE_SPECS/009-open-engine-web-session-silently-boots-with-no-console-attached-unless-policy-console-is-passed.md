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

## Status

Open and unimplemented. The app's explicit policy remains the supported
workaround. This spec synchronizes the pre-existing GitHub issue before the
next issue boundary.
