# Round 2 reproduction

Run from the repository root. The source reads the finalized round-1 native
helper read-only through the include in `native/round2.c`; it does not read
engine, application, or legacy product source. Audio, RSD records, binaries,
and measured outputs stay under `/data/issue-77-lossless/`.

The final source and input freeze is recorded in
`../round-02-evidence/freeze.json`. Its helper hash is for the optimized
binary built by the command below. The final 30-stem output was produced at
`/data/issue-77-lossless/iterations/round-02/final-full2`; the four-stem pilot
was produced at `final-pilot3`, and serial timing at `timing-final5`.

Build the optimized helper:

```sh
mkdir -p /data/issue-77-lossless/iterations/round-02
gcc -std=c11 -O2 -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-02/native/round2.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-02/round2-helper
```

Build and exercise the separately identified sanitizer helper:

```sh
gcc -std=c11 -O1 -g -fno-omit-frame-pointer \
  -fsanitize=address,undefined -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-02/native/round2.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-02/round2-helper-san

PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-02/test_native.py \
  --helper /data/issue-77-lossless/iterations/round-02/round2-helper
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 \
  PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-02/test_native.py \
  --helper /data/issue-77-lossless/iterations/round-02/round2-helper-san
```

Run a fresh four-stem pilot, then the complete corpus. `--workers 4` is frozen
in the measured receipts; each command verifies the embedded manifest and
RSD receipt, strict frame/file accounting, active/chunk/canonical PCM hashes,
and encoder/decoder logical transcript hashes.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-02/round2.py \
  --work /data/issue-77-lossless/iterations/round-02/new-pilot \
  --helper /data/issue-77-lossless/iterations/round-02/round2-helper \
  --pilot-only --workers 4

PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-02/round2.py \
  --work /data/issue-77-lossless/iterations/round-02/new-full \
  --helper /data/issue-77-lossless/iterations/round-02/round2-helper \
  --workers 4
```

The helper's explicit format is:

```text
round2-helper encode INPUT_RSD OUTPUT AUDIT SUMMARY MODE(0|1)
round2-helper decode INPUT OUTPUT_RAW AUDIT SUMMARY
round2-helper decode INPUT OUTPUT_RAW SUMMARY
```

Mode 0 is matched Rice. Mode 1 is context byte-rANS. Passing `-` as the audit
path disables audit serialization for timing only; it does not relax decoding
validation. The checked-in timing command performs three serial deterministic
shuffled trials, warms every compressed input before timing, decodes fresh raw
outputs, and verifies byte count and PCM hash after each timed process:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-02/timing.py \
  --work /data/issue-77-lossless/iterations/round-02/new-timing \
  --pilot-work /data/issue-77-lossless/iterations/round-02/new-pilot \
  --helper /data/issue-77-lossless/iterations/round-02/round2-helper \
  --trials 3
```

The pinned libFLAC executable is
`/data/issue-77-lossless/tooling/flac-build/src/flac/flac`; the timing runner
forces raw little-endian signed output. Hash verification is explicitly outside
the timed interval. The runner records native user/system CPU and peak RSS
from `/usr/bin/time`; wrapper wall time is recorded separately.

The final compact evidence includes no audio, encoded files, binaries, caches,
or full histogram arrays. It contains the full per-stem result and hash
receipts, per-session and total CSVs, pilot results, timing trials, freeze
configuration, validation gates, and a hash index. Full encoded/audit artifacts
remain in the scratch paths named by those receipts for independent audit.
