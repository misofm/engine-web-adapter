# Issue 99: Fund one third warm-verification worker

## 1. Status, workflow and fixed starting points

2026-09-13 — design only; implementation, review, memory qualification and timing qualification are pending. User-directed sequence: Astra medium design → Luna xhigh implementation → fresh Astra medium review → Root memory-first benchmark. This explicit sequence supersedes the generic role defaults in AGENTS.md. Root synchronizes this complete body to GitHub issue 99 before implementation. No release or adoption approval is implied.

Worktrees, both on `perf/warm-three-workers`:

- Adapter `/tmp/miso-three-worker-adapter`, released base `e4593d2d423df7093168a6e02c0aab078ec2a55c`, package 0.5.3.
- App `/tmp/miso-three-worker-app`, base `3709fa32beb46607f07a87d16c2898dde24206e6`.
- Sole benchmark control: registry adapter 0.5.3 at that app revision, `/tmp/miso-worker-adoption-app`, preview 4204. Verify every entry of `/tmp/miso-load-research/worker-shipped-control-dist-manifest.json` (218 files); manifest SHA-256 `c3a83dd9ebca975a6508bf4cf1555a71e9fc5f459f5e0e22007a6ea0e4c47956`.

Decision source: `/tmp/miso-load-research/post-timeline-selection.md`; supporting `/tmp/miso-load-research/worker-timeline-control-v1-report.md` and `post-sync-selection.md`. The three control traces show read/hash occupying 95.0–96.0% of summed worker service, reused handoff gaps 0.23–1.97 ms and first-job composite overhead 13.7–18.0 ms. These support testing additional overlap, not a speedup claim or proof of spare I/O/CPU capacity. Instrumented diagnostic ready times do not replace matched control measurements. Issue 98's FileReaderSync candidate remains rejected.

## 2. Exact runtime delta and reservation contract

Only two production expressions/comments need change:

1. Adapter `src/stems/sparse-resolver.ts`, private `fundedWarmWidth`: change `Math.min(2, concurrency, funded)` to cap 3. Preserve all existing snapshot, safe-integer, admission and eligibility checks. Do not add public configuration.
2. App `src/lib/mixer/engine/open-session.ts`: change warm allowance from `+ 4 * 1024 * 1024` to `+ 6 * 1024 * 1024`, retaining `concurrency * 8 * 1024 * 1024`, `maximumWorkers: concurrency` and all other options. Update associated comments and expectations.

Let B be validated memory budget and C the unchanged derived source/cold concurrency. Eligible warm width is `K = min(3, C, floor(max(0, B - C * 8 MiB) / (2 MiB)))`. Zero funded width keeps local verification. Always reserve `C * 8 MiB + K * 2 MiB <= B`, including while completed cold workers remain retained and idle. Existing 4 MiB warm headroom still funds at most two lanes; 2 MiB funds one. Hardware/maximum caps and source traversal width are unchanged. At app preference 8 configured reservation rises 68 → 70 MiB; this is an allocation policy, not measured physical memory.

For integer requested n, both `floor((8n+4)/8)` and `floor((8n+6)/8)` equal n. Check actual derived widths for preferences 4/8/12/16, low widths 1/2 and a hardware-capped case. Do not infer source width from the preference alone.

Each lane retains the qualified 2 MiB reservation: current payload result 512 KiB, zero scratch 64 KiB, transferred packed metadata at most 256 KiB, pinned BLAKE3 linear memory 128 KiB, fixed hash/protocol/control allowance 64 KiB, remaining 1024 KiB reservation headroom. Verify the pinned hash-wasm 4.12.0 asset still uses the qualified 128 KiB memory; if disproved, stop for design reassessment. Aggregate current payload cap becomes 1.5 MiB and packed metadata cap 768 KiB. No queued payload/packed-copy allocation, read-ahead or additional scratch. Fresh hasher instances can await GC; code, JS/runtime heaps, Blob backing/serialization, browser/native/OPFS resources and delayed reclamation are not bounded by calling this a 2 MiB physical increment.

## 3. Preserved behavior and exclusions

Keep async `blob.slice(...).arrayBuffer()`, 512 KiB interval-local reads, per-result `finally` disposal through qualified `ArrayBuffer.transfer(0)`, full canonical BLAKE3 including silence, independent digest/count validation, original admitted Blob/index descriptor identity, 64 KiB zero checkpoints, fresh per-job hash state and FIFO source policy. Preserve the 10922-interval packed eligibility ceiling, no duplicate payload/metadata open, one outstanding progress plus latest scalar per lane, matching ACKs, generation checks and typed failure mapping.

Keep the existing read deadline and parent no-progress watchdog unchanged. Cancellation invalidates generation, detaches listeners/timers and terminates before settlement/source-lock release; teardown precedes exclusive claim release and aggregate ready. Failed physical termination must still block readiness/reservation reuse. Prior completed sibling source-ready facts need not be erased; no failed/cancelled source-ready or aggregate ready is permitted. Retain fallback for missing capabilities, no funded headroom, overlapping preparation, custom worker/assets, caller-owned admission, wrapped resolver and oversized metadata. A dispatched worker fault does not silently fall back.

No worker/protocol/pool/store runtime redesign, FileReaderSync, source ordering, chunk size, backend/cache, persistent workers, engine/audio/codec/FLAC/pump, format, hashing, readiness, dependencies or release metadata change. Compare packaged worker/protocol runtime with released 0.5.3; require byte identity where directly comparable and explain any build-only difference with provenance. A runtime difference outside the two policy expressions requires reassessment, not an expanded experiment.

## 4. Focused implementation checks

Reuse existing qualified fixtures and assertions; do not recreate a hash correctness suite or multiply unchanged fault cases across widths. New tests should establish only the new cap/funding and third-lane ownership implications.

1. Extend existing policy cases in `tests/sparse-resolver.test.ts`. At fixed C >= 3, cover warm headroom 0/2/4/6/8 MiB with expected K 0/1/2/3/3, plus one-byte-below-6-MiB boundary. Assert C unchanged, reservation inequality and claim exclusion/release. Extend the existing saved-preference loop to compare old +4 and candidate +6 allowances, include 12 and hardware limiting, and retain existing low-width/custom/shared/wrapped/capability/invalid-hint cases. Use existing tests for unchanged metadata and scalar boundaries.
2. Update app `src/lib/mixer/engine/open-session.test.ts` budget assertions to 70 MiB at preference 8 and +6 MiB throughout the existing preference table. Verify `maximumWorkers` and remaining resolver options stay unchanged. No UI or translation change.
3. Extend the compact native mixed fixture in `tests/sparse-resolver.test.ts` to C=4, B=38 MiB, K=3. Hold one cold job while three warm jobs are simultaneously active; then complete and retain that cold worker idle while a fourth warm source is admitted/queued and subsequently runs. Use distinct identities and controlled barriers, not sleeps. Observe active source tasks <=4, warm live/peak <=3 with peak exactly 3, cold retained/physical workers <=4, and `4*8 + 3*2 = 38 MiB` reserved throughout. Preserve overlapping-preparation local fallback and claim reuse after complete teardown. Existing width-two tests remain coverage for lower headroom; they must not all be rewritten to three.
4. Add one compact three-lane lifecycle fixture using existing worker/store seams: all three slots active plus one queued warm source, then cancellation; and a failure variant after an earlier sibling completes and its slot is reused. Across those small variants, hold a read, deliver a stale completion after teardown, trigger the existing deadline/terminal-observer abort paths, and retry successfully with fresh generations/canonical results. Assert all three slots terminate, queued job never becomes ready, every cleanup is attempted, no failed aggregate readiness, claim/lock release ordering and no listener/timer/reference growth. Reuse qualified width-one tests for unchanged startup/ACK/short-read/transport/exhaustion/failed-terminate internals; do not create a Cartesian fault matrix. If existing terminal-observer/deadline tests already prove unchanged paths, run them and add only third-slot teardown assertions needed here.
5. Retain independent active/silent/mixed/tamper/boundary/tail count/digest and buffer-detachment oracles in `tests/sparse-verify-worker.test.ts` and `tests/sparse-store.test.ts`. Do not derive expected results from candidate counters or detached lengths.

## 5. Delivery, review and responsiveness

Run adapter `npm run check`, packed fresh-consumer delivery (`npm run test:browser`, including the indexed-sparse lane), and actual OPFS Chromium/WebKit qualification. App requires `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`. Respect any applicable React-doctor finishing requirement; no unrelated remediation is authorized.

Existing packed indexed fixture has only two sources and cannot establish three workers merely by changing a count assertion. Add one small three-distinct-warm-source success/close/reopen scenario in the existing consumer/browser harness, fund three lanes and observe actual native worker URLs, completions and teardown. Use actual OPFS-backed descriptors in Chromium and WebKit; reuse existing fixture bytes with independently valid expectations. Keep earlier two-source/tail/disposal proofs. A source-tree worker, memory backend, mocked third worker or fallback does not satisfy this gate. Reuse this scenario for delivery/OPFS evidence where possible rather than duplicating infrastructure. Capability fallback may be correct but must be reported as missing third-lane qualification on that target.

Retain external abort-to-rejection <=100 ms for CPU and withheld reads, existing watchdog settlement allowances, synthetic main heartbeat lateness <=50 ms, and no new verifier-attributable main task >50 ms. Exercise the third slot in compact synthetic fairness/cancellation checks; reuse qualified width-one/eight coverage for unchanged behavior. Run one separate Ghost responsiveness pair using the existing 10 ms heartbeat/long-task/committed-progress observers: candidate heartbeat p95 increase <=10 ms, no new verifier main task >50 ms, maximum committed-progress gap <=250 ms while bytes advance. Progress transport stays bounded per lane. DOM/rAF evidence is not painted pixels; automated WebKit does not establish physical Safari/iPad performance.

Fresh Astra medium reviews the actual diff, tests, resource ordering, arithmetic, packaged identity and evidence before Root benchmarks. Record missing browser/physical-device evidence honestly. Complete cheap correctness, packed delivery and review before measurement; memory failure stops timing and any remaining expensive qualification. All required qualification must pass before acceptance.

## 6. Frozen measurement protocol

Freeze adapter/app source revisions and dirty patches, package tarball/dist manifests, engine 0.2.4/codec 0.1.1 assets, app build, harness/analyzer/config hashes, browser version and device. Candidate includes both cap 3 and +6 MiB funding. Never substitute an equal-headroom control or an instrumented diagnostic baseline. Keep authenticated Ghost preference 8, exact source order, same browser/cache, fresh navigation via `about:blank`, cold fill and one unmeasured warm prime per arm. All worker startup occurs inside each measured load. No runtime instrumentation or worker prewarming.

Use separate memory and timing blocks. Retain every row, errors and incomplete samples. Any invalid measurement is a qualification failure/missing evidence, not license to replace unfavorable rows or extend the fixed block. External runner may retain only bounded scalar complete-message fields (eight source completions/load) identically in both arms to establish zeroUpdates/digest/count gates omitted by the public report. Forward native Worker constructor/postMessage/transfer/terminate and listener behavior unchanged; retain no Blob/buffer/view/event or payload-bearing closure, add no await/ACK/read, and freeze this observer before runs. Do not include the earlier full timeline observer in timing.

Every warm measured load must show eight distinct expected source identities and full matching digests, zero warm stem network requests, exactly 845 reads, 249323400 active/read bytes, 297980304 canonical/hashed bytes and 1010 zero updates; exactly 2 actual control verification workers and 3 actual candidate workers with teardown, unchanged C, no page/result/protocol errors. Fallback never counts as candidate three-lane evidence.

### 6.1 Memory first — exactly three pairs

A=shipped control; B=candidate. Order AB/BA/AB using the existing combined main-plus-attributable-dedicated-worker collector. Sample all three candidate workers, report main/worker contributions separately and combined per-load peak, before/peak/teardown/matched-reopen state, worker counts and incomplete-sample coverage. No forced GC during a measured load; preserve the established before-navigation main GC protocol. Termination calls alone are not physical reclamation proof. Disclose native/browser/OPFS exclusions and missed-peak limitations.

Pass only if `median(candidate combined peaks) - median(control combined peaks) <= 8388608 bytes`, with complete attribution, no unexplained retained growth, failed cleanup or rising worker count on reopen. The explicitly allocated +2 MiB is already inside this unchanged rejection ceiling, never added to it. Main-only samples cannot pass; historical control memory is not a substitute for matched control rows. Memory failure/missing coverage stops timing.

### 6.2 Timing second — exactly five pairs

Only after memory passes, run timing-only AB/BA/AB/BA/AB. Define each paired saving `d_i = controlReady_i - candidateReady_i`; faster means `d_i > 0`. Define `MAD = median(abs(d_i - median(d)))`. Pass only when at least 4 of 5 pairs are faster and `median(d) > max(10 ms, 0.01 * median(controlReady), 2 * MAD)`. Retain independent arm medians separately from paired saving; use end-to-end ready, not sum of phase medians or worker service. No added pairs, width sweep, reader/source-order rescue, outlier removal or rebaseline. Report actual improvement and remaining gap to 1000 ms without claiming a target that was not reached.

## 7. Required handoff evidence and stop rule

Implementation handoff records changed files, focused check output, package identity comparison and all remaining blockers. Fresh review records pass/fail with concrete findings. Root records frozen manifests, raw memory/timing/responsiveness/browser rows and gate summaries in `/tmp/miso-load-research/three-worker-*`; mirror final outcome here and in issue 99. Design companion is `/tmp/miso-load-research/three-worker-plan.md`.

If correctness, attribution, memory, timing or responsiveness fails, archive this one candidate against shipped 0.5.3. No automatic fourth lane, combined experiment, release or adoption. Reassess separately rather than weakening a gate.

## 8. Measured candidate results (2026-09-13)

The frozen private cap3/+6 MiB candidate passed the planned three memory pairs and five timing pairs on Chromium 145.0.7632.6 with Ghost, preference8 and reported hardwareConcurrency32. Median sampled combined main/dedicated-worker peak increased from31,129,461 to34,092,988 bytes (+2,963,527, below8MiB). All expected targets were observed, verifier targets disappeared after ready, and an explicit retention review passed; five incomplete target-transition samples remain recorded as unknown. This is not total browser RSS.

All five timing pairs were faster: control/candidate medians1411.5/1054.1ms; median paired saving358.9ms exceeds the78.4ms fixed noise gate. Every warm row retained complete canonical identities/digests/counts and zero stem network requests. No timing extension was run. The candidate remains above the subsecond target. Separate Ghost responsiveness passed: heartbeatp95 5.835→2.505ms, no verification-window long tasks, maximum candidate committed-progress observation gap18.245ms.

Evidence: `/tmp/miso-load-research/three-worker-memory-{results,summary,decision}.json`, `three-worker-pairs-{results,summary}.json`, `three-worker-responsiveness-{results,summary}.json`, and independent `three-worker-fresh-review.md`. Frozen runtime/config/harness provenance is `three-worker-final-benchmark-inputs-v2.json`. Third-slot synthetic cancellation/fairness and actual three-worker WebKit qualification remain release gates; no release/adoption is approved yet.
