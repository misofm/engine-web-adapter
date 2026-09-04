import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ADAPTER_ASSETS, createPumpWorker, createScratchWorker } from "../src/assets.js";
import { EngineWebAdapterError } from "../src/errors.js";
import { ADAPTER_PROVENANCE } from "../src/index.js";
import {
  MemoryStemResolver,
  assertStemIdentity,
  canonicalPcmBytes,
} from "../src/stems/index.js";

const IDENTITY = `sha256:${"a".repeat(64)}` as const;

test("foundation is pinned to the exact public Engine release", () => {
  assert.equal(ADAPTER_PROVENANCE.engine.package, "@misofm/engine@0.1.0");
  assert.equal(
    ADAPTER_PROVENANCE.engine.commit,
    "5360874854f47e3dbfa2279ec6c57174e5ca018e",
  );
  assert.equal(ADAPTER_PROVENANCE.safeBaselines.stemStore, "bd7f330a9773ce43bb077f0e6d5c8fc30fe9e27c");
});

test("documented package gates are fresh-checkout safe", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(packageJson.scripts["check:package"], /^npm run build && /u);
  assert.doesNotMatch(packageJson.scripts.lint, /check-package/u);
});

test("canonical byte accounting accepts launch PCM and rejects 32f", () => {
  assert.equal(
    canonicalPcmBytes({ channels: 2, bitDepth: 24, frames: 101n, content: IDENTITY }),
    606,
  );
  assert.throws(
    () => canonicalPcmBytes({ channels: 1, bitDepth: "32f", frames: 1, content: IDENTITY }),
    (error: unknown) =>
      error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration",
  );
});

test("identity grammar is exact", () => {
  assert.doesNotThrow(() => assertStemIdentity(IDENTITY));
  assert.throws(() => assertStemIdentity(`sha256:${"A".repeat(64)}`));
});

test("memory resolver returns fresh bounded streams", async () => {
  const resolver = new MemoryStemResolver({ [IDENTITY]: new Uint8Array([1, 2, 3, 4, 5]) }, {
    chunkBytes: 2,
  });
  const first = await resolver.resolve(IDENTITY);
  const chunks: number[][] = [];
  const reader = first.stream.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push([...result.value]);
  }
  assert.deepEqual(chunks, [[1, 2], [3, 4], [5]]);
  assert.equal(first.canonicalBytes, 5);
  assert.deepEqual(resolver.requests, [IDENTITY]);
});

test("asset factories honor explicit worker overrides", () => {
  const calls: Array<{ url: string; type: string }> = [];
  const fake = {} as Worker;
  const createWorker = (url: string | URL, options: WorkerOptions & { type: "module" }) => {
    calls.push({ url: String(url), type: options.type });
    return fake;
  };
  assert.equal(createScratchWorker({ createWorker }), fake);
  assert.equal(createPumpWorker({ createWorker }), fake);
  assert.deepEqual(calls, [
    { url: ADAPTER_ASSETS.scratchWorker.href, type: "module" },
    { url: ADAPTER_ASSETS.pumpWorker.href, type: "module" },
  ]);
});
