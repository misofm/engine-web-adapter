# libFLAC Wasm decoder

`flac_decoder.c` is the package-private streaming wrapper around the official
libFLAC 1.5.0 decoder. `../vendor/libflac-1.5.0/flac-1.5.0.tar.xz` is the
unaltered upstream release archive; its SHA-256 is
`f2c1c76592a82ffff8413ba3c4a1299b6c7ab06c734dee03fd88630485c2b920`.

Run `scripts/build-flac-decoder.sh` with Emscripten 6.0.9. The build has no
encoder, Ogg, CLI, filesystem, socket, pthread, WASI, or memory-growth surface.
The only application import is the synchronous `env.miso_flac_read` bridge.
The script uses `/tmp/engine-web-adapter-em-cache` because the pinned
Homebrew toolchain cache is read-only; set `EM_CACHE` to another pre-created or
writable cache directory on non-macOS builders.
