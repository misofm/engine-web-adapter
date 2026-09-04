# Native FLAC browser fixture

`native-silence.flac` is a 206-byte mono PCM16 fixture containing
2,048 zero frames at 48 kHz. It was generated with Xiph FLAC 1.5.0 using a
512-frame block size and seek metadata. Its metadata is
followed by a legal final VORBIS_COMMENT block, exercising the corrected
metadata scan in the packed browser path.

- Canonical PCM SHA-256: `ad7facb2586fc6e966c004d7d1d16b024f5805ff7cb47c7a85dabd8b48892ca7`
- FLAC SHA-256: `2e918bc9adc707a1f7af8884e43ef38aeb11e1b4a53de3ff97fcdbf9900b5787`
- Encoder: Xiph FLAC 1.5.0 (`--blocksize=512`, no padding)
