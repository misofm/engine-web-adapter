import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";

import {
  FLAC_INPUT_SLOT_BYTES,
  FlacInputSlotConsumer,
  FlacInputSlotProducer,
} from "../src/stems/flac-input-slot.js";
import {
  NativeFlacMetadataScanner,
  parseNativeFlacStreamInfo,
} from "../src/stems/native-flac-metadata.js";
import { FLAC_DECODER_MEMORY_BYTES, NativeFlacDecoder } from "../src/stems/native-flac-decoder.js";
import {
  BoundedStemAdmission,
  DEFAULT_FLAC_MEMORY_BUDGET_BYTES,
  FLAC_ACCOUNTED_FIXED_BUFFER_BYTES,
  FLAC_ACCOUNTING_HEADROOM_BYTES,
  FLAC_PACKAGE_MEMORY_COMPONENTS,
  FLAC_WORKER_RESERVATION_BYTES,
  defaultFlacMemoryBudgetBytes,
  flacAdmissionWidth,
} from "../src/stems/index.js";

function putU64(bytes: Uint8Array, offset: number, input: bigint): void {
  let value = input;
  for (let index = 7; index >= 0; index -= 1) {
    bytes[offset + index] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function streamInfo(options: {
  readonly final?: boolean;
  readonly minimumBlockSamples?: number;
  readonly maximumBlockSamples?: number;
  readonly totalSamples?: number;
  readonly zeroFrameBounds?: boolean;
  readonly zeroMd5?: boolean;
} = {}): Uint8Array {
  const bytes = new Uint8Array(42);
  bytes.set([0x66, 0x4c, 0x61, 0x43, options.final ? 0x80 : 0, 0, 0, 34]);
  const minimum = options.minimumBlockSamples ?? 4096;
  const maximum = options.maximumBlockSamples ?? 65_535;
  bytes[8] = minimum >>> 8; bytes[9] = minimum;
  bytes[10] = maximum >>> 8; bytes[11] = maximum;
  if (!options.zeroFrameBounds) bytes.set([0, 0, 1, 0, 0, 9], 12);
  putU64(bytes, 18, (48_000n << 44n) | (1n << 41n) | (23n << 36n) | BigInt(options.totalSamples ?? 96_000));
  if (!options.zeroMd5) bytes.fill(7, 26, 42);
  return bytes;
}

test("native FLAC STREAMINFO accepts variable blocks, unknown totals, zero frame bounds, and absent MD5", () => {
  const parsed = parseNativeFlacStreamInfo(streamInfo({
    minimumBlockSamples: 576, maximumBlockSamples: 65_535, totalSamples: 0,
    zeroFrameBounds: true, zeroMd5: true,
  }), {
    sampleRateHz: 48_000, channels: 2, bitDepth: 24, frames: 123_456, canonicalBytes: 740_736,
  });
  assert.equal(parsed.streamInfo.minimumBlockSamples, 576);
  assert.equal(parsed.streamInfo.maximumBlockSamples, 65_535);
  assert.equal(parsed.streamInfo.totalSamples, 0);
  assert.equal(parsed.streamInfo.maximumFrameBytes, 0);
  assert.ok(parsed.streamInfo.streamMd5.every((byte) => byte === 0));
  assert.equal(parsed.streamInfo.decoderDescription[4], 0x80);
});

test("native FLAC rejects known declaration mismatch before metadata walking", () => {
  assert.throws(() => parseNativeFlacStreamInfo(streamInfo(), {
    sampleRateHz: 44_100, channels: 2, bitDepth: 24, frames: 96_000, canonicalBytes: 576_000,
  }), /disagrees/u);
});

test("metadata scanner skips payloads by checked offsets and accepts no SEEKTABLE", () => {
  const scanner = new NativeFlacMetadataScanner(false);
  assert.equal(scanner.nextHeaderOffset, 42);
  assert.deepEqual(scanner.acceptHeader(new Uint8Array([4, 0, 0, 100]), 2048), {
    type: 4, length: 100, final: false, offset: 42, nextOffset: 146,
  });
  assert.equal(scanner.nextHeaderOffset, 146);
  assert.deepEqual(scanner.acceptHeader(new Uint8Array([0x86, 0, 1, 0]), 2048), {
    type: 6, length: 256, final: true, offset: 146, nextOffset: 406,
  });
  assert.equal(scanner.complete, true);
});

test("one fixed shared input slot drains incrementally and exposes EOF only after final bytes", () => {
  const producer = new FlacInputSlotProducer();
  let credits = 0;
  const consumer = new FlacInputSlotConsumer(producer.buffers, () => { credits += 1; });
  producer.publish(new Uint8Array([1, 2, 3, 4, 5]), true);
  const first = new Uint8Array(2);
  assert.deepEqual(consumer.read(first), { type: "bytes", bytes: 2 });
  assert.deepEqual([...first], [1, 2]);
  const second = new Uint8Array(8);
  assert.deepEqual(consumer.read(second), { type: "bytes", bytes: 3 });
  assert.deepEqual([...second.subarray(0, 3)], [3, 4, 5]);
  assert.deepEqual(consumer.read(second), { type: "eof" });
  assert.equal(credits, 0);
  assert.equal(producer.buffers.bytes.byteLength, FLAC_INPUT_SLOT_BYTES);
});

test("cancellation wakes the synchronous input bridge as ABORT, never EOF", () => {
  const producer = new FlacInputSlotProducer();
  producer.abort();
  const consumer = new FlacInputSlotConsumer(producer.buffers, () => assert.fail("aborted slot requested a refill"));
  assert.deepEqual(consumer.read(new Uint8Array(1)), { type: "aborted" });
});

test("real fixed-memory libFLAC Wasm emits exact canonical PCM", async () => {
  const flac = new Uint8Array(await readFile("tests/fixtures/native-silence.flac"));
  let audioOffset = 42;
  if ((flac[4]! & 0x80) === 0) {
    for (;;) {
      const header = flac[audioOffset]!;
      const length = (flac[audioOffset + 1]! << 16) | (flac[audioOffset + 2]! << 8) | flac[audioOffset + 3]!;
      audioOffset += 4 + length;
      if ((header & 0x80) !== 0) break;
    }
  }
  const parsed = parseNativeFlacStreamInfo(flac.subarray(0, 42), {
    sampleRateHz: 48_000, channels: 1, bitDepth: 16, frames: 2048, canonicalBytes: 4096,
  });
  const producer = new FlacInputSlotProducer();
  producer.publish(flac.subarray(audioOffset), true);
  const wasm = await readFile("src/internal/engine-web-flac-decoder.wasm");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(wasm, { headers: { "Content-Type": "application/wasm" } });
  try {
    const decoder = await NativeFlacDecoder.load({
      url: "https://asset.invalid/decoder.wasm", inputSlot: producer.buffers,
      requestRefill: () => assert.fail("single-frame fixture unexpectedly requested another refill"),
    });
    decoder.initialize(parsed.streamInfo, 2048);
    const output: number[] = [];
    for (;;) {
      const block = decoder.processSingle();
      if (block === "eof") break;
      if (block !== null) output.push(...block.bytes);
    }
    decoder.finish();
    decoder.destroy();
    assert.equal(output.length, 4096);
    assert.ok(output.every((byte) => byte === 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("real increasing variable-block stereo decode reclaims libFLAC allocations within fixed memory", async () => {
  const flac = new Uint8Array(await readFile("tests/fixtures/native-variable-stereo24.flac"));
  const parsed = parseNativeFlacStreamInfo(flac.subarray(0, 42), {
    sampleRateHz: 48_000, channels: 2, bitDepth: 24, frames: 41_024, canonicalBytes: 246_144,
  });
  const producer = new FlacInputSlotProducer();
  producer.publish(flac.subarray(42), true);
  const wasm = await readFile("src/internal/engine-web-flac-decoder.wasm");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(wasm, { headers: { "Content-Type": "application/wasm" } });
  try {
    const decoder = await NativeFlacDecoder.load({
      url: "https://asset.invalid/decoder.wasm", inputSlot: producer.buffers,
      requestRefill: () => assert.fail("bounded fixture unexpectedly requested another refill"),
    });
    decoder.initialize(parsed.streamInfo, 41_024);
    const hash = createHash("sha256");
    const blocks: number[] = [];
    const live: number[] = [];
    const heapPeaks: number[] = [];
    for (;;) {
      const result = decoder.processSingle();
      if (result === "eof") break;
      if (result !== null) {
        blocks.push(result.frames);
        hash.update(result.bytes);
        const stats = decoder.allocatorStats();
        live.push(stats.liveBytes);
        heapPeaks.push(stats.peakHeapBytes);
      }
    }
    decoder.finish();
    const beforeDestroy = decoder.allocatorStats();
    decoder.destroy();
    const afterDestroy = decoder.allocatorStats();
    assert.deepEqual(blocks, [576, 1_152, 2_304, 4_096, 4_096, 4_096, 4_096, 4_096, 4_096, 4_096, 4_096, 4_096, 128]);
    assert.equal(hash.digest("hex"), "1c56647d30a67bd892fd802860925f85eed692a706151dd1738235e0dc62889f");
    assert.ok(live.slice(3, -1).every((bytes) => bytes === live[3]), "live allocation must plateau once the maximum block is reached");
    assert.ok(heapPeaks.slice(3).every((bytes) => bytes === heapPeaks[3]), "heap high-water must be duration-independent after the maximum block");
    assert.ok(beforeDestroy.peakHeapBytes < FLAC_DECODER_MEMORY_BYTES);
    assert.equal(afterDestroy.liveBytes, 0, "libFLAC delete/free must reclaim every live allocation");
    assert.ok(afterDestroy.freeCalls > 0, "real libFLAC must exercise allocator free");
    assert.ok(afterDestroy.reallocCalls > 0, "increasing real blocks must exercise allocator realloc");
    assert.equal(afterDestroy.peakHeapBytes, beforeDestroy.peakHeapBytes, "destroy must not invent allocator history");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("real decoder rejects a valid-CRC reordered variable frame", async () => {
  const flac = new Uint8Array(await readFile("tests/fixtures/native-reordered-stereo24.flac"));
  const parsed = parseNativeFlacStreamInfo(flac.subarray(0, 42));
  const producer = new FlacInputSlotProducer();
  producer.publish(flac.subarray(42), true);
  const wasm = await readFile("src/internal/engine-web-flac-decoder.wasm");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(wasm, { headers: { "Content-Type": "application/wasm" } });
  try {
    const decoder = await NativeFlacDecoder.load({
      url: "https://asset.invalid/decoder.wasm", inputSlot: producer.buffers,
      requestRefill: () => assert.fail("bounded fixture unexpectedly requested another refill"),
    });
    decoder.initialize(parsed.streamInfo, 41_024);
    assert.notEqual(decoder.processSingle(), null);
    assert.throws(
      () => decoder.processSingle(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "stem.decode.flac",
    );
    decoder.destroy();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("real libFLAC waits through delayed one-byte refills across arbitrary frame splits", async () => {
  const flac = new Uint8Array(await readFile("tests/fixtures/native-silence.flac"));
  let audioOffset = 42;
  if ((flac[4]! & 0x80) === 0) {
    for (;;) {
      const header = flac[audioOffset]!;
      const length = (flac[audioOffset + 1]! << 16) | (flac[audioOffset + 2]! << 8) | flac[audioOffset + 3]!;
      audioOffset += 4 + length;
      if ((header & 0x80) !== 0) break;
    }
  }
  const audio = flac.subarray(audioOffset);
  const parsed = parseNativeFlacStreamInfo(flac.subarray(0, 42));
  const producer = new FlacInputSlotProducer();
  const worker = new Worker(new URL("flac-decoder-thread-runner.js", import.meta.url));
  const wasm = new Uint8Array(await readFile("src/internal/engine-web-flac-decoder.wasm"));
  let offset = 0;
  let refills = 0;
  const complete = new Promise<Readonly<{ bytes: number; frames: number }>>((resolve, reject) => {
    worker.on("message", (message: { readonly type: string; readonly bytes?: number; readonly frames?: number; readonly error?: string }) => {
      if (message.type === "credit") {
        refills += 1;
        setTimeout(() => {
          const next = audio.subarray(offset, offset + 1);
          offset += next.byteLength;
          producer.publish(next, offset === audio.byteLength);
        }, 1);
      } else if (message.type === "complete") resolve({ bytes: message.bytes!, frames: message.frames! });
      else reject(new Error(message.error));
    });
    worker.on("error", reject);
  });
  worker.postMessage({ wasm, inputSlot: producer.buffers, streamInfo: parsed.streamInfo, expectedFrames: 2048 });
  try {
    assert.deepEqual(await complete, { bytes: 4096, frames: 2048 });
    assert.equal(refills, audio.byteLength);
  } finally {
    await worker.terminate();
  }
});

test("malformed decoder modules and ABI traps normalize as stem.decode.asset", async () => {
  const producer = new FlacInputSlotProducer();
  const originalFetch = globalThis.fetch;
  try {
    for (const bytes of [new Uint8Array([0]), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])]) {
      globalThis.fetch = async () => new Response(bytes, { headers: { "Content-Type": "application/wasm" } });
      await assert.rejects(
        NativeFlacDecoder.load({ url: "https://asset.invalid/bad.wasm", inputSlot: producer.buffers, requestRefill() {} }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "stem.decode.asset",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("trapping ABI validation and invalid arenas normalize as stem.decode.asset", async () => {
  const originalFetch = globalThis.fetch;
  const originalCompile = WebAssembly.compileStreaming;
  const originalInstantiate = WebAssembly.instantiate;
  const producer = new FlacInputSlotProducer();
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 32 });
  const functions = {
    miso_flac_decoder_abi_version: () => 2,
    miso_flac_decoder_description_ptr: () => memory.buffer.byteLength - 1,
    miso_flac_decoder_description_capacity: () => 42,
    miso_flac_decoder_output_ptr: () => 0,
    miso_flac_decoder_output_length: () => 0,
    miso_flac_decoder_output_frames: () => 0,
    miso_flac_decoder_callback_error: () => 0,
    miso_flac_decoder_state: () => 0,
    miso_flac_decoder_initialize: () => 0,
    miso_flac_decoder_process_single: () => 2,
    miso_flac_decoder_release_output: () => undefined,
    miso_flac_decoder_finish: () => 0,
    miso_flac_decoder_destroy: () => undefined,
    miso_flac_allocator_live_bytes: () => 0,
    miso_flac_allocator_peak_live_bytes: () => 0,
    miso_flac_allocator_peak_heap_bytes: () => 0,
    miso_flac_allocator_free_calls: () => 0,
    miso_flac_allocator_realloc_calls: () => 0,
  };
  globalThis.fetch = async () => new Response(new Uint8Array([0]), { headers: { "Content-Type": "application/wasm" } });
  WebAssembly.compileStreaming = async () => ({} as WebAssembly.Module);
  try {
    WebAssembly.instantiate = (async () => ({ exports: {
      memory, ...functions, miso_flac_decoder_abi_version: () => { throw new Error("trap"); },
    } }) as unknown) as typeof WebAssembly.instantiate;
    await assert.rejects(
      NativeFlacDecoder.load({ url: "https://asset.invalid/trap.wasm", inputSlot: producer.buffers, requestRefill() {} }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "stem.decode.asset",
    );
    WebAssembly.instantiate = (async () => ({ exports: { memory, ...functions } }) as unknown) as typeof WebAssembly.instantiate;
    const decoder = await NativeFlacDecoder.load({
      url: "https://asset.invalid/pointer.wasm", inputSlot: producer.buffers, requestRefill() {},
    });
    const parsed = parseNativeFlacStreamInfo(streamInfo());
    assert.throws(
      () => decoder.initialize(parsed.streamInfo, parsed.streamInfo.totalSamples),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "stem.decode.asset",
    );
    WebAssembly.instantiate = (async () => ({ exports: {
      memory, ...functions, miso_flac_decoder_description_ptr: () => 0,
      miso_flac_decoder_process_single: () => { throw new Error("trap"); },
    } }) as unknown) as typeof WebAssembly.instantiate;
    const processTrap = await NativeFlacDecoder.load({
      url: "https://asset.invalid/process-trap.wasm", inputSlot: producer.buffers, requestRefill() {},
    });
    processTrap.initialize(parsed.streamInfo, parsed.streamInfo.totalSamples);
    assert.throws(
      () => processTrap.processSingle(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "stem.decode.asset",
    );
  } finally {
    globalThis.fetch = originalFetch;
    WebAssembly.compileStreaming = originalCompile;
    WebAssembly.instantiate = originalInstantiate;
  }
});

test("native FLAC admission obeys frozen memory and core bounds", () => {
  assert.equal(defaultFlacMemoryBudgetBytes(), DEFAULT_FLAC_MEMORY_BUDGET_BYTES);
  assert.equal(defaultFlacMemoryBudgetBytes(Number.NaN), DEFAULT_FLAC_MEMORY_BUDGET_BYTES);
  assert.equal(defaultFlacMemoryBudgetBytes(0.5), 8 * 1024 * 1024);
  assert.equal(defaultFlacMemoryBudgetBytes(16), 32 * 1024 * 1024);
  assert.equal(flacAdmissionWidth(), 1);
  assert.equal(flacAdmissionWidth({ hardwareConcurrency: 12, memoryBudgetBytes: 24 * 1024 * 1024 }), 3);
});

test("native FLAC package buffers are fixed and leave reservation headroom", () => {
  assert.deepEqual(FLAC_PACKAGE_MEMORY_COMPONENTS, {
    exactRange: 256 * 1024,
    compressedInputSlot: 256 * 1024,
    decoderLinearMemory: 2 * 1024 * 1024,
    decodedOutputCredits: 2 * 384 * 1024,
    metadataAndControl: 4 * 1024 + 16,
  });
  assert.equal(FLAC_ACCOUNTED_FIXED_BUFFER_BYTES + FLAC_ACCOUNTING_HEADROOM_BYTES, FLAC_WORKER_RESERVATION_BYTES);
  assert.ok(FLAC_ACCOUNTING_HEADROOM_BYTES > 4 * 1024 * 1024);
});

test("native FLAC admission is FIFO and removes queued cancellation", async () => {
  const admission = new BoundedStemAdmission(1);
  const first = await admission.acquire();
  const order: string[] = [];
  const cancelled = new AbortController();
  const second = admission.acquire(cancelled.signal).then(() => order.push("cancelled"));
  const third = admission.acquire().then((lease) => { order.push("third"); lease.release(); });
  cancelled.abort("test");
  await assert.rejects(second);
  first.release();
  await third;
  assert.deepEqual(order, ["third"]);
  assert.deepEqual(admission.stats, { active: 0, queued: 0, limit: 1 });
});
