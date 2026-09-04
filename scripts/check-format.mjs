import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["src", "tests", "scripts"];
const files = ["README.md", "NOTICE", "package.json", "tsconfig.json", "tsconfig.build.json", "tsconfig.test.json"];
for (const root of roots) await walk(root);
let failed = false;
for (const file of files) {
  const text = await readFile(file, "utf8");
  if (text.includes("\r") || !text.endsWith("\n") || /[ \t]+$/mu.test(text)) {
    console.error(`${file}: expected LF, final newline, and no trailing whitespace`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if ([".ts", ".js", ".mjs", ".md"].includes(extname(path))) files.push(path);
  }
}
