# Round 4 reproduction

Round 4 uses the frozen round 1 RSD records and canonical corpus. Generated
audio, transcripts, helpers, and per-stem outputs stay under
`/data/issue-77-lossless/iterations/round-04/`; the checked-in evidence keeps
only compact JSON/CSV receipts and hashes.

Build the optimized and sanitizer helpers from the frozen native source:

```sh
gcc -std=c11 -O2 -fno-fast-math -ffp-contract=off \
  -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-04/native/round4.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-04/round4-helper

gcc -std=c11 -O1 -g -fno-omit-frame-pointer -fno-fast-math -ffp-contract=off \
  -fsanitize=address,undefined -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-04/native/round4.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-04/round4-helper-san
```

Run the independent native and spatial gates before a corpus pass:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-04/test_native.py \
  --helper /data/issue-77-lossless/iterations/round-04/round4-helper

ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 \
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-04/test_native.py \
  --helper /data/issue-77-lossless/iterations/round-04/round4-helper-san

gcc -std=c11 -O2 -fno-fast-math -ffp-contract=off \
  -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-04/native/round4_spatial_driver.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-04/round4-spatial-driver
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-04/test_spatial.py \
  --helper /data/issue-77-lossless/iterations/round-04/round4-spatial-driver
```

Run the exact final pilot, selected sanitizer pilot, and full matrix in fresh
directories. The pilot writes the profile selection receipt; the full run
authenticates that receipt and runs disabled/profile 2 under both coders.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-04/round4.py \
  --work /data/issue-77-lossless/iterations/round-04/pilot-final2 \
  --helper /data/issue-77-lossless/iterations/round-04/round4-helper \
  --workers 4 --pilot-only

ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1 \
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-04/round4.py \
  --work /data/issue-77-lossless/iterations/round-04/sanitized-final2 \
  --helper /data/issue-77-lossless/iterations/round-04/round4-helper-san \
  --workers 4 --sanitized-pilot --selected-profile 2 \
  --selection /data/issue-77-lossless/iterations/round-04/pilot-final2/selection.json \
  --pilot-work /data/issue-77-lossless/iterations/round-04/pilot-final2

PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-04/round4.py \
  --work /data/issue-77-lossless/iterations/round-04/full-final3 \
  --helper /data/issue-77-lossless/iterations/round-04/round4-helper \
  --workers 4 --selected-profile 2 \
  --selection /data/issue-77-lossless/iterations/round-04/pilot-final2/selection.json \
  --pilot-work /data/issue-77-lossless/iterations/round-04/pilot-final2

PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-04/root_audit.py \
  --work /data/issue-77-lossless/iterations/round-04/full-final3
```

Run the controlled serial decode timing only after the optimized full run and
its independent audit pass. It uses a fresh work directory, warms each
compressed input outside the timed interval, disables both audit outputs with
`-`, writes fresh raw PCM during timing, and verifies the PCM/chunk/canonical
digests afterward:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 \
  research/077-lossless-delivery/iterations/round-04/timing.py \
  --work /data/issue-77-lossless/iterations/round-04/timing-final4 \
  --pilot-work /data/issue-77-lossless/iterations/round-04/pilot-final2 \
  --sanitized-work /data/issue-77-lossless/iterations/round-04/sanitized-final2 \
  --full-work /data/issue-77-lossless/iterations/round-04/full-final3 \
  --selected-profile 2 \
  --helper /data/issue-77-lossless/iterations/round-04/round4-helper \
  --round3-helper /data/issue-77-lossless/iterations/round-03/round3-helper \
  --round3-work /data/issue-77-lossless/iterations/round-03/pilot-run4 \
  --trials 3
```

The helper command is:

```text
helper encode INPUT_RSD OUTPUT ORIGINAL_AUDIT CODED_AUDIT SUMMARY MODE PROFILE
helper decode INPUT OUTPUT_RAW ORIGINAL_AUDIT CODED_AUDIT SUMMARY
```

Mode `0` is Rice2 and mode `1` is context byte-rANS. Profile `0` disables
spatial correction; profile `1` fits one lag-0 tap; profile `2` fits the five
ordered lags `[-2,-1,0,1,2]`. The encoder charges every transmitted Q12 i16
coefficient in the per-frame byte total and uses one selected direction for
both entropy modes. The decoder uses only transmitted integer coefficients.
