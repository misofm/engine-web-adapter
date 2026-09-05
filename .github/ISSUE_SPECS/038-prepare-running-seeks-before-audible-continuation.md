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

## First source tranche

Astra medium removes only the running producer-ACK bypass. The serialized seek captures its entry context state, suspends if running, confirms the actual state, reuses attachment/producer ACK/SDK preparation/full-generation target prefill, then resumes and confirms running only for that operation. Both new context transition waits use the existing2000ms duration through the existing abort helper, with timer/listener cleanup. Close remains immediate; preparation/transition failures preserve cause and terminate the session. Initial gesture play and the existing synchronous busy admission remain unchanged. No SDK, store, pump, decoder or protocol edits.

The existing running-path lifecycle assertion now proves suspension and preparation before restoration, with delayed target PCM. Existing tests add FIFO seek/seek/pause final state, invalid running input, transition rejection/wrong settled state, both bounded hung transitions and cleared timers, and close during suspend/prepare/refill/resume including late completion. Initial/suspended/EOF and typed refusal tests remain. Focused session/feed/console51/51 PASS; types, build, format and diff check PASS. Logs `/private/tmp/dx38-{types,build,focused,format}.log`. The first typecheck exposed TypeScript retaining a pre-await state narrowing; a shared expected-state assertion avoids that stale static narrowing while still checking the actual post-await context state.

Pause these six exact paths (session implementation, session types, existing error remedy, README, existing session tests and this spec) for root checkpoint. Full check and the existing packed actual running first-target proof remain pending. These injected tests are not a claim that the updated live Ghost seeks have passed; no app or user-live changes have been made.

## Full and packed qualification afteree81a7c

Existing full check PASS158/158 on ee81a7c1b9f42900465d6b923f2efc3829748ac9, including format/types/source policy, decoder and package policy (154 files). Log `/private/tmp/dx38-full-check.log`. Production source is unchanged in this qualification tranche.

The existing packed fixture retains initial/suspended proofs and all native-FLAC/cache/control/assets assertions, and adds the reviewed running mode. That mode first renders actual nonzero PCM and invokes seek while still running. A wrapper around the public pump seam observes the adapter's suspension before producer mutation and establishes64 stale shared slots plus actual old internal backpressure6. It does not suspend, prepare or restore the context itself. At the adapter's automatic resume call, the fixture verifies current full-generation/target PCM with the public observer, records unchanged clocks during the suspended preparation interval, and arms the existing first-output recorder. Thus pre-seek output cannot satisfy the target assertion.

The first authorized Chromium invocation PASS for all three modes. Running seek restores exactly once and resolves running; initial and paused seek modes make zero automatic resume calls and remain suspended. Each case releases64 stale slots, compares the very first rendered stereo target quantum exactly with the public OfflineEngine oracle, and adds zero underruns/refused/torn/errors. Evidence `/private/tmp/dx38-packed-browser.json`, log `/private/tmp/dx38-packed-browser.log`. Syntax/format/diff checks PASS. No new framework, SDK artifact change, or app/live-server edit.

Pause this two-path script/spec tranche for root checkpoint and dedicated final review before immutable archive packaging. Actual updated Ghost live-seek and sustained pause/resume acceptance remains pending after reviewed app adoption; the isolated packed result does not substitute for that user-page gate.

Dedicated review found one timing gap in that fixture: awaiting the host status snapshot before checking target PCM could allow a producer to refill after an incorrectly early automatic resume request. Move the existing full-generation/first-target observer assertion before the resume wrapper's first await; only then read clocks and arm the recorder. This is a one-line relocation in the existing gate, with no production change or assertion relaxation. The corrected existing browser gate passes all three modes on its first invocation, retaining exact first-output,64 stale/internal6, suspended clock invariants and zero added underruns/refused/torn/errors. Evidence `/private/tmp/dx38-packed-browser-boundary.json` and `.log`; syntax/format/diff PASS. The prior158-test full check remains valid for unchanged production source. Pause this exact script/spec correction for root checkpoint before packing the final reviewed archive.
