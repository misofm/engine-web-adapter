# Sparse stem delivery contract

Issue #54 admits a bounded `MISOSPC1` object: a 16-byte header, a canonical
UTF-8 JSON index tagged `miso_sparse_stems_v1`, then concatenated native FLAC
units. The index is validated at fixed depth before canonical serialization;
source identities are sorted, unit offsets cover the payload exactly, and an
empty unit list means an all-silent source. Parsing reads only the header and
index. It does not verify FLAC or decoded PCM digests.

The derived `miso_sparse_pcm_v1` index is independent metadata. Its interval
offsets are packed canonical PCM offsets computed from channel and bit depth,
never copied from compressed units. `readSparsePcmWindow` returns one
zero-filled logical window of at most 8192 frames. It binary-searches the first
active interval, performs one contiguous packed Blob read for all intersections,
and performs no read for an all-gap window. A short read is an error. Callers
own generation checks, cancellation and physical-read admission; this helper
does not create a pump or background concurrency state machine.
