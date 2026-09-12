# Round 3: bounded adaptive prediction of FLAC residuals

Status: scoped from actual preliminary round-2 artifacts; implementation and
measurement remain outstanding. Astra scopes; Luna implements at the requested
effort. This is research round 3 of 5, with no production/browser/mobile work.

## Evidence, hypothesis, and fixed comparison

Round 2 produced 30 complete files in each mode, with exact active, chunk,
canonical PCM and residual/predictor transcript checks. Preliminary results
are `/data/issue-77-lossless/iterations/round-02/full-run1/results.json`:

| Complete delivery | Bytes |
| --- | ---: |
| Tuned FLAC | 425,415,665 |
| Matched custom Rice | 426,056,035 |
| Context rANS | 423,304,009 |
| Earlier WavPack `-hh -x6` | 422,706,494 |

rANS saves 2,752,026 bytes against matched Rice and 2,111,656 (about 0.496%)
against FLAC after 640,370 bytes of common format overhead. Its bypass stream
still occupies 343,329,111 bytes. This supports testing stronger prediction;
another quotient-table variation is not the main hypothesis of this round.
The preliminary audited parallel decode timings are not controlled speed
comparisons. Pin **final** round-2 source, evidence and artifacts when freezing
round 3, because a final round-2 rerun is required after the last code fixes.

Round-1 residual correlations are small but nonzero: r2/drums has approximately
-0.107/-0.081 at lags 1/2, r3/drums -0.098/-0.120, r3/bass +0.170 at lag 16,
and r4/bass +0.171 at lag 1. These are averages of normalized subframe
correlations, not sample-weighted pooled covariance or predicted byte savings.

Test one causal adaptive FIR correction of the **original FLAC residuals**.
Preserve original frame/stereo/predictor geometry, type, wasted bits, warmups,
coefficients, and intervals. The extra predictor's coded errors change; its
inverse must restore the original residuals before original LPC/fixed
restoration. Constant and verbatim subframes remain unchanged. No repeat search,
cross-stem state, new sparse map, quantization of delivered PCM, or model grid
beyond the four configurations below.

## Small implementation and format contract

New source/tests/runner live under `iterations/round-03/`, scratch under
`/data/issue-77-lossless/iterations/round-03/`. Define `I77_ROUND2_NO_MAIN` and
include the finalized read-only `round-02/native/round2.c` to reuse records,
entropy kernels, side information, and checked PCM restoration. Add only the
FIR transform/inverse, common Rice parameter selection, profile header, and
the necessary orchestrating/audit functions. Do not modify earlier rounds or
the original research evidence, and do not build another codec framework.

Use the round-2 layout with magic `I77FIR03`. Its 32-byte header is: magic[8],
u8 entropy mode (0 Rice, 1 rANS), u8 shape profile=1, u8 predictor profile,
u8 reserved=0, u64 manifest length, u64 record count, u32 table count. The two
profile/reserved bytes replace round 2's zero flags. Predictor profiles are:
0 disabled, 1 M=8/b=3, 2 M=8/b=5, 3 M=32/b=3, 4 M=32/b=5. Reject all others.
All integers remain little-endian. The embedded manifest, sorted per-stem
4096-frequency tables, frame structure, and entropy/bypass formats otherwise
remain unchanged. Profile selection is transmitted in every artifact; no
learned coefficients or external initial state are required.

The ordinary native decoder reads the artifact alone, decodes its error
residuals, applies the inverse below inside each bounded subframe, then calls
the existing original predictor/stereo restoration. It emits bounded PCM
blocks directly. No full intermediate RSD or subprocess pipeline is allowed
in decode-speed trials. Retain all round-2 size, table, block, and read bounds.

## Exact adaptive transform

For each fixed/LPC subframe independently, let t=0 index its first residual;
do not insert original LPC warmups into this filter. Initialize M coefficients
`a[j]=0` (signed Q20), M original-residual history values `h[j]=0`, and
`E=1+sum(h[j]^2)=1`. History j=0 is the most recent residual. Use a ring buffer.
Reset at every new subframe, including frame/chunk boundaries. Do **not** reset
at Rice partition boundaries; that reset belongs only to the entropy context.

For enabled profiles, encoder and decoder perform exactly these steps:

1. Compute `s=sum(a[j]*h[j])`, then
   `p=clamp_i32(floor(s/2^20))`. Floor means toward negative infinity.
2. Encoder receives original signed i32 residual r and emits the signed i32
   representative of `(u32(r)-u32(p)) mod 2^32`, called e. Decoder receives e
   and reconstructs r as the signed representative of
   `(u32(e)+u32(p)) mod 2^32`. Map u>=2^31 to `i64(u)-2^32` explicitly.
   This modular lifting is exact at signed extrema; it is not PCM clipping.
3. Compute the true learning error `d=i64(r)-i64(p)`, **not** the possibly
   wrapped e. At t=3,7,11,... only, let `ell=ceil(log2(E))`, equivalently the
   bit length of E-1 with ell=0 for E=1. For every j compute
   `delta[j]=trunc_zero((d*h[j]*2^20)/2^(ell+b))`, then
   `a[j]=clamp(a[j]+delta[j], -2^20, +2^20)`. Use the same old history, E, and
   d for all coefficient updates; p is not recomputed during the update.
4. Replace the oldest history value with reconstructed **original r**, update
   E by subtracting the old square and adding r squared, advance the ring,
   then t. Never feed coded errors into the history.

Disabled profile emits r directly and has no adaptive state. Keep Q20, update
cadence 4, coefficient limits, and both rounding directions fixed. This is a
power-of-two approximation to normalized LMS, with no claimed convergence or
entropy guarantee. Do not introduce another error clip, leakage, bias term,
state reuse, predictor selection per frame, or hidden learning-rate search.

Arithmetic bounds are part of the contract: M<=32 and |a|<=2^20 give
|s|<=2^56, fitting signed64. Original h is signed32; `E<=1+32*2^62<2^68`, so
store it in unsigned128. |d|<2^32 makes the signed update numerator magnitude
less than 2^83; signed128 suffices. Compute multiplications before division
with these types; do not left-shift a negative integer. Implement floor and
truncation explicitly, avoid `clz(0)`, and clamp coefficients before narrowing.
Track prediction-clamp, coefficient-clamp, modular-wrap, and update counts;
all must agree on encode/decode. A wrap or clamp is permitted and reported,
not silently treated as an impossible input or a reason to omit a stem.

## Shared coding control and exact k selection

For every fixed/LPC subframe in **all profiles**, preserve partition order
and first-partition sample subtraction, set residual method to Rice2, clear
raw widths, and choose k in 0..30 separately per original partition. This
common profile can code any i32 correction error without a raw-width-32
escape. It also applies to disabled control, including synthetic source raw
partitions. Constant/verbatim bypass this change.

Fold residual r or error e to unsigned u with the checked round-2 rule.
Choose k minimizing the actual Rice payload
`C(k)=n*(k+1)+sum(u>>k)`, choosing the smaller k on equal cost. One efficient
exact search uses the monotone difference
`C(k+1)-C(k)=n-sum(ceil((u>>k)/2))`: binary-search the first nonnegative
difference for k=0..29, otherwise choose 30. Empty partitions select 0.
Use wide arithmetic, especially `(q+1)/2` when q can be UINT32_MAX. Test this
search against exhaustive 31-choice costs on deterministic small vectors.

Rice and rANS must receive identical transformed residuals and selected k
for a given profile. rANS retains the **unchanged** round-2 17-symbol,
role/k/previous-quotient model and bypass rule, with its tables trained solely
on that stem's new sequence. Do not optimize k separately for rANS. Recompute
the transform from reset state in both native encoder passes; include model
building/retuning and both passes in offline encode metrics. The control's
retuning/Rice2 overhead must be measured against round 2 separately from the
FIR's gain against that control.

## Pilot selection and bounded full pass

First freeze code/configuration and run the same four complete round-1 pilots
(r1/bass, r2/drums, r3/lead-vox, r4/synth), all five profiles and both coders:
**40 actual encoded/decoded files**. These are pilot results, not corpus
estimates. Select one enabled FIR profile by smallest sum of complete rANS
file bytes over those four pilots; break ties by lower numeric profile ID.
Do not select separate profiles per stem, session, or entropy mode.

Freeze that selected profile and the actual pilot selection receipt before
the full pass. Run disabled plus selected FIR, each with Rice and rANS, on all
30 stems: **120 actual files**. Even if every FIR pilot loses, carry the best
enabled FIR through this bounded full pass and report the negative result.
Show the 4 selection stems and remaining 26 separately as well as normal
per-stem, four-session, and total reports. Do not broaden the grid in response
to an unfavorable result. Maximum native stem concurrency remains four.

## Exactness, auditing, timing, and completion

Every pilot/full artifact must independently pass strict structure/EOF and
complete byte-component accounting, active length/SHA-256, each original
chunk PCM digest, and the full canonical SHA-256 including exact zero gaps.
Retain all interval/channel/LSB gates and authenticate the intended manifest.

Use two bounded audit transcripts: (a) original predictor geometry/metadata
and original residuals, before transform versus after inverse; and (b) coded
predictor/partition metadata and error residuals, after retuning versus just
after entropy decode. For (a), exclude the Rice method/k/raw-width fields that
are intentionally replaced, but include partition geometry. Existing round-2
audit layout can serve (b). Also require (b) to match between Rice and rANS
for the same stem/profile. Hash audit streams in the wrapper, keep them on
scratch, and exclude all audit writes from separate decode-speed trials.

Add focused independent Python-integer reference vectors for transform and
inverse, coefficient updates at exactly every fourth sample, positive/negative
rounding, zero/impulse/alternating/extreme residuals, clamp/wrap paths, resets,
and sequence lengths smaller than M. In particular test that decoder history
uses restored original residuals and that partition changes do not reset the
FIR. Reject unknown profiles/flags and retain malformed length/table/padding
and truncation/trailing-byte gates. Corrupt a profile or payload and require
rejection or canonical hash failure. Test k-search ties, k0/k30, and original
raw-escape width zero. Optimized and ASan/UBSan gates must pass; run a complete
four-stem winning-profile sanitizer pilot before the full measured pass.

Freeze final included sources, binaries/compiler/flags, original records/maps,
final round-1/2 evidence, model/format limits, pilot IDs/configurations, commands
and concurrency. Reject post-freeze changes; measured source changes require
a fresh freeze/run. Record native encode/decode wall, user/system CPU and RSS,
whole-run elapsed wall, table/payload/state/side bytes, and adaptive counters.
Audited screening timings are research costs, not install performance.

After the full pass, run three serial, deterministically shuffled, audit-free
decode trials on the four pilots for disabled/FIR under Rice/rANS. Add the
final round-2 rANS artifacts as the reference so retuning and FIR costs remain
separable. Decode to fresh PCM files with warm compressed inputs and identical
untimed digest/count verification; state the timing boundary and child-only
RSS clearly. Browser/OPFS/network and decoder download size remain unmeasured.

Deliver `round-03-report.md`, reproduction/source/tests and compact frozen
evidence: all pilot/full per-stem rows, four-session/total components, selection
receipt, exactness/audit/metrics/counters, validation and evidence hashes. Do
not commit audio, artifacts, transcripts, binaries, or caches. Report disabled
retuning versus round 2, FIR versus disabled under each coder, and complete
delivery versus tuned FLAC/published/WavPack. Completion requires the 40 pilot
and 120 full-file gates, not a positive saving. Handoff to round 4 must identify
whether this predictor reduced actual bytes, where it regressed, its native
cost, and one distinct remaining hypothesis; no claim of a universal floor.
