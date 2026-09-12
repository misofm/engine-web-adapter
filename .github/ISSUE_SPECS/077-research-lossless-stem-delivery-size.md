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

Status: round 1 scoping started; rounds 2–5 pending evidence from preceding rounds. Root verifies coherent research checkpoints and owns issue/PR synchronization. The explicit requested model assignments take precedence over the guide's generic launch-work Sol assignments; this remains server research, not release qualification.
