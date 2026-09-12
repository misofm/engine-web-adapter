# Round 5 reproduction

Round 5 combines the frozen round-1 residual records with the round-3 Rice
retuning and the round-4 spatial plan. The native helper and all generated
audio, audits, per-frame plans, compressed files, and scratch timing outputs
belong under `/data/issue-77-lossless/iterations/round-05/`. Reviewed compact
JSON/CSV summaries, measurement receipts, source, tests, and reproduction
instructions are the repository evidence.

## Inputs and provenance

Use the prepared issue-77 corpus and records. For portable retrieval from the
published release, follow the [initial experiment's corpus and exactness
instructions](../../README.md#corpus-and-exactness) and its
[reproduction and fetch instructions](../../README.md#reproduction), including
the URL-template or `--local-inputs`/`fetch.py` paths. The common iteration
rules are in the [iterations README](../README.md), and the prior round
reproduction guides are [round 1](../round-01/REPRODUCTION.md), [round
2](../round-02/REPRODUCTION.md), [round 3](../round-03/REPRODUCTION.md), and
[round 4](../round-04/REPRODUCTION.md). Stage the resulting files at the
paths below, or pass their deliberate replacements to the runner:

```text
/data/issue-77-lossless/run-02/<stem>/active.raw
/data/issue-77-lossless/run-02/<stem>/flac8e-30s/{0.flac,...,manifest.json}
/data/issue-77-lossless/run-02/<stem>/wavpackhhx6-concat/0.wv
/data/issue-77-lossless/iterations/round-01/full-run3/full/<stem>/stem.rsd
```

The repository-side catalog and frozen maps are
`research/077-lossless-delivery/sources.json` and
`research/077-lossless-delivery/manifests/<stem>.json`. The runner also
requires the checked-in round-1 evidence (`iterations/round-01-evidence/` and
`evidence/results.json`), the round-3 original audit, and the verified round-3
and round-4 freeze/results/root-audit receipts. The default prior-run paths
are:

```text
/data/issue-77-lossless/iterations/round-03/full-final
/data/issue-77-lossless/iterations/round-04/full-final3
```

These directories must contain the final `freeze.json`, `results.json`, and
`root-verification.json` expected by `round5.py`; the round-4 results receipt
is pinned to SHA-256
`9f4452056a6ac93a4a76f3d2820c5a2c224ad987ea08f01c5a55f4b8412b3056`.
The runner and `root_audit.py` bind to exact paths and hashes; the auditor
also uses the pinned round-3/round-4 scratch paths, and gate receipts carry
absolute input provenance. A different environment therefore requires
deliberate path updates plus fresh gate receipts and freezes; historical
absolute-path hashes do not replay unchanged in a new environment. Do not
substitute unverified PCM, manifests, records, or historical results.

The native toolchain is libFLAC 1.5.0 from
`/data/issue-77-lossless/tooling/flac-1.5.0/include` and
`/data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a`, GCC, and
`libm`. The frozen archive SHA-256 is
`a485b5d7e8f5cec078c954e8d8cc7ab02af4e5e172024a149ce6b6f941921026`;
the resolved libm (`/lib/x86_64-linux-gnu/libm.so.6`) is
`fce00b6f25f459cf4ae0b7fae4257909a1a8a86f9149e7c029a5d617baf1ccd0`; and
the resolved GCC executable (`/usr/bin/x86_64-linux-gnu-gcc-13`) is
`1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26`.

## Native builds

Build both the optimized helper and its independent integer driver from the
frozen source. The driver includes the native implementation for reference
math checks and does not participate in corpus delivery.

```sh
gcc -std=c11 -O2 -fno-fast-math -ffp-contract=off \
  -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-05/native/round5.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-05/round5-helper

gcc -std=c11 -O2 -fno-fast-math -ffp-contract=off \
  -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-05/native/round5_integer_driver.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-05/round5-integer-driver
```

Build the ASan/UBSan copies with the same include path, archive, and math
library:

```sh
gcc -std=c11 -O1 -g -fno-omit-frame-pointer \
  -fno-fast-math -ffp-contract=off -fsanitize=address,undefined \
  -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-05/native/round5.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-05/round5-helper-san

gcc -std=c11 -O1 -g -fno-omit-frame-pointer \
  -fno-fast-math -ffp-contract=off -fsanitize=address,undefined \
  -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-05/native/round5_integer_driver.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-05/round5-integer-driver-san
```

The native sources are `native/round5.c` and
`native/round5_integer_driver.c`. The final helper hashes used by the gate
receipts are:

```text
round5-helper:             f9f9fabae75ce66df06b35ac860195e1b6938d4fcbff5710834028c06fd8ec35
round5-integer-driver:     c7e7740e6879cfac7d66a16dc36eb59b1f2c5dd074fda88f1d5552177c788bda
round5-helper-san:          f91c1edfa55ecdb3a0bf7ef40cc5390acbf2129d71aa76c0001177f316441b0a
round5-integer-driver-san:  376aac3c3b8906093128d4a90db741113949075a7f91cc1cd23e3cc58109f9eb
```

## Native gates

Run the optimized gate and the sanitizer gate before creating a measurement
freeze. Both commands are bytecode-cache-free and cover the same three grouped
native/reference tests.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-05/test_native.py \
  --helper /data/issue-77-lossless/iterations/round-05/round5-helper \
  --driver /data/issue-77-lossless/iterations/round-05/round5-integer-driver

ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1 \
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-05/test_native.py \
  --helper /data/issue-77-lossless/iterations/round-05/round5-helper-san \
  --driver /data/issue-77-lossless/iterations/round-05/round5-integer-driver-san
```

The retained receipts are:

```text
/data/issue-77-lossless/iterations/round-05/native-tests-opt/receipt.json
  SHA-256 adc8e6364e9467cf0eaf0dbf75dc467ff302a8bbdd635bfb2380afd203cf0921
/data/issue-77-lossless/iterations/round-05/native-tests-san/receipt.json
  SHA-256 51e4e4467790ad2951e8bc4183cad1473aee4f4d8b95149ae3defb3f52551f3e
```

Each receipt is an `issue77-round5-native-test-receipt-v1` pass with return
code zero, three tests, exact source/toolchain provenance, and completion time
`2026-09-12T18:33:58.302487Z`. A corpus freeze must use these receipts and
must reject any changed source, helper, driver, archive, compiler, or test
input.

## Native helper interface

The frozen helper interface is:

```text
round5-helper encode INPUT_RSD OUTPUT ORIGINAL_AUDIT CODED_AUDIT SUMMARY MODE POLICY PLAN_CSV
round5-helper decode INPUT_MIX OUTPUT_RAW ORIGINAL_AUDIT CODED_AUDIT SUMMARY
```

Mode `0` is Rice and mode `1` is context byte-rANS. Policy `0` is the cheap
spatial candidate, policy `1` enables FIR when the complete Rice cost gain is
positive, and policy `2` requires a gain greater than 32 bytes. A literal `-`
disables an audit path. `PLAN_CSV` is required for measured encodes and uses
the fixed header from the scope; it is diagnostic and is not part of delivery
byte accounting.

## Frozen pilot and full runs

Use fresh work directories and four workers. The runner authenticates the
catalog, original records, prior round receipts, gate receipts, helper hash,
and all dependencies at startup and again before accepting results. The exact
pilot identities are the four IDs fixed in `round5.py`; do not replace them
with a different subset.

Run the sanitizer pilot first. It covers four stems, policies 1 and 2, and
both entropy modes: 16 files.

```sh
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1 \
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-05/round5.py \
  --work /data/issue-77-lossless/iterations/round-05/sanitized-final2 \
  --helper /data/issue-77-lossless/iterations/round-05/round5-helper-san \
  --records-root /data/issue-77-lossless/iterations/round-01/full-run3/full \
  --corpus /data/issue-77-lossless/run-02 \
  --r3-work /data/issue-77-lossless/iterations/round-03/full-final \
  --r4-work /data/issue-77-lossless/iterations/round-04/full-final3 \
  --gate-receipt /data/issue-77-lossless/iterations/round-05/native-tests-opt/receipt.json \
  --gate-receipt /data/issue-77-lossless/iterations/round-05/native-tests-san/receipt.json \
  --workers 4 --sanitized-pilot

PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-05/root_audit.py \
  --work /data/issue-77-lossless/iterations/round-05/sanitized-final2
```

After the sanitizer audit passes, run the optimized four-stem pilot. It
covers all three policies under both modes: 24 files.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-05/round5.py \
  --work /data/issue-77-lossless/iterations/round-05/pilot-final2 \
  --helper /data/issue-77-lossless/iterations/round-05/round5-helper \
  --records-root /data/issue-77-lossless/iterations/round-01/full-run3/full \
  --corpus /data/issue-77-lossless/run-02 \
  --r3-work /data/issue-77-lossless/iterations/round-03/full-final \
  --r4-work /data/issue-77-lossless/iterations/round-04/full-final3 \
  --sanitized-work /data/issue-77-lossless/iterations/round-05/sanitized-final2 \
  --gate-receipt /data/issue-77-lossless/iterations/round-05/native-tests-opt/receipt.json \
  --gate-receipt /data/issue-77-lossless/iterations/round-05/native-tests-san/receipt.json \
  --workers 4 --pilot-only

PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-05/root_audit.py \
  --work /data/issue-77-lossless/iterations/round-05/pilot-final2
```

Only after the optimized pilot and its root audit pass, run the all-stem
optimized matrix. It covers 30 stems, three policies, and both modes: 180
files.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-05/round5.py \
  --work /data/issue-77-lossless/iterations/round-05/full-final2 \
  --helper /data/issue-77-lossless/iterations/round-05/round5-helper \
  --records-root /data/issue-77-lossless/iterations/round-01/full-run3/full \
  --corpus /data/issue-77-lossless/run-02 \
  --r3-work /data/issue-77-lossless/iterations/round-03/full-final \
  --r4-work /data/issue-77-lossless/iterations/round-04/full-final3 \
  --pilot-work /data/issue-77-lossless/iterations/round-05/pilot-final2 \
  --sanitized-work /data/issue-77-lossless/iterations/round-05/sanitized-final2 \
  --gate-receipt /data/issue-77-lossless/iterations/round-05/native-tests-opt/receipt.json \
  --gate-receipt /data/issue-77-lossless/iterations/round-05/native-tests-san/receipt.json \
  --workers 4

PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-05/root_audit.py \
  --work /data/issue-77-lossless/iterations/round-05/full-final2
```

The authoritative ordering is therefore sanitizer pilot and audit, optimized
pilot and audit, then optimized full and audit. `full-final2` is the verified
180-file full matrix: its freeze SHA-256 is
`8f842f966eb09a7719b3c3542fe24eccaffee0a67e9ff23a1dbb0db9c71e4048`, its
results SHA-256 is
`3617bab8ff9ba4dcf86d5287e1f6c02ee4e0c5406d552532c3234ecb194d9fbc`, and its
root-audit receipt SHA-256 is
`b2b6426158a04bbe2d6ea058bfff64022292f47a1e15b6ccc7f4fd53d6a1004e`.
The root audit passed 180 artifacts and 237,372 frame checks. Do not rerun a
superseded directory in place: a source, helper, input, configuration, or gate
change requires a fresh freeze and fresh run directory.

## Controlled timing

After the verified `full-final2` audit, the authoritative timing run used three
serial trials over all 30 stems for the six fixed candidates: tuned FLAC,
WavPack `-hh -x6`, round-3 P3 rANS, and round-5 policies 0/1/2 rANS. The
authoritative command was:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-05/timing.py \
  --work /data/issue-77-lossless/iterations/round-05/timing-final2 \
  --r5-work /data/issue-77-lossless/iterations/round-05/full-final2 \
  --r3-work /data/issue-77-lossless/iterations/round-03/full-final \
  --r4-work /data/issue-77-lossless/iterations/round-04/full-final3 \
  --corpus /data/issue-77-lossless/run-02 \
  --flac /data/issue-77-lossless/tooling/flac-build/src/flac/flac \
  --wvunpack /data/issue-77-lossless/tooling/wavpack-build/wvunpack \
  --helper /data/issue-77-lossless/iterations/round-05/round5-helper \
  --trials 3
```

The timing freeze fixes the runner, helper, prior artifacts, compressed inputs,
catalog, candidates, stem and mode shuffle seeds, and three-trial count before
measurement. Compressed inputs are warmed outside the timed interval. Each
candidate decodes to a fresh active PCM file; PCM, chunk, and canonical hash
checks run afterward. Native timing invokes custom decoders with both audit
arguments as `- -`, so audit serialization is disabled. PCM writes and
process startup remain inside the timed interval, while input warming and
verification remain outside it. These are warm native decode-to-file timings,
not browser, network, OPFS, or Wasm-installation timings. The timing root audit
passed 540 logical decodes, 360 custom summaries, 861 native child receipts,
and 428 unique frozen file hashes. Its root-verification receipt SHA-256 is
`d6d63b44be0f99d362e284728ae9f2caf326e8d5df309c0ff2bcf9401a8e3735`.
The timing-freeze SHA-256 is
`a3f06214354c789419b0f74079e2eec3052697752d4d014fe3823d9575034f0c`, and the
timing result SHA-256 is
`6d6d431ce02ccea1d49f4c3d4afe7c4b9bf1918eb674535d2851cd6f0eb4521e`.

The measured release wall-time medians, in seconds summed across the 30 stems,
were:

| Candidate | Median seconds |
| --- | ---: |
| Tuned FLAC | 5.776526 |
| WavPack `-hh -x6` | 11.280596 |
| Round-3 P3 rANS | 55.212990 |
| Round-5 policy 0 rANS | 15.891522 |
| Round-5 policy 1 rANS | 48.620862 |
| Round-5 policy 2 rANS | 38.132207 |

These are server-side warm native decode plus raw-file-write measurements;
they do not represent whole-session product latency or mobile/browser speed.

Generated binaries, audio, compressed files, audits, per-frame plans, PCM,
and Python caches are scratch artifacts and are not committed. Compact JSON
and CSV summaries, freeze/validation/root-audit receipts, measurement
receipts, and their hash indexes are the reviewed evidence that may be
committed under the round-5 evidence/report paths. Keep the large artifacts
under the issue-77 scratch tree.
