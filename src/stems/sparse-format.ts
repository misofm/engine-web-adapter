import { EngineWebAdapterError } from "../errors.js";
import { assertStemIdentity } from "./identity.js";
import type { DeclaredStemSource, StemIdentity } from "./types.js";

/** The compressed sparse-stem package contract. */
export const SPARSE_STEM_FORMAT = "miso_sparse_stems_v1" as const;
export const SPARSE_STEM_MAGIC = "MISOSPC1" as const;
export const SPARSE_STEM_HEADER_BYTES = 16;
export const SPARSE_STEM_MAX_INDEX_BYTES = 8 * 1024 * 1024;
export const SPARSE_STEM_MAX_SOURCES = 1024;
export const SPARSE_STEM_MAX_UNITS = 65_536;
export const SPARSE_STEM_MAX_UNIT_BYTES = 2 * 1024 * 1024;
export const SPARSE_STEM_MAX_OBJECT_BYTES = 8 * 1024 * 1024 * 1024;

const SAMPLE_RATES = [44_100, 48_000, 88_200, 96_000] as const;
const DIGEST = /^[0-9a-f]{64}$/u;

export interface SparseStemUnit {
  readonly startFrame: number;
  readonly frames: number;
  /** Offset from the first byte after the package index. */
  readonly offset: number;
  readonly bytes: number;
  readonly flacSha256: string;
  readonly pcmSha256: string;
}

export interface SparseStemSource {
  readonly identity: StemIdentity;
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frames: number;
  readonly units: readonly SparseStemUnit[];
}

export interface SparseStemManifest {
  readonly format: typeof SPARSE_STEM_FORMAT;
  readonly sources: readonly SparseStemSource[];
}

export interface ParsedSparseStemPackage {
  readonly manifest: SparseStemManifest;
  /** Byte offset at which the concatenated native FLAC units begin. */
  readonly dataStart: number;
  readonly payloadBytes: number;
}

export interface SparseSessionSourceShape {
  readonly identity: StemIdentity;
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frames: number | bigint;
}

export interface SparseSessionDeclaredSource {
  readonly sampleRateHz: number;
  readonly source: DeclaredStemSource;
}

export type SparseSessionSourceExpectation = SparseSessionSourceShape | SparseSessionDeclaredSource;

function corrupt(message: string, details: Readonly<Record<string, unknown>> = {}): EngineWebAdapterError {
  return new EngineWebAdapterError("stem.corrupt", message, details);
}

function declaration(message: string, details: Readonly<Record<string, unknown>> = {}): EngineWebAdapterError {
  return new EngineWebAdapterError("stem.invalid_declaration", message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactObject(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value)) throw corrupt(`${path} must be an object`);
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== keys.length) throw corrupt(`${path} has an unknown or missing key`, { path, keys: ownKeys });
  const actual = ownKeys.sort();
  const expected = [...keys].sort();
  if (actual.some((key, index) => key !== expected[index])) {
    throw corrupt(`${path} has an unknown or missing key`, { path, keys: actual });
  }
  return value;
}

function integer(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) {
    throw corrupt(`${path} must be a safe integer at least ${minimum}`, { path });
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  return integer(value, path, 1);
}

function digest(value: unknown, path: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw corrupt(`${path} must be 64 lowercase hex digits`, { path });
  return value;
}

function identity(value: unknown, path: string): StemIdentity {
  if (typeof value !== "string") throw corrupt(`${path} must be a stem identity`, { path });
  try {
    assertStemIdentity(value);
  } catch (error) {
    throw corrupt(`${path} must be sha256 followed by 64 lowercase hex digits`, { path, cause: String(error) });
  }
  return value;
}

function sourceShape(value: unknown, index: number, offsetBase = 0): SparseStemSource {
  const path = `sources[${index}]`;
  const source = exactObject(value, ["bitDepth", "channels", "frames", "identity", "sampleRateHz", "units"], path);
  const sampleRateHz = integer(source.sampleRateHz, `${path}.sampleRateHz`, 1);
  if (!(SAMPLE_RATES as readonly number[]).includes(sampleRateHz)) {
    throw corrupt(`${path}.sampleRateHz is not a launch-supported rate`, { sampleRateHz });
  }
  const channels = integer(source.channels, `${path}.channels`, 1);
  if (channels !== 1 && channels !== 2) throw corrupt(`${path}.channels must be 1 or 2`, { channels });
  const bitDepth = integer(source.bitDepth, `${path}.bitDepth`, 1);
  if (bitDepth !== 16 && bitDepth !== 24) throw corrupt(`${path}.bitDepth must be 16 or 24`, { bitDepth });
  const frames = positiveInteger(source.frames, `${path}.frames`);
  const canonicalBytes = frames * channels * (bitDepth / 8);
  if (!Number.isSafeInteger(canonicalBytes)) throw corrupt(`${path} canonical byte arithmetic is unsafe`, { path });
  if (!Array.isArray(source.units)) throw corrupt(`${path}.units must be an array`, { path });
  const units: SparseStemUnit[] = [];
  let previousStart = -1;
  let previousEnd = 0;
  let expectedOffset = offsetBase;
  for (let unitIndex = 0; unitIndex < source.units.length; unitIndex += 1) {
    const unitPath = `${path}.units[${unitIndex}]`;
    const raw = exactObject(
      source.units[unitIndex],
      ["bytes", "flacSha256", "frames", "offset", "pcmSha256", "startFrame"],
      unitPath,
    );
    const startFrame = integer(raw.startFrame, `${unitPath}.startFrame`, 0);
    const unitFrames = positiveInteger(raw.frames, `${unitPath}.frames`);
    const offset = integer(raw.offset, `${unitPath}.offset`, 0);
    const bytes = positiveInteger(raw.bytes, `${unitPath}.bytes`);
    if (bytes > SPARSE_STEM_MAX_UNIT_BYTES) {
      throw corrupt(`${unitPath}.bytes exceeds the compressed unit limit`, { bytes, limit: SPARSE_STEM_MAX_UNIT_BYTES });
    }
    if (unitFrames > sampleRateHz) {
      throw corrupt(`${unitPath}.frames exceeds one second at the source rate`, { unitFrames, sampleRateHz });
    }
    const endFrame = startFrame + unitFrames;
    if (!Number.isSafeInteger(endFrame) || endFrame > frames) {
      throw corrupt(`${unitPath} lies outside its source timeline`, { startFrame, unitFrames, sourceFrames: frames });
    }
    if (startFrame <= previousStart || startFrame < previousEnd) {
      throw corrupt(`${path}.units must be sorted and non-overlapping`, { path, unitIndex });
    }
    if (offset !== expectedOffset) {
      throw corrupt(`${unitPath}.offset does not exactly cover the packed payload`, { offset, expectedOffset });
    }
    const nextOffset = offset + bytes;
    if (!Number.isSafeInteger(nextOffset)) throw corrupt(`${unitPath} offset arithmetic is unsafe`, { path: unitPath });
    expectedOffset = nextOffset;
    previousStart = startFrame;
    previousEnd = endFrame;
    units.push(Object.freeze({
      startFrame,
      frames: unitFrames,
      offset,
      bytes,
      flacSha256: digest(raw.flacSha256, `${unitPath}.flacSha256`),
      pcmSha256: digest(raw.pcmSha256, `${unitPath}.pcmSha256`),
    }));
  }
  return Object.freeze({
    identity: identity(source.identity, `${path}.identity`),
    sampleRateHz,
    channels: channels as 1 | 2,
    bitDepth: bitDepth as 16 | 24,
    frames,
    units: Object.freeze(units),
  });
}

function normalizeManifest(value: unknown, payloadBytes?: number): SparseStemManifest {
  const root = exactObject(value, ["format", "sources"], "index");
  if (root.format !== SPARSE_STEM_FORMAT) throw corrupt("Sparse package format tag is unsupported", { format: root.format });
  if (!Array.isArray(root.sources) || root.sources.length < 1 || root.sources.length > SPARSE_STEM_MAX_SOURCES) {
    throw corrupt("Sparse package sources must contain between one and 1024 sources");
  }
  if (root.sources.length === 0) throw corrupt("Sparse package sources cannot be empty");
  let remainingUnits = SPARSE_STEM_MAX_UNITS;
  for (let sourceIndex = 0; sourceIndex < root.sources.length; sourceIndex += 1) {
    const rawSource = root.sources[sourceIndex];
    if (!isRecord(rawSource) || !Array.isArray(rawSource.units)) {
      throw corrupt(`sources[${sourceIndex}].units must be an array`);
    }
    if (rawSource.units.length > remainingUnits) {
      throw corrupt("Sparse package contains too many units", { limit: SPARSE_STEM_MAX_UNITS });
    }
    remainingUnits -= rawSource.units.length;
  }
  const sources: SparseStemSource[] = [];
  let previousIdentity = "";
  let payloadEnd = 0;
  for (let sourceIndex = 0; sourceIndex < root.sources.length; sourceIndex += 1) {
    const source = sourceShape(root.sources[sourceIndex], sourceIndex, payloadEnd);
    sources.push(source);
    if (source.identity <= previousIdentity) throw corrupt("Sparse package sources must be unique and sorted by identity");
    previousIdentity = source.identity;
    if (source.units.length > 0) {
      const last = source.units[source.units.length - 1]!;
      payloadEnd = last.offset + last.bytes;
    }
  }
  if (payloadBytes !== undefined) {
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || payloadBytes !== payloadEnd) {
      throw corrupt("Sparse package payload length does not match its unit offsets", { payloadBytes, expected: payloadEnd });
    }
  } else if (payloadEnd < 0 || !Number.isSafeInteger(payloadEnd)) {
    throw corrupt("Sparse package payload size is unsafe", { payloadEnd });
  }
  return Object.freeze({ format: SPARSE_STEM_FORMAT, sources: Object.freeze(sources) });
}

function canonicalObject(manifest: SparseStemManifest): Record<string, unknown> {
  return {
    format: manifest.format,
    sources: manifest.sources.map((source) => ({
      bitDepth: source.bitDepth,
      channels: source.channels,
      frames: source.frames,
      identity: source.identity,
      sampleRateHz: source.sampleRateHz,
      units: source.units.map((unit) => ({
        bytes: unit.bytes,
        flacSha256: unit.flacSha256,
        frames: unit.frames,
        offset: unit.offset,
        pcmSha256: unit.pcmSha256,
        startFrame: unit.startFrame,
      })),
    })),
  };
}

function canonicalBytes(manifest: SparseStemManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalObject(manifest)));
}

function payloadSize(payload: SparsePayload): number {
  if (payload instanceof Blob) return payload.size;
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  if (ArrayBuffer.isView(payload)) return payload.byteLength;
  throw declaration("Sparse package payload must be a Blob or byte buffer");
}

function payloadBlob(payload: SparsePayload): Blob {
  if (payload instanceof Blob) return payload;
  const bytes = payload instanceof ArrayBuffer
    ? new Uint8Array(payload)
    : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return new Blob([copy.buffer]);
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}

export type SparsePayload = Blob | ArrayBuffer | ArrayBufferView;

/** Validate a manifest and return a deeply immutable contract value. */
export function validateSparseStemManifest(value: unknown, payloadBytes?: number): SparseStemManifest {
  const manifest = normalizeManifest(value, payloadBytes);
  const encoded = canonicalBytes(manifest);
  if (encoded.byteLength === 0 || encoded.byteLength > SPARSE_STEM_MAX_INDEX_BYTES) {
    throw corrupt("Sparse package index exceeds its bounded size", { bytes: encoded.byteLength, limit: SPARSE_STEM_MAX_INDEX_BYTES });
  }
  return manifest;
}

/** Return the exact canonical UTF-8 index bytes used by the package header. */
export function serializeSparseStemIndex(value: unknown): Uint8Array {
  const manifest = validateSparseStemManifest(value);
  return canonicalBytes(manifest);
}

/** Build one package without reading its payload into a temporary buffer. */
export function serializeSparseStemPackage(value: unknown, payload: SparsePayload = new Uint8Array()): Blob {
  const size = payloadSize(payload);
  const manifest = validateSparseStemManifest(value, size);
  const index = canonicalBytes(manifest);
  const dataStart = SPARSE_STEM_HEADER_BYTES + index.byteLength;
  const objectBytes = dataStart + size;
  if (!Number.isSafeInteger(objectBytes) || objectBytes > SPARSE_STEM_MAX_OBJECT_BYTES) {
    throw corrupt("Sparse package exceeds its bounded object size", { objectBytes, limit: SPARSE_STEM_MAX_OBJECT_BYTES });
  }
  const header = new Uint8Array(SPARSE_STEM_HEADER_BYTES);
  header.set(new TextEncoder().encode(SPARSE_STEM_MAGIC), 0);
  new DataView(header.buffer).setUint32(8, index.byteLength, true);
  return new Blob([ownedBuffer(header), ownedBuffer(index), payloadBlob(payload)]);
}

/** Parse only the package header and admitted index; compressed units are never read here. */
export async function parseSparseStemPackage(blob: Blob): Promise<ParsedSparseStemPackage> {
  if (!(blob instanceof Blob)) throw declaration("Sparse package input must be a Blob");
  if (!Number.isSafeInteger(blob.size) || blob.size < SPARSE_STEM_HEADER_BYTES || blob.size > SPARSE_STEM_MAX_OBJECT_BYTES) {
    throw corrupt("Sparse package object size is outside its bounded range", { bytes: blob.size });
  }
  const header = new Uint8Array(await blob.slice(0, SPARSE_STEM_HEADER_BYTES).arrayBuffer());
  if (header.byteLength !== SPARSE_STEM_HEADER_BYTES) throw corrupt("Sparse package header is truncated");
  const magic = new TextDecoder("ascii").decode(header.subarray(0, 8));
  if (magic !== SPARSE_STEM_MAGIC) throw corrupt("Sparse package magic/version is invalid", { magic });
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(12, true) !== 0) throw corrupt("Sparse package reserved header bytes are nonzero");
  const indexBytes = view.getUint32(8, true);
  if (indexBytes < 1 || indexBytes > SPARSE_STEM_MAX_INDEX_BYTES) {
    throw corrupt("Sparse package index length is outside its bounded range", { indexBytes });
  }
  const dataStart = SPARSE_STEM_HEADER_BYTES + indexBytes;
  if (dataStart > blob.size) throw corrupt("Sparse package index is truncated", { indexBytes, objectBytes: blob.size });
  const encoded = new Uint8Array(await blob.slice(SPARSE_STEM_HEADER_BYTES, dataStart).arrayBuffer());
  if (encoded.byteLength !== indexBytes) throw corrupt("Sparse package index read is truncated");
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)) as unknown;
  } catch (error) {
    throw corrupt("Sparse package index is not valid fatal UTF-8 JSON", { cause: String(error) });
  }
  const manifest = validateSparseStemManifest(decoded, blob.size - dataStart);
  const canonical = canonicalBytes(manifest);
  if (canonical.byteLength !== encoded.byteLength || canonical.some((byte, index) => byte !== encoded[index])) {
    throw corrupt("Sparse package index is not the exact canonical encoding");
  }
  return Object.freeze({ manifest, dataStart, payloadBytes: blob.size - dataStart });
}

function expectationShape(value: SparseSessionSourceExpectation): SparseSessionSourceShape {
  if (!isRecord(value)) throw declaration("Session source expectation must be an object");
  if ("source" in value) {
    const declared = value as unknown as SparseSessionDeclaredSource;
    const spec = declared.source.spec;
    if (spec.bitDepth === "32f") throw declaration("Sparse package cannot bind a 32-bit float source");
    assertStemIdentity(spec.content);
    return {
      identity: spec.content as StemIdentity,
      sampleRateHz: declared.sampleRateHz,
      channels: spec.channels,
      bitDepth: spec.bitDepth,
      frames: spec.frames,
    };
  }
  return value;
}

/** Check exact identity and shape equality against the authoritative session source set. */
export function assertSparseStemSessionBinding(
  manifestOrParsed: SparseStemManifest | ParsedSparseStemPackage,
  expected: readonly SparseSessionSourceExpectation[],
): void {
  const manifest = "manifest" in manifestOrParsed ? manifestOrParsed.manifest : manifestOrParsed;
  if (expected.length !== manifest.sources.length) throw declaration("Sparse package source set does not match the session", {
    expected: expected.length,
    actual: manifest.sources.length,
  });
  const seen = new Set<string>();
  for (const item of expected) {
    const shape = expectationShape(item);
    assertStemIdentity(shape.identity);
    if (seen.has(shape.identity)) throw declaration("Session source identities must be unique", { identity: shape.identity });
    seen.add(shape.identity);
    const source = manifest.sources.find((candidate) => candidate.identity === shape.identity);
    if (source === undefined) throw declaration("Sparse package is missing a session source", { identity: shape.identity });
    if (
      source.sampleRateHz !== shape.sampleRateHz || source.channels !== shape.channels ||
      source.bitDepth !== shape.bitDepth || !sameFrames(source.frames, shape.frames)
    ) {
      throw declaration("Sparse package source shape disagrees with the session", {
        identity: shape.identity,
        expected: shape,
        actual: source,
      });
    }
  }
}

function sameFrames(actual: number, expected: number | bigint): boolean {
  if (typeof expected === "bigint") return BigInt(actual) === expected;
  return Number.isSafeInteger(expected) && actual === expected;
}
