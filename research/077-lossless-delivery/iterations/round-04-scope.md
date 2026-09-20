# Round 4: offline stereo residual prediction with charged coefficients

Status: final scope, not yet implemented/measured. Astra scopes; Luna
implements at the requested effort. Research round 4 of 5; no production,
engine/app, browser, network, or mobile changes.

## Actual evidence and the distinct hypothesis

Round 3 is verified at
`/data/issue-77-lossless/iterations/round-03/full-final/results.json`, freeze
`4aab18dbc93f457f280596bee3ba11398da68c4408ba3d6b697ade6b6a650265`.
All 120 full files passed root verification, plus 40 pilot and 8 sanitizer
files. The selected temporal predictor is P3, M=32/b=3:

| Complete delivery | Bytes |
| --- | ---: |
| Round-3 disabled Rice | 426,116,798 |
| Round-3 disabled rANS | 423,396,564 |
| Round-3 FIR Rice | 424,438,980 |
| Round-3 FIR rANS | 421,773,671 |
| Tuned FLAC | 425,415,665 |
| Earlier WavPack `-hh -x6` | 422,706,494 |

FIR saves 1,622,893 bytes against disabled rANS, but regresses r1/vocal-fx
by 182,272 bytes, r3/synth-2 by 132,274, r1/fx by 73,622, and r2/fx by 27,284.
The final three-trial native serial medians over four pilots are 7.835196 s
for FIR rANS versus 2.240367 s disabled rANS, about 3.5 times slower; see
`round-03-evidence/timing.json`. These are native decode-to-file timings, not
browser installation results. Its 79,759,993 updates and 17,979 coefficient
clamps support testing a cheaper decoder whose fitting happens offline.
No prediction clamps or modular wraps occurred.

Test **cross-channel residual prediction**, using one complete bounded
reference residual channel to predict the other. This adds weighted/lagged
stereo information beyond the existing FLAC assignment and temporal LPC.
FLAC already decorrelates stereo; useful remaining dependence is a hypothesis,
not assumed headroom. Apply no round-3 adaptive FIR here: compare spatial
prediction alone against its disabled control. Combination/pruning belongs
to round 5 after the actual results.

## Reuse, profiles, and framing

Add only `iterations/round-04/` code/tests/runner. Scratch belongs under
`/data/issue-77-lossless/iterations/round-04/`. Include finalized
`round-03/native/round3.c` read-only with `I77_ROUND3_NO_MAIN`, reusing its
record reader, exact k selection, original/coded audits, entropy kernels and
PCM restoration. Preserve earlier source, scopes, evidence and all canonical
inputs. No general fitting/codec framework or external numerical library.

New magic is `I77XCH04`. Reuse the round-3 32-byte header and reinterpret its
predictor-profile byte: 0 disabled; 1 one tap at lag 0; 2 five taps at ordered
lags [-2,-1,0,1,2]. All other header/table/manifest semantics remain unchanged.
In each frame's existing four-byte prefix, replace the reserved zero byte
with a selector: 0 disabled, 1 reference channel 0 predicts channel 1,
2 reference channel 1 predicts channel 0. Reject other values. Profile 0
requires selector 0. A nonzero selector is immediately followed by one/five
signed little-endian i16 Q12 coefficients, then the existing two subframes.
Selector 0 has no coefficient bytes. Every field and table is in the one
independently decodable per-stem file and counts in its complete length.

All original frame boundaries, FLAC assignments, predictor types/orders,
warmups, precision/shift/coefficients, wasted bits, and intervals are fixed.
Use the round-3 disabled Rice2/k rule for every fixed/LPC subframe. Only the
selected target's coded residuals change. Constant/verbatim remain unchanged;
a frame is eligible for cross prediction only when **both** subframes are
fixed/LPC with nonempty residual arrays. Otherwise selector must be 0.

The disabled control must match the final round-3 P0 artifact **after its
eight-byte magic**, under each entropy mode. This exact control check catches
accidental framing/model changes; existing per-stem total lengths also match.

## Alignment, offline fit, and quantization

For either direction, let target residual i correspond to absolute frame
sample `t=target.order+i`. The feature for lag d is reference **original FLAC
residual** `reference.data[t+d-reference.order]`, or zero when the index lies
outside its residual array. Original LPC warmups do not become residual
features. Different orders and all frame-edge cases use this same rule.
Reference lookahead of at most two samples is permitted because its whole
residual array is already decoded within the bounded frame. There is one
reference and one target, never a cycle or a dependency on another frame.

For each eligible direction, fit y=target original residual against those
one/five x features, without an intercept. Accumulate double-precision
`G[j,k]=sum(x[j]*x[k])` and `v[j]=sum(x[j]*y)` over all target residuals in
ascending sample order. Cast samples to double **before** multiplying. Compute
the upper triangle in a documented fixed loop order and mirror it. If trace(G)
is zero, the candidate is disabled. Otherwise use the single fixed ridge
`lambda=(trace(G)/tapCount)*2^-16` and solve `(G+lambda*I)*a=v` with a tiny
Cholesky/forward/backward solve. No ridge/order grid or data-dependent solver
choice. A nonfinite value or nonpositive Cholesky pivot disables that candidate
and increments an encoder-only fit-failure counter; never emit nonfinite data.

Clip each floating coefficient to [-4,+4], then quantize to signed Q12:
`sign(a)*floor(abs(a)*4096+0.5)`, nearest with half ties away from zero.
The transmitted i16 lies in [-16384,+16384]; decoder rejects values outside
that range. There is no transmitted float and no fitting in the decoder.
All-zero quantized coefficients can immediately disable the candidate.
Pin compiler/libm and use `-fno-fast-math -ffp-contract=off` so offline fit
evaluation order is reproducible in the frozen environment. Decoder exactness
depends only on transmitted integers, not floating-point reproducibility.

## Exact correction and charged per-frame choice

For each target residual, compute signed64
`s=sum(coeffQ12[j]*originalReferenceFeature[j])`, then
`p=clamp_i32(floor(s/4096))`. Encode target error e as the signed i32
representative of `(u32(targetOriginal)-u32(p)) mod 2^32`. Decode targetOriginal
with modular addition. Use the round-3 explicit signed mapping/floor rules;
no implementation-defined negative shifts or signed overflow. With at most
five coefficients of magnitude 16384 and signed32 features, |s|<2^48, so
signed64 is ample. Prediction clamping and modular wrapping remain exact
because the inverse uses the same p; record selected-path counts on both sides.

Within each enabled profile, evaluate exactly three choices per eligible
frame: disabled, reference 0, reference 1. Quantize **before** evaluating
compressed cost. For every choice, retune Rice2 k on the unchanged partitions
using round 3's exact minimum-Rice rule. Score the sum of both subframes'
actual Rice payload byte lengths, plus **2*tapCount coefficient bytes** for
a nonzero selector. A predictive subframe's Rice length is
`ceil(sum_over_partitions(n*(k+1)+sum(u>>k))/8)`; preserve actual subframe
rounding, rather than rounding every partition. Other frame/header/side/length
bytes are identical between the choices and cancel, including the selector
byte already present in every frame. Prefer disabled on a tie, then reference
0, then reference 1. Verify the score against actual serialized Rice frames
in tests. This selection includes its complete incremental metadata cost.

Use that **same** selected direction, quantized coefficients, error residuals,
and k values for Rice and rANS. rANS table/model/bypass definitions remain
unchanged and are trained only on this stem's resulting residual sequence.
Do not make a separate rANS direction decision or use uncharged cross-stem
tables. Reproduce fitting/selection identically in both encoder passes, or
retain a bounded-record scratch plan whose selected coefficients/flags all
appear in the final artifact. Include all fit/plan/model passes in offline
encode cost. The local Rice choice guarantees no extra Rice frame bytes;
it does **not** guarantee an rANS stem improvement after model/table changes.

Decoder reads coefficient metadata and both bounded entropy subframes, checks
the selector's eligibility, then restores the selected target's original
residuals from the unchanged reference. It must not use the reference's coded
errors from any temporal transform. Only after this inverse should it run
original LPC/fixed, wasted-bit and stereo restoration. Emit bounded PCM
directly; no intermediate full RSD, floating-point decode, or adaptive state.

## Pilot, full pass, audits, and useful timing

Freeze the exact code/dependencies/tools/configuration and use the same four
complete pilots (r1/bass, r2/drums, r3/lead-vox, r4/synth). Run profiles 0/1/2
under Rice/rANS: **24 materialized pilot files**. Select profile 1 or 2 by the
smallest aggregate actual pilot rANS file size, choosing 1 on ties. Freeze the
selection receipt, then run disabled plus the selected enabled profile under
both coders for all 30 stems: **120 actual full files**. Complete this pass
even if the enabled profile is unhelpful. Do not broaden the grid. Report the
four selection stems and other 26 separately as additional coverage; they
share the same four recordings and are not independent held-out sessions.

All files require strict structure/EOF, exact component accounting, active
byte count/SHA-256, every original chunk PCM digest, and full canonical SHA-256
with the frozen zero gaps. Require original predictor/residual transcripts
before correction and after inverse to match. Extend the coded transcript
with each frame selector and ordered signed coefficients, followed by its
coded metadata/residuals. It must match encoder/decoder and Rice/rANS for the
same stem/profile. Keep audio/transcripts/binaries/artifacts on scratch only.

Record disabled/reference-0/reference-1 frame counts, coefficient bytes,
selected prediction-clamp/modular-wrap counts, entropy/table/bypass/side bytes,
and exact file totals. Record fit-degenerate/failure/coefficient-clipping counts
as encoder-only diagnostics; the decoder does not repeat fitting. Require
selected-path counters to agree between encoder and decoder. Keep fit failure
coverage visible rather than silently excluding frames or stems.

Focused tests must independently specify known scalar/lagged stereo vectors
and integer predictions/inverses, different LPC orders, missing features at
both edges, both directions, zero/duplicate/rank-deficient features, coefficient
quantization ties/limits, short blocks, signed extrema/clamps/wraps, off-on
ties, and coefficient-cost rejection of a small raw residual improvement.
Check the tiny solve against independent analytic/constructed cases without
requiring a numerical package. Retain round-3 exactness/corruption/length/table
gates and add invalid profile/selector, coefficients on an ineligible frame,
out-of-range coefficients, truncation inside coefficients, and coefficient
or direction corruption. Require rejection or final canonical hash failure.
Optimized and ASan/UBSan gates plus a complete four-stem selected-profile
sanitizer pilot must pass **before** the frozen full run.

Freeze final prior evidence/record identities and every included source/tool,
model/format bound, compiler/flags, pilot/selection receipt and commands.
Maximum stem concurrency remains four. Reject any post-freeze code/input change
and rerun after a fresh freeze if changes are necessary. Record offline encode
and audited decode wall/user/system/RSS plus whole-run wall. These are native
research costs. After verification, run three serial, deterministically
shuffled audit-free decode trials on the four pilots for disabled/spatial
under Rice/rANS, plus final round-3 P3 rANS. Use warm compressed inputs, fresh
PCM output, and identical untimed digest/count checks. Child RSS excludes
wrapper/page cache; no browser/OPFS/network or release-readiness claim.

Deliver `round-04-report.md`, reproduction/source/tests, compact freeze and
selection/validation/hash evidence, pilot/full per-stem rows, four-session
and complete totals. Compare spatial versus disabled under each coder, actual
results versus round-3 FIR and earlier FLAC/WavPack, metadata paid versus Rice
payload saved, per-stem regressions, and native cost. Round 4 completes when
all 24 pilot/120 full files and audits pass, whether or not it beats FIR.
Hand round 5 the supported components and exact regressions for a bounded
combination/pruning experiment with controlled final timing.
