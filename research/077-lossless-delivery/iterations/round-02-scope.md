# Round 2: actual context rANS versus Rice on identical FLAC residuals

Status: scoped from round-1 full-corpus measurements; not implemented or
measured. Astra scopes and Luna implements at the requester-selected effort.
This is the second of five sequential native research rounds. No production,
engine/app, browser, network, or mobile changes are in scope.

## Evidence and the one hypothesis

Round 1 reconstructed all 30 stems from independently serialized residual
records and reconciled every source FLAC frame bit. Preliminary full-run2
evidence is `/data/issue-77-lossless/iterations/round-01/full-run2/results.json`.
Use the finalized round-1 receipt/hashes when freezing this round. The complete
tuned FLAC control is **425,415,665 bytes**. Its 319,124,089 ordinary residuals
use 622,572,113 unary quotient bits (18.293% of delivery) and 2,744,193,154
remainder bits (80.633%); no corpus partition uses raw escape.

Summing **per-stem** models and retaining `controlBytes-frameBytes` unchanged
gives 423,310,378.444 modeled bytes for normalized quotient tables, versus
422,792,533.235 for causal quotient context: about 0.495% and 0.617% estimated
savings. Marginal remainder-bit fitting suggests only another 731,371.51
bytes, unencoded. Do not use the old pooled `total_model` result: it shared
tables across stems and omitted the unchanged envelope; reporting is being
corrected independently. These are limited-model estimates, not entropy floors.

**Hypothesis:** the context quotient model retains a small positive saving in
actual encoded files. Implement exactly two modes: a Rice control and that
context model using byte-rANS, with identical compact side information and
frame geometry. No predictor changes, new model search, remainder codec,
per-frame winner selection, or fallback optimization in this round. Rounds 3
and 4 remain available for stronger prediction even if this result is small.

## Implementation contract

New files belong under `iterations/round-02/`; scratch/builds/audio/artifacts
under `/data/issue-77-lossless/iterations/round-02/`. A native `round2.c`, a small
`round2.py`, and focused tests suffice. Reuse the checked round-1 record reader,
predictor restoration, and Python verification helpers **read-only**, either
by inclusion/import or explicitly attributed research-code reuse. Hash every
executed/included dependency. Do not refactor or modify round 1 or the original
research evidence. No generic codec/benchmark architecture is needed.

Read each finalized `full/<canonical hex>/stem.rsd`, verify its byte length and
frozen SHA-256, and preserve every block, assignment, subframe type, wasted-bit
count, warmup, coefficient/precision/shift, residual, Rice method/partition/k,
and original active interval. The implemented round-1 record header includes
source chunk index, packed start, source frame offset and source frame length;
read the current code rather than assuming the earlier suggested layout.
Source offsets/FLAC byte lengths are extraction provenance and need not be
transmitted by this new format. Validate original chunk boundaries and frame
continuity before dropping those redundant provenance fields.

Encode **one independently decodable file per stem per mode**. The decoder
consumes that file alone and emits bounded stereo s24le PCM blocks; the wrapper
uses its embedded exact interval map to verify the full canonical SHA-256.
Decoder use of original FLAC, RSD, PCM, histograms, or external model tables is
forbidden. Reusing the round-1 native predictor routines inside this decoder
is appropriate. Do not decode through a full intermediate RSD during timing.

## Compact experimental format

Freeze the implemented byte/bit layout before measurement. The following is
the intended format; minor mechanical simplifications before freezing are
allowed if they keep matched side information, bounded decoding, and complete
accounting. Document any difference explicitly.

* Header: magic `I77ENT02` (8 bytes), `u8 mode` (0 Rice, 1 context rANS),
  `u8 profile=1` (stereo 24-bit/44.1 kHz), `u16 flags=0`, `u64 manifestLength`,
  `u64 recordCount`, `u32 tableCount`. Integers are little-endian.
* Embed the original published manifest bytes verbatim, followed by model
  tables and frame records. Its interval/PCM fields remain authoritative; its
  compressed FLAC fields are **source provenance**, not offsets/hashes of the
  new payload. The experimental magic distinguishes this from production.
  No second manifest/index is required. Validate the embedded manifest and
  intended canonical identity in the wrapper before declaring verified output.
* Rice has `tableCount=0`. rANS tables are sorted unique `(role,k,context)`
  triples (three u8 keys), each followed by seventeen u16 frequencies. Only
  nonempty groups are sent. Tables are per stem, not shared between stems.
* Frame: `u32 bodyBytes`, `u16 blockSize`, `u8 assignment`, `u8 flags=0`, then
  two subframes. `bodyBytes` counts all bytes after its own four-byte field.
  Preserve the 39,562 source frames. Sequential block sizes determine packed
  starts; the embedded source chunk frame counts retain reset boundaries.
* Bit-pack each subframe's side information using FLAC field widths: its
  eight-bit header/type/order, wasted-bit unary field, warmups at reduced
  channel depth, LPC precision/shift/coefficients, residual method and
  partition order. Store **all** partition parameters contiguously here,
  each at the original four/five-bit width, with the five-bit raw width for
  escape parameters. This relocation of partition fields is intentional.
  Follow with zero padding to the next byte. All bit fields are MSB first.
  Constant/verbatim subframes include their signed values at the original
  reduced depth in this common section and end after its padding.
* Each fixed/LPC subframe then contains `u32 entropyBytes`, `u32 bypassBytes`,
  followed by those two bounded byte strings. These fields exist in both
  modes, so their overhead is matched. The sample/partition counts determine
  valid payload bit counts; require only the final 0..7 zero pad bits and no
  extra bytes. No residual sample count or table ID per sample is needed.

For Rice mode, `bypassBytes=0`; entropy bytes contain the original partition-
ordered Rice residual payload: q zero bits then one, followed by k remainder
bits. Raw-escape partitions contain signed values at their original raw width,
including zero width. Do not include partition headers a second time.

For rANS, entropy bytes contain only ordinary Rice quotient symbols. The bypass
bitstream is traversed in original residual order: an ordinary symbol below
16 contributes its k remainder bits; symbol 16 contributes the actual q as
32 unsigned bits followed by the k remainder bits. Raw-escape partitions
contribute their signed raw-width residuals and no rANS symbols. A subframe
with zero ordinary symbols has `entropyBytes=0`; otherwise it has one rANS
state and stream. Predictor warmups are never entropy-coded as residuals.

All exact metadata, manifest, table, length, state, padding, escape, and payload
bytes count. Report total file length and its complete component decomposition;
do not retrofit the round-1 nominal state/padding budget to measured bytes.
Matched Rice overhead versus native FLAC is a separate visible result.

## Frozen probability model and byte-rANS

Use the round-1 definition exactly: fold signed residuals with wide arithmetic
to u32; `q=u>>k`; symbol `min(q,16)`. Role is left/right/mid/side. Context is
`min(previous q,3)`, with class 4 at **each Rice partition start**; reset also
when entering a new subframe. Use the actual q after reading an escape, not
the escaped symbol, when updating context. Keep all k values unchanged.

Build histograms from the stem's RSD in a bounded first pass, then encode in a
second pass. Include both passes in offline encode cost. Frequencies sum to
4096: reserve one for each observed symbol, allocate the remaining count
proportionally to observed counts, and assign largest remainders with symbol
index tie-breaking. Use exact integer arithmetic for normalization so tables
are reproducible. Zero-frequency symbols have zero width and are never coded.
Decoder tables come solely from the file; unseen groups are errors.

Use one 32-bit byte-rANS state per ordinary-residual subframe, scale bits 12,
`L=1<<23`, initially `x=L`. Visit symbols **in reverse**, using contexts
computed from the original forward order within that bounded subframe. For
frequency f and cumulative c, emit low bytes while
`x >= ((L>>12)<<8)*f`, shifting x down eight bits each time; then set
`x=(x/f)*4096+(x%f)+c`. Serialize final x as little-endian u32 followed by
the emitted bytes in reverse emission order. A backward output buffer is
convenient. Use wide intermediates/checks where required.

Decode slot `x&4095` to its symbol and set
`x=f*(x>>12)+slot-c`; append input bytes while `x<L`. After the known ordinary
sample count, require terminal state exactly L and exact byte exhaustion.
Validate the starting state's range, every table sum/key/frequency, every
renormalization read, and reconstructed folded integer range. A 4096-entry
symbol lookup per present model or a small bounded search is acceptable;
freeze the selected implementation. Do not pull in another compression library.

Keep only bounded records/sample arrays, tables, and coder buffers. Limits:
65,535 frames per block, 1 MiB source RSD record, 4 MiB encoded frame body,
manifest at most 1 MiB, at most `4*31*5` tables. Reject lengths before allocating
or reading beyond a record. The research profile may reject a pathological
Rice payload exceeding this bound; all frozen corpus records must work.
Do not silently clip, change k, or omit a failing stem. Rice raw widths are
0..31; ordinary k is 0..30. Signed predictor arithmetic and stereo parity
must retain round-1 exactness, including extrema and negative shifts.

## Validation, measurements, and completion

Use the same four complete pilot stems as round 1, then all 30. Freeze the
final round-1 evidence/record identities, new/included code, compiler flags
and version, binary/library hashes, exact format/model limits and commands,
catalog/maps, worker count, and output variants before measured runs. Reject
changes after freeze. Pilot/debug and measured directories remain separate.

For all 60 candidate/stem files, require strict EOF, complete encoded component
accounting, exact active byte count/SHA-256, every original chunk PCM digest,
and the full original canonical SHA-256 after zero-gap reconstruction. Also
compare an encoder-input versus decoded canonical transcript of block geometry,
predictor side information, partitions, and residual i32 values. A bounded
audit stream on scratch hashed by Python is sufficient; omit only redundant
source FLAC offsets/byte lengths. This proves the controlled residual comparison
directly, rather than relying only on equal PCM. Audit-output cost must be
identified; disable audit streams during separate decode-speed trials.

Tests must cover the existing exact predictor/stereo/LSB/wasted-bit cases and
new coder cases: one-symbol tables, zero-frequency entries, context resets,
mixed k/partitions, q>=16, k=0 and k=30, raw escape width zero, short blocks,
signed folding extrema, and valid byte-rANS round trips including renormalizing
streams. Include explicit known-sequence fixtures independent of the encoder.
Reject corrupt/duplicate/oversized tables, sum !=4096, bad state, truncated
entropy or bypass data, altered coefficients/residual payload (parse or final
hash failure), nonzero padding/flags, trailing bytes, and excessive lengths.
Run ASan/UBSan on these gates and pilot fixtures with a separately identified
build. No corrupted output may be reported verified or renamed as complete.

Record native encode/decode wall, user/system CPU, maximum RSS, output bytes,
and whole-run elapsed wall with at most four stems admitted. These are native
research costs. Additionally run three serial, deterministic shuffled decode
trials on the same four pilots for custom Rice, rANS, and pinned libFLAC.
Each decodes to a fresh raw file with warm compressed input; use identical
post-decode hash/byte checks and report whether their time is inside/outside
the timed interval. Exclude audit transcripts from these timing trials. Report
native process RSS separately from wrapper/page-cache memory; do not equate
this with browser/OPFS preparation. One full-corpus pass plus these trials is
sufficient; no optimization marathon or whole-corpus parameter search.

Deliver `round-02-report.md`, source/tests/reproduction commands, and compact
freeze/results/hash evidence with per-stem, four-session, and release totals.
Report measured rANS minus matched Rice (entropy effect), matched Rice minus
tuned FLAC (common format effect), and rANS versus tuned FLAC/published/WavPack
(complete delivery effect). Explain the gap from round-1 model predictions
using actual tables, rounding/states, bypass escapes, and framing. Preserve
negative stem results. An optional per-stem minimum of the two measured modes
must be labeled a selection of existing artifacts, with no uncharged selector.

Round 2 completes only when all 60 actual files pass the transcript/PCM/count
gates and all overhead is charged. Its handoff to round 3 should identify
which stems still dominate delivered bytes and the largest remaining predictor
hypothesis. This experiment may establish a modest actual gain or a negative
result; it cannot establish whether other prediction/model families can or
cannot reach the user's additional 25–50% aspiration.
