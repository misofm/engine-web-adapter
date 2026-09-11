import assert from "node:assert/strict";
import test from "node:test";

import {
  SPARSE_PCM_FORMAT,
  SPARSE_STEM_HEADER_BYTES,
  SPARSE_STEM_MAGIC,
  assertSparseStemSessionBinding,
  deriveSparsePcmIndex,
  parseSparseStemPackage,
  readSparsePcmWindow,
  serializeSparseStemPackage,
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
