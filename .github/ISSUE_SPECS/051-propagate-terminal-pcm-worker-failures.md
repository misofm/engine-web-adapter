# Propagate terminal PCM worker failures through open sessions

Base: adapter feature branch after issue50 implementation `20705fdd8fc5d6fb07323dedbdbc72d75b88f101`, with local 0.3.5 release preparation. Exact registry engine 0.2.1 remains unchanged. Root explicitly extends the authorized scalable 64-track hardening to this lifecycle gap before publication. No engine/app source is copied.

## Problem and required behavior

The pump client already terminates a crashed or failed worker, but an open adapter session is not notified. Audio can stop while the app still reports playing. Issue50 adds a bounded playback-read deadline, making a complete terminal propagation path necessary before release. Ordinary console backpressure and semantic command refusals must remain nonterminal.

Add optional `EnginePump.failure: Promise<unknown>`, fulfilled exactly once with the terminal cause after unexpected physical worker termination. It never rejects. Existing custom pumps without the optional capability remain compatible. Explicit close and caller abort do not report an unexpected failure. Preserve pending request rejection, authoritative cause and single termination behavior.

Add optional `EngineWebSessionCommonOptions.onError(error: EngineWebAdapterError)`. A pump failure during open rejects open and performs existing cleanup; it does not duplicate that error through the runtime callback. A failure after open marks the session closed immediately, aborts pending lifecycle work, and performs terminal cleanup once before invoking the callback once with `session.playback` and its retained cause. Explicit close wins if it happens first. Callback exceptions or rejected callback promises cannot reopen the session or create unhandled rejections.

Root wires this callback through the app opener and existing binding/player error path with load-generation and abort guards, including a failure near binding installation. An old session must never fail a replacement session. No package publication until both sides and the exact packed artifact pass review.

## Objective gates

Focused real/client worker tests cover post-initialize error and messageerror, terminal read rejection/truncation/deadline, exactly-once failure, intentional close/abort suppression and late messages. Session tests cover failure during initial prefill, ready/playing/seek failure, synchronous closed state, pending operation settlement, cleanup once, explicit close race and throwing/rejecting observers. Keep all prior control backpressure, seek, EOF, integrity and bounded memory gates.

Run full adapter check and a fresh packed consumer including an actual post-ready pump failure; verify the session closes, releases its worker/resources and emits one public callback. Root app tests prove generation-safe delivery and visible error state. Existing 64-track sustained results remain relevant to unchanged healthy-path scheduling, while the final artifact receives packed fault and healthy-path qualification.

## Status

Spec established and synchronized to GitHub issue 51 before implementation. `PcmPumpWorkerClient.failure` fulfills once after unexpected physical termination and before pending requests reject, so the session owns terminal cleanup even during a pending seek. Ordinary close/abort never fulfill it; observed Worker errors are prevented from leaking as unhandled page errors. Serialized diagnostic error codes are retained on the cause.

The session subscribes before prefill. During opening, failure aborts/rejects open without a duplicate runtime callback. After opening, failure closes immediately, aborts pending lifecycle calls, and invokes `onError` once after cleanup, swallowing observer exceptions/rejected promises. The additive `session.playback` error has a lifecycle phase, a reopen remedy and the original cause. Custom pump wrappers must forward the optional failure promise to provide automatic propagation.

Final 0.3.5 full check PASS: **189/189 tests**, format/types/source policy, decoder and package gates. Log `/tmp/miso-0.3.5-final-check.log`. Focused tests cover post-initialize error/messageerror and error-code retention, one physical termination/notification, intentional close/abort and late messages, ready/playing failure, failure while a seek waits, initial prefill failure, delayed cleanup, close race and throwing/async-rejecting observers. Existing console/backpressure gates pass unchanged.

Fresh packed real-worker fault gate PASS: `/tmp/miso-0.3.5-final-browser.log`. The isolated consumer bundles the installed package's actual pump worker inside a fixture that arms a storage fault only after the session is ready and playing. Rejected storage closes/notifies once in 31.25 ms; an unresolved read triggers the actual 5-second deadline and closes/notifies once in 5046.72 ms; an uncaught worker crash closes/notifies once in 9.39 ms. All three report `session.playback`, close the AudioContext, physically terminate once, and reject later play with `session.closed`. The deadline cause retains `stem.read_deadline`. No console or unhandled errors remain. This fixture changes no package runtime and preserves whole canonical verification before arming faults.

The same packed run preserves all three healthy initial/paused/running exact first-output proofs, synchronous 64-quantum pre-resume inspection, suspended clocks, 64 stale slots retired and zero new underruns/refused/torn/errors. All 11 package assets plus the one bundled fault fixture load.

Final immutable versioned archive `/tmp/miso-adapter-0.3.5-reviewed/misofm-engine-web-adapter-0.3.5.tgz`: 155073 bytes, SHA-256 `404532072d755c32c14c90cadc764da1fae4a0917cf25e637fd080b795b13885`. All 158 payload files independently match the frozen source/build. Adjacent `manifest.json` retains every payload hash and `browser-result.json` retains the packed proof. Root owns app generation-safe error wiring, independent final review, main merge, OIDC publication and registry adoption. No publication is claimed here.

## Adversarial opening-boundary follow-up

Independent Astra xhigh review reproduced an opening hang when the pump fails after prefill while either console session-map request is pending. The shipped host does not deadline that request. The existing final abort check only runs after attachment returns, so cleanup waits for the unrelated map.

Make opening attachment abortable by the session's existing signal. Terminal failure must reject open and release output, pump, feed, host, context and lease without waiting for either map. Any attachment that resolves after cancellation must be closed exactly once; a late rejection must be consumed without replacing the original failure or producing an unhandled rejection. Keep the runtime callback silent for an opening failure. Add regressions for both map awaits, late success/rejection, and the same-turn resolution/abort race. Preserve the earlier reviewed archive and all prior evidence; rebuild and requalify the new exact archive before publication.

Follow-up implemented: attachment is raced against the existing session abort signal; a canceled late attachment is disposed, and already-aborted operations still have rejection handlers. An attachment accepted just before cancellation enters the normal cleanup stack. Both pending-map regressions pass with late success and late rejection, preserving the terminal cause and exactly-once resource cleanup; both same-turn orderings pass. Full SDK check passes **191/191 tests** (`/tmp/miso-0.3.5-attachment-check.log`). Fresh packed healthy/terminal gate passes (`/tmp/miso-0.3.5-attachment-browser.log`, consumer `/tmp/engine-web-adapter-browser-Z0tMiM`): all exact initial/paused/running output proofs and full runways remain green, and reject/deadline/crash each closes/notifies/terminates once without unhandled errors. The original reviewed archive remains retained as superseded evidence. Cold-start render attribution continues separately before publication.
