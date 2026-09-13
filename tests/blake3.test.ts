import assert from "node:assert/strict";
import test from "node:test";

import { blake3Stream, createIncrementalBlake3 } from "../src/stems/blake3.js";

const bytes = (value: string) => new TextEncoder().encode(value);

test("incremental BLAKE3 matches the official empty and abc vectors", async () => {
  const empty = await createIncrementalBlake3();
  assert.equal(empty.digest("hex"), "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262");

  const abc = await createIncrementalBlake3();
  abc.update(bytes("a")).update(bytes("bc"));
  assert.equal(abc.digest("hex"), "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85");
});

test("incremental BLAKE3 states remain independent when updates interleave", async () => {
  const [left, right] = await Promise.all([createIncrementalBlake3(), createIncrementalBlake3()]);
  left.update(bytes("a"));
  right.update(bytes("ab"));
  left.update(bytes("bc"));
  right.update(bytes("c"));
  assert.equal(left.digest("hex"), right.digest("hex"));
});

test("BLAKE3 stream preserves byte counts and chunk boundaries", async () => {
  const progress: number[] = [];
  const result = await blake3Stream(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes("a"));
      controller.enqueue(bytes("bc"));
      controller.close();
    },
  }), { onChunk: (count) => progress.push(count) });
  assert.deepEqual(result, {
    bytes: 3,
    hex: "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
  });
  assert.deepEqual(progress, [1, 3]);
});
