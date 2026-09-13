import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import {
  decodeFlac,
  FlacDecodeError,
  FLAC_DECODER_LIMITS,
  makeFlacDecoderLayer,
  PcmFormat,
} from "@misofm/codec";

import {
  FLAC_INPUT_SLOT_BYTES,
  FlacInputSlotConsumer,
  FlacInputSlotProducer,
} from "../src/stems/flac-input-slot.js";
import {
  NativeFlacMetadataScanner,
  parseNativeFlacStreamInfo,
} from "../src/stems/native-flac-metadata.js";
import { loadFlacDecoderModule } from "../src/stems/native-flac-decoder.js";
import {
  BoundedStemAdmission,
  DEFAULT_FLAC_MEMORY_BUDGET_BYTES,
  FLAC_ACCOUNTED_FIXED_BUFFER_BYTES,
  FLAC_ACCOUNTING_HEADROOM_BYTES,
  FLAC_PACKAGE_MEMORY_COMPONENTS,
  FLAC_WORKER_RESERVATION_BYTES,
  defaultFlacMemoryBudgetBytes,
  flacAdmissionWidth,
} from "../src/stems/flac-admission.js";

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

async function decodeFixture(name: string, expected: { readonly sampleRate: number; readonly channels: 1 | 2; readonly bitsPerSample: 16 | 24; readonly frames: number }) {
  const flac = new Uint8Array(await readFile(`tests/fixtures/${name}.flac`));
  const wasm = new Uint8Array(await readFile("node_modules/@misofm/codec/wasm/flac-decoder.wasm"));
  const fragments: Uint8Array[] = [flac.subarray(0, 1), flac.subarray(1, 43)];
  for (let offset = 43; offset < flac.byteLength; offset += FLAC_INPUT_SLOT_BYTES) {
    fragments.push(flac.subarray(offset, Math.min(flac.byteLength, offset + FLAC_INPUT_SLOT_BYTES)));
  }
  const input = Stream.fromIterable(fragments);
  const format = new PcmFormat(expected);
  const effect = Effect.scoped(
    decodeFlac(input, { expectedFormat: format, expectedFrames: BigInt(expected.frames) }).pipe(Stream.runCollect),
  ).pipe(Effect.provide(makeFlacDecoderLayer(wasm)));
  const events = await Effect.runPromise(effect);
  return { flac, events };
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

test("native FLAC rejects a known declaration mismatch before metadata walking", () => {
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

test("public codec decodes non-silent multiblock stereo PCM and verifies exact bytes", async () => {
  const { events } = await decodeFixture("native-multiblock-stereo24", {
    sampleRate: 48_000, channels: 2, bitsPerSample: 24, frames: 72_000,
  });
  const pcm = events.filter((event) => event._tag === "Pcm").flatMap((event) => [...event.bytes]);
  const expected = new Uint8Array(await readFile("tests/fixtures/native-multiblock-stereo24.pcm"));
  assert.deepEqual(Uint8Array.from(pcm), expected);
  const complete = events.at(-1);
  assert.equal(complete?._tag, "Complete");
  assert.equal((complete as Extract<typeof complete, { _tag: "Complete" }>).frames, 72_000n);
});

test("public codec rejects a reordered frame and does not produce a verified completion", async () => {
  await assert.rejects(
    decodeFixture("native-reordered-stereo24", { sampleRate: 48_000, channels: 2, bitsPerSample: 24, frames: 41_024 }),
    (error: unknown) => error instanceof FlacDecodeError && error.reason === "invalid-stream" && error.phase === "frame",
  );
});

test("public codec rejects a wrong or corrupt decoder asset through its typed boundary", async () => {
  const wrong = new Uint8Array([0]);
  const exit = await Effect.runPromiseExit(Effect.scoped(
    Effect.succeed(undefined).pipe(Effect.provide(makeFlacDecoderLayer(wrong))),
  ));
  assert.equal(Exit.isFailure(exit), true);
  if (Exit.isFailure(exit)) assert.equal((exit.cause.reasons[0] as { readonly error?: unknown }).error instanceof FlacDecodeError, true);
});

test("decoder asset loading copies empty and tiny response chunks into one bounded destination", async () => {
  const wasm = new Uint8Array(await readFile("node_modules/@misofm/codec/wasm/flac-decoder.wasm"));
  let pulls = 0;
  const emptyChunks = 20_000;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls < emptyChunks) {
        pulls += 1;
        // Each view has a distinct backing allocation. The loader must not
        // retain these objects merely because the stream yielded them.
        controller.enqueue(new Uint8Array(new ArrayBuffer(4096), 0, 0));
        return;
      }
      if (pulls < emptyChunks + wasm.byteLength) {
        const offset = pulls - emptyChunks;
        pulls += 1;
        const backing = new Uint8Array(4096);
        backing[0] = wasm[offset]!;
        controller.enqueue(backing.subarray(0, 1));
        return;
      }
      controller.close();
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { headers: { "Content-Type": "application/wasm" } });
  try {
    const module = await loadFlacDecoderModule({ url: "https://asset.invalid/codec.wasm" });
    assert.ok(module instanceof WebAssembly.Module);
    assert.equal(pulls, emptyChunks + wasm.byteLength);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("oversized decoder asset reads cancel the response body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(256 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { headers: { "Content-Type": "application/wasm" } });
  try {
    await assert.rejects(
      loadFlacDecoderModule({ url: "https://asset.invalid/codec.wasm" }),
      (error: unknown) => error instanceof Error && (error as Error & { readonly code?: unknown }).code === "stem.decode.asset",
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codec limits retain fixed 2 MiB decoder memory, 256 KiB input, and 384 KiB output", () => {
  assert.equal(FLAC_DECODER_LIMITS.wasmMemoryBytes, 2 * 1024 * 1024);
  assert.equal(FLAC_DECODER_LIMITS.maxInputChunkBytes, 256 * 1024);
  assert.equal(FLAC_DECODER_LIMITS.maxOutputBlockBytes, 384 * 1024);
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
    codecInputCopy: 256 * 1024,
    decoderLinearMemory: 2 * 1024 * 1024,
    decodedOutputCredits: 2 * 384 * 1024,
    codecPendingOutput: 384 * 1024,
    decodedInFlightWrite: 384 * 1024,
    opfsWriteClone: 384 * 1024,
    sha256WasmScratch: 2 * 64 * 1024,
    metadataAndControl: 4 * 1024 + 16,
  });
  assert.equal(FLAC_ACCOUNTED_FIXED_BUFFER_BYTES + FLAC_ACCOUNTING_HEADROOM_BYTES, FLAC_WORKER_RESERVATION_BYTES);
  assert.equal(FLAC_ACCOUNTED_FIXED_BUFFER_BYTES, 4_984_848);
  assert.equal(FLAC_ACCOUNTING_HEADROOM_BYTES, 3_403_760);
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
