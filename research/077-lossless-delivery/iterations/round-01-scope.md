# Round 1 scope: exact residuals and controlled entropy headroom

Status: scoped, not implemented or measured. Astra scopes; Luna implements at
the requester-selected effort. The requester explicitly authorized five
sequential research iterations and deferred browser/mobile work. This scope
does not authorize production codec changes.

## Question and fixed control

For the exact predictors selected by libFLAC 1.5.0 `-8 -e`, how many bits go to
prediction metadata, Rice quotients, and Rice remainders? Do small, explicit
residual probability models expose useful headroom after model costs? Which
signals justify stronger prediction in a later, separate comparison?

The control is the existing `flac8e-30s` result: **425,415,665 delivered bytes**
across all 30 stems. Keep all 137 input streams, frame boundaries, channel
assignments, wasted bits, predictor orders/coefficients/warmups, residual
sequences, Rice partitions, and Rice parameters fixed in this round. Published
delivery is 434,311,756 bytes; concatenated tuned FLAC is 425,390,054; strongest
tested WavPack is 422,706,494. Those observations are not an entropy floor.

No exact-repeat search, approximate deduplication, lossy quantization,
threshold silence, new activity maps, or cross-stem models/dependencies. Every
model is reset or explicitly transmitted within one stem. Do not inspect
engine/app or legacy source. Existing research code and evidence stay frozen;
new code and documentation belong under this `iterations/` directory. Scratch,
build outputs, diagnostic records, and audio belong under
`/data/issue-77-lossless/iterations/round-01/`, outside Git.

## Inputs and pilot gate

Use `../sources.json`, all original `../manifests/*.json`, and
`../evidence/results.json` as authoritative identities and byte baselines.
Input directories are `/data/issue-77-lossless/run-02/<canonical hex>/`:
`original.raw`, `active.raw`, and `flac8e-30s/{0.flac,...,manifest.json,stem.blob}`.
Verify source PCM byte counts/hashes, the exact zero omissions, the packed PCM
hash from existing evidence, source FLAC chunk hashes, and frozen map hashes.
Do not derive trusted identities from unchecked scratch files.

First run the complete active PCM of these four stems, not selected favorable
windows:

| Session/source | Canonical identity without `sha256:` |
| --- | --- |
| r1 / bass | ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1 |
| r2 / drums | 8faf64b1ebce116931951541fcb35fd000fc9b5f929ae15e47c30ae8666b76a0 |
| r3 / lead-vox | fdae0da08b49b80492caad638119441bd2a0f2a2330642ff84e3baaafbb03cda |
| r4 / synth | 68f41fc0dfa18e77e77ab99f931dc647d9b1c3d60afd981f9b4917c85986532f |

After correctness and bounded-memory gates pass, run all 30. The full pass is
the expected completion gate; a genuine implementation/runtime blocker must
be reported with its coverage, not hidden by extrapolating pilot totals.
No external Python packages are available or needed. Prefer a native helper
and a small issue-specific Python runner/report writer, not a new framework.

## Native extraction and independent reconstruction

Link the pinned local libFLAC static library at
`/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a`, using headers
in `/data/issue-77-lossless/tooling/flac-1.5.0/include`. Record compiler flags,
compiler/version, source and binary hashes. Do not modify libFLAC. Its public
write callback supplies `FLAC__Frame.subframes`: original residual arrays,
warmups, LPC coefficients/shift/precision, Rice parameters/escape widths, and
wasted bits. The callback PCM is a separate independent reference. Inspect
the pinned public headers when implementing; the 1.5.0 decoder source was
checked during scoping to confirm that residual buffers survive channel
restoration. Copy records before the callback returns.

Implement a native extractor plus a decoder of its serialized records. The
record decoder must reconstruct using stored predictors/residuals, not copy
libFLAC's decoded output. During extraction, compare every reconstructed
sample to callback PCM. In a second process, decode the saved records with no
FLAC or original PCM input, then verify active and full reconstructed hashes.
The Python wrapper can validate embedded JSON and synthesize/hash zero gaps
with reads of at most 1 MiB, using the frozen research helpers read-only if
useful. Do not import production modules.

Suggested diagnostic file format, to freeze in the implementation before the
measured pass:

* File: 8 bytes `I77RSD01`, little-endian `u64 manifestLength`, `u64 recordCount`,
  the original published manifest bytes verbatim, then `recordCount` records
  and strict EOF. The manifest's FLAC fields are provenance; the record stream
  is a research diagnostic, not that FLAC format. Validate maps/shape/counts
  before decoding. The embedded map and PCM identity make one file per stem
  independently reconstructable through the research decoder/wrapper.
* Record: `u32 recordBytes` counting subsequent bytes; `u32 sourceChunkIndex`,
  `u64 packedStartFrame`, `u32 blockSize`, then four bytes `assignment`,
  `channels`, `bitsPerSample`, `reserved=0`. Assignment values are explicitly
  0=independent, 1=left/side, 2=side/right, 3=mid/side. Follow with two subframes.
* Subframe header: bytes `type`, `wastedBits`, `order`, `precision`, signed
  `shift`, `riceMethod`, `partitionOrder`, `reserved=0`, then `u32 dataCount`
  and `u32 partitionCount`. Type is 0=constant, 1=verbatim, 2=fixed, 3=LPC.
  Unused fields are zero, except `riceMethod=255` for nonresidual subframes.
  Follow with `order` signed i32 warmups for fixed/LPC, `order` signed i32
  coefficients for LPC only, partition entries, and signed i32 data.
  A partition entry is `u8 riceParameter`, `u8 rawWidth`, `u16 reserved=0`.
  Data are one value for constant, `blockSize` for verbatim, or
  `blockSize-order` residuals. Partition count is zero for constant/verbatim,
  otherwise exactly `1 << partitionOrder`. All integers are little-endian;
  never serialize padded C structs.

Equivalent changes that simplify implementation are allowed before freezing,
provided the implemented format is documented unambiguously, independently
decodable, and retains every item needed for the controlled comparison. This
uncompressed diagnostic size is **not a compressed-delivery result**. It is
expected to exceed FLAC; keep it outside Git with hashes in the evidence.

The accepted input shape is stereo signed 24-bit PCM at 44,100 Hz. Handle all
four FLAC subframe types, Rice/Rice2 including raw escape width zero, all four
stereo assignments, nonzero wasted bits, and short final blocks. Use checked
64-bit arithmetic for predictor sums and stereo reconstruction; define floor
division for signed power-of-two shifts explicitly instead of relying on C
negative shifts or overflow. Fixed orders 0..4 use the standard integer
polynomial predictors; LPC uses `sum(coeff[j] * history[j])`, the signed
quantization shift, then adds the residual. Restore wasted bits before
undoing stereo. For mid/side, let `twiceMid = 2*mid + (side mod 2 in {0,1})`,
then `left=(twiceMid+side)/2`, `right=(twiceMid-side)/2`. Check final s24 ranges
and emit signed interleaved little-endian bytes exactly.

Validate all lengths, orders, shifts, partition coverage, chunk/frame ordering,
reserved fields, and counts before allocation/use. Bound a decoded record by
1 MiB and block size by 65,535, and bound all other tables by fixed dimensions.
Do not buffer a whole stem in RAM. Any libFLAC error callback, including an
error followed by successful decoder resynchronization, fails the input.

## Exact control bit accounting

For each fixed/LPC partition let `u = r>=0 ? 2*r : -2*r-1`, computed wide
before conversion to u32. In ordinary Rice, `q=u>>k` and the exact payload is
`sum(q+1+k)` bits. Separately accumulate quotient unary bits `sum(q+1)` and
remainder bits `n*k`. An escaped partition costs its five-bit raw-width field
plus `n*rawWidth`; recognize escape from the parameter value, not from a
nonzero raw width. Partition zero contains `blockSize/partitions-order`
residuals, all later partitions `blockSize/partitions`. Include the two-bit
residual method, four-bit partition order, and each four/five-bit parameter.

Other exact subframe costs: eight-bit subframe header; `wastedBits` additional
bits when nonzero; warmups at the reduced channel bit depth; LPC coefficient
precision field (4), signed shift field (5), and `order*precision`; or the
constant/verbatim values. Side channels have one extra bit before wasted-bit
removal. Obtain frame byte positions with decoder decode-position queries;
parse the short raw frame header if needed to identify its exact length.
Require reconstructed subframe bits + final zero padding + actual frame
header + CRC16 to equal the actual frame byte length. Metadata plus all frame
bytes must equal the verified FLAC chunk length. Fail on unaccounted trailing
bytes. Never report a negative or unexplained balancing remainder as overhead.

Output separate exact counters for file metadata, frame headers/CRCs/padding,
subframe/wasted-bit headers, coefficients/shifts/warmups, constant/verbatim
data, residual headers/partition fields/escape widths, Rice quotient bits,
Rice remainder bits, and escaped raw residual bits. Aggregate to the complete
425,415,665-byte envelope total using its existing manifest/header lengths.
Keep fractional bytes in bit counters until the final aggregate; do not round
every partition to a byte. Record type/order/assignment/k distributions and
sample counts so model coverage is explicit.

## Three bounded diagnostics, with honest labels

Use only ordinary Rice residuals for the following models; leave escaped and
constant/verbatim data unchanged. Role is left, right, mid, or side, inferred
from assignment/subframe index. Tables are per stem, never pooled to avoid
charging transmission. Retain all original side information (including k).

1. **Quotient distribution.** For each `(role,k)`, histogram the 17 symbols
   `min(q,16)`. Symbol 16 escapes and transmits the actual q as 32 bypass bits;
   every symbol also retains its original k remainder bits. Compute empirical
   categorical ideal length `N*H(symbol)` and the bypass lengths. This is an
   optimistic fitted-model estimate, not an encoded artifact or an entropy
   floor. Also compute a table-charged integer-frequency model: total 4096,
   reserve frequency 1 for each observed symbol, distribute the remainder
   proportionally to counts, and use largest remainder with symbol-index tie
   breaking. Score `sum(-log2(freq/4096))`, plus bypass bits. Charge a u32
   table count and, per present table, two key bytes plus seventeen u16
   frequencies. Charge a nominal four-byte coder state and byte padding per
   ordinary-Rice subframe. Label state/padding as a proposed format budget;
   round 2 must measure actual bytes and any additional selectors/indexes.
2. **Causal quotient context.** Repeat with `(role,k,previousClass)`, where
   previousClass is `min(previous q,3)` and is 4 at the beginning of every
   Rice partition. The first symbol therefore has a decoder-known reset.
   There are five classes. Transmit three key bytes plus the same seventeen
   u16 frequencies per nonempty table. This isolates within-partition scale
   dependence without altering a single prediction or residual. Report both
   likelihood gain and its table cost relative to diagnostic 1.
3. **Remainder-bit diagnostic.** For each `(role,k,bitPosition)` with position
   0..k-1, collect zero/one counts and empirical bit entropy. Report bit-position
   entropy and the sum of fitted binary-code lengths versus raw remainder
   bits. These marginal models can overfit and ignore dependencies. They do
   not establish irreducible microphone noise or a universal lower bound.
   Do not add this unencoded estimate to a measured-codec savings column.

These arrays are small: role<=4, k<=30, context<=5, alphabet=17, bitPosition<31.
Use u64 counters. Report the escape fraction so the arbitrary quotient cap's
limitations are visible. Also accumulate residual mean/variance and normalized
lag correlations at 1, 2, 4, 8, 16, and 32 using wide floating accumulators,
resetting within each subframe; these are predictors' diagnostic statistics,
not savings claims. No causal claim follows solely from a correlation.

Show every modeled replacement against both its exact residual control and
the complete delivery control. Retain all unchanged bits and add the proposed
table/state budgets explicitly. At this baseline, another 25% or 50% saving
requires eliminating roughly 850.8 million or 1,701.7 million delivered bits
(106.35 MB or 212.71 MB). Report the measured model gap against those targets;
do not describe a tested model's failure as impossibility for other codecs.

## Freeze, measurements, and adversarial gates

Provide an explicit build/freeze command and a measured-run command. Freeze
the scope/configuration, all executed research source files, manifest/catalog
and input chunk hashes, original evidence references, native source/archive,
linked library and binary hashes, compiler/version/flags, environment/CPU,
pilot IDs, worker count, model dimensions, and exact commands before running.
The measured run rejects changed inputs/code/tools/configuration. Debug/pilot
attempts have separate directories and are not reported as frozen full runs.

Use one native process per active stem, with a frozen maximum of four stems
for corpus analysis. Record process wall, user+system CPU, and maximum RSS
for extraction/analysis and independent reconstruction separately, plus whole
run elapsed wall time. These are native research costs, not codec/mobile
installation performance. If reporting a decoder speed comparison, run the
four pilot stems serially in three deterministic shuffled trials against
libFLAC decode-to-file, with identical output/hashing treatment and warm input
cache, and distinguish wrapper time from child maximum RSS. Do not compare
parallel analysis timing directly with prior serial preparation latency.

Before the full pass, include meaningful synthetic gates for constant/verbatim,
fixed and LPC reconstruction, all stereo assignments, odd/negative side,
signed extrema, single-LSB values, wasted bits, Rice2/raw escape including
zero width, different partitions, short blocks, and omission/channel-order
failures. Generate deterministic fixtures or explicit valid diagnostic records
for modes libFLAC does not choose naturally, and report which are synthetic.
Corruption gates must reject truncation, trailing bytes, oversized record
length, inconsistent sample/partition/order fields, nonzero reserved fields,
and altered coefficients/residual bytes (structural rejection or final hash
failure, never verified output). Exercise the native decoder with ASan/UBSan
on synthetic/pilot fixtures when supported; use the ordinary optimized binary
for measured timings. Keep sanitizer and timing builds separately identified.

## Required handoff to the round 2 scoper

Check in source, concise reproduction instructions, `round-01-report.md`, and
compact evidence under `round-01-evidence/`: freeze, per-stem CSV, four-session
CSV, total CSV/JSON, verification/metrics receipts, and SHA-256 evidence index.
Do not commit audio, diagnostic dumps, build files, or generated caches.
Every tested stem must have active/full byte counts and expected/actual SHA-256
identities, record/control artifact hashes, exact bit accounting, modeled
components with units/labels, and process metrics. Include the model table
byte totals, coder-state budget, unsupported coverage if any, and failure log.

The report must answer: how much of tuned FLAC is residual data; quotient vs
remainder shares; fitted and table-charged headroom for the two specified
quotient models; remainder-bit evidence; worst/best stems and session totals;
what is measured versus estimated; and the specific best next hypothesis.
All 30 full-corpus independent reconstruction hashes, exact byte accounting,
and stress gates must pass to label round 1 complete.

## Adaptive five-round roadmap

Future entries are hypotheses, not frozen scopes or completed experiments.
Each later scope must cite the actual prior report and select a small bounded
experiment before Luna implements it. Low savings do not cancel the requested
five rounds; they redirect the next experiment and can yield a documented
negative result.

| Round | Intended experiment | Adaptation from prior evidence |
| --- | --- | --- |
| 1 | Exact FLAC residual extraction, independent reconstruction, Rice bit decomposition, and small explicit entropy models. | Establish trustworthy residuals and distinguish quotient overhead, remainder regularity, and prediction opportunity. |
| 2 | Actual bounded entropy codec on those identical residuals: Rice control versus one byte-rANS or range/arithmetic model, complete per-stem artifact and independent decode. | Choose the better table-charged round-1 model; if quotient gain is tiny, keep that comparison small and test the specific remainder/context hypothesis supported by the diagnostics. All coefficients, maps, tables, escapes, and fallbacks count. |
| 3 | Stronger deterministic prediction, keeping entropy coding fixed across old/new residuals. Candidate: causal integer adaptive FIR correction of FLAC LPC residuals or expanded block LPC order/search. | Choose one predictor from residual lag/context evidence. Use a small frozen order/learning-rate grid on designated pilot stems; freeze the winner before the full pass. Record Rice as a common control and winning round-2 coding separately. Quantized coefficients are allowed only as exactly decoded predictors with lossless residual correction. |
| 4 | One complementary predictor/model experiment, such as causal stereo cross-prediction or a bounded multi-timescale/context model for heteroscedastic residuals. | Target the largest remaining observed source of bits. If round 3 found no predictor improvement, test a distinct hypothesis; do not merely repeat a losing parameter grid or pivot to exact-repeat search. Include additive/ablation comparisons so interactions are distinguishable. |
| 5 | Freeze and combine only supported components, full 30-stem artifacts and serial native decode verification/performance, with practical table/context/predictor-cost ablations and an adversarial audit. | Prune components whose complete artifacts regress. Report byte savings relative to published, tuned FLAC, and WavPack; assess the 25–50% aspiration against actual evidence and identify the precise remaining uncertainty. A native go/no-go is allowed; browser readiness remains deferred. |

For rounds 2–5, a compressed-size claim requires a materialized, independently
decodable, hash-verified complete per-stem artifact. All model tables/learned
weights, coefficients, seeds, selectors, interval maps, indexes, hashes,
padding, and escape/fallback data count. Decoder-fixed tables must be generic
and frozen rather than secretly trained on evaluation stems; any corpus-fitted
information must be transmitted and charged. No external cross-stem state is
available to the decoder. A model-specific conditional lower bound must name
its conditioning/model class and unavailable information and remain separate
from achievable/encoded sizes. At every round preserve an honest negative
finding rather than weakening the exactness or accounting gates.
