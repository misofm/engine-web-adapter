# Lossless stem delivery: server results for issue #77

Measured 2026-09-12. **Recommend a separately scoped libFLAC encoder-tuning
follow-up that preserves the current 30-second independent chunks.** libFLAC
1.5.0 `-8 -e` reduces the 30-stem release by **8,896,091 bytes (2.0483%)** against
the published indexed blobs. Combining each stem into a single FLAC stream
saves only another **25,611 bytes**. WavPack's strongest tested lossless setting
saves a further **2,683,560 bytes (0.6308%)** against that concatenated FLAC,
but takes **12.325 seconds versus 6.855 seconds** to prepare verified sparse PCM
in the serial server trial median. That is insufficient evidence to recommend
another browser decoder for this release.

**Custom residual codec: no-go for implementation at this stage.** No custom
prototype was justified or built, and no ANS/Rice savings are claimed.
Production formats and code remain unchanged. At the requester's direction,
this pass benchmarks the server only; mobile/network measurements are deferred.
The forthcoming separated stems were not supplied and are not represented by
the current submixed corpus.

## Results and baseline

The exact inputs are the 30 stems in four recording sessions from
[Between the Doors at the pinned release revision](https://github.com/misofm/releases/blob/aab52d13309a191494bcb02dc706519c31bc1a97/gatewaygirl-between-the-doors/release.json).
All are stereo, signed 24-bit PCM at 44,100 Hz. All **420 candidate/stem
round trips** and **450 repeated stem preparations** reproduced their original
full canonical SHA-256, including zero gaps and channel ordering.
The FFmpeg level-5 replay also reproduced all 30 published blobs byte-for-byte.

| Preserved publication measurement | Bytes |
| --- | ---: |
| Original full-length FLAC | 431,666,252 |
| Published indexed blobs | 434,311,756 |
| FLAC payload inside those blobs | 434,233,060 |
| Manifest JSON inside those blobs | 78,216 |
| Fixed blob headers, 30 × 16 bytes | 480 |
| Full canonical PCM | 1,308,317,520 |
| Active PCM in sparse cache | 971,988,594 |
| PCM zeros omitted | 336,328,926 |

The published delivery is **2,645,504 bytes (0.6129%) larger** than the original
FLAC. Its 336 MB of omitted PCM is a cache saving, not a compressed download
saving. The manifests are already included in the indexed-blob total.

All following delivery totals include the complete per-stem envelope,
serialized manifest, codec metadata, and encoded audio. The original reference
is its historical bare FLAC delivery; the dense tuned control includes the
same interval map as the sparse candidates. Unchanged session descriptors and
release metadata are excluded uniformly. MB means 1,000,000 bytes.

| Candidate | Delivered bytes | Saving vs published | Offline encode seconds¹ |
| --- | ---: | ---: | ---: |
| Original full-length FLAC | 431,666,252 | 0.6091% | Unknown historical cost |
| Published sparse FLAC, 30 s | 434,311,756 | 0 | Unknown historical cost |
| FFmpeg 6.1.1 level 5, 30 s replay | 434,311,756 | 0 | 17.867 |
| FFmpeg 6.1.1 level 8, 30 s | 431,589,055 | 0.6269% | 26.355 |
| libFLAC 1.5.0 `-5`, 30 s | 430,897,046 | 0.7862% | 5.915 |
| libFLAC `-8`, 30 s | 425,769,056 | 1.9670% | 15.434 |
| **libFLAC `-8 -e`, 30 s** | **425,415,665** | **2.0483%** | **60.814** |
| libFLAC `-8 -e`, 60 s | 425,400,585 | 2.0518% | 60.651 |
| libFLAC `-8 -e`, one active stream/stem | 425,390,054 | 2.0542% | 60.516 |
| libFLAC `-8 -e`, full-length + interval map | 425,945,289 | 1.9264% | 62.080 |
| WavPack 5.9.0 default, one active stream/stem | 442,707,247 | −1.9331% | 8.730 |
| WavPack `-x6`, one active stream/stem | 427,864,156 | 1.4846% | 525.473 |
| WavPack `-hh`, one active stream/stem | 436,901,091 | −0.5962% | 15.317 |
| WavPack `-hh -x6`, one active stream/stem | 422,706,494 | 2.6721% | 876.054 |

¹ Sum of native encoder invocation wall times with four stems admitted at
once. Includes process startup/output writes, excludes Python extraction,
metadata finalization, assembly and verification. This is offline screening
cost, not elapsed installation time. The entire screening run took 513.957 s.
Original-file encoder versions/settings were not recorded; that row is a
frozen historical artifact, not an attribution to a particular encoder preset.

Per-session totals for the leading comparisons:

| Session | Published | Tuned FLAC, 30 s | Tuned FLAC, one active stream | WavPack `-hh -x6` |
| --- | ---: | ---: | ---: | ---: |
| r1 — Ghost | 92,722,644 | 90,604,822 | 90,598,020 | 89,993,620 |
| r2 — War | 71,722,085 | 68,302,183 | 68,298,834 | 67,943,888 |
| r3 — Play Me | 108,642,019 | 106,716,345 | 106,710,412 | 106,002,398 |
| r4 — Wide Open | 161,225,008 | 159,792,315 | 159,782,788 | 158,766,588 |

The complete [per-stem table](evidence/per-stem.csv),
[all per-session comparisons](evidence/per-session.csv), and
[aggregate totals](evidence/totals.csv) include all tested candidates.

## What causes the overhead?

**Encoder settings explain much more than the blob headers.** Keeping the
exact published PCM, interval map, and 137 chunk boundaries, FFmpeg level 8
saves 2,722,701 bytes relative to level 5. That alone slightly exceeds the
publication's 2,645,504-byte regression against original FLAC. Switching to
libFLAC `-8 -e` at the same boundaries saves 8,896,091 bytes. This controlled
result supports encoder tuning; it does not establish the historical original
encoder's settings.

**The independent chunk penalty is tiny here.** With libFLAC `-8 -e`, moving
from 137 streams to 30 saves 25,611 bytes in total: the JSON shrinks by 25,451
bytes and FLAC payload shrinks by only **160 bytes**. FLAC file metadata shrinks
by 9,202 bytes (11,782 → 2,580), almost completely offset by a 9,042-byte increase
in audio-frame data from the changed framing. Therefore, repeated file headers
alone overstate the measured savings available from merging chunks. The
60-second intermediate candidate saves 15,080 bytes against 30 seconds.

**Removing silence does save some compressed bytes under matched settings,
but far less than raw PCM.** At libFLAC `-8 -e`, one concatenated active stream
plus map saves 555,235 bytes (about 0.13%) against full-length FLAC plus the same
map. That net comparison includes removed silent frames and the effect of
joining active boundaries; this experiment does not separate those two effects
into independent causal estimates. Both reconstruct exactly the same PCM.
The more separated stem set could behave differently and needs its own run.

**Extra encoder search has diminishing but measurable returns.** libFLAC
`-8 -e` saves another 353,391 bytes over `-8`, at about 45 seconds more summed
offline encoder time for the release. That is reasonable for a one-time
publication if minimizing delivered bytes is the priority. WavPack `-x6`
substantially improves its own default and `-hh` outputs, so testing only
WavPack's default would have missed its best result. Its strongest tested
setting remains only 0.63% smaller than tuned FLAC.

## Server preparation and decoder cost

Measured on Linux x86-64, AMD EPYC 7313P (16 cores, 32 logical CPUs). See the
[frozen environment and commands](evidence/freeze.json) for full details.
These separate trials run **one stem and one native decoder at a time**, with
three repeats and seed-77 shuffled candidate order. Input page cache is warm
because compressed-file hashes are checked before timing; output is a fresh
cache each time. The timed path streams decoded PCM through a bounded pipe,
hashes full canonical PCM including synthesized gaps, writes 971,988,594 sparse
cache bytes across the release, checks every digest/count, and flushes/fsyncs
the cache before its verified rename. It neither reads nor writes on an audio
render thread.

| Candidate | Release preparation median | Min–max over 3 trials | Max native decoder RSS² |
| --- | ---: | ---: | ---: |
| Published, 30 s | 6.961 s | 6.821–6.997 s | 2,816 KiB |
| libFLAC `-8`, 30 s | 7.171 s | 7.154–7.237 s | 2,816 KiB |
| libFLAC `-8 -e`, 30 s | 7.158 s | 7.137–7.174 s | 2,816 KiB |
| libFLAC `-8 -e`, one active stream | 6.855 s | 6.800–6.889 s | 2,816 KiB |
| WavPack `-hh -x6`, one active stream | 12.325 s | 12.270–12.328 s | 1,792 KiB |

² GNU `time` maximum RSS of one native decoder process. This excludes the
Python orchestrator, filesystem page cache, and browser memory. It is **not**
an end-to-end peak-memory measurement. The preparation code reads at most
1 MiB per copy, regardless of stream length; full PCM scratch files in the
offline screening run live on disk. These are server filesystem measurements,
not browser/OPFS results. Fine differences between FLAC variants should not be
generalized from one server and three trials.

The existing package libFLAC Wasm asset is 56,762 bytes, or 22,392 bytes with
local gzip level 9, excluding JavaScript glue and workers. Tuning a compatible
FLAC encoder does not require adding a codec asset. No WavPack browser decoder
was built, so its additional Wasm/JavaScript transfer and browser peak memory
remain unmeasured. Native executable size is not used as a substitute.

**Downloaded bytes are measured as exact complete artifact lengths; network
download duration is not measured.** The prepared inputs were local. As a
clearly hypothetical additive model, at 10 Mbit/s WavPack's extra 2,683,560-byte
saving against concatenated tuned FLAC buys about 2.15 seconds of transfer,
while its measured server preparation costs another 5.47 seconds. The
corresponding no-overlap break-even is about 3.93 Mbit/s, before any added
decoder transfer. Pipelining and mobile behavior can change that comparison;
this arithmetic is neither a network test nor a mobile prediction.

## Recommendation, custom coding decision, and remaining work

1. **Follow up on libFLAC `-8 -e` with the existing chunk policy.** It captures
   essentially all of the measured FLAC savings without a new browser codec
   or a chunk-policy change. Plain `-8` is a cheaper offline alternative that
   gives up only 353 KB across the release. A `misofm/cli` change must get a
   separate issue with exact-PCM, byte-saving and packaging acceptance targets.
2. **Do not replace FLAC with WavPack on this evidence.** WavPack wins the
   narrow byte comparison by 2.68 MB, but loses this server preparation
   comparison by 5.47 s and requires a browser decoder that was not evaluated.
   Very slow transport or a different corpus could justify revisiting it.
3. **Do not pursue a custom residual-codec implementation now.** FLAC already
   provides fixed/LPC prediction, partitioned Rice coding, wasted-bit removal
   and stereo decorrelation, as described in
   [RFC 9639](https://www.rfc-editor.org/rfc/rfc9639.html). Another LPC/Rice
   implementation is not itself a new compression opportunity. This run does
   not compare a fixed residual sequence under Rice and ANS, so it supplies
   no evidence for or against a particular ANS probability model. Reconsider
   a bounded prototype only with a concrete residual-model hypothesis and an
   expected all-in benefit sufficient to justify another decoder; retain the
   same predictor when isolating entropy coding and count all side information.
4. **Re-run on the separated stems when available.** Their different silence
   distribution may change the answer. Real mobile/browser installation,
   network timings, and WavPack Wasm footprint remain deferred by the requester.
   No production migration or release readiness is claimed here.

The encoder-search options follow the primary documentation for
[FLAC](https://xiph.org/flac/documentation_tools_flac.html) and
[WavPack](https://www.wavpack.com/wavpack_doc.html).
All configurations, data identities, verification code, build commands, and
portable fixture acquisition are in [README.md](README.md).
[provenance.json](provenance.json) records archive identities and checks all
published blob IDs against the pinned release; a
[public retrieval spot-check](portable-retrieval.json) verified both original
and published bytes independently of the machine-local corpus. The
[evidence manifest](evidence/evidence-hashes.json) hashes the retained reports
and raw measurement receipts. No engine or application source was inspected
or copied, and no production package files were changed.
