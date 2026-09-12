# Round 2: matched Rice and context byte-rANS

Round 2 encoded the unchanged round-1 predictor and residual records in two
independently decodable modes. Rice mode is the matched control. Context mode
uses 17 quotient symbols with a per-stem byte-rANS table keyed by channel role,
unchanged Rice parameter, and the previous quotient class. Both modes retain
the same FLAC-width side information and leave remainder bits in a bypass
stream.

The final measured run used the frozen 30-stem round-1 records, the unchanged
stereo s24le 44.1 kHz manifests, four workers, and the final optimized helper.
All 60 files passed strict EOF, frame and file accounting, exact active PCM
hashes, all source chunk hashes, canonical zero-gap hashes, and encoder versus
decoder logical transcripts. The compact receipts are in
[`round-02-evidence`](round-02-evidence/).

The independent root audit in
[`root-verification.json`](round-02-evidence/root-verification.json) separately
rechecked all 60 artifacts, 39,562 frames, normalized tables, PCM identities,
and timing baseline chunk hashes against the tuned FLAC candidates.

| Mode | Delivered bytes | Difference from tuned FLAC | Difference from matched Rice |
| --- | ---: | ---: | ---: |
| Tuned libFLAC `-8 -e` control | 425,415,665 | — | — |
| Matched Rice | 426,056,035 | +640,370 (+0.151%) | — |
| Context byte-rANS | 423,304,009 | **−2,111,656 (−0.496%)** | **−2,752,026 (−0.646%)** |

The rANS result is an actual all-in saving. It includes each 32-byte header,
the original manifest, per-stem tables, side information, frame and subframe
length fields, rANS states and streams, bypass bits, and zero padding. The
Rice result is 0.151% larger than tuned FLAC because this experiment charges
its relocated side information and framing directly.

The rANS file decomposition is:

| Component | Bytes |
| --- | ---: |
| 30 format headers | 960 |
| Embedded manifests | 78,216 |
| Context tables (10,204 tables) | 377,548 |
| Frame records | 422,847,285 |
| **Total** | **423,304,009** |

The frame equation is exact across all stems:
`8 × 39,562 frames + 4,155,758 side bytes + 8 × 78,087 predictive
subframes + 74,421,224 entropy bytes + 343,329,111 bypass bytes =
422,847,285 frame bytes`. Rice has the same 78,087 predictive-subframe and
4,155,758 side-byte totals, with 420,879,909 entropy bytes and no bypass
bytes, producing 425,976,859 frame bytes. The per-stem receipts enforce these
equations before aggregating them.

Round 1's limited model estimated 423,310,378 bytes for normalized tables and
422,792,533.235 bytes for the context model. The measured context result is
423,304,009 bytes, a gap of 511,475.765 bytes. The context estimate implied a
2,623,131.765-byte gain over tuned FLAC; the measured rANS gain is 2,752,026
bytes, exceeding that estimate by 128,894.235 bytes. The matched Rice framing
cost is 640,370 bytes; after actual rANS entropy, table, and state costs, the
measured saving over matched Rice is 2,752,026 bytes. The remaining difference
reflects actual quotient-cap bypass bits, per-subframe byte padding and states,
and the measured frame/header layout. The model's fitted remainder gain was not used: the
measured bypass stream preserves those bits exactly. The final rANS entropy
stream is 74,421,224 bytes and the bypass stream is 343,329,111 bytes; the
tables total 377,548 bytes.

Against the other complete-delivery totals from the initial benchmark, rANS is
11,007,747 bytes below the published package (434,311,756 bytes),
19,403,238 bytes below `wavpack-concat` (442,707,247), 4,560,147 bytes below
`wavpackx6-concat` (427,864,156), and 13,597,082 bytes below
`wavpackhh-concat` (436,901,091). It is 597,515 bytes above the smallest
retained `wavpackhhx6-concat` result (422,706,494). These comparisons include
the respective format envelopes and manifests recorded by round 1.

The final full run took 22.323659 seconds wall at the wrapper level. Native per-stem
process receipts, including audit transcript serialization for verification,
sum to 14.95 encode wall seconds and 19.33 decode wall seconds for Rice, and
16.01 encode and 19.75 decode wall seconds for rANS; peak native RSS was 4,864
KiB. These are offline research costs and include four-worker scheduling in
the wrapper totals.

Separate serial decode trials disabled audit output and warmed compressed
inputs before each measured interval. Each trial shuffled the four pilot stems
and the order of Rice, rANS, and pinned libFLAC deterministically. The median
wall times over three trials were Rice 2.170569694 s, rANS 2.232136523 s, and
libFLAC 0.841840358 s. Median user/system CPU times were respectively
2.00/0.13 s, 2.07/0.12 s, and 0.53/0.03 s; peak native RSS was 4,864, 4,864,
and 2,816 KiB. Raw PCM hash and byte checks ran outside each timed interval.
libFLAC was
decoded one manifest chunk at a time with raw little-endian signed output.

The optimized and ASan/UBSan native fixture suites each passed four tests. The
sanitized pilot passed all eight mode/stem files with no sanitizer diagnostics.
The native tests include predictor and stereo restoration, wasted bits, mixed
partitions and Rice parameters, q≥16, k=0 and k=30, raw width zero, signed
extrema, context resets, table/state corruption, truncation, padding, flags,
trailing bytes, and bounded lengths. The decoder consumes only the embedded
experimental file during verification; it does not read the RSD, source FLAC,
histograms, or external model tables.

This round establishes a modest measured gain for the fixed residual model.
The largest remaining delivered stems are r3/bv_s (26,720,929 rANS bytes),
r4/lead-vox (26,638,287), r4/synth (26,367,729), and r4/drums (24,800,719).
The result does not test stronger predictors or establish the
25–50% aspiration; those remain later hypotheses.

Reproduction commands, compiler flags, source and dependency hashes, frozen
inputs, pilot/full receipts, per-stem/session CSVs, and timing receipts are in
[`REPRODUCTION.md`](round-02/REPRODUCTION.md) and
[`round-02-evidence`](round-02-evidence/).
