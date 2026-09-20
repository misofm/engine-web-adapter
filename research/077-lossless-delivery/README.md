# Issue #77: lossless delivery experiment

This directory contains an offline, issue-specific experiment and its evidence.
It does not change the adapter, a production format, or publication tooling.
See [REPORT.md](REPORT.md) for the measured recommendation.

## Corpus and exactness

`sources.json` preserves the 30-stem publication baseline as portable metadata,
including original FLAC and published blob IDs, byte counts, SHA-256 identities,
recording/source names, PCM shapes, and the publication receipt's SHA-256.
`manifests/` preserves every published manifest **byte-for-byte** (there is no
added newline), including every active interval and chunk hash. The release is
pinned to `misofm/releases` revision
`aab52d13309a191494bcb02dc706519c31bc1a97`, path
`gatewaygirl-between-the-doors/release.json`. These references do not depend on
the original machine's receipt path. Audio is not checked into this repository.

Every input blob must match its frozen byte count and SHA-256. Original FLAC is
decoded with libFLAC into headerless, signed, interleaved stereo 24-bit
little-endian PCM at 44,100 Hz. All samples, including the least significant bit,
remain unchanged. The runner checks the original canonical SHA-256, checks that
**every omitted byte is zero**, and freezes the original active interval map.
It never derives a new activity threshold. Each encoded chunk is independently
decoded and checked for exact byte count and PCM SHA-256. The decoded active
regions are reassembled in original order with synthesized zero gaps, and the
full canonical SHA-256 must match the original identity. It also compares the
packed PCM SHA-256. This includes channel ordering and leading/trailing gaps.

The publication uses 137 independent FLAC streams, split at 1,323,000 packed
frames (30 seconds of **active** PCM), across 30 independently published blobs.
Chunks can cross original region boundaries. Larger chunks use 2,646,000 packed
frames. `concat` uses one stream per stem; `dense` retains every original frame.
All sparse variants retain identical intervals, channels, bit depth, and PCM.

The FFmpeg 6.1.1 level-5 replay includes the publication's metadata finalization:
clear optional STREAMINFO frame-byte bounds, write the known sample count, and
write the PCM MD5. This does not change compressed audio frames. Both the replay
and extracted publication must reproduce the entire original indexed blob
SHA-256, not just its size. A preliminary run that omitted finalization was
rejected by this gate and is excluded from the reported measurements.

## Byte accounting

Each sparse candidate is materialized as **one complete blob per stem**:
8-byte magic, 8-byte little-endian manifest length, compact sorted-key JSON,
then all encoded streams. The total includes all codec headers, frame/subframe
metadata, predictor coefficients, indexes, hashes, and the interval map.
FLAC candidates retain the published `MISOSTM1` envelope and manifest shape.
Experimental WavPack uses `MISO77WV`, `issue77_research_wavpack_v1`, and
`wavpackSha256` in place of `flacSha256`. The dense matched-codec control uses
`MISO77DF` and `issue77_research_dense_flac_v1`; its chunk covers full PCM and
its retained interval map describes the desired sparse cache. These two
research envelopes are **not supported production delivery formats**.

The historical original row counts the original bare FLAC files. It did not
deliver the sparse interval maps; the dense matched-codec control includes them
to make its comparison with concatenated sparse FLAC fair. Unchanged session
descriptors, release metadata, transport headers, and the decoder are excluded
from all stem-byte totals and discussed separately in the report. Manifests
are already inside each blob: do not add them twice. Codec metadata is a subset
of payload bytes, not an additional charge. No cross-stem bundling occurs.

## Reproduction

Requirements: Python 3.12, GNU `time`, CMake, a C/C++ compiler, FFmpeg **6.1.1**,
libFLAC **1.5.0**, and WavPack/WvUnpack **5.9.0**. The measured run uses the Ubuntu
FFmpeg 6.1.1-3ubuntu5 executable, not the newer `/usr/bin/ffmpeg` symlink on the
measurement server. `evidence/freeze.json` records complete version output,
binary hashes, the exact encoder/decoder arguments, platform, CPU, concurrency,
and input/script hashes before encoding begins.

Native tools can be built outside the repository:

```sh
mkdir -p /tmp/issue77-tools
tar -xf vendor/libflac-1.5.0/flac-1.5.0.tar.xz -C /tmp/issue77-tools
cmake -S /tmp/issue77-tools/flac-1.5.0 -B /tmp/issue77-tools/flac-build \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF \
  -DBUILD_DOCS=OFF -DWITH_OGG=OFF -DBUILD_SHARED_LIBS=OFF
cmake --build /tmp/issue77-tools/flac-build --parallel 4
curl -fLsS https://www.wavpack.com/wavpack-5.9.0.tar.xz \
  -o /tmp/issue77-tools/wavpack-5.9.0.tar.xz
sha256sum /tmp/issue77-tools/wavpack-5.9.0.tar.xz
tar -xf /tmp/issue77-tools/wavpack-5.9.0.tar.xz -C /tmp/issue77-tools
cmake -S /tmp/issue77-tools/wavpack-5.9.0 -B /tmp/issue77-tools/wavpack-build \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF -DBUILD_SHARED_LIBS=OFF
cmake --build /tmp/issue77-tools/wavpack-build --parallel 4
```

Verify archive SHA-256 before building:

| Archive | SHA-256 |
| --- | --- |
| `flac-1.5.0.tar.xz` | `f2c1c76592a82ffff8413ba3c4a1299b6c7ab06c734dee03fd88630485c2b920` |
| `wavpack-5.9.0.tar.xz` | `b5291bc4e6d69ebbd3da3800c5bf4a70f19bb92679b23e09b3b612c1e648d1ff` |

Supply a caller-owned URL template containing `{blob_id}`. The runner downloads
both original and published inputs and verifies the frozen hashes before use.
For example, set `ISSUE77_BLOB_URL_TEMPLATE` to the release's accessible blob
gateway template, then run from the repository root:

```sh
python3 research/077-lossless-delivery/run.py \
  --work /tmp/issue77-run \
  --flac /tmp/issue77-tools/flac-build/src/flac/flac \
  --wavpack /tmp/issue77-tools/wavpack-build/wavpack \
  --wvunpack /tmp/issue77-tools/wavpack-build/wvunpack \
  --ffmpeg /path/to/ffmpeg-6.1.1 \
  --url-template "$ISSUE77_BLOB_URL_TEMPLATE" --workers 4
python3 research/077-lossless-delivery/prepare.py --work /tmp/issue77-run
python3 research/077-lossless-delivery/summarize.py \
  --work /tmp/issue77-run --output /tmp/issue77-evidence
```

Alternatively, replace `--url-template` with `--local-inputs /path/to/inputs.json`.
That JSON maps each canonical digest (without `sha256:`) to
`{"original":"/path/to/original.flac","published":"/path/to/published.mspcm"}`.
The measurement used this mode; the mapping is intentionally machine-local.
Existing inputs get the same digest checks as downloaded inputs.
The public CDN allowed `curl` but returned HTTP 403 to Python's default urllib
client during a retrieval spot-check. If that applies to the caller's gateway,
stage the inputs with the included curl helper and use its local mapping:

```sh
python3 research/077-lossless-delivery/fetch.py \
  --output /tmp/issue77-inputs --url-template "$ISSUE77_BLOB_URL_TEMPLATE"
# Pass --local-inputs /tmp/issue77-inputs/local-inputs.json to run.py.
```

The work directory must be outside the repository. Use a fresh directory for
each experiment. `--freeze-only` writes the configuration without measurements;
`--resume-frozen` runs that exact configuration and rejects changed code, tools,
maps, or concurrency. It does not resume a partially completed experiment.

## Measurement interpretation

The screening run admits four stems at once. Within each stem, each codec
process runs serially. WavPack explicitly uses one thread; libFLAC defaults to
one. FFmpeg uses the publication's arguments. Encoder wall times sum codec
process invocations, including startup and output writes; they exclude Python
PCM extraction, metadata finalization, packaging, and verification. They are
offline encoding cost, not installation time. Screening decode times include
native process startup and decoded-file writes, and run alongside encoders;
they are not a controlled latency comparison.

`prepare.py` separately freezes and executes three trials with one active stem
and one native decoder at a time. Candidate order is shuffled with seed 77.
Compressed files are verified before timing, so their page cache is warm.
Each trial writes a new sparse cache. Timing starts before decoder startup,
includes bounded pipe reads, canonical hashing (including synthesized zeros),
sparse writes, `fsync`, and rename after verification. Deletion is untimed.
Codec-process maximum RSS comes from GNU `time`; it excludes Python, the OS
page cache, and all browser memory. The cache is ordinary server storage,
not OPFS. Network/download time is not measured. No cache-drop or cold-network
claim is made. No server time is presented as a mobile result.

`evidence/per-stem.csv` contains all 420 candidate/stem rows and their exact
reconstructed PCM and blob SHA-256 hashes. `per-session.csv` contains each of
the four recording sessions; `totals.csv` aggregates the 30-stem release.
`results.json` additionally records every chunk hash and native process metrics.
The preparation receipt contains all 450 independently verified stem
preparations (five candidates × three trials × 30 stems).

Run the experiment's acceptance-gate tests without codec dependencies:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s research/077-lossless-delivery -p 'test_*.py' -v
```

These cover channel swaps, signed extrema and single-LSB samples, nonzero
omissions, truncation/trailing data, interval/chunk corruption, bounded copies,
and frozen baseline accounting. The full native experiment exercises the real
codec round trips. Package/browser tests are not release gates for this research
change because no package code or assets change and no release is proposed.
