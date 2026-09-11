import { EngineWebAdapterError } from "../errors.js";
import { assertStemIdentity } from "./identity.js";
import type { DeclaredStemSource, StemIdentity } from "./types.js";

export const SPARSE_STEM_FORMAT = "miso_sparse_stem_v1" as const;
export const SPARSE_STEM_MAGIC = "MISOSTM1" as const;
export const SPARSE_STEM_HEADER_BYTES = 16;
export const SPARSE_STEM_MAX_INDEX_BYTES = 8 * 1024 * 1024;
export const SPARSE_STEM_MAX_INTERVALS = 65_536;
export const SPARSE_STEM_MAX_CHUNKS = 65_536;
export const SPARSE_STEM_MAX_CHUNK_BYTES = 32 * 1024 * 1024;
export const SPARSE_STEM_MAX_OBJECT_BYTES = 8 * 1024 * 1024 * 1024;

const SAMPLE_RATES = [44_100, 48_000, 88_200, 96_000] as const;
const DIGEST = /^[0-9a-f]{64}$/u;
const HEADER_MAGIC = new TextEncoder().encode(SPARSE_STEM_MAGIC);
const TEXT_ENCODER = new TextEncoder();

export interface SparseStemInterval {
  readonly startFrame: number;
  readonly frames: number;
  readonly packedFrameOffset: number;
}

export interface SparseStemChunk {
  readonly offset: number;
  readonly bytes: number;
  readonly frames: number;
  readonly packedStartFrame: number;
  readonly flacSha256: string;
  readonly pcmSha256: string;
}

export interface SparseStemManifest {
  readonly format: typeof SPARSE_STEM_FORMAT;
  readonly identity: StemIdentity;
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frames: number;
  readonly intervals: readonly SparseStemInterval[];
  readonly chunks: readonly SparseStemChunk[];
}

export interface ParsedSparseStemPackage {
  readonly manifest: SparseStemManifest;
  readonly dataStart: number;
  readonly payloadBytes: number;
}

export interface SparseStemHeaderAdmission {
  readonly manifestBytes: number;
  readonly payloadStart: number;
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

function exactObject(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value)) throw corrupt(path + " must be an object");
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== keys.length) throw corrupt(path + " has an unknown or missing key", { path, keys: ownKeys });
  const expected = [...keys].sort();
  const actual = [...ownKeys].sort();
  if (actual.some((key, index) => key !== expected[index])) {
    throw corrupt(path + " has an unknown or missing key", { path, keys: actual });
  }
  return value;
}

function integer(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) {
    throw corrupt(path + " must be a safe integer at least " + minimum, { path });
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  return integer(value, path, 1);
}

function digest(value: unknown, path: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw corrupt(path + " must be 64 lowercase hex digits", { path });
  }
  return value;
}

function identity(value: unknown, path: string): StemIdentity {
  if (typeof value !== "string") throw corrupt(path + " must be a stem identity", { path });
  try {
    assertStemIdentity(value);
  } catch (error) {
    throw corrupt(path + " must be sha256 followed by 64 lowercase hex digits", { path, cause: String(error) });
  }
  return value;
}

function bytesPerFrame(value: Pick<SparseStemManifest, "channels" | "bitDepth">): number {
  return value.channels * (value.bitDepth / 8);
}

function checkSum(left: number, right: number, path: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw corrupt(path + " arithmetic is unsafe", { path });
  return sum;
}

function checkProduct(left: number, right: number, path: string): number {
  const product = left * right;
  if (!Number.isSafeInteger(product)) throw corrupt(path + " arithmetic is unsafe", { path });
  return product;
}

function preflightArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) throw corrupt(path + " must be an array", { path });
  if (value.length > maximum) throw corrupt(path + " exceeds its bounded count", { path, limit: maximum });
  return value;
}

function validateManifest(value: unknown, payloadBytes?: number): SparseStemManifest {
  const root = exactObject(
    value,
    ["bitDepth", "channels", "chunks", "format", "frames", "identity", "intervals", "sampleRateHz"],
    "manifest",
  );
  if (root.format !== SPARSE_STEM_FORMAT) {
    throw corrupt("Sparse stem format tag is unsupported", { format: root.format });
  }

  const intervalsRaw = preflightArray(root.intervals, "manifest.intervals", SPARSE_STEM_MAX_INTERVALS);
  const chunksRaw = preflightArray(root.chunks, "manifest.chunks", SPARSE_STEM_MAX_CHUNKS);
  const sampleRateHz = integer(root.sampleRateHz, "manifest.sampleRateHz", 1);
  if (!(SAMPLE_RATES as readonly number[]).includes(sampleRateHz)) {
    throw corrupt("manifest.sampleRateHz is not a launch-supported rate", { sampleRateHz });
  }
  const channels = integer(root.channels, "manifest.channels", 1);
  if (channels !== 1 && channels !== 2) throw corrupt("manifest.channels must be 1 or 2");
  const bitDepth = integer(root.bitDepth, "manifest.bitDepth", 1);
  if (bitDepth !== 16 && bitDepth !== 24) throw corrupt("manifest.bitDepth must be 16 or 24");
  const frames = positiveInteger(root.frames, "manifest.frames");
  const frameBytes = bytesPerFrame({ channels: channels as 1 | 2, bitDepth: bitDepth as 16 | 24 });
  checkProduct(frames, frameBytes, "manifest canonical PCM");
  const sourceIdentity = identity(root.identity, "manifest.identity");

  const intervals: SparseStemInterval[] = [];
  let previousTimelineEnd = -1;
  let expectedPackedFrameOffset = 0;
  for (let index = 0; index < intervalsRaw.length; index += 1) {
    const path = "manifest.intervals[" + index + "]";
    const raw = exactObject(intervalsRaw[index], ["frames", "packedFrameOffset", "startFrame"], path);
    const startFrame = integer(raw.startFrame, path + ".startFrame", 0);
    const intervalFrames = positiveInteger(raw.frames, path + ".frames");
    const packedFrameOffset = integer(raw.packedFrameOffset, path + ".packedFrameOffset", 0);
    const endFrame = checkSum(startFrame, intervalFrames, path + ".timeline");
    if (endFrame > frames) throw corrupt(path + " lies outside the source timeline");
    if (startFrame <= previousTimelineEnd) throw corrupt(path + " overlaps or is adjacent to the previous interval");
    if (packedFrameOffset !== expectedPackedFrameOffset) {
      throw corrupt(path + ".packedFrameOffset is not contiguous", { expected: expectedPackedFrameOffset });
    }
    expectedPackedFrameOffset = checkSum(expectedPackedFrameOffset, intervalFrames, path + ".packed frames");
    previousTimelineEnd = endFrame;
    intervals.push(Object.freeze({ startFrame, frames: intervalFrames, packedFrameOffset }));
  }

  const chunks: SparseStemChunk[] = [];
  let expectedChunkFrame = 0;
  let expectedChunkOffset = 0;
  const maxChunkFrames = checkProduct(sampleRateHz, 30, "manifest chunk frame limit");
  for (let index = 0; index < chunksRaw.length; index += 1) {
    const path = "manifest.chunks[" + index + "]";
    const raw = exactObject(
      chunksRaw[index],
      ["bytes", "flacSha256", "frames", "offset", "packedStartFrame", "pcmSha256"],
      path,
    );
    const offset = integer(raw.offset, path + ".offset", 0);
    const bytes = positiveInteger(raw.bytes, path + ".bytes");
    const chunkFrames = positiveInteger(raw.frames, path + ".frames");
    const packedStartFrame = integer(raw.packedStartFrame, path + ".packedStartFrame", 0);
    if (bytes > SPARSE_STEM_MAX_CHUNK_BYTES) throw corrupt(path + ".bytes exceeds the compressed chunk limit");
    if (chunkFrames > maxChunkFrames) throw corrupt(path + ".frames exceeds the 30 second chunk limit");
    if (packedStartFrame !== expectedChunkFrame) {
      throw corrupt(path + ".packedStartFrame is not contiguous", { expected: expectedChunkFrame });
    }
    if (offset !== expectedChunkOffset) throw corrupt(path + ".offset is not contiguous", { expected: expectedChunkOffset });
    expectedChunkFrame = checkSum(expectedChunkFrame, chunkFrames, path + ".packed frames");
    expectedChunkOffset = checkSum(expectedChunkOffset, bytes, path + ".offset");
    chunks.push(Object.freeze({
      offset,
      bytes,
      frames: chunkFrames,
      packedStartFrame,
      flacSha256: digest(raw.flacSha256, path + ".flacSha256"),
      pcmSha256: digest(raw.pcmSha256, path + ".pcmSha256"),
    }));
  }
  if (expectedChunkFrame !== expectedPackedFrameOffset) {
    throw corrupt("Chunk packed frame endpoint does not equal the active interval endpoint", {
      chunks: expectedChunkFrame,
      intervals: expectedPackedFrameOffset,
    });
  }
  if (payloadBytes !== undefined) {
    integer(payloadBytes, "payloadBytes", 0);
    if (payloadBytes !== expectedChunkOffset) {
      throw corrupt("Payload length does not match the final chunk endpoint", {
        payloadBytes,
        expected: expectedChunkOffset,
      });
    }
  }

  const manifest = Object.freeze({
    format: SPARSE_STEM_FORMAT,
    identity: sourceIdentity,
    sampleRateHz,
    channels: channels as 1 | 2,
    bitDepth: bitDepth as 16 | 24,
    frames,
    intervals: Object.freeze(intervals),
    chunks: Object.freeze(chunks),
  });
  const encoded = canonicalBytes(manifest);
  if (encoded.byteLength < 1 || encoded.byteLength > SPARSE_STEM_MAX_INDEX_BYTES) {
    throw corrupt("Sparse stem manifest exceeds its bounded size", {
      bytes: encoded.byteLength,
      limit: SPARSE_STEM_MAX_INDEX_BYTES,
    });
  }
  return manifest;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
  }
  throw new Error("canonical JSON received an unsupported value");
}

function canonicalBytes(manifest: SparseStemManifest): Uint8Array {
  return TEXT_ENCODER.encode(canonicalJson(manifest));
}

function byteInput(value: Uint8Array | ArrayBuffer | ArrayBufferView, path: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw declaration(path + " must be a byte buffer");
}

function payloadSize(payload: SparsePayload): number {
  if (payload instanceof Blob) return payload.size;
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  if (ArrayBuffer.isView(payload)) return payload.byteLength;
  throw declaration("Sparse stem payload must be a Blob or byte buffer");
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

/** Admit an exactly 16-byte stem header without reading any manifest bytes. */
export function admitSparseStemHeader(input: Uint8Array | ArrayBuffer | ArrayBufferView): SparseStemHeaderAdmission {
  const header = byteInput(input, "Sparse stem header");
  if (header.byteLength !== SPARSE_STEM_HEADER_BYTES) {
    throw corrupt("Sparse stem header must be exactly 16 bytes", { bytes: header.byteLength });
  }
  for (let index = 0; index < HEADER_MAGIC.length; index += 1) {
    if (header[index] !== HEADER_MAGIC[index]) throw corrupt("Sparse stem magic/version is invalid");
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const manifestBytes = view.getUint32(8, true);
  if (manifestBytes < 1 || manifestBytes > SPARSE_STEM_MAX_INDEX_BYTES) {
    throw corrupt("Sparse stem manifest length is outside its bounded range", { manifestBytes, limit: SPARSE_STEM_MAX_INDEX_BYTES });
  }
  if (view.getUint32(12, true) !== 0) throw corrupt("Sparse stem reserved header bytes are nonzero");
  const payloadStart = SPARSE_STEM_HEADER_BYTES + manifestBytes;
  if (!Number.isSafeInteger(payloadStart)) throw corrupt("Sparse stem payload start arithmetic is unsafe");
  return Object.freeze({ manifestBytes, payloadStart });
}

/** Admit exactly the bounded manifest bytes, with an optional known payload length. */
export function admitSparseStemManifest(
  input: Uint8Array | ArrayBuffer | ArrayBufferView,
  payloadBytes?: number,
): SparseStemManifest {
  const encoded = byteInput(input, "Sparse stem manifest");
  if (encoded.byteLength < 1 || encoded.byteLength > SPARSE_STEM_MAX_INDEX_BYTES) {
    throw corrupt("Sparse stem manifest bytes are outside its bounded range", { bytes: encoded.byteLength });
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)) as unknown;
  } catch (error) {
    throw corrupt("Sparse stem manifest is not valid fatal UTF-8 JSON", { cause: String(error) });
  }
  const manifest = validateSparseStemManifest(decoded, payloadBytes);
  const canonical = canonicalBytes(manifest);
  if (canonical.byteLength !== encoded.byteLength || canonical.some((byte, index) => byte !== encoded[index])) {
    throw corrupt("Sparse stem manifest is not the exact canonical encoding");
  }
  return manifest;
}

/** Validate and return a deeply immutable admitted singular manifest. */
export function validateSparseStemManifest(value: unknown, payloadBytes?: number): SparseStemManifest {
  return validateManifest(value, payloadBytes);
}

/** Return the exact canonical UTF-8 manifest bytes used by the header. */
export function serializeSparseStemIndex(value: unknown): Uint8Array {
  return canonicalBytes(validateSparseStemManifest(value));
}

/** Build HEADER || MANIFEST || PAYLOAD without reading the payload into a temporary buffer. */
export function serializeSparseStemPackage(value: unknown, payload: SparsePayload = new Uint8Array()): Blob {
  const size = payloadSize(payload);
  const manifest = validateSparseStemManifest(value, size);
  const index = canonicalBytes(manifest);
  const objectBytes = checkSum(checkSum(SPARSE_STEM_HEADER_BYTES, index.byteLength, "stem object"), size, "stem object");
  if (objectBytes > SPARSE_STEM_MAX_OBJECT_BYTES) {
    throw corrupt("Sparse stem object exceeds its bounded size", { objectBytes, limit: SPARSE_STEM_MAX_OBJECT_BYTES });
  }
  const header = new Uint8Array(SPARSE_STEM_HEADER_BYTES);
  header.set(HEADER_MAGIC);
  new DataView(header.buffer).setUint32(8, index.byteLength, true);
  return new Blob([ownedBuffer(header), ownedBuffer(index), payloadBlob(payload)]);
}

/** Parse exactly the header and manifest; the FLAC payload remains a Blob view. */
export async function parseSparseStemPackage(blob: Blob): Promise<ParsedSparseStemPackage> {
  if (!(blob instanceof Blob)) throw declaration("Sparse stem input must be a Blob");
  if (!Number.isSafeInteger(blob.size) || blob.size < SPARSE_STEM_HEADER_BYTES || blob.size > SPARSE_STEM_MAX_OBJECT_BYTES) {
    throw corrupt("Sparse stem object size is outside its bounded range", { bytes: blob.size });
  }
  const header = new Uint8Array(await blob.slice(0, SPARSE_STEM_HEADER_BYTES).arrayBuffer());
  if (header.byteLength !== SPARSE_STEM_HEADER_BYTES) throw corrupt("Sparse stem header read was short");
  const admission = admitSparseStemHeader(header);
  if (admission.payloadStart > blob.size) {
    throw corrupt("Sparse stem manifest is truncated", { manifestBytes: admission.manifestBytes, objectBytes: blob.size });
  }
  const encoded = new Uint8Array(await blob.slice(SPARSE_STEM_HEADER_BYTES, admission.payloadStart).arrayBuffer());
  if (encoded.byteLength !== admission.manifestBytes) throw corrupt("Sparse stem manifest read was short");
  const manifest = admitSparseStemManifest(encoded, blob.size - admission.payloadStart);
  return Object.freeze({ manifest, dataStart: admission.payloadStart, payloadBytes: blob.size - admission.payloadStart });
}

function expectationShape(value: SparseSessionSourceExpectation): SparseSessionSourceShape {
  if (!isRecord(value)) throw declaration("Session source expectation must be an object");
  if ("source" in value) {
    const declared = value as unknown as SparseSessionDeclaredSource;
    const spec = declared.source.spec;
    if (spec.bitDepth === "32f") throw declaration("Sparse stem cannot bind a 32-bit float source");
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

/** Check exact identity and native shape against one canonical session source. */
export function assertSparseStemSessionBinding(
  manifestOrParsed: SparseStemManifest | ParsedSparseStemPackage,
  expected: SparseSessionSourceExpectation,
): void {
  const candidate = "manifest" in manifestOrParsed ? manifestOrParsed.manifest : manifestOrParsed;
  const manifest = validateSparseStemManifest(candidate);
  const shape = expectationShape(expected);
  assertStemIdentity(shape.identity);
  if (
    manifest.identity !== shape.identity ||
    manifest.sampleRateHz !== shape.sampleRateHz ||
    manifest.channels !== shape.channels ||
    manifest.bitDepth !== shape.bitDepth ||
    !sameFrames(manifest.frames, shape.frames)
  ) {
    throw declaration("Sparse stem identity or shape disagrees with the session source", { expected: shape, actual: manifest });
  }
}

function sameFrames(actual: number, expected: number | bigint): boolean {
  if (typeof expected === "bigint") return BigInt(actual) === expected;
  return Number.isSafeInteger(expected) && actual === expected;
}
