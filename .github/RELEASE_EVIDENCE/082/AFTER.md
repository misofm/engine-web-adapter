# Official post-verification comparison

Measured 2026-09-13 after the fresh Astra medium review passed and its sole CI
blocker was repaired/rechecked. The compared candidate trees stayed clean and
frozen throughout the run:

- Codec `8c2823b041594a38284b01b5a39d77a6b515716e`, tree
  `0028688d80b1baf794508340bc477da590be4b38`, decoder asset SHA-256
  `70caf38185675dff89498e89f98171d49ec6f143a56c6895088d93c35e2018cd`.
- Adapter `088a14f57a945e6feb93145f3338943276a335dc`, tree
  `d453f0937c99954bd7a8917cec06ce2682f77ee5`, generated selected SHA module
  payload SHA-256
  `4435c2078c2783a77c06532e480d195ce314f500b849688d89d494432789fc28`.

The adjacent unchanged controls are published codec `0.1.0`
`12f54c988a2df319064e6ca3885268d976319cc1` and adapter `0.4.0`
`9b8172fd52746907c113442995dc7538cfe5ad13`. Both runs used the same Linux
x86_64 AMD EPYC 7313P host, Node 22.23.2 runner, Playwright Core 1.62.1, Vite
8.2.2, and headless Chromium 153.0.8010.12 binary
`8c599d43aec53f2460a31ae2f4af6bd863f8258b34ff519564bc5d4726bfaa1e`.
System load after the serial benchmark sequence was 0.76/1.06/1.10. No
competing builds or study benchmarks ran in the window.

## Correctness and workload identity

The official baseline and candidate each admitted the same eight published
Ghost `r1` `MISOSTM1` packages and passed all 8 package SHA-256, 35 compressed
FLAC SHA-256, 35 decoded chunk PCM SHA-256, and 8 reconstructed canonical PCM
SHA-256 checks. The corpus remained 92,722,644 container bytes, 92,685,354
compressed payload bytes, 249,323,400 decoded active PCM bytes, 48,656,904
synthesized zero bytes, and 297,980,304 canonical PCM bytes. The indexed PCM
verification workload remained 547,303,704 hashed bytes. Maximum observed PCM
output remained 27,648 bytes. The raw JSON records each source identity and
package digest; the representative chunk independently matched compressed
SHA-256 `ab35d73ddbfb7cbeb9384a34c585edc0141e88bb812d047caad4969a4abe884b`
and PCM SHA-256
`649b462aa016a111211498488ffca8da24e16f1a9b594f58bf38fb03933bb4f5`
with both adapter and Node crypto, and libFLAC MD5 was checked and verified.

## Official adjacent Chromium results

Each decoder case had one untimed warm-up and five measured rounds. Main-thread
PCM verification had one warm-up and three measured rounds. Local HTTP reads,
package/compressed correctness hashes, manifest admission, Wasm fetch/compile,
worker construction, network/CDN, OPFS, quota estimation, structured-clone
acknowledgements, and input/output waits are outside the timed sections.

| Slice | Published adjacent samples (ms) | Candidate samples (ms) | Median change | Candidate CV / throughput |
| --- | --- | --- | ---: | ---: |
| One-worker FLAC decode | 2197.2, 2232.9, 2268.7, 2243.6, 2226.3 | 2155.4, 2175.5, 2187.5, 2167.5, 2199.7 | 2232.9 → 2175.5, **2.57% faster** | 0.71%; 109.30 MiB/s |
| Eight-worker decode makespan | 399.9, 404.9, 399.9, 391.7, 416.3 | 371.3, 404.3, 379.3, 382.7, 394.6 | 399.9 → 382.7, **4.30% faster** | 3.02%; 621.30 MiB/s |
| Main-thread indexed PCM SHA | 11589.8, 11568.0, 11550.9 | 2184.3, 2201.6, 2193.2 | 11568.0 → 2193.2, **81.04% faster** | 0.32%; 237.99 MiB/s |

The unchanged-control CVs were 1.04%, 2.01%, and 0.14% respectively. Decoder
gains are modest. The one-worker median improvement exceeds run variation and
the result agrees with the earlier independent candidate runs. The eight-worker
ranges overlap under greater scheduling noise, but its 4.30% median gain and
the earlier adjacent 4.16% result have the same direction and magnitude. The
compiler-only decoder candidate therefore passes this host's compute gate in
both serial and default-eight-worker modes.

The SHA result is decisive and does not overlap the control. For attribution,
the same-host development control measured scalar Wasm at a 2224.7 ms median
against its adjacent unchanged-JS median of 11540.5 ms: **scalar Wasm reduces
time by 80.72% versus JS**. Selected SIMD measured
2190.4 ms in the paired control, another **1.54% faster than scalar Wasm**; its
adjacent repeat was 2189.8 ms and the official frozen result is 2193.2 ms. SIMD
adds a small repeatable gain to the much larger Wasm gain.

## Representative Bun results

The identical largest indexed chunk was rerun for seven rounds on Bun 1.4.2.
Bun's reported `process.version` is compatibility metadata and is not a Node 26
qualification.

| Slice | Published adjacent median (range; CV) | Candidate median (range; CV) | Change |
| --- | ---: | ---: | ---: |
| FLAC decode, 7,938,000 PCM bytes | 60.117 ms (57.117–63.479; 3.85%) | 55.460 ms (51.870–62.195; 5.68%) | **7.75% faster** |
| PCM SHA-256, 7,938,000 bytes | 389.382 ms (385.286–391.515; 0.55%) | 33.247 ms (33.181–33.836; 0.66%) | **91.46% faster** |

Exact samples are retained in the official Bun JSON files. The representative
result supports the browser direction; the whole-corpus Chromium comparison is
the primary gate.

## Assets, initialization, and memory

The decoder asset grew from 74,338 to 75,923 bytes: +1,585 bytes (+2.13%). Its
fixed 2 MiB memory, ABI, imports/exports, 256 KiB input cap, and 384 KiB maximum
output cap are unchanged. Browser decoder compile/validation was 2.0 ms for the
adjacent control and 3.3 ms for the candidate; Bun measured 4.676 and 4.332 ms.
These are single setup observations and are excluded from throughput.

The selected SHA compression module is 957 bytes, versus 1,347 bytes for the
scalar Wasm control. It has no imports, one fixed 64 KiB memory, a 16 KiB input
scratch/batch cap, and no growth. A single Bun observation of the candidate's
first 16 KiB hash was 1.094 ms versus 0.280 ms warm, placing a coarse upper bound
of about 0.814 ms on lazy compile/instance overhead on this host. The operation
also includes hashing and JIT effects, so it is not a pure compile measurement.

Adapter fixed-buffer accounting rises by 131,072 bytes, from 4,853,776 to
4,984,848 bytes, leaving 3,403,760 bytes within the unchanged 8 MiB worker
reservation. Per-hash JS state/tail/length ownership and API semantics remain
unchanged. Independent verification confirmed fixed memories, failed growth,
bounded copies, digest equivalence, packed deployment, and full test gates.

## Recommendation and limits

**Codec decoder: ship the reviewed SIMD candidate.** It gives a repeatable but
modest 2.57% one-worker and 4.30% eight-worker Chromium improvement with exact
PCM and unchanged bounds. The small asset/compile changes are acceptable in the
measured scope.

**Adapter SHA: ship the reviewed selected SIMD candidate.** The production
selection reduces current indexed main-thread PCM verification compute by
81.04%; scalar Wasm separately reduces time by 80.72% versus JS, and SIMD adds a
measured 1.54% reduction versus scalar Wasm. Correctness and bounded-memory
gates remain intact.

These are isolated cached-compute findings. They make no app-open, CDN/network,
OPFS, mobile, or end-to-end latency claim. App integration and release remain
root-owned follow-up work.

Official raw evidence:

- `browser-official-adjacent-baseline.json` SHA-256
  `514844c7c52396fa94f861f0a9b4ca27fc0feba5bb1d7ca7c477dd1dfa6bc9df`
- `browser-official-candidate.json` SHA-256
  `44d1c75c80963317bbe8033f6732ac0770e274fcbf60e23e1e48c3dc09731dbf`
- `representative-bun-official-adjacent-baseline.json` SHA-256
  `8070ac00dc4bfdbcb756c033c3c634a4ef8f20e927bf5ae1b4c645829a5f3809`
- `representative-bun-official-candidate.json` SHA-256
  `e094254f2838e75ff4769f9c6d63b54f9a6b76eac1fc4ae7dd14c6993befe272`

Exact rerun commands and the parameterized source-root contract remain in
`../harness/README.md`.
