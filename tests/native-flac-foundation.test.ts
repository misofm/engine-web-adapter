import assert from "node:assert/strict";
import test from "node:test";

import {
  FLAC_INPUT_SLOT_BYTES,
  FlacInputSlotConsumer,
  FlacInputSlotProducer,
} from "../src/stems/flac-input-slot.js";
import {
  NativeFlacMetadataScanner,
  parseNativeFlacStreamInfo,
} from "../src/stems/native-flac-metadata.js";

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
