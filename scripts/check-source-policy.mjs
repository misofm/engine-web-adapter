import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const files = [];
await walk("src");
for (const file of files) {
  const source = await readFile(file, "utf8");
  assert.doesNotMatch(source, /(?:from\s+|import\()["']react(?:[\/"'])/iu, `${file} imports React`);
  assert.doesNotMatch(source, /(?:stems\.miso\.fm|r2\.dev|\bR2\b|cloudflare|@aws-sdk\/client-s3)/u, `${file} embeds product delivery policy`);
  assert.doesNotMatch(source, /https?:\/\//u, `${file} embeds a transport URL`);
}
const flacFiles = files.filter((file) => /(?:flac|engine-web-flac-worker)/u.test(file));
for (const file of flacFiles) {
  const source = await readFile(file, "utf8");
  assert.doesNotMatch(
    source,
    /(?:AudioDecoder|EncodedAudioChunk|decodeAudioData|WebCodecs|flac-packetizer|flac-ingest|flac-pcm|\.arrayBuffer\s*\()/u,
    `${file} contains a forbidden codec fallback or whole-file path`,
  );
}
for (const removed of ["src/stems/flac-packetizer.ts", "src/stems/flac-ingest.ts", "src/stems/flac-pcm.ts", "src/stems/flac-metadata.ts"]) {
  assert.ok(!files.includes(removed), `${removed} must remain removed`);
}
console.log(`source-policy: ${files.length} files`);

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if ([".ts", ".js"].includes(extname(path))) files.push(path);
  }
}
