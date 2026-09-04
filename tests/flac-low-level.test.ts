import assert from "node:assert/strict";
import test from "node:test";

import { EngineWebAdapterError } from "../src/errors.js";
import {
  BoundedStemAdmission,
  DEFAULT_FLAC_MEMORY_BUDGET_BYTES,
  MAXIMUM_CANONICAL_OUTPUT_BYTES,
  MAXIMUM_DELIVERY_CHUNK_BYTES,
  DenseFlacFramePacketizer,
  DenseFlacMetadataParser,
  audioDataToCanonicalPcm,
  defaultFlacMemoryBudgetBytes,
  flacAdmissionWidth,
  type WebCodecsAudioDataLike,
  type WebCodecsAudioFormat,
} from "../src/stems/index.js";

interface FixtureOptions {
  readonly blockSamples?: number;
  readonly minimumBlockSamples?: number;
  readonly totalSamples?: number;
  readonly sampleRateHz?: number;
  readonly channels?: number;
  readonly bitDepth?: number;
  readonly minimumFrameBytes?: number;
  readonly maximumFrameBytes?: number;
  readonly points?: readonly (readonly [number | bigint, number, number])[];
  readonly metadata?: readonly Readonly<{ type: number; bytes: Uint8Array }>[];
  readonly finalFrameBytes?: number;
}

function putU64(bytes: Uint8Array, offset: number, input: bigint): void {
  let value = input;
  for (let index = 7; index >= 0; index -= 1) {
    bytes[offset + index] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function metadataBlock(type: number, payload: Uint8Array, last: boolean): Uint8Array {
  const output = new Uint8Array(4 + payload.byteLength);
  output[0] = type | (last ? 0x80 : 0);
  output[1] = (payload.byteLength >> 16) & 0xff;
  output[2] = (payload.byteLength >> 8) & 0xff;
  output[3] = payload.byteLength & 0xff;
  output.set(payload, 4);
  return output;
}

function fixture(options: FixtureOptions = {}): Uint8Array {
  const blockSamples = options.blockSamples ?? 16;
  const totalSamples = options.totalSamples ?? 40;
  const points = options.points ?? [
    [0, 0, 16],
    [16, 5, 16],
    [32, 12, 8],
  ];
  const minimumFrameBytes = options.minimumFrameBytes ?? 4;
  const maximumFrameBytes = options.maximumFrameBytes ?? 8;
  const stream = new Uint8Array(34);
  const minimumBlock = options.minimumBlockSamples ?? blockSamples;
  stream[0] = minimumBlock >> 8;
  stream[1] = minimumBlock & 0xff;
  stream[2] = blockSamples >> 8;
  stream[3] = blockSamples & 0xff;
  stream[4] = (minimumFrameBytes >> 16) & 0xff;
  stream[5] = (minimumFrameBytes >> 8) & 0xff;
  stream[6] = minimumFrameBytes & 0xff;
  stream[7] = (maximumFrameBytes >> 16) & 0xff;
  stream[8] = (maximumFrameBytes >> 8) & 0xff;
  stream[9] = maximumFrameBytes & 0xff;
  const packed =
    (BigInt(options.sampleRateHz ?? 44_100) << 44n) |
    (BigInt((options.channels ?? 2) - 1) << 41n) |
    (BigInt((options.bitDepth ?? 24) - 1) << 36n) |
    BigInt(totalSamples);
  putU64(stream, 10, packed);
  stream.fill(0xa5, 18, 34);

  const seek = new Uint8Array(points.length * 18);
  points.forEach(([sample, offset, samples], index) => {
    putU64(seek, index * 18, BigInt(sample));
    putU64(seek, index * 18 + 8, BigInt(offset));
    seek[index * 18 + 16] = samples >> 8;
    seek[index * 18 + 17] = samples & 0xff;
  });
  const intervening = options.metadata ?? [];
  const blocks = [
    metadataBlock(0, stream, false),
    ...intervening.map((block) => metadataBlock(block.type, block.bytes, false)),
    metadataBlock(3, seek, true),
  ];
  const finalFrameBytes = options.finalFrameBytes ?? 4;
  const audioBytes = (points.at(-1)?.[1] ?? 0) + (points.length === 0 ? 0 : finalFrameBytes);
  const audio = new Uint8Array(audioBytes);
  for (let index = 0; index < audio.byteLength; index += 1) audio[index] = (index * 17 + 1) & 0xff;
  const totalBytes = 4 + blocks.reduce((sum, block) => sum + block.byteLength, 0) + audio.byteLength;
  const result = new Uint8Array(totalBytes);
  result.set([0x66, 0x4c, 0x61, 0x43]);
  let offset = 4;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.byteLength;
  }
  result.set(audio, offset);
  return result;
}

function parse(bytes: Uint8Array, chunkBytes = bytes.byteLength) {
  const parser = new DenseFlacMetadataParser();
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    const parsed = parser.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes)));
    if (parsed !== null) return parsed;
  }
  return parser.finish();
}

function expectCode(code: EngineWebAdapterError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof EngineWebAdapterError && error.code === code;
}

test("dense FLAC parser accepts exact, partial-final, and single-frame CLI geometry", () => {
  const exact = parse(
    fixture({
      totalSamples: 32,
      points: [
        [0, 0, 16],
        [16, 5, 16],
      ],
    }),
    7,
  );
  assert.deepEqual(exact.metadata.seekPoints.map((point) => point.frameSamples), [16, 16]);

  const partial = parse(fixture(), 1);
  assert.equal(partial.metadata.audioDataStart, 100);
  assert.deepEqual(partial.metadata.seekPoints.map((point) => point.frameSamples), [16, 16, 8]);
  assert.ok(partial.audioRemainder.byteLength <= 1);

  const single = parse(fixture({ totalSamples: 7, points: [[0, 0, 7]] }), 5);
  assert.deepEqual(single.metadata.seekPoints, [{ sampleNumber: 0, byteOffset: 0, frameSamples: 7 }]);
});

test("dense FLAC parser scans legal intervening metadata and uses the true audio offset", () => {
  const bytes = fixture({
    metadata: [
      { type: 1, bytes: new Uint8Array(23) },
      { type: 2, bytes: new Uint8Array([1, 2, 3, 4, 5]) },
      { type: 4, bytes: new Uint8Array([9, 8, 7]) },
      { type: 6, bytes: new Uint8Array(19) },
    ],
  });
  const parsed = parse(bytes, 11);
  assert.equal(parsed.metadata.audioDataStart, 166);
  assert.equal(parsed.metadata.decoderDescription.byteLength, 42);
  assert.deepEqual([...parsed.metadata.decoderDescription.subarray(0, 8)], [0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
});

test("dense FLAC parser rejects gaps, shifted offsets, placeholders, and bad frame bounds", () => {
  assert.throws(
    () => parse(fixture({ points: [[0, 0, 16], [17, 5, 16], [32, 12, 8]] })),
    expectCode("stem.flac.invalid"),
  );
  assert.throws(
    () => parse(fixture({ points: [[0, 1, 16], [16, 6, 16], [32, 13, 8]] })),
    expectCode("stem.flac.invalid"),
  );
  assert.throws(
    () => parse(fixture({ points: [[0xffffffffffffffffn, 0, 16], [16, 5, 16], [32, 12, 8]] })),
    /Placeholder/u,
  );
  assert.throws(
    () => parse(fixture({ minimumFrameBytes: 6 })),
    /frame violates/u,
  );
  assert.throws(
    () => parse(fixture({ minimumFrameBytes: 0 })),
    expectCode("stem.flac.shape"),
  );
  assert.throws(
    () => parse(fixture({ minimumBlockSamples: 8 })),
    expectCode("stem.flac.shape"),
  );
});

test("dense FLAC parser rejects unsupported shape and bounded resource violations", () => {
  for (const bytes of [
    fixture({ sampleRateHz: 22_050 }),
    fixture({ channels: 3 }),
    fixture({ bitDepth: 20 }),
    fixture({ totalSamples: 0, points: [] }),
  ]) {
    assert.throws(() => parse(bytes), expectCode("stem.flac.shape"));
  }
  assert.throws(
    () => new DenseFlacMetadataParser().push(new Uint8Array(MAXIMUM_DELIVERY_CHUNK_BYTES + 1)),
    expectCode("stem.flac.resource_limit"),
  );
  const oversizedMetadataHeader = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 34]);
  const parser = new DenseFlacMetadataParser();
  parser.push(oversizedMetadataHeader);
  const streamAndHeader = new Uint8Array(38);
  streamAndHeader.fill(1, 0, 34);
  streamAndHeader.set([1, 0x10, 0, 0], 34);
  assert.throws(() => parser.push(streamAndHeader), expectCode("stem.flac.resource_limit"));
});

test("packetizer emits exactly one packet per dense point across arbitrary chunks", () => {
  const bytes = fixture();
  const parsed = parse(bytes, 100);
  const audio = bytes.subarray(parsed.metadata.audioDataStart);
  const packetizer = new DenseFlacFramePacketizer(parsed.metadata, { expectedAudioBytes: 16 });
  const packets = [
    ...packetizer.push(audio.subarray(0, 3)),
    ...packetizer.push(audio.subarray(3, 9)),
    ...packetizer.push(audio.subarray(9)),
    ...packetizer.finish(),
  ];
  assert.deepEqual(
    packets.map((packet) => [packet.sampleNumber, packet.frameSamples, packet.bytes.byteLength]),
    [[0, 16, 5], [16, 16, 7], [32, 8, 4]],
  );
});

test("packetizer rejects truncation and short or long final frames", () => {
  const parsed = parse(fixture(), 100);
  const truncated = new DenseFlacFramePacketizer(parsed.metadata);
  truncated.push(parsed.audioRemainder);
  assert.throws(() => truncated.finish(), /final FLAC frame/u);

  const long = new DenseFlacFramePacketizer(parsed.metadata);
  assert.throws(() => long.push(new Uint8Array(21)), /exceeds/u);
});

class FakeAudioData implements WebCodecsAudioDataLike {
  closed = false;
  constructor(
    readonly format: WebCodecsAudioFormat,
    readonly numberOfFrames: number,
    readonly numberOfChannels: number,
    readonly sampleRate: number,
    readonly planes: readonly Uint8Array[],
  ) {}
  allocationSize({ planeIndex }: { readonly planeIndex: number }): number {
    return this.planes[planeIndex]!.byteLength;
  }
  copyTo(destination: AllowSharedBufferSource, { planeIndex }: { readonly planeIndex: number }): void {
    const view = ArrayBuffer.isView(destination)
      ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
      : new Uint8Array(destination);
    view.set(this.planes[planeIndex]!);
  }
  close(): void {
    this.closed = true;
  }
}

function signed(values: readonly number[], bits: 16 | 32): Uint8Array {
  const bytes = new Uint8Array(values.length * (bits / 8));
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) =>
    bits === 16 ? view.setInt16(index * 2, value, true) : view.setInt32(index * 4, value, true),
  );
  return bytes;
}

function floats(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

test("PCM conversion covers interleaved and planar source-depth integer layouts", () => {
  const s16 = new FakeAudioData("s16", 2, 2, 44_100, [signed([-32_768, 32_767, -1, 1], 16)]);
  assert.deepEqual(
    audioDataToCanonicalPcm(s16, { sampleRateHz: 44_100, channels: 2, bitDepth: 16, frameSamples: 2 }),
    new Uint8Array([0, 128, 255, 127, 255, 255, 1, 0]),
  );
  assert.equal(s16.closed, true);

  const s32 = new FakeAudioData("s32-planar", 2, 2, 48_000, [
    signed([-8_388_608 * 256, 256], 32),
    signed([8_388_607 * 256, -256], 32),
  ]);
  assert.deepEqual(
    audioDataToCanonicalPcm(s32, { sampleRateHz: 48_000, channels: 2, bitDepth: 24 }),
    new Uint8Array([0, 0, 128, 255, 255, 127, 1, 0, 0, 255, 255, 255]),
  );
  assert.equal(s32.closed, true);
});

test("PCM conversion accepts exact floats and closes all invalid AudioData", () => {
  const exact = new FakeAudioData("f32-planar", 2, 1, 96_000, [floats([-1, 1 / 8_388_608])]);
  assert.deepEqual(
    audioDataToCanonicalPcm(exact, { sampleRateHz: 96_000, channels: 1, bitDepth: 24 }),
    new Uint8Array([0, 0, 128, 1, 0, 0]),
  );
  for (const audio of [
    new FakeAudioData("f32", 1, 1, 44_100, [floats([0.1])]),
    new FakeAudioData("s32", 1, 1, 44_100, [signed([0x101], 32)]),
    new FakeAudioData("s16", 1, 1, 48_000, [signed([0], 16)]),
  ]) {
    assert.throws(
      () => audioDataToCanonicalPcm(audio, { sampleRateHz: 44_100, channels: 1, bitDepth: 24 }),
      expectCode("stem.decode.output"),
    );
    assert.equal(audio.closed, true);
  }
});

test("PCM conversion refuses output beyond the canonical block bound and still closes it", () => {
  const frames = MAXIMUM_CANONICAL_OUTPUT_BYTES / 2 + 1;
  const audio = new FakeAudioData("s16", frames, 1, 44_100, [new Uint8Array(frames * 2)]);
  assert.throws(
    () => audioDataToCanonicalPcm(audio, { sampleRateHz: 44_100, channels: 1, bitDepth: 16 }),
    expectCode("stem.flac.resource_limit"),
  );
  assert.equal(audio.closed, true);
});

test("FLAC admission defaults obey unknown hints and frozen memory/core bounds", () => {
  assert.equal(defaultFlacMemoryBudgetBytes(), DEFAULT_FLAC_MEMORY_BUDGET_BYTES);
  assert.equal(defaultFlacMemoryBudgetBytes(Number.NaN), DEFAULT_FLAC_MEMORY_BUDGET_BYTES);
  assert.equal(defaultFlacMemoryBudgetBytes(0.5), 8 * 1024 * 1024);
  assert.equal(defaultFlacMemoryBudgetBytes(16), 32 * 1024 * 1024);
  assert.equal(flacAdmissionWidth(), 1);
  assert.equal(flacAdmissionWidth({ hardwareConcurrency: 12, memoryBudgetBytes: 24 * 1024 * 1024 }), 3);
  assert.equal(
    flacAdmissionWidth({ hardwareConcurrency: 12, memoryBudgetBytes: 32 * 1024 * 1024, maximum: 2 }),
    2,
  );
});

test("bounded admission is FIFO and removes queued cancellation", async () => {
  const admission = new BoundedStemAdmission(1);
  const first = await admission.acquire();
  const order: string[] = [];
  const cancelled = new AbortController();
  const second = admission.acquire(cancelled.signal).then(() => order.push("cancelled"));
  const third = admission.acquire().then((lease) => {
    order.push("third");
    lease.release();
  });
  assert.deepEqual(admission.stats, { active: 1, queued: 2, limit: 1 });
  cancelled.abort("test");
  await assert.rejects(second, expectCode("stem.cancelled"));
  assert.deepEqual(admission.stats, { active: 1, queued: 1, limit: 1 });
  first.release();
  await third;
  assert.deepEqual(order, ["third"]);
  assert.deepEqual(admission.stats, { active: 0, queued: 0, limit: 1 });
});
