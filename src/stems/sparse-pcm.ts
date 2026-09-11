import { EngineWebAdapterError } from "../errors.js";
import {
  SPARSE_STEM_FORMAT,
  validateSparseStemManifest,
  type SparseStemSource,
} from "./sparse-format.js";

export const SPARSE_PCM_FORMAT = "miso_sparse_pcm_v1" as const;
export const SPARSE_PCM_MAX_WINDOW_FRAMES = 8192;
export const SPARSE_PCM_MAX_INTERVALS = 65_536;
export const SPARSE_PCM_MAX_INDEX_BYTES = 8 * 1024 * 1024;

export interface SparsePcmInterval {
  readonly startFrame: number;
  readonly frames: number;
  readonly byteOffset: number;
}

export interface SparsePcmIndex {
  readonly format: typeof SPARSE_PCM_FORMAT;
  readonly identity: SparseStemSource["identity"];
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frames: number;
  readonly intervals: readonly SparsePcmInterval[];
  readonly activeBytes: number;
  readonly canonicalBytes: number;
}

export interface SparsePcmDerivation {
  readonly index: SparsePcmIndex;
  readonly activeBytes: number;
  readonly canonicalBytes: number;
}

export interface SparsePcmIndexDraft {
  readonly format: typeof SPARSE_PCM_FORMAT;
  readonly identity: SparseStemSource["identity"];
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frames: number;
  readonly intervals: readonly SparsePcmInterval[];
  readonly activeBytes?: number;
  readonly canonicalBytes?: number;
}

function corrupt(message: string, details: Readonly<Record<string, unknown>> = {}): EngineWebAdapterError {
  return new EngineWebAdapterError("stem.corrupt", message, details);
}

function integer(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) {
    throw corrupt(`${path} must be a safe integer at least ${minimum}`, { path });
  }
  return value;
}

function bytesPerFrame(source: Pick<SparseStemSource, "channels" | "bitDepth">): number {
  return source.channels * (source.bitDepth / 8);
}

type PackedSize = Blob | ArrayBuffer | ArrayBufferView | number;

const PCM_INDEX_KEYS = [
  "activeBytes", "bitDepth", "canonicalBytes", "channels", "format", "frames", "identity", "intervals", "sampleRateHz",
] as const;
const PCM_INTERVAL_KEYS = ["byteOffset", "frames", "startFrame"] as const;
const ADMITTED = new WeakSet<SparsePcmIndex>();

function packedSize(value: PackedSize): number {
  if (typeof value === "number") return integer(value, "packedBytes", 0);
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  throw corrupt("Packed PCM input must be a Blob or byte buffer");
}

function sourceManifest(source: SparseStemSource): SparseStemSource {
  const baseOffset = source.units[0]?.offset ?? 0;
  const rebased: SparseStemSource = baseOffset === 0
    ? source
    : {
        ...source,
        units: source.units.map((unit) => ({ ...unit, offset: unit.offset - baseOffset })),
      };
  const manifest = validateSparseStemManifest({ format: SPARSE_STEM_FORMAT, sources: [rebased] });
  return manifest.sources[0]!;
}

/** Derive packed PCM offsets from frame shape; compressed unit offsets are ignored. */
export function deriveSparsePcmIndex(source: SparseStemSource, packed: PackedSize = 0): SparsePcmDerivation {
  const valid = sourceManifest(source);
  const frameBytes = bytesPerFrame(valid);
  const canonicalBytes = valid.frames * frameBytes;
  if (!Number.isSafeInteger(canonicalBytes)) throw corrupt("Canonical PCM byte count is unsafe", { frames: valid.frames });
  const intervals: SparsePcmInterval[] = [];
  let activeBytes = 0;
  for (const unit of valid.units) {
    const byteCount = unit.frames * frameBytes;
    if (!Number.isSafeInteger(byteCount) || !Number.isSafeInteger(activeBytes + byteCount)) {
      throw corrupt("Packed PCM byte arithmetic is unsafe", { unit: unit.startFrame });
    }
    const previous = intervals[intervals.length - 1];
    if (previous !== undefined && previous.startFrame + previous.frames === unit.startFrame) {
      intervals[intervals.length - 1] = Object.freeze({
        startFrame: previous.startFrame,
        frames: previous.frames + unit.frames,
        byteOffset: previous.byteOffset,
      });
    } else {
      intervals.push(Object.freeze({ startFrame: unit.startFrame, frames: unit.frames, byteOffset: activeBytes }));
    }
    activeBytes += byteCount;
  }
  const actual = packedSize(packed);
  if (actual !== activeBytes) throw corrupt("Packed PCM payload size does not match the derived intervals", {
    actual,
    expected: activeBytes,
  });
  const index = validateSparsePcmIndex({
    format: SPARSE_PCM_FORMAT,
    identity: valid.identity,
    sampleRateHz: valid.sampleRateHz,
    channels: valid.channels,
    bitDepth: valid.bitDepth,
    frames: valid.frames,
    intervals: Object.freeze(intervals),
  }, packed);
  const actualActiveBytes = index.activeBytes;
  const actualCanonicalBytes = index.canonicalBytes;
  return Object.freeze({ index, activeBytes: actualActiveBytes, canonicalBytes: actualCanonicalBytes });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], path: string): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw corrupt(`${path} has an unknown or missing key`, { path, keys });
  }
}

/** Validate an independently constructed packed-PCM index and derive its byte counts. */
export function validateSparsePcmIndex(value: unknown, packed?: PackedSize): SparsePcmIndex {
  if (!isRecord(value)) throw corrupt("Packed PCM index must be an object");
  exactKeys(value, PCM_INDEX_KEYS, ["bitDepth", "channels", "format", "frames", "identity", "intervals", "sampleRateHz"], "index");
  if (value.format !== SPARSE_PCM_FORMAT) throw corrupt("Packed PCM index format tag is unsupported");
  const identity = value.identity as SparseStemSource["identity"];
  const sampleRateHz = value.sampleRateHz as number;
  const channels = value.channels as 1 | 2;
  const bitDepth = value.bitDepth as 16 | 24;
  const frames = value.frames as number;
  const source: SparseStemSource = {
    identity,
    sampleRateHz,
    channels,
    bitDepth,
    frames,
    units: [],
  };
  sourceManifest(source);
  const frameBytes = bytesPerFrame(source);
  const canonicalBytes = frames * frameBytes;
  if (!Number.isSafeInteger(canonicalBytes)) throw corrupt("Packed PCM canonical byte count is unsafe");
  if (!Array.isArray(value.intervals)) throw corrupt("Packed PCM intervals must be an array");
  if (value.intervals.length > SPARSE_PCM_MAX_INTERVALS) {
    throw corrupt("Packed PCM index contains too many intervals", { limit: SPARSE_PCM_MAX_INTERVALS });
  }
  const intervals: SparsePcmInterval[] = [];
  let intervalMetadataBytes = 0;
  let expectedOffset = 0;
  let previousEnd = 0;
  for (const rawInterval of value.intervals) {
    if (!isRecord(rawInterval)) throw corrupt("Packed PCM interval must be an object");
    exactKeys(rawInterval, PCM_INTERVAL_KEYS, PCM_INTERVAL_KEYS, "interval");
    const startFrame = integer(rawInterval.startFrame, "interval.startFrame", 0);
    const intervalFrames = integer(rawInterval.frames, "interval.frames", 1);
    const byteOffset = integer(rawInterval.byteOffset, "interval.byteOffset", 0);
    if (startFrame < previousEnd || startFrame + intervalFrames > frames) throw corrupt("Packed PCM interval is outside the source timeline");
    if (intervals.length > 0 && startFrame === previousEnd) {
      throw corrupt("Adjacent packed PCM intervals must be coalesced");
    }
    if (byteOffset !== expectedOffset) throw corrupt("Packed PCM offsets are not contiguous");
    const next = byteOffset + intervalFrames * frameBytes;
    if (!Number.isSafeInteger(next)) throw corrupt("Packed PCM offset arithmetic is unsafe");
    expectedOffset = next;
    previousEnd = startFrame + intervalFrames;
    intervalMetadataBytes += new TextEncoder().encode(JSON.stringify({ byteOffset, frames: intervalFrames, startFrame })).byteLength;
    if (!Number.isSafeInteger(intervalMetadataBytes) || intervalMetadataBytes > SPARSE_PCM_MAX_INDEX_BYTES) {
      throw corrupt("Packed PCM index metadata exceeds its bounded size", { limit: SPARSE_PCM_MAX_INDEX_BYTES });
    }
    intervals.push(Object.freeze({ startFrame, frames: intervalFrames, byteOffset }));
  }
  if (value.activeBytes !== undefined && value.activeBytes !== expectedOffset) throw corrupt("Packed PCM active byte count is invalid");
  if (value.canonicalBytes !== undefined && value.canonicalBytes !== canonicalBytes) throw corrupt("Packed PCM canonical byte count is invalid");
  if (packed !== undefined && packedSize(packed) !== expectedOffset) throw corrupt("Packed PCM payload size does not match its index");
  const prefix = `{"activeBytes":${expectedOffset},"bitDepth":${bitDepth},"canonicalBytes":${canonicalBytes},"channels":${channels},"format":${JSON.stringify(SPARSE_PCM_FORMAT)},"frames":${frames},"identity":${JSON.stringify(identity)},"intervals":[`;
  const suffix = `],"sampleRateHz":${sampleRateHz}}`;
  const encodedBytes = new TextEncoder().encode(prefix).byteLength + intervalMetadataBytes +
    Math.max(0, intervals.length - 1) + new TextEncoder().encode(suffix).byteLength;
  if (!Number.isSafeInteger(encodedBytes) || encodedBytes > SPARSE_PCM_MAX_INDEX_BYTES) {
    throw corrupt("Packed PCM index metadata exceeds its bounded size", { bytes: encodedBytes, limit: SPARSE_PCM_MAX_INDEX_BYTES });
  }
  const admitted = Object.freeze({
    format: SPARSE_PCM_FORMAT,
    identity,
    sampleRateHz,
    channels,
    bitDepth,
    frames,
    intervals: Object.freeze(intervals),
    activeBytes: expectedOffset,
    canonicalBytes,
  });
  ADMITTED.add(admitted);
  return admitted;
}

function firstIntersecting(intervals: readonly SparsePcmInterval[], frame: number): number {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const end = intervals[middle]!.startFrame + intervals[middle]!.frames;
    if (end <= frame) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Read one bounded logical PCM window. The caller owns generation checks and
 * physical-read admission; this helper has no background state or cancellation.
 */
export async function readSparsePcmWindow(
  index: SparsePcmIndex,
  packed: Blob,
  startFrame: number,
  frameCount: number,
): Promise<Uint8Array> {
  if (!ADMITTED.has(index)) throw corrupt("Packed PCM index has not been admitted by this module");
  if (!(packed instanceof Blob)) throw corrupt("Packed PCM input must be a Blob");
  const packedBytes = packed.size;
  if (!Number.isSafeInteger(packedBytes) || packedBytes !== index.activeBytes) {
    throw corrupt("Packed PCM payload size does not match its admitted index", { actual: packedBytes, expected: index.activeBytes });
  }
  const valid = index;
  const start = integer(startFrame, "startFrame", 0);
  const count = integer(frameCount, "frameCount", 1);
  if (count > SPARSE_PCM_MAX_WINDOW_FRAMES) throw corrupt("PCM window exceeds its bounded frame count", { count, limit: SPARSE_PCM_MAX_WINDOW_FRAMES });
  if (start + count > valid.frames) throw corrupt("PCM window lies outside the source timeline", { start, count, frames: valid.frames });
  const frameBytes = bytesPerFrame(valid);
  const outputBytes = count * frameBytes;
  if (!Number.isSafeInteger(outputBytes)) throw corrupt("PCM window byte count is unsafe");
  const output = new Uint8Array(outputBytes);
  const first = firstIntersecting(valid.intervals, start);
  if (first >= valid.intervals.length || valid.intervals[first]!.startFrame >= start + count) return output;
  let last = first;
  while (last + 1 < valid.intervals.length && valid.intervals[last + 1]!.startFrame < start + count) last += 1;
  const firstInterval = valid.intervals[first]!;
  const lastInterval = valid.intervals[last]!;
  const firstFrame = Math.max(start, firstInterval.startFrame);
  const lastFrame = Math.min(start + count, lastInterval.startFrame + lastInterval.frames);
  const packedStart = firstInterval.byteOffset + (firstFrame - firstInterval.startFrame) * frameBytes;
  const packedEnd = lastInterval.byteOffset + (lastFrame - lastInterval.startFrame) * frameBytes;
  if (!Number.isSafeInteger(packedStart) || !Number.isSafeInteger(packedEnd) || packedEnd < packedStart) throw corrupt("PCM window packed range is unsafe");
  const source = new Uint8Array(await packed.slice(packedStart, packedEnd).arrayBuffer());
  if (source.byteLength !== packedEnd - packedStart) throw corrupt("Packed PCM window read was short", {
    expected: packedEnd - packedStart,
    actual: source.byteLength,
  });
  for (let index = first; index <= last; index += 1) {
    const interval = valid.intervals[index]!;
    const intersectionStart = Math.max(start, interval.startFrame);
    const intersectionEnd = Math.min(start + count, interval.startFrame + interval.frames);
    if (intersectionEnd <= intersectionStart) continue;
    const sourceOffset = interval.byteOffset + (intersectionStart - interval.startFrame) * frameBytes - packedStart;
    const destinationOffset = (intersectionStart - start) * frameBytes;
    const copyBytes = (intersectionEnd - intersectionStart) * frameBytes;
    output.set(source.subarray(sourceOffset, sourceOffset + copyBytes), destinationOffset);
  }
  return output;
}
