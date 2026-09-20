# Round 1 report: exact residuals and bounded entropy diagnostics

Round 1 froze the tuned libFLAC 1.5.0 `-8 -e` `flac8e-30s` control and copied
the public decoder callback data into an independently decodable diagnostic
record. The accepted shape was stereo signed 24-bit PCM at 44,100 Hz. The
optimized native helper processed the four complete pilot stems and then all
30 stems with at most four concurrent stem processes.

The diagnostic file is `I77RSD01`, followed by little-endian manifest length,
record count, and the original published manifest bytes. Each record stores
the source chunk index, packed frame start, source frame offset and frame byte
length, block size, stereo assignment, and two complete subframes. Subframes
retain type, wasted bits, predictor order, LPC precision and signed shift,
warmups, coefficients, Rice/Rice2 parameters and raw widths, and signed
residual values. The source offset and frame length fields are an explicit
round 1 extension to the suggested record layout; they make frame accounting
auditable without changing the FLAC control. The second process reconstructs
predictors and stereo channels from these records without FLAC or original PCM
input. The Python wrapper authenticates the embedded manifest and validates
its map, chunk order, packed sequence, and strict record EOF before invoking
that decoder.

The complete 30-stem control is **425,415,665 bytes**:

| Component | Bytes | Bits where applicable |
| --- | ---: | ---: |
| FLAC frame bytes | 425,325,188 | 3,402,601,504 |
| FLAC metadata | 11,782 | — |
| Candidate manifest | 78,215 | — |
| Envelope header | 480 | — |
| Delivered control | **425,415,665** | **3,403,325,320** |

The independently accumulated frame categories sum exactly to 3,402,601,504
bits, with zero unexplained remainder. They are: frame headers 2,081,608;
CRC16 632,992; zero padding 138,780; subframe headers 632,992; warmups
15,849,698; LPC coefficients and fields 10,296,225; constant values 25,789;
residual headers and partition fields 6,178,153; Rice quotients 622,572,113;
Rice remainders 2,744,193,154; escaped raw bits 0. Wasted and verbatim bits
were both zero in this control. The 137 FLAC chunks and all 30 merged records
passed this reconciliation.

There were 319,124,089 ordinary residual samples and no raw escaped residual
samples. The bounded 17-symbol quotient diagnostic did encounter 70,556
quotients at or above its cap, 0.022109% of ordinary residuals; their exact 32-bit
bypass charge is 2,257,792 bits. This quotient-cap escape count is separate
from the raw-partition escape fraction, which is zero. Quotients account for
622,572,113 bits, or 18.297% of frame bits;
remainders account for 2,744,193,154 bits, or 80.650%. Together the two Rice
payload parts are 3,366,765,267 bits, 98.947% of frame bits. The complete
active PCM input was 971,988,594 bytes; every reconstructed active hash and
zero-filled canonical hash matched the frozen identity. Per-stem identities,
active/full byte counts, record hashes, exact counters, and process receipts
are in `round-01-evidence/verification.json` and the independent root receipt.

The three quotient figures below are fitted diagnostics over ordinary Rice
residuals. They are not encoded artifacts, entropy floors, or measured codec
sizes. Each estimate retains every unchanged control bit, uses a separate
model per stem, and charges its tables, a 32-bit proposed coder state per
ordinary subframe, and one byte of proposed padding per such subframe. The
ideal figure uses the empirical 17-symbol categorical length plus the 32-bit
bypass cost for symbol 16. The table figure uses the specified 4096-frequency
integer tables. The context figure uses separate `(role, k, previousClass)`
tables with the reset class at each partition.

| Estimate | Bits | Equivalent control reduction |
| --- | ---: | ---: |
| Complete control | 3,403,325,320 | — |
| Ideal quotient model, with charged budgets | 3,386,006,923.19 | 2,164,799.60 bytes (0.509%) |
| Per-stem table model, with charged budgets | 3,386,483,027.55 | 2,105,286.56 bytes (0.495%) |
| Per-stem causal context model, with charged budgets | **3,382,340,265.88** | **2,623,131.76 bytes (0.617%)** |

The per-stem table model uses 2,044 quotient tables and 73,704 table bytes.
The context model uses 10,204 tables and 377,668 table bytes. The state budget
is 2,498,784 bits and the nominal padding budget is 624,696 bits. The context
estimate is lower than the table estimate by about 517,845 bytes after its
larger table charge. The pooled histogram is retained only as a diagnostic;
it is not used in the reported per-stem estimate. The per-stem CSV exposes
the complete model components and session totals.

| Session | Stems | Control bytes | Context estimate bits |
| --- | ---: | ---: | ---: |
| r1 | 8 | 90,604,822 | 718,335,781.59 |
| r2 | 8 | 68,302,183 | 541,273,970.19 |
| r3 | 6 | 106,716,345 | 850,119,563.99 |
| r4 | 8 | 159,792,315 | 1,272,610,950.12 |

Marginal remainder-bit fitting reports 2,744,193,154 raw bits and
2,738,342,181.91 fitted bits when summed per stem, a 5,850,972.09-bit
diagnostic difference. The pooled diagnostic is 5,511,238.57 bits. This
binary marginal fit ignores dependencies and is not added to a savings claim.
Pooled normalized residual lag correlations at lags 1, 2, 4, 8, 16, and 32
were respectively -0.02159, -0.03390, -0.02737, -0.02744, -0.00822, and
0.00823. These values alone do not establish a stronger predictor.

The context estimate was positive for every stem. The largest estimated
complete-envelope reduction was 254,138.87 bytes for r1/vocal-fx; the smallest
was 8,918.30 bytes for r4/outro-fx. These are fitted estimates, not achieved
delivery savings. Relative to the 25% and 50% aspiration, the control would
need to remove about 106.35 MB and 212.71 MB respectively (101.43 MiB and
202.85 MiB); this round did
not test or claim either target.

The native run receipts reported 19.71 seconds of summed extraction child
wall time over 137 chunks, 17.42 seconds user CPU, 0.69 seconds system CPU,
and 2,560 KiB maximum RSS. Independent reconstruction over 30 merged stems
reported 14.34 seconds summed child wall time, 13.06 seconds user CPU, 0.91
seconds system CPU, and 2,048 KiB maximum RSS. Parallel full-run wall time
was 11.33 seconds. These are research helper measurements rather than browser
or mobile performance claims.

Synthetic gates cover constant, verbatim, fixed orders 0 through 4, LPC with
positive and negative shifts, all four stereo assignments, negative odd side
values, signed extrema, wasted bits, Rice2 raw escape at width zero, multiple
partitions, short blocks, and corruption or structural rejection. The native
optimized helper passes 8/8 tests; a separately built ASan/UBSan helper passes
the same synthetic suite and a four-stem sanitizer pilot without diagnostics.
The existing research verification suite passes 8/8. The final failure log is
empty; an early synthetic fixture used a non-divisible block size with a
partition order that the final FLAC-validity gate correctly rejects, and that
fixture was corrected before the final test run.

Round 1 did not materialize a compressed replacement and therefore makes no
codec savings claim. The best bounded next experiment is the scoped round 2
comparison between a compact Rice control and a context-conditioned byte-rANS
model over these same predictors, Rice parameters, and residuals. It should
retain raw remainders as bypass data, transmit all per-stem model state, and
require a complete independently decoded artifact before reporting bytes.

See [reproduction commands](round-01/REPRODUCTION.md),
[native process metrics](round-01-evidence/native-metrics.json), and
[validation receipts](round-01-evidence/validation.json). The independent
[root audit](round-01-evidence/root-verification.json) records expected and
actual active/canonical hashes and exact accounting for every stem.
