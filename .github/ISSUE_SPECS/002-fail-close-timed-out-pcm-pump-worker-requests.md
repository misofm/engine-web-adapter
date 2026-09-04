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

## Implementation evidence

The client now records the first terminal cause, removes all Worker listeners,
terminates the Worker, and only then rejects every pending request with that
same cause. Timeout, constructor-signal cancellation, Worker errors, and
message-clone errors share this fail-close path. Closed clients refuse new
requests with the preserved cause, and late replies return before inspecting
pending state. Successful seek and idempotent close retain their prior public
behavior.

Deterministic tests cover termination-before-timeout rejection, a delayed seek
that cannot apply after termination, forced late replies through a retained
listener callback, two in-flight seeks rejected exactly once by constructor
signal cancellation with the identical abort reason, and successful seek plus
concurrent idempotent close. `npm run check` passes 32 tests and package policy
over 100 files. The packed Chromium gate passes cold/warm reuse with 32 accepted
submissions, one applied unaligned seek, and zero refused, torn, or feed errors.
Offline `npm publish --dry-run` passes with a 66.2 kB/100-file tarball (SHA-1
`7a8d0888c3cb82bc28c3c72e9cdca610f4b182cc`), and `git diff --check` passes.
