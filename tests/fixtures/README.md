# Native FLAC browser fixture

`native-silence.flac` is a 206-byte mono PCM16 fixture containing
2,048 zero frames at 48 kHz. It was generated with Xiph FLAC 1.5.0 using a
512-frame block size and seek metadata. Its metadata is
followed by a legal final VORBIS_COMMENT block, exercising the corrected
metadata scan in the packed browser path.

- Canonical PCM SHA-256: `ad7facb2586fc6e966c004d7d1d16b024f5805ff7cb47c7a85dabd8b48892ca7`
- FLAC SHA-256: `2e918bc9adc707a1f7af8884e43ef38aeb11e1b4a53de3ff97fcdbf9900b5787`
- Encoder: Xiph FLAC 1.5.0 (`--blocksize=512`, no padding)

`native-variable-stereo24.flac` is a 42,114-byte stereo PCM24 fixture with
41,024 frames at 48 kHz, increasing variable block sizes of 576, 1,152,
2,304, and 4,096 samples, then eight more maximum-size blocks and one legal
128-sample final partial block below the declared minimum.
`scripts/generate-variable-flac-fixture.mjs`
deterministically creates the PCM, encodes each block with Xiph FLAC, converts
the frames to contiguous variable-block numbering, updates STREAMINFO/MD5, and
checks the result with the reference decoder.

- Canonical PCM SHA-256: `1c56647d30a67bd892fd802860925f85eed692a706151dd1738235e0dc62889f`

`native-reordered-stereo24.flac` is the negative companion generated from the
same bytes. Its second frame has a valid CRC but starts at sample 577 instead
of 576, proving the private wrapper rejects reordered/noncontiguous PCM rather
than relying on libFLAC to enforce the host's cumulative-position contract.
