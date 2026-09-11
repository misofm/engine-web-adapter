import assert from "node:assert/strict";
import test from "node:test";

import {
  SPARSE_PCM_FORMAT,
  SPARSE_PCM_MAX_INTERVALS,
  SPARSE_STEM_HEADER_BYTES,
  SPARSE_STEM_MAGIC,
  assertSparseStemSessionBinding,
  deriveSparsePcmIndex,
  parseSparseStemPackage,
  readSparsePcmWindow,
  serializeSparseStemPackage,
  validateSparseStemManifest,
  validateSparsePcmIndex,
  type SparseStemManifest,
  type SparseStemSource,
} from "../src/stems/index.js";

const ID_A = `sha256:${"a".repeat(64)}` as const;
const ID_B = `sha256:${"b".repeat(64)}` as const;

function unit(startFrame: number, frames: number, offset: number, bytes: number, fill: string) {
  return {
    startFrame,
    frames,
    offset,
    bytes,
    flacSha256: fill.repeat(64),
    pcmSha256: fill === "a" ? "b".repeat(64) : "a".repeat(64),
  };
}

const manifest: SparseStemManifest = {
  format: "miso_sparse_stems_v1",
  sources: [
    {
      identity: ID_A,
      sampleRateHz: 44_100,
      channels: 1,
      bitDepth: 16,
      frames: 10,
      units: [unit(0, 3, 0, 5, "a"), unit(6, 2, 5, 7, "b")],
    },
    {
      identity: ID_B,
      sampleRateHz: 96_000,
      channels: 2,
      bitDepth: 24,
      frames: 4,
      units: [unit(1, 3, 12, 9, "c")],
    },
  ],
};

class SpyBlob extends Blob {
  readonly slices: Array<[number | undefined, number | undefined]> = [];

  override slice(start?: number, end?: number, contentType?: string): Blob {
    this.slices.push([start, end]);
    return super.slice(start, end, contentType);
  }
}

class ShortSliceBlob extends Blob {
  override slice(start?: number, end?: number): Blob {
    const expected = Math.max(0, (end ?? this.size) - (start ?? 0));
    return super.slice(start, (start ?? 0) + Math.max(0, expected - 1));
  }
}

test("sparse package serializer/parser round-trip reads only header and index", async () => {
  const payload = new Uint8Array(21).fill(0x7f);
  const built = serializeSparseStemPackage(manifest, payload);
  const spy = new SpyBlob([await built.arrayBuffer()]);
  const parsed = await parseSparseStemPackage(spy);
  assert.equal(parsed.manifest.format, "miso_sparse_stems_v1");
  assert.deepEqual(parsed.manifest.sources, manifest.sources);
  assert.ok(parsed.dataStart > SPARSE_STEM_HEADER_BYTES);
  assert.equal(parsed.payloadBytes, 21);
  assert.deepEqual(spy.slices, [[0, SPARSE_STEM_HEADER_BYTES], [SPARSE_STEM_HEADER_BYTES, parsed.dataStart]]);
  assert.ok(Object.isFrozen(parsed.manifest));
  assert.ok(Object.isFrozen(parsed.manifest.sources));
  assert.ok(Object.isFrozen(parsed.manifest.sources[0]!.units));
});

test("sparse parser rejects noncanonical headers and index encodings", async () => {
  const built = serializeSparseStemPackage(manifest, new Uint8Array(21));
  const bytes = new Uint8Array(await built.arrayBuffer());
  bytes[12] = 1;
  await assert.rejects(parseSparseStemPackage(new Blob([bytes])), /reserved/u);

  const index = new TextEncoder().encode(JSON.stringify({ format: "miso_sparse_stems_v1", sources: [] }));
  const header = new Uint8Array(SPARSE_STEM_HEADER_BYTES);
  header.set(new TextEncoder().encode(SPARSE_STEM_MAGIC));
  new DataView(header.buffer).setUint32(8, index.byteLength, true);
  await assert.rejects(parseSparseStemPackage(new Blob([header, index])), /sources/u);
});

function rawPackageBytes(index: Uint8Array, payload = new Uint8Array(21), mutateHeader?: (header: Uint8Array) => void): Blob {
  const header = new Uint8Array(SPARSE_STEM_HEADER_BYTES);
  header.set(new TextEncoder().encode(SPARSE_STEM_MAGIC));
  new DataView(header.buffer).setUint32(8, index.byteLength, true);
  mutateHeader?.(header);
  return new Blob([header.buffer as ArrayBuffer, index.buffer as ArrayBuffer, payload.buffer as ArrayBuffer]);
}

function rawPackage(indexText: string, payload = new Uint8Array(21), mutateHeader?: (header: Uint8Array) => void): Blob {
  return rawPackageBytes(new TextEncoder().encode(indexText), payload, mutateHeader);
}

test("table-driven raw wire corpus rejects malformed admission before payload use", async () => {
  const valid = serializeSparseStemPackage(manifest, new Uint8Array(21));
  const validBytes = new Uint8Array(await valid.arrayBuffer());
  const indexLength = new DataView(validBytes.buffer).getUint32(8, true);
  const validIndex = new TextDecoder().decode(validBytes.slice(SPARSE_STEM_HEADER_BYTES, SPARSE_STEM_HEADER_BYTES + indexLength));
  const parsedIndex = JSON.parse(validIndex) as {
    format: string;
    sources: Array<Record<string, unknown>>;
  };
  const firstSource = parsedIndex.sources[0]!;
  const firstUnits = firstSource.units as Array<Record<string, unknown>>;
  const secondSource = parsedIndex.sources[1]!;
  const malformed = (sources: Array<Record<string, unknown>>, payload = new Uint8Array(21)) =>
    rawPackage(JSON.stringify({ format: parsedIndex.format, sources }), payload);
  const cases: Array<[string, Blob]> = [
    ["bad magic", rawPackage(validIndex, new Uint8Array(21), (header) => { header[0] = 0; })],
    ["reserved", rawPackage(validIndex, new Uint8Array(21), (header) => { header[12] = 1; })],
    ["invalid utf8", (() => {
      const bytes = new Uint8Array(new TextEncoder().encode(validIndex));
      bytes[0] = 0xff;
      return rawPackageBytes(bytes, new Uint8Array(21));
    })()],
    ["noncanonical whitespace", rawPackage(` ${validIndex}`, new Uint8Array(21))],
    ["duplicate key", rawPackage(validIndex.replace('"sources":', '"format":"miso_sparse_stems_v1","sources":'), new Uint8Array(21))],
    ["unknown root key", rawPackage(validIndex.replace('"sources":', '"unexpected":1,"sources":'), new Uint8Array(21))],
    ["offset hole", rawPackage(validIndex.replace('"offset":0', '"offset":1'), new Uint8Array(21))],
    ["truncated index", rawPackage(validIndex.slice(0, -1), new Uint8Array(21))],
    ["short header", new Blob([new Uint8Array(4)])],
    ["unsupported rate", malformed([{ ...firstSource, sampleRateHz: 12 }, secondSource])],
    ["unsafe integer", malformed([{ ...firstSource, frames: 9_007_199_254_740_992 }, secondSource])],
    ["zero unit frames", malformed([{ ...firstSource, units: [{ ...firstUnits[0]!, frames: 0 }, firstUnits[1]!] }, secondSource])],
    ["unit out of bounds", malformed([{ ...firstSource, frames: 2 }, secondSource])],
    ["overlapping units", malformed([{ ...firstSource, units: [{ ...firstUnits[0]! }, { ...firstUnits[1]!, startFrame: 2 }] }, secondSource])],
    ["unsorted units", malformed([{ ...firstSource, units: [firstUnits[1]!, firstUnits[0]!] }, secondSource])],
    ["oversized unit", malformed([{ ...firstSource, units: [{ ...firstUnits[0]!, bytes: 2_097_153 }, firstUnits[1]!] }, secondSource])],
    ["offset alias", malformed([{ ...firstSource, units: [{ ...firstUnits[0]! }, { ...firstUnits[1]!, offset: 0 }] }, secondSource])],
    ["duplicate sources", malformed([{ ...firstSource, units: [] }, { ...firstSource, units: [] }], new Uint8Array(0))],
    ["unsorted sources", malformed([{ ...secondSource, units: [{ ...(secondSource.units as Array<Record<string, unknown>>)[0]!, offset: 0 }] }, { ...firstSource, units: (firstUnits as Array<Record<string, unknown>>).map((item) => ({ ...item, offset: (item.offset as number) + 9 })) }])],
    ["trailing payload", rawPackage(validIndex, new Uint8Array(22))],
  ];
  for (const [name, blob] of cases) await assert.rejects(parseSparseStemPackage(blob), name);
});

test("transport unit budget is preflighted before walking or cloning unit elements", () => {
  let touched = false;
  const units = new Proxy(new Array(65_537), {
    get(target, property, receiver) {
      if (property !== "length") touched = true;
      if (property !== "length") throw new Error("unit element was touched");
      return Reflect.get(target, property, receiver);
    },
  });
  const source = { ...manifest.sources[0]!, units };
  assert.throws(() => validateSparseStemManifest({ format: "miso_sparse_stems_v1", sources: [source] }), /too many/u);
  assert.equal(touched, false);
});

test("session binding is exact by identity and shape", async () => {
  const packageBlob = serializeSparseStemPackage(manifest, new Uint8Array(21));
  const parsed = await parseSparseStemPackage(packageBlob);
  assert.doesNotThrow(() => assertSparseStemSessionBinding(parsed, [
    { identity: ID_A, sampleRateHz: 44_100, channels: 1, bitDepth: 16, frames: 10 },
    { identity: ID_B, sampleRateHz: 96_000, channels: 2, bitDepth: 24, frames: 4n },
  ]));
  assert.throws(() => assertSparseStemSessionBinding(parsed, [
    { identity: ID_A, sampleRateHz: 48_000, channels: 1, bitDepth: 16, frames: 10 },
    { identity: ID_B, sampleRateHz: 96_000, channels: 2, bitDepth: 24, frames: 4 },
  ]), /shape/u);
  assert.throws(() => assertSparseStemSessionBinding(parsed, [
    { identity: ID_A, sampleRateHz: 44_100, channels: 1, bitDepth: 16, frames: 10 },
  ]), /source set/u);
  assert.throws(() => assertSparseStemSessionBinding(parsed, [
    { identity: `sha256:${"c".repeat(64)}`, sampleRateHz: 44_100, channels: 1, bitDepth: 16, frames: 10 },
    { identity: ID_B, sampleRateHz: 96_000, channels: 2, bitDepth: 24, frames: 4 },
  ]), /missing/u);
});

function pcmSource(): SparseStemSource {
  return {
    identity: ID_A,
    sampleRateHz: 44_100,
    channels: 2,
    bitDepth: 24,
    frames: 12,
    units: [
      unit(0, 2, 0, 1, "a"),
      unit(4, 2, 1, 17, "b"),
      unit(6, 1, 18, 2, "c"),
    ],
  };
}

test("packed PCM offsets use shape bytes and one bounded active read", async () => {
  const packedBytes = new Uint8Array(5 * 6);
  packedBytes.forEach((_, index) => { packedBytes[index] = index + 1; });
  const derived = deriveSparsePcmIndex(pcmSource(), packedBytes);
  assert.equal(derived.index.format, SPARSE_PCM_FORMAT);
  assert.equal(derived.activeBytes, 30);
  assert.equal(derived.canonicalBytes, 72);
  assert.deepEqual(derived.index.intervals, [
    { startFrame: 0, frames: 2, byteOffset: 0 },
    { startFrame: 4, frames: 3, byteOffset: 12 },
  ]);
  const validated = validateSparsePcmIndex({
    format: derived.index.format,
    identity: derived.index.identity,
    sampleRateHz: derived.index.sampleRateHz,
    channels: derived.index.channels,
    bitDepth: derived.index.bitDepth,
    frames: derived.index.frames,
    intervals: derived.index.intervals,
  }, packedBytes);
  assert.equal(validated.activeBytes, 30);

  const spy = new SpyBlob([packedBytes]);
  const output = await readSparsePcmWindow(derived.index, spy, 1, 7);
  assert.equal(output.byteLength, 42);
  assert.deepEqual(spy.slices, [[6, 30]]);
  assert.deepEqual([...output.slice(0, 6)], [7, 8, 9, 10, 11, 12]);
  assert.deepEqual([...output.slice(6, 18)], new Array(12).fill(0));
  assert.deepEqual([...output.slice(18, 36)], Array.from({ length: 18 }, (_, index) => index + 13));
});

test("standalone PCM admission is strict, bounded, and rejects unadmitted forgeries", async () => {
  const draft = {
    format: SPARSE_PCM_FORMAT,
    identity: ID_A,
    sampleRateHz: 44_100,
    channels: 1 as const,
    bitDepth: 16 as const,
    frames: 2,
    intervals: [{ startFrame: 0, frames: 1, byteOffset: 0 }],
  };
  assert.throws(() => validateSparsePcmIndex({ ...draft, unexpected: true }), /unknown/u);
  assert.throws(() => validateSparsePcmIndex({ ...draft, intervals: [{ ...draft.intervals[0]!, unexpected: true }] }), /unknown/u);
  const oversized = new Proxy(new Array(SPARSE_PCM_MAX_INTERVALS + 1), {
    get(target, property, receiver) {
      if (property !== "length") throw new Error("interval element was touched");
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => validateSparsePcmIndex({ ...draft, intervals: oversized }), /too many/u);
  const admitted = validateSparsePcmIndex(draft, new Uint8Array(2));
  const forged = Object.freeze({ ...admitted, intervals: [...admitted.intervals] });
  await assert.rejects(readSparsePcmWindow(forged, new Blob([new Uint8Array(2)]), 0, 1), /admitted/u);
});

test("repeated reads use the admitted interval map without cloning it", async () => {
  const intervalCount = 10_000;
  const intervals = Array.from({ length: intervalCount }, (_, index) => ({
    startFrame: index * 2,
    frames: 1,
    byteOffset: index * 2,
  }));
  const index = validateSparsePcmIndex({
    format: SPARSE_PCM_FORMAT,
    identity: ID_A,
    sampleRateHz: 44_100,
    channels: 1 as const,
    bitDepth: 16 as const,
    frames: intervalCount * 2,
    intervals,
  }, new Uint8Array(intervalCount * 2));
  const packed = new Blob([new Uint8Array(intervalCount * 2)]);
  const originalFreeze = Object.freeze;
  let freezeCalls = 0;
  Object.freeze = ((value: object) => {
    freezeCalls += 1;
    return originalFreeze(value);
  }) as typeof Object.freeze;
  try {
    await readSparsePcmWindow(index, packed, intervalCount * 2 - 2, 1);
  } finally {
    Object.freeze = originalFreeze;
  }
  assert.equal(freezeCalls, 0);
});

test("all-silent and all-gap windows do not read the packed Blob", async () => {
  const source: SparseStemSource = {
    identity: ID_A,
    sampleRateHz: 48_000,
    channels: 1,
    bitDepth: 16,
    frames: 20_000,
    units: [],
  };
  const empty = new SpyBlob([]);
  const derived = deriveSparsePcmIndex(source, empty);
  const silence = await readSparsePcmWindow(derived.index, empty, 8192, 8192);
  assert.equal(silence.every((byte) => byte === 0), true);
  assert.deepEqual(empty.slices, []);

  const sparse = deriveSparsePcmIndex({ ...source, units: [unit(10_000, 1, 0, 1, "a")] }, new Uint8Array(2));
  const gapBlob = new SpyBlob([new Uint8Array(2)]);
  await readSparsePcmWindow(sparse.index, gapBlob, 0, 8192);
  assert.deepEqual(gapBlob.slices, []);
});

test("wrong payload size and short active slices reject", async () => {
  const source = pcmSource();
  assert.throws(() => deriveSparsePcmIndex(source, new Uint8Array(29)), /payload size/u);
  const packed = new Uint8Array(30);
  const derived = deriveSparsePcmIndex(source, packed);
  await assert.rejects(readSparsePcmWindow(derived.index, new ShortSliceBlob([packed]), 0, 1), /short/u);
});

function denseOracle(frames: number, frameBytes: number, spans: readonly { startFrame: number; frames: number }[], packed: Uint8Array): Uint8Array {
  const output = new Uint8Array(frames * frameBytes);
  let packedOffset = 0;
  for (const span of spans) {
    const bytes = span.frames * frameBytes;
    output.set(packed.subarray(packedOffset, packedOffset + bytes), span.startFrame * frameBytes);
    packedOffset += bytes;
  }
  assert.equal(packedOffset, packed.byteLength);
  return output;
}

test("dense integer oracle covers mono16, stereo24, silent gaps, LSB, 8192 crossing and EOF", async () => {
  const cases: Array<{
    source: SparseStemSource;
    packed: Uint8Array;
    frameBytes: number;
    spans: readonly { startFrame: number; frames: number }[];
    windows: readonly { startFrame: number; frames: number }[];
  }> = [
    {
      source: {
        identity: ID_A, sampleRateHz: 44_100, channels: 1, bitDepth: 16, frames: 5,
        units: [unit(0, 5, 0, 3, "a")],
      },
      packed: Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0]),
      frameBytes: 2,
      spans: [{ startFrame: 0, frames: 5 }],
      windows: [{ startFrame: 0, frames: 5 }],
    },
    {
      source: {
        identity: ID_A, sampleRateHz: 96_000, channels: 2, bitDepth: 24, frames: 10_000,
        units: [unit(9_999, 1, 0, 3, "a")],
      },
      packed: Uint8Array.from([0x01, 0, 0, 0x02, 0, 0]),
      frameBytes: 6,
      spans: [{ startFrame: 9_999, frames: 1 }],
      windows: [{ startFrame: 9_000, frames: 1_000 }],
    },
    {
      source: {
        identity: ID_A, sampleRateHz: 44_100, channels: 1, bitDepth: 16, frames: 8_203,
        units: [unit(0, 8_203, 0, 4, "a")],
      },
      packed: Uint8Array.from({ length: 8_203 * 2 }, (_, index) => index & 0xff),
      frameBytes: 2,
      spans: [{ startFrame: 0, frames: 8_203 }],
      windows: [
        { startFrame: 8_188, frames: 8 },
        { startFrame: 8_192, frames: 8 },
        { startFrame: 8_199, frames: 4 },
      ],
    },
    {
      source: {
        identity: ID_A, sampleRateHz: 48_000, channels: 1, bitDepth: 16, frames: 10,
        units: [unit(3, 1, 0, 2, "a"), unit(7, 2, 2, 2, "b")],
      },
      packed: Uint8Array.from([1, 0, 2, 0, 3, 0]),
      frameBytes: 2,
      spans: [{ startFrame: 3, frames: 1 }, { startFrame: 7, frames: 2 }],
      windows: [{ startFrame: 0, frames: 10 }],
    },
    {
      source: {
        identity: ID_A, sampleRateHz: 88_200, channels: 2, bitDepth: 24, frames: 12,
        units: [],
      },
      packed: new Uint8Array(0),
      frameBytes: 6,
      spans: [],
      windows: [{ startFrame: 0, frames: 12 }],
    },
  ];
  for (const item of cases) {
    const derived = deriveSparsePcmIndex(item.source, item.packed);
    const oracle = denseOracle(item.source.frames, item.frameBytes, item.spans, item.packed);
    for (const window of item.windows) {
      const actual = await readSparsePcmWindow(derived.index, new Blob([item.packed.buffer as ArrayBuffer]), window.startFrame, window.frames);
      const expected = oracle.slice(window.startFrame * item.frameBytes, (window.startFrame + window.frames) * item.frameBytes);
      assert.deepEqual(actual, expected);
    }
  }
});
