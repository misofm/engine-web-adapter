# Round 3: bounded adaptive prediction of FLAC residuals

Round 3 tested one causal adaptive FIR correction of the original fixed/LPC
FLAC residuals. The implementation uses the exact Q20 transform in the scope,
resets state for every predictive subframe, updates at samples 3, 7, 11, and so
on, restores original residuals before the original FLAC predictor, and uses
the same retuned Rice2 parameters for Rice and context rANS. Constants and
verbatim subframes remain unchanged.

The final source and runner were frozen before the final measurements. The
final pilot selected profile 3 (M=32, learning b=3), by the smallest complete
rANS byte total among enabled profiles:

| Pilot configuration | Complete bytes |
| --- | ---: |
| Disabled Rice | 65,733,506 |
| Disabled rANS | 65,343,722 |
| M=8, b=3 Rice | 65,514,969 |
| M=8, b=3 rANS | 65,116,751 |
| M=8, b=5 Rice | 65,582,119 |
| M=8, b=5 rANS | 65,158,106 |
| M=32, b=3 Rice | 65,434,411 |
| M=32, b=3 rANS | **65,037,694** |
| M=32, b=5 Rice | 65,605,618 |
| M=32, b=5 rANS | 65,174,770 |

The pilot contained 40 encoded and independently decoded files. The required
sanitized winner pilot contained 8 files and passed ASan/UBSan with leak
detection enabled. The final full pass contained 120 files: disabled and
profile 3, each with Rice and rANS. Root verification independently checked
all artifact headers, table totals, component accounting, EOF, PCM chunk and
canonical hashes, and the original residual audit projected directly from the
frozen RSD records. The final checks covered 210 pilot chunk digests, 42
sanitized-pilot digests, and 548 full-pass digests.

| Full configuration | Complete bytes | Difference from tuned FLAC |
| --- | ---: | ---: |
| Disabled Rice | 426,116,798 | +701,133 |
| Disabled rANS | 423,396,564 | -2,019,101 |
| Profile 3 Rice | 424,438,980 | -976,685 |
| Profile 3 rANS | **421,773,671** | **-3,641,994** |

The tuned FLAC comparison is 425,415,665 bytes. Final round-2 context rANS is
423,304,009 bytes, so profile 3 rANS improves the final round-2 artifact by
1,530,338 bytes (0.361522%). Against tuned FLAC, profile 3 rANS saves
3,641,994 bytes (0.856102%); against the earlier WavPack comparison of
422,706,494 bytes, it saves 932,823 bytes (0.220679%). FIR correction saves
1,677,818 bytes (0.393746%) under Rice and 1,622,893 bytes (0.383303%) under
rANS against the disabled round-3 control. The disabled round-3 control is
slightly larger than round 2 because common Rice2 retuning costs 60,763 bytes
in Rice and 92,555 bytes in rANS.

The full profile 3 rANS artifact components were 374,884 table bytes,
4,235,904 side-information bytes, 75,566,835 entropy bytes, 340,575,680
bypass bytes, and 421,319,611 frame bytes. Its encoder totals were 146.02
wall seconds, 142.35 user seconds, and 3.31 system seconds; decode totals were
64.31 wall seconds, 60.56 user seconds, and 3.45 system seconds, with a 5,120
KiB encode and 4,864 KiB decode peak RSS receipt. The full runner elapsed wall
time was 140.12 seconds at four workers. The adaptive counters were 79,759,993
updates, 17,979 coefficient clamps, zero prediction clamps, and zero modular
wraps. The counters matched between the final encoder pass and decoder.

The selected pilot identities (4 stems) and the remaining corpus (26 stems)
had these complete-byte totals:

| Corpus slice | Disabled Rice | Disabled rANS | Profile 3 Rice | Profile 3 rANS |
| --- | ---: | ---: | ---: | ---: |
| Selected pilot, 4 stems | 65,733,506 | 65,343,722 | 65,434,411 | 65,037,694 |
| Remaining, 26 stems | 360,383,292 | 358,052,842 | 359,004,569 | 356,735,977 |
| Full corpus, 30 stems | 426,116,798 | 423,396,564 | 424,438,980 | 421,773,671 |

Profile 3 rANS was larger than disabled rANS on four stems: `r2/fx`
(+27,284 bytes), `r1/vocal-fx` (+182,272), `r1/fx` (+73,622), and
`r3/synth-2` (+132,274). The other 26 stems were at or below the disabled
rANS control.

Three serial, shuffled, audit-free decode trials were run over the four pilot
stems. The timed interval includes native compressed-file reads, decode, and
PCM output writes; input warming and preflight hashing, post-decode digest
verification are outside it. The timed commands passed `-` audit paths, so
audit serialization was disabled. Median wall times were 2.158621
seconds for disabled Rice, 2.240367 seconds for disabled rANS, 7.734652 seconds
for profile 3 Rice, 7.835196 seconds for profile 3 rANS, and 2.242406 seconds
for final round-2 rANS. Profile 3 therefore costs 3.50x the disabled rANS
decode wall time in this timing set. Child RSS is reported as the maximum over
the three trials for each mode from `/usr/bin/time`; it was 4,864 KiB for all
five modes. Browser, OPFS, network, and decoder download costs were not
measured.

The independent integer reference gate passed in both optimized and
ASan/UBSan builds. It compared 95 trace vectors across all five profiles and
306 exhaustive Rice-parameter cases, including coefficient-clamp,
prediction-clamp, and modular-wrap paths. The native source, independent
driver, helper hashes, commands, and both receipts are pinned in
`round-03-evidence/validation.json`, `integer-reference-opt.json`, and
`integer-reference-san.json`.

The compact frozen evidence is in
[`round-03-evidence`](round-03-evidence/). It includes both pilot and full
per-stem/session rows, the profile selection receipt, all three root
verification receipts, the independent original-audit receipt, validation and
hash indexes, sanitizer build metadata, and timing freezes/results. Audio,
PCM, audit transcripts, compressed artifacts, and binaries remain under
`/data/issue-77-lossless/iterations/round-03/`.

Reproduction uses the final source with the pinned libFLAC archive:

```sh
gcc -std=c11 -O2 -Wall -Wextra -Wconversion -Wshadow \
  -I/data/issue-77-lossless/tooling/flac-1.5.0/include \
  research/077-lossless-delivery/iterations/round-03/native/round3.c \
  /data/issue-77-lossless/tooling/flac-build/src/libFLAC/libFLAC.a -lm \
  -o /data/issue-77-lossless/iterations/round-03/round3-helper
```

The native helper contract is:

```text
round3-helper encode INPUT_RSD OUTPUT ORIGINAL_AUDIT CODED_AUDIT SUMMARY MODE PROFILE
round3-helper decode INPUT OUTPUT_RAW ORIGINAL_AUDIT CODED_AUDIT SUMMARY
```

The pilot and full commands are recorded in the frozen runner configuration
and can be reproduced with fresh work directories using
`iterations/round-03/round3.py`. Serial timing uses
`iterations/round-03/timing.py` and the same frozen pilot artifacts.

The result supports this bounded conclusion: profile 3 reduced complete bytes
for this corpus under both tested coders, while adding substantial native
encode/decode cost and showing coefficient clamps. A distinct remaining
hypothesis for round 4 is required; these measurements do not establish a
universal compression floor.
