# Admit sparse stem packages and read bounded packed PCM windows

Status: attempt 2 at `b90a182` received Astra medium FAIL for residual derivation admission; bounded attempt 3 authorized below. Matching adapter GitHub issue: #54. Luna xhigh implements; an independent Astra medium adversarially verifies. Maximum five coherent attempts. No production delivery claim until the successor cache/network/app issues are complete.

## Problem and smallest closable capability

The adapter assumes a whole native FLAC object and dense canonical PCM Blob. The selected production path needs an independently testable, strict transport contract and exact bounded packed-PCM timeline reads. Ship exported admission/serialization and interval-read helpers using synthetic data. This issue changes no network/session/store path, requires no Rust edits, and does not publish or upload artist assets.

Baseline adapter 338b633b1971f699147643536cd8c8060a81b4ce. Existing reusable seams: src/stems/identity.ts, types.ts, pump.ts, errors.ts, stems/index.ts. Add focused sparse-format.ts and sparse-pcm.ts modules, exports, tests and short contract documentation. No generic ZIP library or new workspace package.

## Frozen wire contract

One blob: header16 + UTF8 JSON index + concatenated native FLAC unit objects. Magic first8 ASCII MISOSPC1; bytes8..11 uint32LE index length; bytes12..15 zero. Index exactly `{format:'miso_sparse_stems_v1',sources:[...]}`. Each source exactly `{identity,sampleRateHz,channels,bitDepth,frames,units}`. Each unit exactly `{startFrame,frames,offset,bytes,flacSha256,pcmSha256}`. Offsets relative to start of unit payload. Identity syntax `sha256:[0-9a-f]{64}`; digests bare lowercase hex64. JSON encoded deterministically with recursively sorted lexical keys, no whitespace/BOM and integer numbers; accepted encoding must equal canonical re-encoding (including unknown-key/schema rejection), so duplicates cannot be interpreted differently. UTF8 decoding is fatal for invalid sequences. Validate the fixed-depth shape before canonical serialization; never recursively sort arbitrary untrusted objects. Reject empty sources arrays.

Index <=8MiB; between1 and1024 sources; <=65536 units total; each compressed unit <=2MiB and <=one second of frames; total object <=8GiB. Index nonempty. Sources positive native frames, supported sample rates44100/48000/88200/96000, channels1/2 and integer depth16/24. All byte/frame arithmetic checked safe integer. Unique sources sorted identity; units positive lengths sorted timeline, nonoverlapping and wholly within source. Empty unit array means all-silent source. In global source/unit order offsets must exactly cover payload with no holes, aliases, trailer or overlap. Actual object length must equal header+index+payload. No channel maps. Implicit intervals are zero; short zero runs may remain active. Parser does not infer zero data from compressed bytes.

Expose a bounded Blob-backed parser that reads only the16-byte header then admitted index, not whole object arrayBuffer; return an immutable validated manifest and dataStart. Provide deterministic serializer/build validation useful to the CLI. Expose a binder checking exact identity/source-shape equality to authoritative session expectations. Decoder/content hash verification remains the resolver's responsibility in the successor issue; parser validation alone must never use naming implying verified PCM.

## Sparse PCM index and reader

A derived cache index stores source identity/shape and active intervals `{startFrame,frames,byteOffset}`; offsets form a contiguous packed-PCM payload, with bytesPerFrame=channels*(bitDepth/8). It is separately tagged `miso_sparse_pcm_v1`; do not reuse compressed offsets or mutate transport metadata. Adjacent timeline intervals coalesce. Derivation returns exact activeBytes and canonicalBytes, and validates actual packed Blob size before admitting a reader. All-silent sources require a zero-byte Blob and empty intervals.

Implement a bounded canonical-window helper taking validated index, packed Blob, startFrame and frameCount<=8192. Reject unsafe/out-of-range requests. Return zero-initialized canonical integer bytes for the exact requested logical range. Binary-search first intersecting interval and copy only active data. Prefer one contiguous packed Blob slice covering active intersections: packed intervals omit all gaps, so total read cannot exceed output length. This avoids per-interval concurrent requests and keeps one window's temporary source bytes <=window canonical bytes. No Blob read for an all-gap window. Short active reads reject rather than remain zero. Document caller ownership of generation checks and physical-read admission; this pure helper does not create background concurrency or cancellation state machines. It must accept empty window only if explicitly documented; prefer reject zero frameCount and let pump skip EOF.

Future pump integration may keep one current and next destination per source plus globally bounded read scratch; allocation diagnostics must include scratch. Do not claim the existing pump is integrated in this issue.

## Objective gates

- Serializer/parser round-trip a synthetic multi-source package; admitted header/index bytes recorded. Blob spy refuses payload/full-object reads during parse.
- Reject bad magic/reserved/version/UTF8, noncanonical or duplicate/unknown keys, oversized/truncated index, unsafe integers, unsupported shape, zero-length/out-of-bounds/overlapping units, duplicate/unsorted sources, oversized unit, incorrect offsets/object length and trailing bytes.
- Exact session binding accepts equivalent declared source set and rejects missing/extra/shape/digest disagreement.
- PCM index offsets demonstrably derive from PCM shape, with compressed lengths deliberately different; wrong payload size rejects.
- Exact integer-byte comparisons to a synthetic dense oracle: all-silent/all-active; leading/interior/trailing gaps; one-LSB nonzero; adjacent active spans; boundaries within/across8192 windows; partial final window; representative mono16 and stereo24 and launch rate extremes.
- Reader spies prove no gap reads, one bounded active read maximum per window, no whole-stem read, and a short Blob slice rejects. Tiny active regions separated by huge logical gaps allocate only one8192-frame maximum output plus bounded scratch.
- Run focused new tests, npm run typecheck, npm test, npm run check:package and format/source-policy checks as proportional existing gates. No new browser harness or benchmark required because no worker/session integration changed. Successor integrates this helper in packed Chromium/WebKit tests.

## Decision/evidence record

Astra approves this bounded foundation and deterministic format as the first slice. It deliberately avoids research ZIP parsing while preserving independently decodable native FLAC units. A 1024-source resource ceiling applies only to an admitted delivery object, not the Rust graph/track model. Current research transport units can later be repackaged without codec retuning, but this issue uses synthetic fixtures exclusively. Luna records touched files, commands/results, any deviations and unresolved risks; Astra records one adversarial PASS/FAIL. Root commits exact paths once green, publishes evidence according to active delivery mode, synchronizes remote issue state, and only then starts the next implementation tranche.

## Attempt 1 implementation evidence (Luna)

Implemented the first bounded foundation in `src/stems/sparse-format.ts` and
`src/stems/sparse-pcm.ts`, with exports from `src/stems/index.ts`. Added the
focused synthetic tests in `tests/sparse-stems.test.ts` and the short contract
at `docs/sparse-stem-contract.md`. The parser performs separate header and
index Blob reads and returns a frozen manifest; package validation checks fixed
schema depth, canonical UTF-8 JSON, checked offsets and object bounds. PCM
derivation computes packed offsets from source shape, and the public validator
admits independently constructed interval indexes. The window helper binary
searches intervals, zero-fills gaps, performs at most one active contiguous
Blob read, and rejects short reads.

Evidence from the clean worktree:

- `npm test`: 197 tests passed.
- `npm run typecheck`: passed.
- `npm run format:check`: passed.
- `node scripts/check-source-policy.mjs`: passed.
- `npm run check:package`: passed.

No network, store, session, worker, Rust, version, or artist-data behavior was
changed. Decoder and PCM content-hash verification remain outside this slice.
Root committed/pushed the tranche as `65c023f`; the independent verdict follows.

## Attempt 1 adversarial verdict (Astra medium): FAIL

The non-implementing brief owner reviewed the committed implementation. Two
attempts to spawn a new reviewer failed with `agent thread limit reached`, so
this is an independent implementation review, not a fresh-context review.

- R1: `readSparsePcmWindow` revalidates and clones all intervals per read.
  A one-frame read with an admitted 10,000-interval index made 10,006
  `Object.freeze` calls. This violates bounded per-window scratch/work.
- R2: standalone PCM index validation accepts unknown root/interval keys and
  oversized lists, including 65,537 intervals and a 9,429,084-byte index.
  Transport object validation also checks the global unit budget after cloning.
- R3: six new focused tests pass, but the required malformed-wire, binding,
  nonzero mono, and larger boundary/oracle cases are largely absent. The total
  197-test pass includes 191 existing tests and does not establish those gates.

Attempt 2 must separate one-time admission from repeated reads using a
module-owned admission proof, retain constant-time payload/request checks,
enforce strict known keys and early count/metadata bounds, and add compact
table-driven wire/binding cases plus independent dense-oracle window tests.
Include counters proving a small read does not traverse unrelated intervals
and oversized arrays reject before element access. The wire contract and
existing resource ceilings remain unchanged. No new harness or integration
scope is authorized by this revision.

## Attempt 2 implementation evidence (Luna)

Attempt 2 keeps the same transport/session scope. Sparse PCM admission now
records a module-private WeakSet proof; `readSparsePcmWindow` rejects frozen or
structured-cloned forgeries and performs only constant-time Blob-size and
request checks before binary search/intersection copying. Standalone PCM
admission has fixed known keys, a 65,536 interval ceiling, an 8 MiB metadata
ceiling, checked packed offsets and derived byte counts. Transport source unit
counts are preflighted across all sources before source/unit element walking or
cloning. Focused tests add raw malformed-wire cases, binding negatives, early
array-access discriminators, repeated-read freeze counters, and independent
dense integer oracles for mono16/stereo24, all-active/silent, leading/interior/
trailing gaps, one-LSB data, large gaps, 8192 boundaries, partial EOF and
launch-rate extremes.

Evidence from this worktree:

- Focused `node --test .test-dist/tests/sparse-stems.test.js`: 11 tests passed.
- `npm run typecheck`: passed.
- `npm test`: 202 tests passed.
- `npm run format:check`: passed.
- `node scripts/check-source-policy.mjs`: passed.
- `npm run check:package`: passed.

No network, store, session, worker, Rust, mono-conversion, version, or
artist-data behavior changed. The worker must re-admit a structured-cloned
index in its own module realm; this issue still does not add worker/session
integration. Astra's attempt-2 verdict and root's checkpoint/push remain
pending.

## Attempt 2 adversarial verdict (Astra medium): FAIL

Reviewed upstream `b90a182`. R1 is fixed: active and all-gap reads over an
admitted 10,000-interval index produce zero freeze calls. Direct transport and
PCM admission now enforce early counts and strict keys. The expanded 11
focused tests pass and cover meaningful wire/binding/oracle cases.

Residual R2: `deriveSparsePcmIndex` calls `sourceManifest`, which rebases
nonzero-offset units by cloning them before admission. A 65,537-unit source's
last-element getter is read through derivation but not direct validation. An
original first offset of -1 is also normalized to zero and accepted. The
public derivation API has no admitted-source proof, so it cannot assume a
caller-supplied source already passed validation.

Attempt 3 is limited to admitting raw source shape/count/offset arithmetic
before any rebasing or cloning, preserving valid global nonzero offsets, and
adding the discriminating oversized-derivation and invalid-base tests. Add the
remaining small contracted cases: bad format tag, declared index above 8 MiB
or beyond the Blob, invalid window frame count/range. Validate raw offsets
and endpoints before subtraction so rebasing cannot hide invalid arithmetic.
Do not alter the wire format, enlarge limits, add a public API family, or
start cache/network integration. Reuse bounded internal source validation
where practical. One coherent correction receives the next independent
Astra verdict.
