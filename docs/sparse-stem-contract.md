# Indexed sparse stem delivery contract

Issue #56 replaces the unreleased recording-wide MISOSPC1 package with one
ordinary blob per canonical stem. The object is exactly:

MISOSTM1 header (16 bytes) || canonical manifest || packed FLAC payload.

The header stores a little-endian manifest length in bytes 8..11; bytes 12..15
are zero. The manifest is bounded to 8 MiB, the object to 8 GiB, and the
payload begins immediately after the manifest. Old MISOSPC1 and unknown
magics are rejected. The parser reads exactly the header and manifest slices;
the payload remains a Blob view and no FLAC bytes are authenticated here.

The manifest has one source shape and the fixed format tag
miso_sparse_stem_v1. Its recursively lexicographic canonical JSON contains
the identity, rate, channels, bit depth, total frames, timeline intervals and
packed FLAC chunks. The identity is the BLAKE3-256 digest of the complete
canonical PCM timeline, including implicit zero gaps. Intervals are sorted,
non-overlapping and maximal. Their
packedFrameOffset values cover active frames from zero. Chunks have
independent SHA-256 FLAC and decoded PCM transport digests, contiguous payload offsets and
packed-frame offsets. Chunk records may cross interval boundaries and are
bounded to 30 seconds and 32 MiB. Empty intervals and chunks represent a
valid all-silent stem with an empty payload. Admission proves metadata and
extent arithmetic; it does not verify FLAC, STREAMINFO, decoded PCM, or the
whole-source digest.

admitSparseStemHeader admits only the exact 16-byte header and returns the
bounded manifest length and payload start. admitSparseStemManifest admits
exactly the manifest bytes and can check a known payload length. These pure
seams let a later sequential GET consumer stream the header and manifest
without a whole-blob read. parseSparseStemPackage provides the bounded local
Blob qualification path, and serializeSparseStemPackage emits the same exact
envelope.

assertSparseStemSessionBinding compares one admitted manifest with one
canonical session identity and native shape. The session remains authoritative;
manifest metadata cannot override it. Source aliases are handled later by
consumer normalization using identity and shape, while recording-level source
readiness remains outside this format helper.

deriveSparsePcmIndex uses only the interval timeline and packed frame offsets.
It computes canonical PCM byte offsets from channels and bit depth; FLAC chunk
boundaries and hashes never enter the PCM index. The existing
miso_sparse_pcm_v1 admission and readSparsePcmWindow helper retain their
private one-time brand, 65,536-interval and 8 MiB metadata bounds, binary
search, one contiguous packed read per window, exact zero fill, and 8,192-frame
window cap. Preparation must later verify each SHA-256 FLAC hash, exact
STREAMINFO, decoded chunk length/SHA-256 hash, and the full canonical BLAKE3-256
source identity before cache readiness.
