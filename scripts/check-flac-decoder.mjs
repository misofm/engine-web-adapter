import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bytes = await readFile("src/internal/engine-web-flac-decoder.wasm");
assert.ok(bytes.byteLength <= 256 * 1024, "decoder Wasm exceeds 256 KiB");
const module = await WebAssembly.compile(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), [
  { module: "env", name: "miso_flac_read", kind: "function" },
]);
const instance = await WebAssembly.instantiate(module, { env: { miso_flac_read: () => -1 } });
const memory = instance.exports.memory;
assert.ok(memory instanceof WebAssembly.Memory);
assert.equal(memory.buffer.byteLength, 32 * 64 * 1024);
assert.throws(() => memory.grow(1), RangeError, "decoder memory unexpectedly grows");
console.log(`flac-decoder-policy: ${bytes.byteLength} bytes, one read import, fixed 32/32 pages`);
