import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(packageJson.version, "0.5.6");
assert.deepEqual(packageJson.dependencies, {
  "@misofm/codec": "0.1.1",
  "@misofm/engine": "0.2.4",
  effect: "4.0.0-rc.112",
  "hash-wasm": "4.12.0",
});
assert.equal(packageJson.type, "module");
const blake3Manifest = JSON.parse(await readFile("src/stems/blake3-wasm.manifest.json", "utf8"));
const blake3Wasm = await import("../dist/stems/blake3-wasm.js");
assert.equal(blake3Wasm.BLAKE3_WASM_SHA256, blake3Manifest.assetSha256);
assert.equal(
  createHash("sha256").update(blake3Wasm.BLAKE3_WASM_BYTES).digest("hex"),
  blake3Manifest.assetSha256,
  "packed BLAKE3 Wasm bytes must match the reproducible manifest",
);
const { ADAPTER_PROVENANCE } = await import("../dist/provenance.js");
assert.equal(ADAPTER_PROVENANCE.engine.package, `@misofm/engine@${packageJson.dependencies["@misofm/engine"]}`, "built provenance must identify the installed Engine dependency");
const cache = await mkdtemp(join(tmpdir(), "engine-web-adapter-npm-cache-"));
const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8", env: { ...process.env, npm_config_cache: cache },
});
if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
const report = JSON.parse(packed.stdout)[0];
const names = new Set(report.files.map((file) => file.path));
for (const required of [
  "dist/index.js", "dist/index.d.ts",
  "dist/internal/engine-web-pcm-pump-worker.js", "dist/internal/engine-web-flac-worker.js", "dist/internal/engine-web-sparse-verify-worker.js",
  "dist/internal/engine-web-flac-decoder.wasm",
  "dist/internal/engine-web-opfs-worker.js",
  "dist/codec-licenses/codec-LICENSE",
  "dist/codec-licenses/effect-LICENSE",
  "dist/codec-licenses/hash-wasm-LICENSE",
  "dist/stems/blake3-wasm.js",
  "dist/codec-licenses/blake3-LICENSE_A2",
  "dist/codec-licenses/blake3-LICENSE_A2LLVM",
  "dist/codec-licenses/blake3-LICENSE_CC0",
  "dist/codec-licenses/blake3-arrayvec-LICENSE-APACHE",
  "dist/codec-licenses/blake3-arrayvec-LICENSE-MIT",
  "dist/codec-licenses/blake3-cfg-if-LICENSE-APACHE",
  "dist/codec-licenses/blake3-cfg-if-LICENSE-MIT",
  "dist/codec-licenses/blake3-constant_time_eq-LICENSE-APACHE",
  "dist/codec-licenses/blake3-constant_time_eq-LICENSE-CC0",
  "dist/codec-licenses/blake3-constant_time_eq-LICENSE-MIT0",
  "dist/codec-licenses/THIRD_PARTY_NOTICES.md",
  "dist/codec-licenses/vendor/licenses/compiler-rt.txt",
  "dist/codec-licenses/vendor/licenses/emscripten.txt",
  "dist/codec-licenses/vendor/licenses/libFLAC.txt",
  "dist/codec-licenses/vendor/licenses/musl.txt",
  "README.md", "NOTICE", "LICENSE",
]) assert.ok(names.has(required), `packed artifact missing ${required}`);
for (const [packedPath, sourcePath] of [
  ["dist/codec-licenses/codec-LICENSE", "node_modules/@misofm/codec/LICENSE"],
  ["dist/codec-licenses/effect-LICENSE", "node_modules/effect/LICENSE"],
  ["dist/codec-licenses/hash-wasm-LICENSE", "node_modules/hash-wasm/LICENSE"],
  ["dist/codec-licenses/blake3-LICENSE_A2", "native/blake3/licenses/LICENSE_A2"],
  ["dist/codec-licenses/blake3-LICENSE_A2LLVM", "native/blake3/licenses/LICENSE_A2LLVM"],
  ["dist/codec-licenses/blake3-LICENSE_CC0", "native/blake3/licenses/LICENSE_CC0"],
  ["dist/codec-licenses/blake3-arrayvec-LICENSE-APACHE", "native/blake3/vendor/arrayvec/LICENSE-APACHE"],
  ["dist/codec-licenses/blake3-arrayvec-LICENSE-MIT", "native/blake3/vendor/arrayvec/LICENSE-MIT"],
  ["dist/codec-licenses/blake3-cfg-if-LICENSE-APACHE", "native/blake3/vendor/cfg-if/LICENSE-APACHE"],
  ["dist/codec-licenses/blake3-cfg-if-LICENSE-MIT", "native/blake3/vendor/cfg-if/LICENSE-MIT"],
  ["dist/codec-licenses/blake3-constant_time_eq-LICENSE-APACHE", "native/blake3/vendor/constant_time_eq/LICENSE-APACHE"],
  ["dist/codec-licenses/blake3-constant_time_eq-LICENSE-CC0", "native/blake3/vendor/constant_time_eq/LICENSE-CC0"],
  ["dist/codec-licenses/blake3-constant_time_eq-LICENSE-MIT0", "native/blake3/vendor/constant_time_eq/LICENSE-MIT0"],
]) {
  assert.equal(
    await readFile(packedPath, "utf8"),
    await readFile(sourcePath, "utf8"),
    `packed license ${packedPath} must preserve the installed dependency license verbatim`,
  );
}
assert.ok([...names].every((name) => !name.startsWith("tests/") && !name.startsWith("src/")), "source/tests leaked into tarball");
for (const removed of ["dist/internal/engine-web-scratch-worker.js", "dist/internal/engine-web-feed-worklet.js", "dist/stems/flac-packetizer.js", "dist/stems/flac-ingest.js", "dist/stems/flac-pcm.js", "dist/stems/flac-metadata.js"]) {
  assert.ok(!names.has(removed), `packed artifact retained obsolete decoder path ${removed}`);
}

const sourceFiles = [...names].filter((name) => name.endsWith(".js") && name.startsWith("dist/"));
for (const file of sourceFiles) {
  const text = await readFile(file, "utf8");
  assert.doesNotMatch(text, /(?:from\s+|import\()["'](?:react|@aws-sdk)/iu, `${file} imports forbidden runtime scope`);
  assert.doesNotMatch(
    text,
    /(?:stems\.miso\.fm|r2\.dev|\bR2\b|cloudflare|@aws-sdk\/client-s3)/u,
    `${file} embeds product delivery policy`,
  );
  assert.doesNotMatch(text, /https?:\/\//u, `${file} embeds a transport URL`);
}
console.log(`package-policy: ${report.files.length} files, ${report.size} bytes`);

const sdkPcm = await import("@misofm/engine/browser");
const adapterRing = await import("../dist/stems/ring.js");
const adapterAssets = await import("../dist/assets.js");
const sdkAssets = (await import("@misofm/engine/assets")).BUNDLED_ENGINE_ASSETS;
assert.equal(adapterRing.Msb1RingWriter, sdkPcm.Msb1RingWriter);
assert.equal(adapterRing.createMsb1Ring, sdkPcm.createMsb1Ring);
assert.equal(adapterRing.MSB1_CONTROL, sdkPcm.MSB1_CONTROL);
assert.equal(adapterAssets.ADAPTER_ASSETS.scratchWorker, sdkAssets.scratchWorkerModule);
assert.equal(adapterAssets.ADAPTER_ASSETS.feedWorkletModule, sdkAssets.pcmFeedWorklet);
