# Five custom lossless coding design iterations

On 2026-09-12 the requester authorized five rounds of design iteration, with
**Astra xhigh scoping** and **Luna xhigh implementation**. This extends issue
#77's initial server report and supersedes its earlier decision to defer a
custom prototype. The experiments remain research; production format changes
are not authorized. The requester considers exact musical repetition a weak
candidate for microphone recordings, so the work focuses on residual entropy
models and stronger prediction.

Each round gets an Astra scope informed by available measurements, a Luna
implementation, a frozen experiment configuration, and a root verification
checkpoint before its findings inform the next round. Failed hypotheses count
as useful results. There is no promised compression improvement.

The frozen 30-stem corpus, canonical PCM identities, and active interval maps
from [the initial experiment](../README.md) remain the common comparison.
The main reference is libFLAC 1.5.0 `-8 -e` with the published 30-second chunk
boundaries: **425,415,665 bytes**, including per-stem headers and manifests.
An additional 25% reduction would require at most 319,061,748 bytes; a 50%
reduction would require at most 212,707,832 bytes (integer byte ceilings rounded
down). Per-stem and per-session results must accompany release totals.

Predictions stay identical when comparing entropy coders. Predictor changes
get separate comparisons. Every materialized codec candidate must reconstruct
the original canonical PCM exactly, including zero gaps and channel ordering.
All transmitted models, coefficients, indexes, headers, and manifests count.
Model estimates are labeled as estimates, not encoded byte totals or universal
entropy bounds. Cross-stem dictionaries/dependencies, lossy changes, silence
thresholds, production runtime edits, and engine/app source copying are excluded.

Scratch PCM, codec binaries, and generated encoded blobs live outside the
repository under `/data/issue-77-lossless/iterations/`; only reviewed code,
scopes, reproducible metadata, and measurement receipts are checkpointed here.
Existing initial-run scripts and evidence remain immutable. Server-only timing
and native memory evidence do not stand in for mobile/browser measurements.

| Round | Astra scope | Luna implementation and measurement | Verification |
| --- | --- | --- | --- |
| 1 | [Exact residual accounting](round-01-scope.md) | [Complete report](round-01-report.md): context model estimates 0.617% lower delivery bytes | All 30 reconstructions and exact accounting pass; optimized/sanitizer suites and four-stem sanitizer pilot pass |
| 2 | [Actual Rice vs context-rANS artifacts](round-02-scope.md) | [Complete report](round-02-report.md): 423,304,009 bytes, 0.496% below tuned FLAC | All 60 files, PCM/transcripts/accounting and 10,204 tables independently verified; optimized/sanitizer tests and pilot pass |
| 3 | [Adaptive residual FIR prediction](round-03-scope.md) | [Complete report](round-03-report.md): 421,773,671 bytes, 0.856% below tuned FLAC; 3.5x disabled decode time | All 40 pilot, 8 sanitizer and 120 full artifacts independently verified; integer and malformed-stream gates pass |
| 4 | [Offline stereo residual prediction](round-04-scope.md) | [Complete report](round-04-report.md): 423,034,938 bytes, 0.560% below tuned FLAC; 2.309 s pilot decode versus 2.287 s disabled | All 24 pilot, 8 sanitizer and 120 full artifacts independently verified; spatial reference and malformed-stream gates pass |
| 5 | [Selective temporal and spatial prediction](round-05-scope.md) | [Complete report](round-05-report.md): 420,447,085 bytes, 1.168% below tuned FLAC; 48.621 s full-corpus decode, or 38.132 s for 165,039 more bytes | All 16 sanitizer, 24 pilot and 180 full artifacts independently verified; integer/malformed-stream gates and all 540 controlled timing decodes pass |

The smallest actual artifact set after these five designs is round 5 policy 1
with rANS: **420,447,085 bytes**, including all delivery metadata. It saves
4,968,580 bytes (1.168%) versus tuned FLAC, 2,259,409 bytes (0.535%) versus the
strongest retained WavPack result, and 13,864,671 bytes (3.192%) versus the
published delivery. Every stem improves versus tuned FLAC and the earlier
temporal-only predictor; ten stems remain larger than WavPack individually.

Round 5 policy 2 requires more than 32 bytes of complete Rice-frame savings
before enabling temporal prediction. It delivers **420,612,124 bytes**, only
165,039 bytes more than policy 1, while retaining 93.62% of its saving over
the spatial/off control. It avoids 31.84% of policy 1's temporal residual work.
Work counts and measured decode time are separate evidence; the final round
report records the controlled full-corpus timing comparison.

Three serial full-corpus trials use warm compressed inputs, fresh active PCM
output files, and disabled audit serialization. Hash verification follows each
timed decode; process startup and PCM writes are included. These measurements
exclude network, browser/OPFS, fsync and verified publication, and therefore
have a different boundary from the initial preparation benchmark.

| Candidate | Complete delivery bytes | Median decode and write, all 30 stems |
| --- | ---: | ---: |
| Tuned FLAC, current 30-second chunks | 425,415,665 | 5.777 s |
| WavPack `-hh -x6`, concatenated active regions | 422,706,494 | 11.281 s |
| Round 3 temporal rANS | 421,773,671 | 55.213 s |
| Round 5 spatial/off rANS | 423,034,938 | 15.892 s |
| Round 5 policy 1 rANS | 420,447,085 | 48.621 s |
| Round 5 policy 2 rANS | 420,612,124 | 38.132 s |

Policy 2 reduces measured decode time by 21.57% versus policy 1, but still
takes 6.60 times the tuned FLAC time on this server. Native decoder peak RSS
is 2,816 KiB for FLAC, 2,048 KiB for WavPack, and 4,864 KiB for the custom
candidates; these are child-process measurements, not end-to-end host memory.

None of the tested approaches approaches the additional 25–50% saving under
discussion. The best result remains 101,385,337 bytes above the integer
25%-below-FLAC target. This is evidence about these tested model families on
30 stems from four recordings, not a universal compression bound or an
independent validation corpus. Round-local gains use different controls and
must not be added together.

The five-round research continuation is complete. The evidence supports
separately scoping the existing FLAC encoder tuning and retaining the current
delivery format. Further production work on this custom family is a no-go on
the present corpus: its small incremental size benefit does not justify the
measured decode cost and an additional browser codec. A different hypothesis
or a substantially different corpus could justify new research. Mobile and
separated-stem measurements remain deferred; no production format, package
asset, engine/app source, or runtime behavior changed.
