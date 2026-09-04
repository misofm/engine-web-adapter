import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const files = [];
await walk("src");
for (const file of files) {
  const source = await readFile(file, "utf8");
  assert.doesNotMatch(source, /(?:from\s+|import\()["'](?:react|@effect|flac|webcodecs)/iu, `${file} imports forbidden runtime scope`);
  assert.doesNotMatch(source, /https?:\/\//u, `${file} embeds a transport URL`);
}
console.log(`source-policy: ${files.length} files`);

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if ([".ts", ".js"].includes(extname(path))) files.push(path);
  }
}
