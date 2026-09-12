## Problem

Determine whether the current per-stem indexed FLAC delivery format is the best practical lossless choice for minimizing session download size and time to verified sparse PCM on mobile.

The complete session must be downloaded and prepared before use. Playback reads sparse PCM and synthesizes omitted zeros; it does not decode FLAC in realtime. Retain one independently published blob per stem so adding a stem never requires repackaging existing stems.

The Between the Doors publication receipts provide this baseline across 30 stems:

| Measurement | Bytes |
| --- | ---: |
| Original full-length FLAC | 431,666,252 |
| Published indexed sparse blobs | 434,311,756 |
| FLAC payload within indexed blobs | 434,233,060 |
| Manifest JSON | 78,216 |
| PCM zeros omitted from the cache | 336,328,926 |

Thus the current packaging saves substantial PCM cache space but increases delivered bytes by about 0.61% for this release. Do not confuse omitted PCM bytes with compressed download savings. The current release uses submixed stems; a forthcoming, more separated stem set may contain substantially more silence.

## Research questions

- How much overhead comes from independent chunks, codec settings, and region boundaries?
- Does an established alternative outperform tuned FLAC enough to justify another browser decoder?
- Does custom residual entropy coding offer meaningful additional savings after accounting for all metadata and decoder cost?

FLAC already implements fixed/LPC prediction, partitioned Rice residual coding, wasted-bit removal, and stereo decorrelation. Reimplementing LPC + Rice is not itself a new compression opportunity. ANS or different residual probability models are hypotheses to test, not assumed improvements.

## Bounded experiment

Use the same exact PCM and active interval map for every sparse candidate. Include the existing 30-stem release, plus the separated stem set when available; its absence must not block an initial report. Freeze and record source identities, codec versions, settings, and chunk policy before measurement.

1. Compare full-length FLAC, current sparse FLAC, tuned sparse FLAC, larger independent chunks, and one FLAC stream containing concatenated active regions with an interval map.
2. Compare an established alternative such as WavPack in strictly lossless modes, including its extra encoder-search settings.
3. If justified by the first comparisons, build one bounded custom residual-coding prototype. Hold prediction constant when comparing Rice and ANS so the entropy-coding benefit can be measured independently. Include model tables, predictor coefficients, headers, indexes, and manifests in byte totals. Record predictor changes as a separate comparison.

Wasted-bit or bit-depth optimizations must be exactly reversible. No threshold-based removal of nonzero samples, lossy quantization, or changes to canonical PCM identities.

For promising candidates, measure representative mobile-browser installation: downloaded bytes, download time separately from decode/cache-write time, total time to verified sparse PCM, decoder download size, and peak memory. Record device, browser, network conditions, cold/warm state, and worker concurrency. Native command-line timings are screening evidence, not mobile-browser results. Report encoding time separately; offline encoding may spend more compute when it improves delivery.

## Deliverable and completion criteria

- A reproducible comparison with per-stem and session totals, exact settings, and portable fixture references; preserve the publication baseline rather than depending only on machine-local receipts.
- Exact reconstructed PCM hashes for every tested candidate, including omitted regions and channel ordering.
- A recommendation explaining the measured byte savings and mobile installation tradeoffs. Distinguish measured results from hypotheses and untested candidates.
- A go/no-go decision on further custom-codec work. If none provides a worthwhile practical improvement, close with that finding.

This is a research issue, not authorization to replace the production format. Any selected implementation gets a separately scoped issue with explicit acceptance targets. No engine DSP/PCM-interface changes, application UI redesign, offline-shell work, cross-stem bundling, or new generic benchmark framework. Packaging changes in misofm/cli are follow-ups if a candidate is selected.

## References

- [FLAC specification, RFC 9639](https://www.rfc-editor.org/rfc/rfc9639.html)
- [WavPack encoder options and asymmetric extra processing](https://www.wavpack.com/wavpack_doc.html)
- [Release manifest with the published indexed stem IDs](https://github.com/misofm/releases/blob/aab52d1/gatewaygirl-between-the-doors/release.json)

Existing local baseline receipt: `/data/sparse-pcm-launch/publication-per-stem-20260911/receipt.json`.

## Server experiment checkpoint (2026-09-12)

Requester explicitly deferred mobile measurements and asked for server benchmarking in this pass. This research checkpoint is complete for that scope; no production format, decoder, engine/app source, package asset, or CLI behavior changed. The separated stem set was not supplied and did not block the initial report.

Repository deliverable: `research/077-lossless-delivery/REPORT.md`, with reproduction instructions, exact source identities and all 30 published interval maps, pinned release/source-archive provenance, 420 per-stem candidate rows, all four session totals, raw measurement receipts, and integrity hashes. Original and published public blob retrieval was spot-checked with curl; the complete local corpus passed byte-count/SHA-256 verification. The frozen server run uses FFmpeg 6.1.1, libFLAC 1.5.0, WavPack 5.9.0, and an AMD EPYC 7313P.

| Result across 30 stems | Delivered bytes | Finding |
| --- | ---: | --- |
| Published indexed FLAC | 434,311,756 | All 30 blobs reproduced byte-for-byte |
| libFLAC `-8 -e`, current 30-second chunks | 425,415,665 | Saves 8,896,091 bytes / 2.0483% |
| libFLAC `-8 -e`, one active stream per stem | 425,390,054 | Only 25,611 bytes more saved; 25,451 from manifest shrinkage |
| WavPack `-hh -x6`, one active stream per stem | 422,706,494 | 0.6308% smaller than concatenated tuned FLAC |

Every one of the 420 candidate/stem comparisons reconstructs the exact original full canonical PCM SHA-256, including omitted zeros and channel ordering. All 450 additional native preparation runs also pass. Three serial release trials measure median preparation of 6.961 s published, 7.158 s tuned FLAC/current chunks, 6.855 s concatenated tuned FLAC, and 12.325 s WavPack `-hh -x6`. Timings include native decode, full canonical hashing, sparse cache writes, fsync and verified rename; inputs have warm page cache. These are server filesystem measurements, not browser/OPFS or network timings. Native decoder process peak RSS is reported separately from unmeasured end-to-end/browser memory. Offline encoding time is reported separately.

Recommendation: separately scope libFLAC encoder tuning while retaining the current chunk policy. No recommendation to add a WavPack browser decoder on this evidence. Custom residual-codec implementation is **no-go for now**; no ANS prototype or fixed-predictor entropy comparison was justified or measured, and no custom-codec savings are claimed. Revisit with the separated corpus or a concrete, promising residual-model hypothesis.

Validation: eight adversarial experiment-gate tests pass (nonzero omissions including single LSB, stereo order, signed extrema, truncation/trailing bytes, interval/chunk corruption, bounded copying and baseline accounting); all actual codec round trips and repeated preparation checks pass; repository format and whitespace checks pass. Package/browser release gates are not claimed: this is an isolated research artifact, not a release candidate. Real mobile/network/OPFS measurements and WavPack browser decoder download/peak-memory cost remain deferred. Any production implementation requires a separate issue with acceptance targets.

## Authorized five-round continuation (2026-09-12)

The requester now explicitly authorizes five design/measurement iterations on custom lossless compression, with **Astra xhigh scoping and Luna xhigh implementation**. This supersedes the initial report's decision to defer custom prototyping. Exact repeated passages are deprioritized for the microphone-recorded corpus; the two primary questions are remaining entropy-coding opportunity with predictions held fixed, and separately stronger prediction. The 25–50% additional saving discussed is a hypothesis to investigate, not an acceptance result or promised gain.

Track each sequential round, its frozen design, implementation, results, and verification in `research/077-lossless-delivery/iterations/README.md`. All five rounds must be completed and the next design must use prior findings. Preserve the original 30-stem PCM identities, maps and publication evidence; count model/table/predictor/index/container costs; exactly verify every materialized codec candidate. Distinguish model estimates from actual encoded savings and model-specific bounds from universal limits. Keep per-stem/session totals and separately reported encoding/preparation timing. Mobile measurements remain deferred. Production replacement, cross-stem dependencies, lossy PCM changes and engine/app source copying remain out of scope.

Status: all five rounds are complete, including independent artifact audits and final controlled server timing. Round 1 independently reconstructs all 30 stems and reconciles all 39,562 FLAC frames to the 425,415,665-byte control. Its per-stem context quotient model estimates a 0.617% complete-delivery reduction, with tables/state/padding charged; this is an estimate, not a compressed artifact. Rice remainders occupy 80.633% of delivery, motivating later prediction experiments. Optimized/sanitizer synthetic gates, a four-stem sanitizer pilot, and independent root hash/accounting/corruption audits pass. See `research/077-lossless-delivery/iterations/round-01-report.md`. Round 2 materializes matched Rice and context-rANS files over identical residuals: Rice totals 426,056,035 bytes and rANS 423,304,009 bytes. rANS saves 0.496% against tuned FLAC and 0.646% against matched Rice, but remains 597,515 bytes larger than the strongest retained WavPack result. All 60 files pass exact PCM, logical transcript and accounting checks; root independently verifies the artifacts and all 10,204 transmitted context tables. Optimized and sanitizer fixture suites and the eight-file sanitizer pilot pass. Serial server decode timing is reported separately from verification and remains screening evidence. See `research/077-lossless-delivery/iterations/round-02-report.md`. Round 3 tests four bounded adaptive FIR configurations on residuals, with an identically retuned Rice control and frozen pilot selection before full-corpus measurement. Root verifies coherent research checkpoints and owns issue/PR synchronization. The explicit requested model assignments take precedence over the guide's generic launch-work Sol assignments; this remains server research, not release qualification.

Round 3 selects the M=32/b=3 adaptive residual predictor from four enabled configurations. Complete rANS delivery is 421,773,671 bytes: 0.856% below tuned FLAC, 1,530,338 bytes below round 2, and 932,823 bytes below the strongest retained WavPack result. It improves 26 stems but enlarges four relative to its identically retuned disabled control. All 40 pilot, 8 winning-profile sanitizer, and 120 full artifacts pass independent PCM, component and transcript checks, including original-residual audit hashes projected directly from the frozen round-1 records. Independent integer reference and malformed-stream tests pass optimized and ASan/UBSan. Three serial pilot decode trials give medians 7.835 s for FIR rANS versus 2.240 s disabled and 2.242 s round-2 rANS: about 3.5 times the native decode cost. See `research/077-lossless-delivery/iterations/round-03-report.md`. Round 4 tests an offline-fitted one/five-tap stereo residual predictor with charged coefficients, matched entropy controls, and an explicit per-frame off choice.

Round 4 selects the five-tap offline stereo residual predictor, with a per-frame off choice and all transmitted coefficients charged. Its rANS delivery totals 423,034,938 bytes (0.560% below tuned FLAC), saving 361,626 bytes versus its disabled control but remaining 1,261,267 bytes larger than round 3. Stereo is selected in 6,390 of 39,562 frames and adds 63,900 coefficient bytes; no stem grows versus the disabled rANS control. Independent audits pass all 24 pilot, 8 sanitizer, and 120 final full artifacts, including 79,124 actual Rice frame-cost comparisons. Optimized and sanitizer spatial-reference and malformed-stream gates pass before the final full run. Three controlled serial pilot trials give medians 2.309 s for spatial rANS, 2.287 s disabled, and 7.830 s for the prior temporal predictor. See `research/077-lossless-delivery/iterations/round-04-report.md`. Round 5 measures three fixed policies: spatial/off alone, or adding pure/stacked temporal prediction when its charged Rice-frame saving exceeds 0 or 32 bytes. It concludes with three serial full-corpus decode trials against the retained FLAC, WavPack and prior temporal references.

Round 5 combines the frozen temporal and spatial predictors with two fixed Rice-frame saving thresholds. The smaller policy-1 rANS artifacts total 420,447,085 bytes: 1.168% below tuned FLAC, 0.535% below the strongest retained WavPack result, and 3.192% below published delivery. All 30 stems improve versus tuned FLAC and the earlier temporal-only design; ten remain larger than WavPack individually, while all four complete sessions improve. Policy 2 requires more than 32 bytes of frame savings and totals 420,612,124 bytes. It retains 93.62% of policy 1's gain over the spatial/off control while avoiding 31.84% of its temporal residual work; work counts do not substitute for measured speed. Independent audits pass all 16 sanitizer, 24 optimized pilot, and 180 full artifacts, including 237,372 full frame/plan checks. Optimized and ASan/UBSan combined integer-reference and malformed-stream gates pass. See `research/077-lossless-delivery/iterations/round-05-report.md`.

Final controlled timing uses three serial full-corpus trials with warm compressed inputs and fresh active PCM output files. Native decode, process startup and PCM writes are timed; audit serialization, input warming and subsequent PCM/chunk/canonical verification are outside the interval. Median times are 5.777 s tuned FLAC, 11.281 s WavPack, 55.213 s round-3 temporal rANS, 15.892 s round-5 spatial/off rANS, 48.621 s round-5 policy 1 rANS, and 38.132 s policy 2 rANS. Policy 2 is 21.57% faster than policy 1 but still takes 6.60 times the tuned FLAC time. All 540 timed stem decodes pass exact PCM verification in the harness; root independently verifies 360 custom summaries, 861 native child timing/diagnostic receipts, and 428 unique frozen dependency/artifact files. These timings exclude network, browser/OPFS, fsync and verified publication; they are distinct from the initial full preparation timings. Native child peak RSS is 2,816 KiB for FLAC, 2,048 KiB for WavPack, and 4,864 KiB for the custom candidates; end-to-end host/browser memory remains unmeasured.

Five-round decision: none of the tested designs approaches an additional 25–50% saving. The best materialized result saves 1.168% versus tuned FLAC and 0.535% versus WavPack, at substantial native decode cost. This is evidence about the tested models and four-recording corpus, not a universal entropy bound or an independent validation set. Further production work on this custom family is no-go on the present evidence. Separately scope the existing FLAC encoder tuning while retaining the current chunk policy. Mobile/separated-stem evaluation and any production format or decoder change remain separate follow-ups. The authorized server research is complete; no production code, package assets, engine/app source, or delivery policy changed.
