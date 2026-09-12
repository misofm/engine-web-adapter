# Round 3 reproduction

All large inputs and generated outputs live outside the repository under
`/data/issue-77-lossless/iterations/round-03/`. The commands below use fresh
work directories; they leave the frozen final receipts in `pilot-run4`,
`sanitized-pilot3`, `full-final`, and `timing-final` unchanged.

The runner expects the independently projected original-audit receipt at
`/data/issue-77-lossless/iterations/round-03/root-original-audit.json`. With
the frozen round-1 RSD records available, regenerate that deterministic
receipt first, or copy the checked-in verified receipt to that path:

```sh
python3 research/077-lossless-delivery/iterations/round-03/root_original_audit.py
```

From the repository root, build the optimized helper and its sanitizer build:

```sh
gcc -std=c11 -O2 -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-03/native/round3.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-03/round3-helper

gcc -std=c11 -O1 -g -fno-omit-frame-pointer \
  -fsanitize=address,undefined -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-03/native/round3.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-03/round3-helper-san
```

Run the independent native gates before the corpus pass:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-03/test_native.py \
  --helper /data/issue-77-lossless/iterations/round-03/round3-helper

ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1 PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-03/test_native.py \
  --helper /data/issue-77-lossless/iterations/round-03/round3-helper-san
```

Run a fresh 40-file pilot, then the 8-file sanitizer winner pilot. The first
command writes `selection.json`; use that receipt for the full pass rather
than selecting a profile by hand:

```sh
# Each of these work directories must be new and empty.
python3 research/077-lossless-delivery/iterations/round-03/round3.py \
  --work /data/issue-77-lossless/iterations/round-03/pilot-repro \
  --helper /data/issue-77-lossless/iterations/round-03/round3-helper \
  --workers 4 --pilot-only

python3 research/077-lossless-delivery/iterations/round-03/round3.py \
  --work /data/issue-77-lossless/iterations/round-03/sanitized-repro \
  --helper /data/issue-77-lossless/iterations/round-03/round3-helper-san \
  --workers 4 --pilot-only --profiles 3

python3 research/077-lossless-delivery/iterations/round-03/round3.py \
  --work /data/issue-77-lossless/iterations/round-03/full-repro \
  --helper /data/issue-77-lossless/iterations/round-03/round3-helper \
  --workers 4 --selected-profile 3 \
  --selection /data/issue-77-lossless/iterations/round-03/pilot-repro/selection.json \
  --pilot-work /data/issue-77-lossless/iterations/round-03/pilot-repro
```

Run the three serial timing trials after the full pass. The timing script
validates the pilot selection and the frozen round-2 reference before timing
native decode, and disables audit output for the timed child processes:

```sh
python3 research/077-lossless-delivery/iterations/round-03/timing.py \
  --work /data/issue-77-lossless/iterations/round-03/timing-repro \
  --pilot-work /data/issue-77-lossless/iterations/round-03/pilot-repro \
  --selected-profile 3 \
  --helper /data/issue-77-lossless/iterations/round-03/round3-helper \
  --round2-helper /data/issue-77-lossless/iterations/round-02/round2-helper \
  --round2-work /data/issue-77-lossless/iterations/round-02/final-pilot3
```

The independent integer reference gates are separate from the corpus runner:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-03/test_integer.py \
  --build-dir /data/issue-77-lossless/iterations/round-03/integer-repro-opt

ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1 PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-03/test_integer.py \
  --build-dir /data/issue-77-lossless/iterations/round-03/integer-repro-san \
  --sanitized
```

The final measured receipts are the corresponding `pilot-run4`,
`sanitized-pilot3`, `full-final`, and `timing-final` directories in the same
scratch root. Their compact checked-in copies, source/helper hashes, and
independent root verification receipts are in `round-03-evidence/`.
