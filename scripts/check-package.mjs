import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
assert.deepEqual(packageJson.dependencies, {
  "@misofm/engine": "0.1.0",
  effect: "4.0.0-rc.112",
});
assert.equal(packageJson.type, "module");
const cache = await mkdtemp(join(tmpdir(), "engine-web-adapter-npm-cache-"));
const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8", env: { ...process.env, npm_config_cache: cache },
});
if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
const report = JSON.parse(packed.stdout)[0];
const names = new Set(report.files.map((file) => file.path));
for (const required of [
  "dist/index.js", "dist/index.d.ts", "dist/internal/engine-web-scratch-worker.js",
  "dist/internal/engine-web-pcm-pump-worker.js", "dist/internal/engine-web-flac-worker.js",
  "dist/internal/engine-web-flac-decoder.wasm",
  "dist/internal/engine-web-feed-worklet.js",
  "README.md", "NOTICE", "LICENSE", "vendor/libflac-1.5.0/COPYING.Xiph",
]) assert.ok(names.has(required), `packed artifact missing ${required}`);
assert.ok([...names].every((name) => !name.startsWith("tests/") && !name.startsWith("src/")), "source/tests leaked into tarball");
for (const removed of ["dist/stems/flac-packetizer.js", "dist/stems/flac-ingest.js", "dist/stems/flac-pcm.js", "dist/stems/flac-metadata.js"]) {
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
