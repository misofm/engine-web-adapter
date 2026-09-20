# Round 1 reproduction

Run from the repository root. The source catalogue, original manifests, and
published evidence under `research/077-lossless-delivery/` are immutable
inputs. Scratch, diagnostic records, PCM, and helper binaries stay under
`/data/issue-77-lossless/iterations/round-01/`.

The native helper links the pinned public libFLAC 1.5.0 archive. Its record
format is `I77RSD01`, little-endian `u64` manifest length and record count,
the original manifest bytes, then length-prefixed records. Each record stores
`u32 sourceChunkIndex`, `u64 packedStartFrame`, `u64 sourceFrameOffset`,
`u32 sourceFrameBytes`, `u32 blockSize`, four assignment/shape bytes, and
two subframes. The offset and frame-byte fields are provenance extensions used
for exact frame reconciliation; they are not a compressed delivery format.
The decoder reconstructs from warmups, LPC coefficients/shift, partition
parameters, and signed residuals without FLAC or source PCM input.

Build the optimized helper:

```sh
gcc -std=c11 -O2 -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-01/native/round1.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-01/round1-helper
```

Run the focused native gates, the repository verification suite, the complete
pilot, and the full corpus with the frozen worker limit:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 research/077-lossless-delivery/iterations/round-01/test_native.py \
  --helper /data/issue-77-lossless/iterations/round-01/round1-helper
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s research/077-lossless-delivery -p 'test_*.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 research/077-lossless-delivery/iterations/round-01/round1.py \
  --work /data/issue-77-lossless/iterations/round-01/pilot-final \
  --helper /data/issue-77-lossless/iterations/round-01/round1-helper \
  --pilot-only --workers 4
PYTHONDONTWRITEBYTECODE=1 python3 research/077-lossless-delivery/iterations/round-01/round1.py \
  --work /data/issue-77-lossless/iterations/round-01/full-final \
  --helper /data/issue-77-lossless/iterations/round-01/round1-helper \
  --workers 4
```

For the sanitizer gates, build a separate helper and run the same native
tests and pilot. The measured full pass uses the optimized helper.

```sh
gcc -std=c11 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
  -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-01/native/round1.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-01/round1-helper-sanitize
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 \
  PYTHONDONTWRITEBYTECODE=1 python3 research/077-lossless-delivery/iterations/round-01/test_native.py \
  --helper /data/issue-77-lossless/iterations/round-01/round1-helper-sanitize
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 \
  PYTHONDONTWRITEBYTECODE=1 python3 research/077-lossless-delivery/iterations/round-01/round1.py \
  --work /data/issue-77-lossless/iterations/round-01/pilot-sanitize-final \
  --helper /data/issue-77-lossless/iterations/round-01/round1-helper-sanitize \
  --pilot-only --workers 4
```

The retained full-run evidence was produced in `full-run3` with the same
optimized command and is summarized under `../round-01-evidence/`. Its freeze
receipt pins the scope, source catalogue, manifests, original evidence,
native source, helper, compiler, libFLAC archive, and worker count.

Checked-in CSV copies normalize line endings to LF; measurement values are
unchanged. The scratch full-run JSON hash and the checked-in file hashes are
recorded separately. Compact summaries omit the large histogram arrays.
