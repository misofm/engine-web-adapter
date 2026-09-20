# Round 4 report: offline spatial residual correction

Round 4 tested a charged offline cross-channel predictor over the frozen
round-1 FLAC residual records, retaining round-3's Rice retuning. Profile 1
fits one lag-0 Q12 tap and profile 2 fits five Q12 taps at lags `[-2,-1,0,1,2]`.
Each eligible frame evaluates disabled,
channel 0 to channel 1, and channel 1 to channel 0 with exact Rice2 byte cost;
the selected coefficients and direction are reused by Rice and rANS. Constants,
verbatim frames, and frames with an empty residual channel stay disabled.

The implementation is in [round4.c](round-04/native/round4.c), with the bounded corpus
runner in [round4.py](round-04/round4.py). It includes the frozen round-3 reader,
predictor restoration, entropy coders, audits, and PCM restoration read-only.
The independent native gates are in [test_native.py](round-04/test_native.py) and the
integer spatial/selection gates are in [test_spatial.py](round-04/test_spatial.py).
Exact commands and compiler flags are in [REPRODUCTION.md](round-04/REPRODUCTION.md).

All 24 pilot files and all 120 full files passed the runner gates. The final
pilot selected profile 2 by actual aggregate rANS size:

| Pilot profile | Rice bytes | rANS bytes |
| --- | ---: | ---: |
| 0 disabled | 65,733,506 | 65,343,722 |
| 1 one tap | 65,688,804 | 65,296,102 |
| 2 five taps | 65,672,737 | 65,283,171 |

The selected four-stem sanitizer pilot also passed. Optimized and ASan/UBSan
spatial suites each passed 162 independent checks. The final full totals are:

| Full mode | Complete bytes |
| --- | ---: |
| P0 Rice | 426,116,798 |
| P0 rANS | 423,396,564 |
| P2 Rice | 425,760,621 |
| P2 rANS | 423,034,938 |

Profile 2 saves 356,177 bytes against disabled Rice and 361,626 bytes against
disabled rANS, after its 63,900 coefficient bytes and rANS table changes are
included. The selected path uses 3,574 channel-0-to-1 frames and 2,816
channel-1-to-0 frames; 33,172 frames remain disabled. There are no prediction
clamps or modular wraps. The encoder recorded 3,144 coefficient clips, with no
fit-degenerate or fit-failure candidates in the full pass.

Against the complete tuned FLAC baseline (425,415,665 bytes), P2 rANS is
2,380,727 bytes smaller; P2 Rice is 344,956 bytes larger. P2 rANS is
1,261,267 bytes larger than the verified round-3 P3 rANS result of 421,773,671
bytes and 328,444 bytes larger than the earlier WavPack result of 422,706,494
bytes. The spatial correction is therefore useful against its disabled control
but does not beat the round-3 temporal predictor.

Per-stem P2 rANS changes are nonpositive in the final matrix. The largest
reductions are r1/bv_s (55,134 bytes), r1/drums (53,769), r2/drums (53,655),
and r1/fx (38,499); r1/bass is unchanged, while r1/lead-vox shrinks by one
byte and r1/guitar by five bytes. Session totals and every stem are retained in
`round-04-evidence/full-results.json` and `full-per-stem.csv`.

The complete delivery accounting includes the 32-byte header, embedded
manifest, rANS tables, frame length/prefix bytes, side information, entropy
and bypass payloads, and transmitted coefficients. The root audit independently
checked all 120 artifacts, 79,124 Rice frame costs, original/coded transcripts,
active PCM and chunk hashes, canonical zero-gap hashes, and disabled P0
post-magic equality against round 3. Its compact receipts are
`round-04-evidence/pilot-root-verification.json`,
`round-04-evidence/sanitized-root-verification.json`, and
`round-04-evidence/full-root-verification.json`.

Three serial, shuffled, audit-free decode trials were run over the four pilot
stems. The timed interval includes native compressed-file reads, decode, and
PCM output writes; input warming and preflight hashing, post-decode digest
verification are outside it. Median wall/user/system CPU seconds were
2.236973/2.04/0.14 for disabled Rice, 2.286924/2.11/0.12 for disabled rANS,
2.256630/2.09/0.13 for profile 2 Rice, 2.309486/2.12/0.13 for profile 2
rANS, and 7.829731/7.65/0.14 for the round-3 profile 3 rANS reference. Profile
2 adds 0.019657 seconds (0.879%) to disabled Rice and 0.022562 seconds
(0.987%) to disabled rANS in this set; round-3 profile 3 rANS is 3.390x slower
than selected profile 2 rANS. Child RSS was 4,864 KiB for every mode. The
timing receipt records the three trial orders and all 60 successful decode
summaries in `round-04-evidence/timing-freeze.json` and `timing.json`; browser,
OPFS, network, and decoder download costs were not measured.
