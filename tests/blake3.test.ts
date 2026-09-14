import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { blake3 as scalarBlake3, createBLAKE3 } from "hash-wasm";

import { BLAKE3_WASM_BYTES } from "../src/stems/blake3-wasm.js";
import {
  blake3Stream,
  createIncrementalBlake3,
  setBlake3BackendForTests,
} from "../src/stems/blake3.js";

const bytes = (value: string) => new TextEncoder().encode(value);

function pattern(length: number, offset = 0): Uint8Array {
  const output = new Uint8Array(length + offset);
  for (let index = offset; index < output.length; index += 1) output[index] = (index - offset) % 251;
  return output;
}

async function digestInSplits(
  hash: Awaited<ReturnType<typeof createIncrementalBlake3>>,
  input: Uint8Array,
  splits: readonly number[],
): Promise<string> {
  hash.update(new Uint8Array());
  let offset = 0;
  for (const split of splits) {
    const next = Math.min(input.byteLength, offset + split);
    hash.update(input.subarray(offset, next));
    offset = next;
  }
  if (offset < input.byteLength) hash.update(input.subarray(offset));
  return hash.digest("hex");
}

async function digestInScalarSplits(input: Uint8Array, splits: readonly number[]): Promise<string> {
  const hash = await createBLAKE3(256);
  hash.update(new Uint8Array());
  let offset = 0;
  for (const split of splits) {
    const next = Math.min(input.byteLength, offset + split);
    hash.update(input.subarray(offset, next));
    offset = next;
  }
  if (offset < input.byteLength) hash.update(input.subarray(offset));
  return hash.digest("hex");
}

test("generated BLAKE3 module has the fixed SIMD ABI and bounded raw calls", () => {
  const module = new WebAssembly.Module(BLAKE3_WASM_BYTES);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.deepEqual(
    WebAssembly.Module.exports(module).map(({ name, kind }) => `${name}:${kind}`).sort(),
    [
      "blake3_finalize:function",
      "blake3_init:function",
      "blake3_input_capacity:function",
      "blake3_input_ptr:function",
      "blake3_output_len:function",
      "blake3_output_ptr:function",
      "blake3_update:function",
      "memory:memory",
    ],
  );
  const instance = new WebAssembly.Instance(module);
  const memory = instance.exports.memory as WebAssembly.Memory;
  assert.equal(memory.buffer.byteLength, 128 * 1024);
  assert.throws(() => memory.grow(1), RangeError);
  const exports = instance.exports as unknown as {
    readonly blake3_finalize: () => number;
    readonly blake3_init: () => void;
    readonly blake3_update: (length: number) => number;
  };
  const initialBuffer = memory.buffer;
  assert.equal(exports.blake3_update(0), -2);
  assert.equal(exports.blake3_finalize(), -2);
  assert.equal(exports.blake3_update(-1), -1);
  exports.blake3_init();
  assert.equal(exports.blake3_update(16 * 1024 + 1), -1);
  assert.strictEqual(memory.buffer, initialBuffer);
  assert.equal(exports.blake3_update(16 * 1024), 0);
  assert.strictEqual(memory.buffer, initialBuffer);
  assert.equal(exports.blake3_finalize(), 0);
});

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
  await Promise.resolve();
  right.update(bytes("ab"));
  left.update(bytes("bc"));
  await Promise.resolve();
  right.update(bytes("d"));
  assert.notEqual(left.digest("hex"), right.digest("hex"));
  assert.equal(
    left.init().update(bytes("left-only")).digest("hex"),
    await scalarBlake3("left-only"),
  );
  assert.equal(
    right.init().update(bytes("right-only")).digest("hex"),
    await scalarBlake3("right-only"),
  );
});

test("official pinned vectors cover the staging and tree boundaries", async () => {
  const vectorFile = JSON.parse(await readFile("tests/fixtures/blake3-vectors.json", "utf8")) as {
    readonly sourceSha256: string;
    readonly inputRule: string;
    readonly cases: readonly { readonly inputLen: number; readonly hash: string }[];
  };
  assert.equal(vectorFile.sourceSha256, "dcb91ea8accc77e6d6e632af7cdc1a99a9f3ae78cf648da595c7d064db32f624");
  assert.equal(vectorFile.inputRule, "input[i] = i % 251");
  for (const vector of vectorFile.cases) {
    const hash = await createIncrementalBlake3();
    assert.equal(
      await digestInSplits(hash, pattern(vector.inputLen, 5).subarray(5), [1, 63, 960, 1024, 4096]),
      vector.hash,
    );
  }
  const abc = await createIncrementalBlake3();
  assert.equal(abc.update(bytes("abc")).digest("hex"), "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85");
});

test("SIMD BLAKE3 matches independent hash-wasm across streaming boundaries", async () => {
  const lengths = [63, 64, 65, 1023, 1024, 1025, 4095, 4096, 4097, 16383, 16384, 16385, 65535, 65536, 65537, 524287, 524288, 524289];
  for (const length of lengths) {
    const input = pattern(length, 7).subarray(7);
    const splits = [0, 1, 64, 1024, 4096, 16384, 65536, 3];
    const candidate = await createIncrementalBlake3();
    const expected = await digestInScalarSplits(input, splits);
    assert.equal(await digestInSplits(candidate, input, splits), expected, `length ${length}`);
    assert.equal(await scalarBlake3(input), expected, `oracle length ${length}`);
  }
});

test("a large bounded stream never needs a full-input allocation", async () => {
  const length = 37_247_538;
  const candidate = await createIncrementalBlake3();
  const oracle = await createBLAKE3(256);
  const chunk = new Uint8Array(512 * 1024);
  for (let offset = 0; offset < length; ) {
    const size = Math.min(chunk.byteLength, length - offset);
    for (let index = 0; index < size; index += 1) chunk[index] = (offset + index) % 251;
    const view = chunk.subarray(0, size);
    candidate.update(view);
    oracle.update(view);
    offset += size;
  }
  assert.equal(candidate.digest("hex"), oracle.digest("hex"));
});

test("reset owns mutable state and binary output survives later operations", async () => {
  const hash = await createIncrementalBlake3();
  assert.throws(() => hash.update(null as never), /input/u);
  const output = hash.update(bytes("first")).digest("binary");
  const retained = output.slice();
  assert.deepEqual(output, retained);
  assert.throws(() => hash.digest("hex"), /after digest/u);
  assert.throws(() => hash.update(bytes("late")), /after digest/u);
  hash.init().update(bytes("second"));
  assert.deepEqual(output, retained);
  assert.equal(hash.digest("hex"), await scalarBlake3("second"));
});

test("unsupported SIMD selection uses the real scalar fallback", async () => {
  const nativeValidate = WebAssembly.validate;
  const restore = setBlake3BackendForTests("auto");
  WebAssembly.validate = (() => false) as typeof WebAssembly.validate;
  try {
    const hash = await createIncrementalBlake3();
    assert.equal(hash.update(bytes("fallback")).digest("hex"), await scalarBlake3("fallback"));
  } finally {
    WebAssembly.validate = nativeValidate;
    restore();
  }
});

test("validation exceptions propagate without scalar downgrade", async () => {
  const nativeValidate = WebAssembly.validate;
  const restore = setBlake3BackendForTests("auto");
  WebAssembly.validate = (() => { throw new Error("forced BLAKE3 validation failure"); }) as typeof WebAssembly.validate;
  try {
    await assert.rejects(createIncrementalBlake3(), /forced BLAKE3 validation failure/u);
  } finally {
    WebAssembly.validate = nativeValidate;
    restore();
  }
});

test("Wasm init, update, and finalize failures propagate without scalar downgrade", async () => {
  const nativeInstance = WebAssembly.Instance;
  const restore = setBlake3BackendForTests("wasm");
  try {
    for (const failure of ["init", "update", "finalize"] as const) {
      WebAssembly.Instance = (function (module: WebAssembly.Module, imports?: WebAssembly.Imports) {
        const instance = new nativeInstance(module, imports);
        const exports = { ...instance.exports } as Record<string, unknown>;
        exports[`blake3_${failure}`] = () => { throw new Error(`forced BLAKE3 ${failure} failure`); };
        return {
          exports,
        } as unknown as WebAssembly.Instance;
      }) as unknown as typeof WebAssembly.Instance;
      try {
        if (failure === "init") {
          await assert.rejects(createIncrementalBlake3(), /forced BLAKE3 init failure/u);
        } else {
          const hash = await createIncrementalBlake3();
          if (failure === "update") {
            assert.throws(() => hash.update(bytes("update")), /forced BLAKE3 update failure/u);
          } else {
            assert.throws(() => hash.digest("hex"), /forced BLAKE3 finalize failure/u);
          }
        }
      } finally {
        WebAssembly.Instance = nativeInstance;
      }
    }
  } finally {
    WebAssembly.Instance = nativeInstance;
    restore();
  }
});

test("validated SIMD compile failures reject and retry without scalar downgrade", async () => {
  const nativeCompile = WebAssembly.compile;
  let attempts = 0;
  const restore = setBlake3BackendForTests("wasm");
  WebAssembly.compile = ((source: BufferSource) => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error("forced BLAKE3 compile failure"));
    return nativeCompile(source);
  }) as typeof WebAssembly.compile;
  try {
    await assert.rejects(createIncrementalBlake3(), /forced BLAKE3 compile failure/u);
    assert.equal(attempts, 1);
    const hash = await createIncrementalBlake3();
    assert.equal(hash.update(bytes("retry")).digest("hex"), await scalarBlake3("retry"));
    assert.equal(attempts, 2);
  } finally {
    WebAssembly.compile = nativeCompile;
    restore();
  }
});

test("concurrent first factories share one compile and keep independent state", async () => {
  const nativeCompile = WebAssembly.compile;
  let attempts = 0;
  const restore = setBlake3BackendForTests("wasm");
  WebAssembly.compile = ((source: BufferSource) => {
    attempts += 1;
    return nativeCompile(source);
  }) as typeof WebAssembly.compile;
  try {
    const [left, right] = await Promise.all([createIncrementalBlake3(), createIncrementalBlake3()]);
    assert.equal(attempts, 1);
    left.update(bytes("concurrent-left"));
    right.update(bytes("concurrent-right"));
    assert.equal(left.digest("hex"), await scalarBlake3("concurrent-left"));
    assert.equal(right.digest("hex"), await scalarBlake3("concurrent-right"));
  } finally {
    WebAssembly.compile = nativeCompile;
    restore();
  }
});

test("sparse active and zero gaps preserve canonical timeline order", async () => {
  const canonical = new Uint8Array([0, 0, 0, 4, 7, 9, 0, 0, 0, 0, 0, 11, 13, 0, 0, 0]);
  const hash = await createIncrementalBlake3();
  hash.update(canonical.subarray(0, 3));
  hash.update(canonical.subarray(3, 6));
  hash.update(canonical.subarray(6, 11));
  hash.update(canonical.subarray(11, 13));
  hash.update(canonical.subarray(13));
  assert.equal(hash.digest("hex"), await scalarBlake3(canonical));
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
