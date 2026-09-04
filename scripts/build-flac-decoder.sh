#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
archive="$root/vendor/libflac-1.5.0/flac-1.5.0.tar.xz"
expected=f2c1c76592a82ffff8413ba3c4a1299b6c7ab06c734dee03fd88630485c2b920
actual=$(shasum -a 256 "$archive" | awk '{print $1}')
test "$actual" = "$expected"
test "$(emcc --version | sed -n '1s/.* //p')" = "6.0.9-git"

work=$(mktemp -d "${TMPDIR:-/tmp}/engine-flac-wasm.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
# Homebrew's installed cache is read-only and macOS's per-user TMPDIR cannot
# execute configure probes in some sandbox profiles. Keep compiler cache files
# outside the repository at an explicit writable location; callers may override.
cache=${EM_CACHE:-/tmp/engine-web-adapter-em-cache}
mkdir -p "$cache"
tar -xf "$archive" -C "$work"
source="$work/flac-1.5.0"
build="$work/build"
mkdir "$build"

cd "$build"
EM_CACHE="$cache" emconfigure "$source/configure" \
  --host=wasm32-unknown-emscripten \
  --srcdir="$source" --disable-shared --enable-static --disable-ogg \
  --disable-programs --disable-examples --disable-doxygen-docs \
  --disable-cpplibs --disable-asm-optimizations >/dev/null

common="-O3 -ffreestanding -fno-builtin -DFLAC__NO_DLL -DHAVE_CONFIG_H -I$build -I$source/include -I$source/src/libFLAC/include"
objects=""
for unit in bitmath bitreader cpu crc fixed format lpc md5 memory stream_decoder; do
  object="$work/$unit.o"
  EM_CACHE="$cache" emcc $common -c "$source/src/libFLAC/$unit.c" -o "$object"
  objects="$objects $object"
done

wrapper="$work/wrapper.o"
runtime="$work/freestanding.o"
EM_CACHE="$cache" emcc $common -c "$root/decoder/flac_decoder.c" -o "$wrapper"
EM_CACHE="$cache" emcc $common -c "$root/decoder/freestanding.c" -o "$runtime"
output="$work/engine-web-flac-decoder.wasm"
wasm_ld=$(emcc -v 2>&1 | sed -n 's/^InstalledDir: //p')/wasm-ld
test -x "$wasm_ld"
"$wasm_ld" --no-entry --allow-undefined --import-undefined --export-memory \
  --initial-memory=2097152 --max-memory=2097152 --stack-first -z stack-size=65536 \
  --strip-all \
  --export=miso_flac_decoder_abi_version \
  --export=miso_flac_decoder_description_ptr \
  --export=miso_flac_decoder_description_capacity \
  --export=miso_flac_decoder_output_ptr \
  --export=miso_flac_decoder_output_length \
  --export=miso_flac_decoder_output_frames \
  --export=miso_flac_decoder_callback_error \
  --export=miso_flac_decoder_state \
  --export=miso_flac_decoder_initialize \
  --export=miso_flac_decoder_process_single \
  --export=miso_flac_decoder_release_output \
  --export=miso_flac_decoder_finish \
  --export=miso_flac_decoder_destroy \
  --export=miso_flac_allocator_live_bytes \
  --export=miso_flac_allocator_peak_live_bytes \
  --export=miso_flac_allocator_peak_heap_bytes \
  --export=miso_flac_allocator_free_calls \
  --export=miso_flac_allocator_realloc_calls \
  -o "$output" "$wrapper" $objects "$runtime"

size=$(wc -c < "$output" | tr -d ' ')
test "$size" -le 262144
candidate=$(shasum -a 256 "$output" | awk '{print $1}')
if test "${UPDATE_FLAC_DECODER_ASSET:-0}" = 1; then
  cp "$output" "$root/src/internal/engine-web-flac-decoder.wasm"
  printf '%s  %s\n' "$candidate" engine-web-flac-decoder.wasm > "$root/decoder/flac_decoder.sha256"
fi
pin=$(awk '{print $1}' "$root/decoder/flac_decoder.sha256")
test "$candidate" = "$pin"
cmp "$output" "$root/src/internal/engine-web-flac-decoder.wasm"
printf '%s  %s\n' "$candidate" engine-web-flac-decoder.wasm
