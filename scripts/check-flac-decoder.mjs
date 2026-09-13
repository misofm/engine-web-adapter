import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const asset = await readFile("node_modules/@misofm/codec/wasm/flac-decoder.wasm");
const hash = createHash("sha256").update(asset).digest("hex");
assert.equal(hash, "70caf38185675dff89498e89f98171d49ec6f143a56c6895088d93c35e2018cd", "installed codec asset hash changed");
assert.ok(asset.byteLength <= 256 * 1024, "codec decoder Wasm exceeds 256 KiB");

const module = await WebAssembly.compile(asset);
assert.deepEqual(WebAssembly.Module.imports(module), [
  { module: "codec", name: "read", kind: "function" },
]);
const instance = await WebAssembly.instantiate(module, { codec: { read: () => -1 } });
const memory = instance.exports.memory;
assert.ok(memory instanceof WebAssembly.Memory);
assert.equal(memory.buffer.byteLength, 2 * 1024 * 1024, "codec decoder memory changed");
assert.throws(() => memory.grow(1), RangeError, "codec decoder memory unexpectedly grows");
assert.equal(typeof instance.exports.codec_decoder_process_single, "function");
assert.equal(typeof instance.exports.codec_decoder_finish, "function");
console.log(`codec-decoder-policy: ${asset.byteLength} bytes, public asset ${hash}, fixed 2 MiB memory`);
