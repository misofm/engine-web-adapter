import assert from "node:assert/strict";
import test from "node:test";

import {
  SPARSE_PCM_FORMAT,
  SPARSE_PCM_MAX_INTERVALS,
  SPARSE_STEM_FORMAT,
  SPARSE_STEM_HEADER_BYTES,
  SPARSE_STEM_MAGIC,
  SPARSE_STEM_MAX_CHUNK_BYTES,
  SPARSE_STEM_MAX_INDEX_BYTES,
  SPARSE_STEM_MAX_OBJECT_BYTES,
  admitSparseStemHeader,
  admitSparseStemManifest,
  assertSparseStemSessionBinding,
  deriveSparsePcmIndex,
  parseSparseStemPackage,
  readSparsePcmWindow,
  serializeSparseStemIndex,
  serializeSparseStemPackage,
  validateSparsePcmIndex,
  validateSparseStemManifest,
  type SparseStemManifest,
} from "../src/stems/index.js";

const ID_A = ("blake3:" + "a".repeat(64)) as `blake3:${string}`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function chunk(frames: number, packedStartFrame: number, bytes: number, offset: number) {
  return { bytes, flacSha256: HASH_A, frames, offset, packedStartFrame, pcmSha256: HASH_B };
}

function manifestWith(
  intervals: SparseStemManifest["intervals"],
  chunks: SparseStemManifest["chunks"],
  frames = 20,
): SparseStemManifest {
  return {
    format: SPARSE_STEM_FORMAT,
    identity: ID_A,
    sampleRateHz: 44_100,
    channels: 1,
    bitDepth: 16,
    frames,
    intervals,
    chunks,
  };
}

const manifest = manifestWith(
  [
    { startFrame: 0, frames: 2, packedFrameOffset: 0 },
    { startFrame: 5, frames: 3, packedFrameOffset: 2 },
  ],
  [chunk(5, 0, 10, 0)],
);

class SpyBlob extends Blob {
  readonly slices: Array<[number | undefined, number | undefined]> = [];

  override slice(start?: number, end?: number, contentType?: string): Blob {
    this.slices.push([start, end]);
    return super.slice(start, end, contentType);
  }
}

class ShortBlob extends Blob {
  override slice(start?: number, end?: number): Blob {
    const expected = Math.max(0, (end ?? this.size) - (start ?? 0));
    return super.slice(start, (start ?? 0) + Math.max(0, expected - 1));
  }
}

function header(manifestBytes: number, magic: string = SPARSE_STEM_MAGIC): Uint8Array {
  const result = new Uint8Array(SPARSE_STEM_HEADER_BYTES);
  result.set(new TextEncoder().encode(magic));
  new DataView(result.buffer).setUint32(8, manifestBytes, true);
  return result;
}

function rawManifest(value: unknown, payload = new Uint8Array(0)): Blob {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const h = header(bytes.byteLength);
  return new Blob([h.buffer as ArrayBuffer, bytes.buffer as ArrayBuffer, payload.buffer as ArrayBuffer]);
}

test("canonical singular package round-trip reads only header and manifest", async () => {
  const payload = new Uint8Array(10).fill(0x7f);
  const built = serializeSparseStemPackage(manifest, payload);
  const spy = new SpyBlob([await built.arrayBuffer()]);
  const parsed = await parseSparseStemPackage(spy);
  assert.equal(parsed.manifest.format, SPARSE_STEM_FORMAT);
  assert.deepEqual(parsed.manifest.intervals, manifest.intervals);
  assert.deepEqual(parsed.manifest.chunks, manifest.chunks);
  assert.equal(parsed.payloadBytes, payload.byteLength);
  assert.deepEqual(spy.slices, [[0, SPARSE_STEM_HEADER_BYTES], [SPARSE_STEM_HEADER_BYTES, parsed.dataStart]]);
  assert.ok(Object.isFrozen(parsed.manifest));
  assert.ok(Object.isFrozen(parsed.manifest.intervals));
  assert.ok(Object.isFrozen(parsed.manifest.chunks));
});

test("recursive lexical canonical bytes and pure streaming admissions agree", () => {
  const encoded = serializeSparseStemIndex(manifest);
  const text = new TextDecoder().decode(encoded);
  assert.equal(
    text,
    '{"bitDepth":16,"channels":1,"chunks":[{"bytes":10,"flacSha256":"' + HASH_A +
      '","frames":5,"offset":0,"packedStartFrame":0,"pcmSha256":"' + HASH_B +
      '"}],"format":"miso_sparse_stem_v1","frames":20,"identity":"' + ID_A +
      '","intervals":[{"frames":2,"packedFrameOffset":0,"startFrame":0},{"frames":3,"packedFrameOffset":2,"startFrame":5}],"sampleRateHz":44100}',
  );
  const admission = admitSparseStemHeader(header(encoded.byteLength));
  assert.equal(admission.payloadStart, SPARSE_STEM_HEADER_BYTES + encoded.byteLength);
  assert.deepEqual(admitSparseStemManifest(encoded, 10), manifest);
  assert.throws(() => admitSparseStemManifest(encoded, 9), /Payload length/u);
  assert.throws(() => admitSparseStemHeader(header(encoded.byteLength).subarray(0, 15)), /exactly/u);
});

test("raw header corpus rejects old wire, unknown magic, short, reserved and bounded lengths", () => {
  assert.throws(() => admitSparseStemHeader(header(1, "MISOSPC1")), /magic/u);
  assert.throws(() => admitSparseStemHeader(header(1, "UNKNOWN1")), /magic/u);
  const reserved = header(1);
  reserved[12] = 1;
  assert.throws(() => admitSparseStemHeader(reserved), /reserved/u);
  assert.throws(() => admitSparseStemHeader(header(0)), /length/u);
  assert.throws(() => admitSparseStemHeader(header(SPARSE_STEM_MAX_INDEX_BYTES + 1)), /length/u);
  assert.throws(() => admitSparseStemHeader(new Uint8Array(15)), /exactly/u);
});

test("raw manifest corpus rejects malformed encodings and extent", async () => {
  const encoded = serializeSparseStemIndex(manifest);
  const text = new TextDecoder().decode(encoded);
  const malformed: Array<[string, () => void]> = [
    ["bad utf8", () => assert.throws(() => admitSparseStemManifest(Uint8Array.from([0xff])), /UTF-8/u)],
    ["whitespace", () => assert.throws(() => admitSparseStemManifest(new TextEncoder().encode(" " + text)), /canonical/u)],
    ["unknown root key", () => assert.throws(() => admitSparseStemManifest(new TextEncoder().encode(text.replace('"format":', '"extra":1,"format":')), 10), /unknown/u)],
    ["wrong format", () => assert.throws(() => admitSparseStemManifest(new TextEncoder().encode(text.replace(SPARSE_STEM_FORMAT, "miso_sparse_stem_v2")), 10), /unsupported/u)],
    ["adjacent intervals", () => assert.throws(() => validateSparseStemManifest(manifestWith([
      { startFrame: 0, frames: 2, packedFrameOffset: 0 },
      { startFrame: 2, frames: 1, packedFrameOffset: 2 },
    ], [chunk(3, 0, 6, 0)])), /adjacent/u)],
    ["chunk gap", () => assert.throws(() => validateSparseStemManifest(manifestWith(manifest.intervals, [
      chunk(2, 0, 4, 0), chunk(3, 3, 6, 5),
    ])), /contiguous/u)],
    ["chunk endpoint", () => assert.throws(() => validateSparseStemManifest(manifestWith(manifest.intervals, [
      chunk(4, 0, 8, 0),
    ])), /endpoint/u)],
    ["payload trailing", () => assert.throws(() => admitSparseStemManifest(encoded, 11), /Payload length/u)],
  ];
  for (const [, run] of malformed) run();
  const duplicate = text.replace('"format":', '"format":"' + SPARSE_STEM_FORMAT + '","format":');
  assert.throws(() => admitSparseStemManifest(new TextEncoder().encode(duplicate), 10), /unknown|canonical/u);
  await assert.rejects(parseSparseStemPackage(rawManifest(JSON.parse(text), new Uint8Array(9))), /endpoint|Payload/u);
});

function lexicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return "[" + value.map((item) => lexicalJson(item)).join(",") + "]";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + lexicalJson(record[key])).join(",") + "}";
  }
  throw new Error("unsupported test JSON value");
}

function boundaryManifest(totalBytes: number): Uint8Array {
  let lastBytes = SPARSE_STEM_MAX_CHUNK_BYTES;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const chunks = [];
    let offset = 0;
    for (let index = 0; index < 256; index += 1) {
      const bytes = index === 255 ? lastBytes : SPARSE_STEM_MAX_CHUNK_BYTES;
      chunks.push(chunk(1, index, bytes, offset));
      offset += bytes;
    }
    const value = manifestWith([{ startFrame: 0, frames: 256, packedFrameOffset: 0 }], chunks, 256);
    const encoded = new TextEncoder().encode(lexicalJson(value));
    const desiredPayload = totalBytes - SPARSE_STEM_HEADER_BYTES - encoded.byteLength;
    const nextLastBytes = desiredPayload - 255 * SPARSE_STEM_MAX_CHUNK_BYTES;
    if (nextLastBytes === lastBytes) return encoded;
    lastBytes = nextLastBytes;
  }
  throw new Error("boundary manifest did not converge");
}

test("streaming admission enforces the global object ceiling with or without known payload length", () => {
  for (const totalBytes of [SPARSE_STEM_MAX_OBJECT_BYTES - 1, SPARSE_STEM_MAX_OBJECT_BYTES, SPARSE_STEM_MAX_OBJECT_BYTES + 1]) {
    const encoded = boundaryManifest(totalBytes);
    const declaredPayload = totalBytes - SPARSE_STEM_HEADER_BYTES - encoded.byteLength;
    assert.ok(declaredPayload > 0);
    if (totalBytes <= SPARSE_STEM_MAX_OBJECT_BYTES) {
      assert.doesNotThrow(() => admitSparseStemManifest(encoded, declaredPayload));
      assert.doesNotThrow(() => admitSparseStemManifest(encoded));
    } else {
      assert.throws(() => admitSparseStemManifest(encoded, declaredPayload), /bounded size/u);
      assert.throws(() => admitSparseStemManifest(encoded), /bounded size/u);
    }
  }
});

test("metadata count limits are preflighted before late getters", () => {
  let touched = false;
  const intervals = new Proxy(new Array(SPARSE_PCM_MAX_INTERVALS + 1), {
    get(target, property, receiver) {
      if (property !== "length") touched = true;
      if (property !== "length") throw new Error("late interval getter");
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => validateSparseStemManifest({ ...manifest, intervals }), /bounded count/u);
  assert.equal(touched, false);

  let chunksTouched = false;
  const chunks = new Proxy(new Array(65_537), {
    get(target, property, receiver) {
      if (property !== "length") chunksTouched = true;
      if (property !== "length") throw new Error("late chunk getter");
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => validateSparseStemManifest({ ...manifest, chunks }), /bounded count/u);
  assert.equal(chunksTouched, false);
});

test("chunk frame and byte ceilings are enforced before extent acceptance", () => {
  const frameLimit = 30 * manifest.sampleRateHz;
  assert.throws(() => validateSparseStemManifest(manifestWith(
    [{ startFrame: 0, frames: frameLimit + 1, packedFrameOffset: 0 }],
    [chunk(frameLimit + 1, 0, 1, 0)],
    frameLimit + 1,
  )), /30 second/u);
  assert.throws(() => validateSparseStemManifest(manifestWith(
    [{ startFrame: 0, frames: 1, packedFrameOffset: 0 }],
    [chunk(1, 0, SPARSE_STEM_MAX_CHUNK_BYTES + 1, 0)],
    1,
  )), /compressed chunk/u);
  assert.throws(() => validateSparseStemManifest({ ...manifest, frames: Number.MAX_SAFE_INTEGER, intervals: [], chunks: [] }), /canonical|unsafe/u);
  assert.throws(() => validateSparseStemManifest({ ...manifest, frames: -0 }), /safe integer/u);
});

test("direct serialization enforces the manifest byte ceiling", () => {
  const count = 65_536;
  const chunks = Array.from({ length: count }, (_, index) => chunk(1, index, 1, index));
  const oversized = manifestWith([{ startFrame: 0, frames: count, packedFrameOffset: 0 }], chunks, count);
  assert.throws(() => serializeSparseStemIndex(oversized), /bounded size/u);
});

test("accepted all-silent and mixed chunk partitions", async () => {
  const silent = manifestWith([], [], 100);
  const silentBlob = serializeSparseStemPackage(silent, new Uint8Array(0));
  const parsedSilent = await parseSparseStemPackage(silentBlob);
  assert.equal(parsedSilent.payloadBytes, 0);
  const multiChunk = manifestWith(
    [{ startFrame: 4, frames: 6, packedFrameOffset: 0 }],
    [chunk(2, 0, 4, 0), chunk(4, 2, 8, 4)],
    20,
  );
  const bytes = serializeSparseStemIndex(multiChunk);
  assert.deepEqual(admitSparseStemManifest(bytes, 12).chunks, multiChunk.chunks);
});

test("single-source identity and shape binding rejects every mismatch", () => {
  assert.doesNotThrow(() => assertSparseStemSessionBinding(manifest, {
    identity: ID_A, sampleRateHz: 44_100, channels: 1, bitDepth: 16, frames: 20n,
  }));
  for (const expected of [
    { identity: ID_A, sampleRateHz: 48_000, channels: 1, bitDepth: 16, frames: 20 },
    { identity: ID_A, sampleRateHz: 44_100, channels: 2, bitDepth: 16, frames: 20 },
    { identity: ID_A, sampleRateHz: 44_100, channels: 1, bitDepth: 24, frames: 20 },
    { identity: ID_A, sampleRateHz: 44_100, channels: 1, bitDepth: 16, frames: 21 },
    { identity: ("blake3:" + "b".repeat(64)) as `blake3:${string}`, sampleRateHz: 44_100, channels: 1, bitDepth: 16, frames: 20 },
  ] as const) assert.throws(() => assertSparseStemSessionBinding(manifest, expected), /identity|shape/u);
});

function pcmManifest(intervals: SparseStemManifest["intervals"], frames: number, channels: 1 | 2, bitDepth: 16 | 24): SparseStemManifest {
  let active = 0;
  const chunks: SparseStemManifest["chunks"] = [];
  for (const item of intervals) {
    active += item.frames;
  }
  return {
    format: SPARSE_STEM_FORMAT,
    identity: ID_A,
    sampleRateHz: 44_100,
    channels,
    bitDepth,
    frames,
    intervals,
    chunks: active === 0 ? chunks : [chunk(active, 0, active * channels * (bitDepth / 8), 0)],
  };
}

test("PCM index derives from intervals only and ignores chunk partition", () => {
  const intervals = [
    { startFrame: 0, frames: 2, packedFrameOffset: 0 },
    { startFrame: 5, frames: 3, packedFrameOffset: 2 },
  ];
  const first = pcmManifest(intervals, 10, 1, 16);
  const second = { ...first, chunks: [chunk(1, 0, 2, 0), chunk(4, 1, 8, 2)] };
  const left = deriveSparsePcmIndex(first, new Uint8Array(10));
  const right = deriveSparsePcmIndex(second, new Uint8Array(10));
  assert.deepEqual(left.index.intervals, right.index.intervals);
  assert.equal(left.activeBytes, 10);
  assert.equal(left.canonicalBytes, 20);
});

test("reader returns exact zeros and one bounded contiguous active read", async () => {
  const source = pcmManifest([
    { startFrame: 0, frames: 2, packedFrameOffset: 0 },
    { startFrame: 5, frames: 3, packedFrameOffset: 2 },
  ], 10, 1, 16);
  const packed = Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0]);
  const derived = deriveSparsePcmIndex(source, packed);
  const blob = new SpyBlob([packed]);
  const output = await readSparsePcmWindow(derived.index, blob, 1, 7);
  assert.deepEqual(blob.slices, [[2, 10]]);
  assert.deepEqual([...output], [2, 0, 0, 0, 0, 0, 0, 0, 3, 0, 4, 0, 5, 0]);
});

test("all-silent windows do not read the packed Blob and repeated reads do not clone", async () => {
  const silent = pcmManifest([], 20_000, 1, 16);
  const empty = new SpyBlob([]);
  const silentIndex = deriveSparsePcmIndex(silent, empty).index;
  const silence = await readSparsePcmWindow(silentIndex, empty, 8192, 8192);
  assert.equal(silence.every((value) => value === 0), true);
  assert.deepEqual(empty.slices, []);

  const source = pcmManifest([{ startFrame: 10_000, frames: 1, packedFrameOffset: 0 }], 20_000, 1, 16);
  const sparse = deriveSparsePcmIndex(source, new Uint8Array(2)).index;
  const gap = new SpyBlob([new Uint8Array(2)]);
  await readSparsePcmWindow(sparse, gap, 0, 8192);
  assert.deepEqual(gap.slices, []);

  const originalFreeze = Object.freeze;
  let freezeCalls = 0;
  Object.freeze = ((value: object) => {
    freezeCalls += 1;
    return originalFreeze(value);
  }) as typeof Object.freeze;
  try {
    await readSparsePcmWindow(sparse, gap, 10_000, 1);
  } finally {
    Object.freeze = originalFreeze;
  }
  assert.equal(freezeCalls, 0);
});

test("dense oracle covers mono16 stereo24 gaps, crossing, seek and EOF", async () => {
  const cases = [
    {
      source: pcmManifest([{ startFrame: 0, frames: 5, packedFrameOffset: 0 }], 5, 1, 16),
      packed: Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0]),
      windows: [{ start: 0, count: 5 }],
    },
    {
      source: pcmManifest([{ startFrame: 9_999, frames: 1, packedFrameOffset: 0 }], 10_000, 2, 24),
      packed: Uint8Array.from([1, 0, 0, 2, 0, 0]),
      windows: [{ start: 9_000, count: 1_000 }, { start: 9_999, count: 1 }],
    },
    {
      source: pcmManifest([{ startFrame: 0, frames: 8_203, packedFrameOffset: 0 }], 8_203, 1, 16),
      packed: new Uint8Array(8_203 * 2).map((_, index) => index & 0xff),
      windows: [{ start: 8_188, count: 8 }, { start: 8_192, count: 8 }],
    },
    {
      source: pcmManifest([], 12, 2, 24),
      packed: new Uint8Array(0),
      windows: [{ start: 0, count: 12 }],
    },
  ];
  for (const item of cases) {
    const valid = validateSparseStemManifest(item.source, item.packed.byteLength);
    const frameBytes = valid.channels * (valid.bitDepth / 8);
    const expected = new Uint8Array(valid.frames * frameBytes);
    let packedOffset = 0;
    for (const span of valid.intervals) {
      const bytes = span.frames * frameBytes;
      expected.set(item.packed.subarray(packedOffset, packedOffset + bytes), span.startFrame * frameBytes);
      packedOffset += bytes;
    }
    const index = deriveSparsePcmIndex(valid, item.packed).index;
    for (const window of item.windows) {
      const actual = await readSparsePcmWindow(index, new Blob([item.packed]), window.start, window.count);
      assert.deepEqual(actual, expected.slice(window.start * frameBytes, (window.start + window.count) * frameBytes));
    }
  }
});

test("PCM admission and window bounds remain strict", async () => {
  const source = pcmManifest([{ startFrame: 0, frames: 2, packedFrameOffset: 0 }], 4, 1, 16);
  const derived = deriveSparsePcmIndex(source, new Uint8Array(4));
  const forged = Object.freeze({ ...derived.index, intervals: [...derived.index.intervals] });
  await assert.rejects(readSparsePcmWindow(forged, new Blob([new Uint8Array(4)]), 0, 1), /admitted/u);
  await assert.rejects(readSparsePcmWindow(derived.index, new Blob([new Uint8Array(4)]), 0, 8193), /bounded/u);
  await assert.rejects(readSparsePcmWindow(derived.index, new Blob([new Uint8Array(4)]), 4, 1), /outside/u);
  await assert.rejects(readSparsePcmWindow(derived.index, new ShortBlob([new Uint8Array(4)]), 0, 1), /short/u);
});

test("PCM index count and metadata bounds are checked before interval access", () => {
  const intervals = new Proxy(new Array(SPARSE_PCM_MAX_INTERVALS + 1), {
    get(target, property, receiver) {
      if (property !== "length") throw new Error("late PCM interval getter");
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => validateSparsePcmIndex({
    format: SPARSE_PCM_FORMAT, identity: ID_A, sampleRateHz: 44_100, channels: 1, bitDepth: 16, frames: 1, intervals,
  }), /too many/u);
  assert.throws(() => validateSparsePcmIndex({
    format: SPARSE_PCM_FORMAT, identity: ID_A, sampleRateHz: 44_100, channels: 1, bitDepth: 16,
    frames: 4, intervals: [{ startFrame: 0, frames: 1, byteOffset: 0, extra: true }],
  }), /unknown/u);
});

test("short packed payload and wrong derivation payload are rejected", async () => {
  const source = pcmManifest([{ startFrame: 0, frames: 2, packedFrameOffset: 0 }], 4, 1, 16);
  assert.throws(() => deriveSparsePcmIndex(source, new Uint8Array(3)), /payload size/u);
  const index = deriveSparsePcmIndex(source, new Uint8Array(4)).index;
  await assert.rejects(readSparsePcmWindow(index, new ShortBlob([new Uint8Array(4)]), 0, 1), /short/u);
});
