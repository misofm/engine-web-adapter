# Prepare running seeks before audible continuation

## Product slice and decision

A seek issued while the adapter is running must preserve playback intent while ensuring the first audio after the seek is fresh target-generation PCM. The actual app Ghost run at a51d057 records 0→16→30 source underruns across two live seeks; these are not protected by a muted transition. The same run proves paused resume adds zero underruns. Evidence: /private/tmp/dx101-ghost-adapter36-a51d057.json and adjacent summary. App101 remains open.

Explicitly supersede issue36's decision to preserve running ACK-only seek completion. Dedicated Astra medium review approves this bounded adapter-only correction. No new Rust or SDK operation is needed: use the already reviewed SDK457 and adapter36 suspended preparation path. No progressive playback, backend, protocol, application ring mechanics, hidden rendering, discarded output, or mute workaround.

## Required behavior

- Preserve the existing seekFrames signature. Mark seeks pending synchronously, including queued operations, so play rejects session.busy before any resume call.
- Validate frame input before changing playback state. Capture whether the context was running when the serialized operation executes.
- For that running operation, await suspension of the existing context before producer mutation. Reuse the exact existing producer ACK, SDK prepareSeek and current-generation/first-target PCM prefill sequence. Do not advance the engine or context clock during preparation.
- Resume only after successful readiness, only when the operation entered running, and inside the same serialized operation. Assert open after awaited transitions. An initially suspended seek remains suspended; initial gesture-bound play stays unchanged.
- Preserve FIFO order for seek/seek and seek/pause. A later fulfilled pause cannot be followed by an earlier operation's late resume. Close remains immediate outside the queue and must win during suspend, prepare, refill or resume.
- Any failed transition after suspension begins must close through existing terminal cleanup, preserving the original cause. Invalid input remains non-destructive. Existing EOF, bigint-generation, deadlines, close and backpressure behavior remains.
- The app retains its existing public seek then origin refresh/play sequence and clock-accuracy contract. No new app readiness algorithm.

## Smallest implementation and objective gates

Use existing session implementation, existing session tests, README/contract documentation and scripts/browser-packed.mjs. Amend only directly affected fixtures. SDK source/archive and store, pump, decoder, ring layout and Worker protocol remain unchanged.

Extend the existing packed fresh-consumer gate with an already-playing seek and full stale shared/internal queues. Observe actual suspension before preparation, unchanged clocks while suspended, one resume only after fresh target readiness, exact first resumed stereo quantum against the existing public offline oracle, and zero added underruns/refused/torn/errors. Arm the existing first-quantum recorder at the suspended public resume boundary so pre-seek audio cannot satisfy it. Retain initial and paused proofs and original FLAC/cache/control/asset assertions. Focused lifecycle tests cover queued seeks/pause, invalid input and close/failure during each awaited transition. No additional browser matrix or fixture framework.

Checkpoint the smallest focused-green implementation before qualification. Run the existing full adapter check and packed gate; dedicated Astra medium independently reviews source and immutable archive. Adopt that exact archive in existing app101 with truthful provenance and lock/asset identities. Reuse the existing localhost5173 Ghost driver, strengthening its two live-seek counter checks as well as its already reviewed sustained resume gate. Retain all Range/CORS/source-ready/asset and seek-clock assertions. App101 closes only after actual acceptance and upstream evidence synchronization.

## Reviewed lifecycle clarification before implementation

Dedicated Astra medium explicitly approves preserving FIFO: a later pause may execute after the seek has restored running state, but once that pause fulfills no earlier seek may resume it. Add no pause-intent state machine. Bound the newly awaited seek suspend/resume transitions using the existing seek timeout duration and timer/abort pattern, with cleanup of timers/listeners, expected-state checks and terminal cause-preserving failure. Add no public timeout option. Close remains outside the queue and must prevent automatic restoration after close. These clarifications are frozen before code.
