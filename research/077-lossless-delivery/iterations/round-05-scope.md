# Round 5: combine supported predictors and prune costly FIR work

Status: **Final scope**, based on root-approved round-4 full artifacts and
controlled timing. Astra scopes; Luna implements at the requested effort.
Final research round 5 of 5;
no production migration, engine/app, network, browser, or mobile work.

## Evidence and the bounded final question

Verified round 3 produced 421,773,671 rANS bytes with P3 temporal FIR, versus
423,396,564 disabled. Its four-pilot native serial median is 7.835196 s versus
2.240367 s disabled. The final round-4 result is 423,034,938 rANS bytes with
five-tap spatial/off selection, or 361,626 bytes below its disabled control.
Root approved all 120 full artifacts and 79,124 exact Rice frame comparisons
in `/data/issue-77-lossless/iterations/round-04/full-final3/root-verification.json`,
plus 24 pilot and 8 sanitizer artifacts. Spatial correction occurs in only
6,390/39,562 frames and costs 63,900 coefficient bytes; 29 rANS stems improve,
one ties, none regress. The final full-results SHA-256 is
`9f4452056a6ac93a4a76f3d2820c5a2c224ad987ea08f01c5a55f4b8412b3056`.

Round-4 three-trial serial medians over the four pilots are 2.236973 s disabled
Rice, 2.286924 s disabled rANS, 2.256630 s spatial Rice, 2.309486 s spatial
rANS, and 7.829731 s round-3 P3 rANS. All 60 audit-free decodes passed; peak
native child RSS was 4,864 KiB. The frozen timing is
`/data/issue-77-lossless/iterations/round-04/timing-final4/timing.json`, SHA-256
`c2c19cd5690a4bdee94df55dd97aebc6ee99d85f8be5a73055a5fae28cf7a0b0`.
These are warm native decode-to-file costs, not browser installation timing.
They support preserving spatial/off as the cheap branch while pruning FIR.

Root's verified round-4 pilot frame-cost comparison against already encoded
pure P3 FIR suggests the fixed 32-byte threshold is worth measuring: versus
the cheap spatial/off plan, threshold >0 chooses FIR on 4,709/5,934 frames
and saves 377,355 Rice bytes; >32 chooses 3,314 frames and saves 355,901 bytes.
This retains 94.3% of that **pilot pure-FIR Rice** gain while avoiding another
1,395 FIR frames. It does not measure stacking, rANS outcomes, or saved time.

Materialize only three final policies: cheap spatial/off; allow FIR when its
complete Rice-frame saving exceeds 0 bytes; allow FIR when it exceeds 32.
No additional thresholds, learning rates, tap counts, predictors, or entropy
models. Measure the actual byte/decode tradeoff and finish the five-round
research answer, including an honest conclusion about the 25–50% aspiration.

## Reuse and the three frame candidates

Add only `iterations/round-05/` source/tests/runner, with all generated work
under `/data/issue-77-lossless/iterations/round-05/`. Define
`I77_ROUND4_NO_MAIN` and include finalized `round-04/native/round4.c` read-only;
reuse prior transforms, k selection, entropy coding and validation. Do not
modify earlier code/evidence or create another framework. Pin the final
round-3 P3 and round-4 selected five-tap profile and all prior input identities.

For each original bounded RSD frame, form at most these three candidates:

* **C (cheap):** the final round-4 five-tap off/reference-0/reference-1 plan,
  using its unchanged fit, quantization and exact charged Rice selection.
* **T (temporal):** apply the exact round-3 P3 FIR independently to the
  original residual arrays, without spatial correction.
* **H (stacked):** apply P3 FIR independently to the two residual arrays
  **after C's spatial correction**. Retain C's chosen direction/coefficients;
  do not refit or search another spatial direction for the stacked candidate.

If C's spatial selector is off, T and H are identical: compute them only once.
When no predictive residuals exist, only C is eligible. Spatial correction
keeps round-4 eligibility (both subframes predictive and nonempty); P3 affects
only fixed/LPC residual arrays and skips constant/verbatim. Preserve all
original frame geometry, coefficients/warmups, stereo assignments, wasted
bits and exact intervals. Every FIR starts from its specified zero state at
each subframe; no state crosses frame choices or stems.

Retune Rice2 k under the exact same prior rule after each candidate transform.
Let a candidate's cost be its actual complete Rice frame length, including
length fields, side information, selector, all coefficient bytes, and actual
subframe padding. The existing Rice-payload score plus spatial coefficient
bytes may be used because all other frame bytes are identical; verify that
equivalence against actual serialization. Never sum separate prior-round
savings to estimate H: its residuals and encoded cost must be computed.

Choose E as the smaller of T and H, preferring T on equal bytes. For threshold
tau in {0,32}, select E exactly when `cost(C)>cost(E)` and
`cost(C)-cost(E)>tau`; otherwise select C. Thus ties and the 32-byte equality
case use C. Policy 0 always selects C and need not compute the FIR candidates.
Use u64 checks, not unsigned subtraction before the ordering test. The chosen
frame must be the same for Rice and rANS; no separate entropy-mode selection.
This optimizes the specified Rice proxy, not an unmeasured rANS/time oracle.

Keep per-frame original RSD identity/order plus candidate C/T/H Rice costs,
selected pipeline, threshold, spatial direction/coefficients, coefficient
bytes, predictive residual count, and FIR update count. A bounded-record
scratch plan can avoid repeated fitting/transform searches between encoder
passes. All selections and coefficients must appear in the final artifact;
no decoder access to that scratch plan is permitted. Include plan construction
and model/encoding passes in offline encode cost, and hash their provenance.

## Format and exact inverse order

Use magic `I77MIX05` and the existing 32-byte header: magic[8], u8 entropy mode,
u8 shape=1, u8 policy (0 cheap, 1 threshold 0, 2 threshold 32), u8 spatial
profile=2 (the fixed five taps), u64 manifest length, u64 record count, u32
table count. The prior reserved byte now explicitly identifies the spatial
profile. Reject other shape/policy/spatial values. Tables and original manifest
remain per stem, exactly charged and independently available in that file.

Use the existing one-byte frame selector as bits 0..1 spatial direction
(0 none, 1 ref0, 2 ref1; 3 invalid), bit 2 FIR enabled, bits 3..7 zero.
Legal values are 0,1,2,4,5,6. Policy 0 forbids bit 2. A nonzero direction
is followed by five signed i16 Q12 coefficients exactly as in round 4;
otherwise no coefficients are present. Original two-subframe coding follows.
FIR uses fixed P3 (M32/b3/Q20/cadence4) and needs no coefficient table.

Decoder first entropy-decodes both bounded residual arrays, then:

1. If FIR is enabled, inverse P3 on each predictive subframe independently.
   **FIR history is its stage input**, restored during that inverse. For H,
   this means the spatial error sequence on the target and original FLAC
   residual sequence on the reference. Do not substitute original FLAC
   target residuals into H's FIR history.
2. If spatial direction is nonzero, apply its integer inverse using the
   now-restored original reference residuals, yielding original target
   residuals. Keep round-4 order/warmup/sample alignment unchanged.
3. Only then restore original LPC/fixed samples, wasted bits and stereo PCM.

The reverse order is mandatory. Both stages retain their existing modular
signed32 lifting, explicit signed rounding, coefficient clamps and arithmetic
bounds. Sequential modular corrections are exactly invertible; do not assume
an intermediate difference fits signed32 or omit wrap counters. Decoder has
no floating-point fitting, searches, original FLAC/RSD inputs, or cross-frame
dependencies. Never decode through a full intermediate RSD file during timing.

Freeze all prior bounds: block <=65,535 frames, RSD record <=1 MiB, encoded
frame <=4 MiB, manifest <=1 MiB, and at most 4*31*5 rANS tables. Bound the
number of simultaneous candidate frame copies and free them per frame.
Keep only the selected path's execution counters in decoder comparisons;
offline evaluation counters are separate.

## Native/runner ownership and fixed interface

The native implementer owns `round-05/native/round5.c`, native/reference drivers
and native/math/malformed-stream tests. The runner implementer owns
`round-05/round5.py`, `timing.py`, freeze/provenance tests, reproduction and
results/report assembly. Root owns independent artifact/frame-cost auditing.
Coordinate source-file ownership; freeze all executed sources before measured
runs. Astra reviews conformance without editing implementation files.

The CLI is fixed so those tasks can proceed independently:

```text
round5-helper encode INPUT_RSD OUTPUT ORIGINAL_AUDIT CODED_AUDIT SUMMARY MODE POLICY PLAN_CSV
round5-helper decode INPUT OUTPUT_RAW ORIGINAL_AUDIT CODED_AUDIT SUMMARY
```

MODE is integer 0 Rice or 1 rANS; POLICY is integer 0/1/2 as above. A literal
`-` disables an audit path. PLAN_CSV may be `-` in focused unit tests, but is
required in every measured pilot/full encode. It is a diagnostic output, not
an input plan or a decoder dependency. Emit one header and exactly one row per
RSD frame, ordered by zero-based ordinal, with this fixed CSV schema:

```text
frameOrdinal,blockSize,cheapRiceBytes,temporalRiceBytes,stackedRiceBytes,selectedRiceBytes,selectedSelector,coefficientBytes,predictiveResiduals,firResiduals,firUpdates
```

All values are unsigned decimal integers except unavailable T/H costs, which
are exactly `NA`. Policy 0 may skip T/H and emits NA; frames without predictive
residuals also emit NA. When C is off and T/H are identical, report the known
T cost in both columns, even though it was computed only once. All cost
columns are **complete serialized Rice frame bytes**, including the four-byte
frame length field; do not put payload-only scores here. CoefficientBytes is
0 or 10 for the selected path. PredictiveResiduals counts all fixed/LPC
residuals in the frame; FirResiduals is that count when selector bit 2 is set,
otherwise 0. FirUpdates is then the sum of `floor(subframeResidualCount/4)`
over predictive subframes, otherwise 0. SelectedSelector is the actual stored
0/1/2/4/5/6 byte. CSVs must be identical between Rice/rANS for a stem/policy.
Hash the CSV in receipts; keep it separate from original/coded audits.
Its writes and any scratch-plan construction are included in offline encode
cost, but it is not delivered and does not enter artifact byte accounting.

Native SUMMARY uses `format="issue77-round5-summary-v1"`, `mode`, `policy`,
and the existing common fields `recordCount`, `frameCount`,
`predictiveSubframes`, `manifestBytes`, `tableCount`, `tableBytes`, `sideBytes`,
`entropyBytes`, `bypassBytes`, `frameBytes`, `fileBytes`, `auditBytes`,
`originalAuditBytes`, `inputRecordCount`. Add `coefficientBytes`, `planRows`,
`cheapFrames`, `temporalFrames`, `stackedFrames`, `spatialFrames`,
`reference0Frames`, `reference1Frames`, `firFrames`, `predictiveResiduals`,
`firResiduals`, `firUpdates`, `firPredictionClamp`, `firCoefficientClamp`,
`firModularWrap`, `spatialPredictionClamp`, `spatialModularWrap`. PlanRows is
frameCount on measured encode and 0 on decode. Runtime counters describe only
the selected path and must match encode/decode; optional fit/search counters
are explicitly encoder-only. CheapFrames counts selectors 0/1/2, temporalFrames
4, stackedFrames 5/6, spatialFrames 1/2/5/6, and firFrames 4/5/6.

Keep the accounting identities explicit:
`frameBytes = 8*frameCount + sideBytes + 8*predictiveSubframes + entropyBytes
+ bypassBytes + coefficientBytes`, and
`fileBytes = 32 + manifestBytes + tableBytes + frameBytes`.
SideBytes retains original subframe metadata/padding; coefficientBytes counts
only extra spatial Q12 coefficients. Plan CSV, audits and receipts are outside
those delivery totals. Native errors return nonzero and remove partial outputs;
the wrapper validates intended PCM/manifest identities before verified promotion.

## Required controls, tests and provenance gates

Policy 0 must reproduce the final round-4 selected-profile artifact body,
manifest and tables exactly (header identity/profile fields differ). Pure T
Rice cost and coded predictor/residual transcript, projecting out new plan
fields, must agree with final round-3 P3 per frame. The root round-4
`root-frame-costs.csv` is an independently
audited cross-check of C and T, not a substitute for measuring H. Compare
complete actual lengths and both original/coded transcripts for all policies.
Extend coded transcripts with full selector bits and spatial coefficients;
require Rice/rANS to agree on selected pipeline, coefficients, residuals and k.

Independent integer-reference tests must exercise all six legal selectors,
both spatial directions, differing original LPC orders, lookahead/edge zeros,
FIR state resets, and the stacked inverse ordering. Include a constructed H
case that differs from both T and spatial-only and would fail if FIR used
original target history or spatial inversion happened first. Include signed
extrema, intermediate wraps, both stages' clamps, constant/verbatim and short
subframes, coefficient boundaries and exact padding. Test C/T/H ties and gains
of 0,1,31,32,33 bytes, and verify the chosen complete Rice frame length.

Retain malformed header/manifest/interval/record/table/payload/trailing-byte
gates. Add forbidden selector bits, direction=3, FIR under policy 0, FIR with
no predictive residuals, spatial direction on ineligible subframes, missing
or extra coefficients, and unknown policy/spatial profile. Mutating a legal
pipeline bit or coefficient must reject structurally or fail the intended
canonical digest; no unverified decoded output may be promoted as complete.

Finish code and relevant tests, then create a **separate gate freeze** for
the sanitizer build, inputs and commands. Run optimized and ASan/UBSan
synthetic gates and a complete frozen four-stem sanitizer pilot covering both
FIR policies under both coders. This gate freeze is allowed before the
optimized measurement freeze; sanitizer runs are not optimized timing results.
After those gates pass, create the optimized pilot freeze and subsequently
the full measurement freeze. Changes after gates require affected gates to
be rerun. Each applicable freeze records every executed/included native source,
runner, timing tool, independent audit source, compiler/flags/binaries/libm,
original catalog/maps/records, final prior receipts, exact configuration and
commands. Include the fixed policies/thresholds and existing fit/FIR parameters.
All dependencies must be validated at run startup, not merely recorded.

Use separate fresh freeze/run directories for pilot, full and timing; require
explicit frozen-resume validation. Reject changed source/helper/configuration,
wrong pilot IDs or coverage, wrong source-record/prior-receipt hashes, and
changed concurrency. Recheck source/dependency hashes at run completion before
accepting a receipt. A late code/provenance correction requires a fresh frozen
run; do not relabel earlier measurements with the new source hash.

## Bounded corpus run and final native timing

Use the same four full pilots, all three policies under Rice/rANS: **24 real
files**. After the gates pass, run all three policies under both coders on all
30 stems: **180 real full files**. No winner/threshold selection step or expanded
grid; measure both fixed policies even if one loses. Maximum stem concurrency
is four for screening. Every file must pass active byte count/SHA-256, each
original chunk digest, full canonical SHA-256 with exact gaps, original and
coded transcripts, strict EOF, and complete byte-component accounting.

Report per stem, four sessions and release: total/frame/side/table/entropy/
bypass/coefficient bytes; C/T/H or off/spatial/FIR/stacked frame counts; actual
FIR residual/update counts; selected spatial and FIR clamp/wrap counters;
encode/decode wall/user/system/RSS and whole-run wall. Compare thresholds by
both retained byte gain and avoided FIR work. The 26 nonselection stems are
additional coverage from the same four recordings, not independent sessions.

For the final cost comparison, run **three serial complete 30-stem trials**
for six fixed candidates: tuned FLAC/current 30-second chunks, established
WavPack `-hh -x6` concatenated, final round-3 P3 rANS, and round-5 policy
0/1/2 rANS. These are already materialized artifacts; no concurrent encoding
or other corpus experiments during timing. Fix deterministic shuffled orders,
verify/warm compressed inputs outside timing, decode to fresh active PCM files,
and perform identical untimed active/chunk/canonical checks afterwards.
Audits are disabled during timing. For multi-chunk FLAC, time the complete
per-stem decode sequence and output writes, summing child CPU and reporting
the maximum child RSS; disclose process/chunk layout rather than presenting
one child invocation as complete stem time. Use the prior native tools and
strict lossless flags. No full intermediate RSD is allowed for custom codecs.

Record each trial's summed release decode wall, user/system CPU, maximum
native child RSS, median/range across three trials, and whole-trial wall.
State that file output and process startup are timed; compressed hashing,
warming and PCM verification are outside the decode interval. These are warm
server decode-to-file results, not network, OPFS, fsync-to-verified-cache or
browser installation benchmarks. Do not reuse mismatched historical latency
as this controlled comparison. Native executable size is not Wasm transfer.

## Final artifact and completion

Deliver `round-05-report.md`, reproduction/source/tests and compact freeze,
validation/independent-audit/hash evidence, all pilot/full rows, frame-choice
cost audit, per-session/total components and final timing receipts. Keep audio,
compressed artifacts, transcripts, binaries and caches outside Git. Preserve
the original research report/evidence; the iterations ledger can link this
final result without rewriting the historical checkpoint.

The report must distinguish the final measured policies from ideal/model
estimates and explain all five rounds' evidence: entropy-only gain; temporal
prediction gain/cost; spatial gain/cost; actual stacking interactions; threshold
pruning; remaining per-stem regressions; and the byte/time tradeoff. Compare
complete delivery against published 434,311,756 bytes, tuned FLAC 425,415,665,
and WavPack 422,706,494. State whether any tested candidate achieves an extra
25% or 50%; negative results restrict these tested models/corpus, not all
lossless coding or future microphone recordings. Do not call FLAC or empirical
residual fits a universal entropy floor.

Give a research go/no-go recommendation grounded in actual byte savings and
native cost, with browser/Wasm/mobile/separated-corpus limitations explicit.
No production migration or publish readiness is authorized. Round 5 completes
only after all 24 pilot/180 full files, sanitizer/independent correctness gates
and the controlled final trials pass. A small or negative gain is a complete
research outcome; an unfinished experiment is not.
