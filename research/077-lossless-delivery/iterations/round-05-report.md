# Round 5: thresholded temporal and spatial residual correction

Round 5 measured three fixed policies on the frozen round-1 residual records.
Policy 0 keeps the final round-4 spatial/off path. Policy 1 enables the frozen
round-3 P3 temporal FIR when its complete Rice frame is strictly smaller than
the cheap candidate. Policy 2 uses the same candidate set but requires a gain
greater than 32 bytes. Rice frame costs choose the path shared by Rice and
rANS; no rANS-specific search or post-selection was added.

The implementation is [round5.py](round-05/round5.py) and
[native/round5.c](round-05/native/round5.c). The exact fresh-work commands,
compiler settings, gate receipts and provenance checks are in
[REPRODUCTION.md](round-05/REPRODUCTION.md). Audio, PCM, compressed files,
transcripts, helpers and timing trial directories remain under
`/data/issue-77-lossless/iterations/round-05/`.

## Gates and measured corpus

The optimized and ASan/UBSan native gates passed the expanded malformed-stream
and integer/reference suites. The sanitized pilot covered policies 1 and 2,
both coders and the four selected stems: 16 files and 23,736 independent
frame/plan checks passed with leak detection and UBSan halting enabled. The
optimized pilot covered all three policies and both coders on 24 files; the
full run covered 30 stems, 180 files and 237,372 independent frame/plan
checks. Each artifact passed strict header, table, EOF, byte accounting,
original/coded transcript, chunk digest, active PCM and canonical PCM checks.
Root reused the immutable round-3 original-audit projection created directly
from the frozen round-1 RSD records, so the encoder and decoder could not agree
on a changed source.

The four pilot stems are a selected subset of the 30-stem corpus. The other 26
stems are additional coverage from the same four recordings, not independent
held-out microphone evidence.

## Complete delivery bytes

The final 30-stem results are in
[`round-05-evidence/full-results.json`](round-05-evidence/full-results.json),
with per-stem and per-session rows in
[`full-per-stem.csv`](round-05-evidence/full-per-stem.csv) and
[`full-per-session.csv`](round-05-evidence/full-per-session.csv).

| Candidate | Rice bytes | rANS bytes |
| --- | ---: | ---: |
| Policy 0, cheap spatial/off | 425,760,621 | 423,034,938 |
| Policy 1, FIR gain > 0 | 422,898,446 | **420,447,085** |
| Policy 2, FIR gain > 32 | 423,070,004 | 420,612,124 |

Policy 1 rANS saves 4,968,580 bytes (1.167935%) against tuned libFLAC
`-8 -e` at 425,415,665 bytes, 2,259,409 bytes (0.534510%) against the
422,706,494-byte WavPack `-hh -x6` concatenation, and 13,864,671 bytes
(3.192332%) against the published 434,311,756-byte package. Policy 2 saves
4,803,541 bytes (1.129141%), 2,094,370 bytes (0.495467%), and 13,699,632
bytes (3.154331%) against those same controls. Policy 0 is the round-4
selected spatial/off control and saves 2,380,727 bytes (0.559624%) against
tuned FLAC.

Policy 1 is 1,326,586 bytes below the final round-3 P3 rANS result of
421,773,671 bytes and 2,856,924 bytes below the final round-2 context-rANS
result of 423,304,009 bytes. These differences combine the round-specific
framing, spatial selection, FIR selection and model-table changes; they are
not additive savings that can be assigned independently to each round.

The selected four-stem slice and the remaining 26 stems were:

| Corpus slice | Tuned FLAC | Policy 0 rANS | Policy 1 rANS | Policy 2 rANS |
| --- | ---: | ---: | ---: | ---: |
| Selected, 4 stems | 65,633,773 | 65,283,171 | 64,894,966 | 64,917,457 |
| Remaining, 26 stems | 359,781,892 | 357,751,767 | 355,552,119 | 355,694,667 |
| Full, 30 stems | 425,415,665 | 423,034,938 | **420,447,085** | 420,612,124 |

Policy 1 is smaller than tuned FLAC and the final round-3 P3 rANS result on all
30 stems. The largest per-stem
percentage reduction is 7.196% on the small `r1/vocal-fx` stem; the release
comparison is the byte-weighted 1.168% result above. Policy 2 retains 93.6226%
of policy 1's 2,587,853-byte gain over policy 0 while avoiding 10,453 FIR
frames, 84,708,760 FIR residuals and 21,171,425 FIR updates. Policy 2 is
larger than policy 1 on 29 stems and smaller on one (`r2/vocal-fx`, by 200
bytes); this is a consequence of using a Rice proxy for rANS and does not
imply monotonic rANS behavior. Compared with round-3 P3 rANS, policy 2 loses
on seven stems, with the largest loss on `r1/guitar` at 21,299 bytes, despite
being smaller in the full byte total.

Against WavPack, policy 1 has ten individual-stem regressions, with the
largest on `r3/synth-2` at 216,680 bytes (1.03565%). Its four recording-session
totals still improve against both tuned FLAC and WavPack. These per-stem
comparisons do not change the byte-weighted release result.

The three frame candidates have distinct inverse histories. C is the round-4
spatial/off candidate. T applies P3 independently to both original FLAC
residual arrays. H first applies C's spatial correction and then applies P3
independently to both channels: the target FIR history is the spatially
corrected target residual, while the reference FIR history is the original
reference residual. Decoding reverses this order, restoring FIR on both
channels first and then applying spatial inversion with the restored reference
residual. The independent root frame audit compared complete actual C and T
Rice lengths with the prior round's actual Rice frames and checked selected H
lengths from the measured run. Unselected H lengths were not independently
re-encoded by the auditor; they are covered by the frozen implementation and
integer gates.

## Selected frame work and accounting

The full policy 1 rANS artifact contains 39,562 frames, 78,087 predictive
subframes, 4,235,904 side-information bytes, 373,071 table bytes, 74,831,775
ordinary rANS entropy bytes, 339,930,497 bypass bytes and 55,470 transmitted
spatial coefficient bytes. It selects 6,677 cheap frames, 28,087 temporal
frames and 4,798 stacked frames. The selected path processes 266,020,352 FIR
residuals with 66,489,523 updates. There are 985 coefficient clamps and zero
prediction clamps or modular wraps. The 339,930,497 bypass bytes are a
property of this coder's fixed-width residual representation, not an entropy
floor.

Policy 2 selects 17,130 cheap, 18,573 temporal and 3,859 stacked frames. Its
FIR workload is 181,311,592 residuals and 45,318,098 updates, with 931
coefficient clamps. The policy 1 stacked count is 4,798 frames (12.13% of
all frames). A complete C/T-only ablation was not materialized, so the
1,326,586-byte difference from round-3 cannot be described as a separately
measured stacking gain.

All delivery totals include the header, manifest, tables, frame lengths, side
information, entropy and bypass streams and transmitted coefficients. Plan
CSVs, audits and receipts are diagnostics outside delivery totals. The root
frame/plan auditor independently checked complete Rice costs, selection ties,
both coder transcripts, policy counters and the policy-0 body relation to the
round-4 control.

Offline native encode/decode process totals for the full run were:

| Candidate | Encode wall/user/system s | Encode RSS KiB | Decode wall/user/system s | Decode RSS KiB |
| --- | ---: | ---: | ---: | ---: |
| Policy 0 Rice | 50.870/45.68/4.85 | 6,144 | 24.025/20.91/2.77 | 4,864 |
| Policy 0 rANS | 82.224/75.92/5.93 | 6,144 | 24.477/21.28/2.86 | 4,864 |
| Policy 1 Rice | 142.744/137.21/5.13 | 6,144 | 56.796/53.40/2.98 | 4,864 |
| Policy 1 rANS | 233.005/226.26/6.36 | 6,144 | 57.128/53.83/2.94 | 4,864 |
| Policy 2 Rice | 132.297/126.85/5.08 | 6,144 | 46.245/42.98/2.90 | 4,864 |
| Policy 2 rANS | 222.462/215.89/6.24 | 6,144 | 46.699/43.39/2.92 | 4,864 |

These are sums of the native process receipts across four concurrent workers;
the full runner elapsed wall time was 320.335 s. Encode measurements include
model construction, candidate selection, plan CSV writes and audit writes.
They are offline process costs, separate from the six-candidate serial decode
timing below.

## Timing

The final timing uses three serial shuffled trials over the complete 30-stem
corpus and six fixed candidates: tuned FLAC, WavPack, round-3 P3 rANS and
round-5 policies 0/1/2 rANS. The measured interval includes compressed-file
reads, process startup, native decode and PCM output writes. Input warming,
preflight hashing and post-decode verification are outside the interval.
Both audit arguments were `-`, so audit serialization was disabled. Hash
verification was false inside the timed interval, and the reported RSS is the
maximum native child RSS from GNU `time`, in KiB. These are warm native
decode-to-file measurements, not network, OPFS, fsync, browser-installation or
Wasm-transfer measurements.

| Candidate | Median wall s | Median user s | Median system s | Max child RSS KiB |
| --- | ---: | ---: | ---: | ---: |
| Tuned FLAC | 5.776526 | 3.81 | 0.25 | 2,816 |
| WavPack `-hh -x6` | 11.280596 | 10.22 | 0.65 | 2,048 |
| Round-3 P3 rANS | 55.212990 | 53.90 | 0.92 | 4,864 |
| Round-5 policy 0 rANS | 15.891522 | 14.63 | 0.88 | 4,864 |
| Round-5 policy 1 rANS | 48.620862 | 47.31 | 0.93 | 4,864 |
| Round-5 policy 2 rANS | 38.132207 | 36.85 | 0.89 | 4,864 |

The three-trial minimum-to-maximum wall values were 5.769952–5.785525 s for
FLAC, 11.275267–11.286830 s for WavPack, 55.194064–55.222887 s for round-3
P3, 15.853483–15.893313 s for policy 0, 48.616565–48.621353 s for policy 1,
and 38.121491–38.132703 s for policy 2. Policy 1 therefore costs 3.06x the
policy 0 rANS decode wall time in this controlled set; policy 2 costs 2.40x
policy 0 but is 21.57% faster than policy 1 while retaining 93.62% of its
policy 0 byte gain.
FLAC launches 137 chunk decoder processes per full-corpus trial; WavPack and
each custom candidate launch one process per stem. Process startup remains in
the timed interval, giving 861 child receipts across three trials.
The timed output files were verified by the harness after each decode and
root independently checked 540 logical decodes, 360 custom summaries, 861
native child time/stderr receipts and 428 unique frozen-file hashes.

The timing source and receipts are
[`timing.py`](round-05/timing.py),
[`timing-freeze.json`](round-05-evidence/timing-freeze.json),
[`timing.json`](round-05-evidence/timing.json), and
[`root-timing-verification.json`](round-05-evidence/root-timing-verification.json).
The timing JSON SHA-256 is
`6d6d431ce02ccea1d49f4c3d4afe7c4b9bf1918eb674535d2851cd6f0eb4521e` and its
freeze SHA-256 is
`a3f06214354c789419b0f74079e2eec3052697752d4d014fe3823d9575034f0c`.

## Five-round interpretation

Round 1 reconstructed the exact FLAC predictor/residual records and separated
charged model estimates from achieved delivery. Its best bounded context/table
estimate was below one percent of the control and was not presented as a
codec result. Round 2 materialized matched Rice and context byte-rANS, ending
at 423,304,009 rANS bytes. Round 3 materialized the causal Q20 P3 FIR and
reached 421,773,671 rANS bytes, at substantially higher native decode cost.
Round 4 materialized the five-tap spatial/off correction and reached
423,034,938 rANS bytes; it improved its disabled control but did not beat
round 3. Round 5 measured actual temporal, stacked and thresholded choices
and reached 420,447,085 rANS bytes for policy 1.

The tested result does not achieve an additional 25% or 50% reduction. That is
a negative result for these five bounded models and this corpus, not a claim
about all lossless coding, future microphone recordings or an entropy limit.
The full byte-weighted gain over tuned FLAC is 1.168%, while policy 1 adds
substantial native work. The research recommendation is to stop this exact
model family here: preserve the evidence and controls, make no production
migration, and do not infer browser/Wasm/mobile performance or separated
recording generalization from these offline native measurements.

## Frozen evidence

The compact evidence directory is
[`round-05-evidence`](round-05-evidence/). It contains the sanitizer, pilot,
full and timing freezes/results, all per-stem and per-session rows, native gate
receipts, independent root verification receipts, preflight receipts and the
hash index. `evidence-hashes.json` records explicit path bases and SHA-256
values for the checked-in evidence and source dependencies; it excludes
itself so its own hash does not create a circular dependency.
