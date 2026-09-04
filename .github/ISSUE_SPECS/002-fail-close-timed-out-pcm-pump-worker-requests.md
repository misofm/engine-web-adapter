# Fail-close timed-out PCM pump Worker requests

## Objective

Ensure every timed-out or cancelled `PcmPumpWorkerClient` request fail-closes
and terminates its Worker before the public promise rejects. A rejected
`seekFrames()` must never apply later.

## Baseline and reproduction

Issue #1 commit `d17e944` passes its package and Chromium gates, but this
remains reproducible:

1. Initialize a fake Worker successfully.
2. Configure a 5 ms client deadline.
3. Delay a seek reply/application for 25 ms.
4. `seekFrames()` rejects with `stem.read_deadline`, while the Worker remains
   unterminated.
5. The Worker can subsequently apply the rejected seek.

The defect is in `src/stems/worker-client.ts`: request timeout removes and
rejects only that pending request, allowing the live Worker to continue.

## Smallest fix

- On any request timeout, terminate/fail-close the client and Worker before
  rejecting pending callers.
- Preserve the first authoritative timeout/cancellation error.
- Ensure constructor-signal cancellation follows the same
  terminate-before-reject ordering.
- Ignore all late Worker messages after termination.
- Preserve successful initialize/seek behavior and idempotent bounded close.
- Do not change the Worker protocol, ring ABI, pump scheduling, session API,
  deadlines, or issue #1 gates.

## Objective gates

1. A timed-out seek observes Worker termination before its promise rejection
   handler runs.
2. A delayed simulated seek cannot mutate state or settle successfully after
   rejection.
3. Cancellation with a request in flight terminates before rejecting and
   permits no late effect.
4. All pending requests reject exactly once with the authoritative error; late
   replies are inert.
5. Successful seek and close behavior remain covered.
6. `npm run check` passes.
7. From a clean archive/install, the packed real-Chromium gate passes
   cold/warm open, play, pause, unaligned seek, and close with zero refused,
   torn, or feed errors.
8. `git diff --check` passes and the source worktree remains clean after
   generated artifacts are ignored.

## Non-goals

No retry policy, Worker restart, session hot replacement, protocol expansion,
BigInt allocation work, or broader lifecycle redesign.

## Review workflow

Sol produced this stateless successor brief after issue #1 exhausted its three
implementation attempts. Sol implements the bounded correction, and a fresh
Sol review verifies the immutable checkpoint against these gates.
