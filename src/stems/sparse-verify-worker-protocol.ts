import type { SparsePcmIndex } from "./sparse-pcm.js";
import type { StemIdentity } from "./types.js";

/** Private wire version; this protocol is intentionally not a public API. */
export const SPARSE_VERIFY_PROTOCOL_VERSION = 1 as const;
export const SPARSE_VERIFY_READ_BYTES = 512 * 1024;
export const SPARSE_VERIFY_ZERO_BYTES = 64 * 1024;
export const SPARSE_VERIFY_MAX_PACKED_BYTES = 256 * 1024;
export const SPARSE_VERIFY_MAX_INTERVALS = Math.floor(SPARSE_VERIFY_MAX_PACKED_BYTES / (3 * Float64Array.BYTES_PER_ELEMENT));

export interface SparseVerifyStart {
  readonly type: "start";
  readonly version: typeof SPARSE_VERIFY_PROTOCOL_VERSION;
  readonly jobId: number;
  readonly generation: number;
  readonly identity: StemIdentity;
  readonly frames: number;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frameBytes: number;
  readonly canonicalBytes: number;
  readonly activeBytes: number;
  readonly intervalCount: number;
  readonly intervals: ArrayBuffer;
  readonly data: Blob;
  readonly readDeadlineMs: number;
}

export interface SparseVerifyProgress {
  readonly type: "progress";
  readonly version: typeof SPARSE_VERIFY_PROTOCOL_VERSION;
  readonly jobId: number;
  readonly generation: number;
  readonly bytes: number;
}

export interface SparseVerifyAck {
  readonly type: "ack";
  readonly version: typeof SPARSE_VERIFY_PROTOCOL_VERSION;
  readonly jobId: number;
  readonly generation: number;
  readonly bytes: number;
}

export interface SparseVerifyCancel {
  readonly type: "cancel";
  readonly version: typeof SPARSE_VERIFY_PROTOCOL_VERSION;
  readonly jobId: number;
  readonly generation: number;
}

export interface SparseVerifyComplete {
  readonly type: "complete";
  readonly version: typeof SPARSE_VERIFY_PROTOCOL_VERSION;
  readonly jobId: number;
  readonly generation: number;
  readonly identity: StemIdentity;
  readonly digest: string;
  /** Terminal progress; supersedes any coalesced progress not yet sent. */
  readonly progressBytes: number;
  readonly canonicalBytes: number;
  readonly readCalls: number;
  readonly readBytes: number;
  readonly hashedBytes: number;
  /** Number of raw hash.update calls, including zero-gap checkpoints. */
  readonly hashUpdates: number;
  /** Number of 64 KiB (or final tail) zero-gap updates. */
  readonly zeroUpdates: number;
  readonly elapsedMs: number;
  readonly readWaitMs: number;
  readonly hashMs: number;
}

export type SparseVerifyFailureKind = "boundary" | "corrupt" | "deadline" | "io" | "cancelled";

export interface SparseVerifyFailure {
  readonly type: "failure";
  readonly version: typeof SPARSE_VERIFY_PROTOCOL_VERSION;
  readonly jobId: number;
  readonly generation: number;
  readonly kind: SparseVerifyFailureKind;
  readonly message: string;
}

export type SparseVerifyWorkerRequest = SparseVerifyStart | SparseVerifyAck | SparseVerifyCancel;
export type SparseVerifyWorkerResponse = SparseVerifyProgress | SparseVerifyComplete | SparseVerifyFailure;

export interface SparseVerifyDecodedStart {
  readonly request: SparseVerifyStart;
  readonly intervals: Float64Array;
}

export interface SparseVerifyExpectedCounts {
  readonly readCalls: number;
  readonly zeroUpdates: number;
  readonly hashUpdates: number;
}

/** Derive the exact bounded accounting expected for one admitted index. */
export function sparseVerifyExpectedCounts(index: SparsePcmIndex, frames: number, frameBytes: number): SparseVerifyExpectedCounts {
  safeInteger(frames, "frames", 1);
  safeInteger(frameBytes, "frameBytes", 1);
  let readCalls = 0;
  let zeroUpdates = 0;
  let previousEnd = 0;
  for (const interval of index.intervals) {
    const gapBytes = (interval.startFrame - previousEnd) * frameBytes;
    const activeBytes = interval.frames * frameBytes;
    if (!Number.isSafeInteger(gapBytes) || gapBytes < 0 || !Number.isSafeInteger(activeBytes) || activeBytes < 1) {
      throw new Error("Sparse verification count arithmetic is invalid");
    }
    zeroUpdates = safeAdd(zeroUpdates, Math.ceil(gapBytes / SPARSE_VERIFY_ZERO_BYTES), "zero update count");
    readCalls = safeAdd(readCalls, Math.ceil(activeBytes / SPARSE_VERIFY_READ_BYTES), "read call count");
    previousEnd = safeAdd(interval.startFrame, interval.frames, "interval frame end");
  }
  const trailingBytes = (frames - previousEnd) * frameBytes;
  if (!Number.isSafeInteger(trailingBytes) || trailingBytes < 0) throw new Error("Sparse verification trailing count arithmetic is invalid");
  zeroUpdates = safeAdd(zeroUpdates, Math.ceil(trailingBytes / SPARSE_VERIFY_ZERO_BYTES), "zero update count");
  return { readCalls, zeroUpdates, hashUpdates: safeAdd(readCalls, zeroUpdates, "hash update count") };
}

export function sparseVerifyWorkerStart(value: unknown): SparseVerifyDecodedStart {
  if (!record(value) || value.type !== "start" || value.version !== SPARSE_VERIFY_PROTOCOL_VERSION) {
    throw new Error("Sparse verification start protocol version or tag is invalid");
  }
  const request = value as unknown as SparseVerifyStart;
  safeInteger(request.jobId, "jobId", 1);
  safeInteger(request.generation, "generation", 1);
  if (!/^blake3:[0-9a-f]{64}$/u.test(request.identity)) throw new Error("Sparse verification identity is invalid");
  safeInteger(request.frames, "frames", 1);
  if (request.channels !== 1 && request.channels !== 2) throw new Error("Sparse verification channels are invalid");
  if (request.bitDepth !== 16 && request.bitDepth !== 24) throw new Error("Sparse verification bit depth is invalid");
  safeInteger(request.frameBytes, "frameBytes", 1);
  if (request.frameBytes !== request.channels * (request.bitDepth / 8)) throw new Error("Sparse verification frame size is invalid");
  safeInteger(request.canonicalBytes, "canonicalBytes", 0);
  if (request.canonicalBytes !== request.frames * request.frameBytes) throw new Error("Sparse verification canonical size is invalid");
  safeInteger(request.activeBytes, "activeBytes", 0);
  safeInteger(request.intervalCount, "intervalCount", 0);
  if (request.intervalCount > SPARSE_VERIFY_MAX_INTERVALS) throw new Error("Sparse verification interval metadata exceeds its bound");
  if (!(request.intervals instanceof ArrayBuffer) || request.intervals.byteLength !== request.intervalCount * 24 || request.intervals.byteLength > SPARSE_VERIFY_MAX_PACKED_BYTES) {
    throw new Error("Sparse verification packed intervals are invalid");
  }
  if (!(request.data instanceof Blob) || !Number.isSafeInteger(request.data.size) || request.data.size !== request.activeBytes) {
    throw new Error("Sparse verification payload is invalid");
  }
  safeInteger(request.readDeadlineMs, "readDeadlineMs", 1);
  const intervals = new Float64Array(request.intervals);
  let previousEnd = 0;
  let expectedOffset = 0;
  for (let index = 0; index < request.intervalCount; index += 1) {
    const offset = index * 3;
    const startFrame = safeInteger(intervals[offset], "interval.startFrame", 0);
    const frames = safeInteger(intervals[offset + 1], "interval.frames", 1);
    const byteOffset = safeInteger(intervals[offset + 2], "interval.byteOffset", 0);
    const endFrame = safeAdd(startFrame, frames, "interval frame end");
    const endOffset = safeAdd(byteOffset, frames * request.frameBytes, "interval byte end");
    if (startFrame < previousEnd || endFrame > request.frames || byteOffset !== expectedOffset) {
      throw new Error("Sparse verification intervals are unordered or outside their bounds");
    }
    previousEnd = endFrame;
    expectedOffset = endOffset;
  }
  if (expectedOffset !== request.activeBytes) throw new Error("Sparse verification active byte total is invalid");
  return { request, intervals };
}

export function sparseVerifyWorkerControl(value: unknown): SparseVerifyAck | SparseVerifyCancel {
  if (!record(value) || (value.type !== "ack" && value.type !== "cancel") || value.version !== SPARSE_VERIFY_PROTOCOL_VERSION) {
    throw new Error("Sparse verification control protocol is invalid");
  }
  const control = value as unknown as SparseVerifyAck | SparseVerifyCancel;
  safeInteger(control.jobId, "jobId", 1);
  safeInteger(control.generation, "generation", 1);
  if (control.type === "ack") safeInteger(control.bytes, "bytes", 0);
  return control;
}

export function sparseVerifyWorkerResponse(value: unknown): SparseVerifyWorkerResponse {
  if (!record(value) || value.version !== SPARSE_VERIFY_PROTOCOL_VERSION ||
    (value.type !== "progress" && value.type !== "complete" && value.type !== "failure")) {
    throw new Error("Sparse verification worker response protocol is invalid");
  }
  const response = value as unknown as SparseVerifyWorkerResponse;
  safeInteger(response.jobId, "jobId", 1);
  safeInteger(response.generation, "generation", 1);
  if (response.type === "progress") {
    safeInteger(response.bytes, "bytes", 0);
  } else if (response.type === "complete") {
    if (!/^blake3:[0-9a-f]{64}$/u.test(response.identity)) throw new Error("Sparse verification completion identity is invalid");
    safeInteger(response.progressBytes, "progressBytes", 0);
    safeInteger(response.canonicalBytes, "canonicalBytes", 0);
    safeInteger(response.readCalls, "readCalls", 0);
    safeInteger(response.readBytes, "readBytes", 0);
    safeInteger(response.hashedBytes, "hashedBytes", 0);
    safeInteger(response.hashUpdates, "hashUpdates", 0);
    safeInteger(response.zeroUpdates, "zeroUpdates", 0);
    finiteNonnegative(response.elapsedMs, "elapsedMs");
    finiteNonnegative(response.readWaitMs, "readWaitMs");
    finiteNonnegative(response.hashMs, "hashMs");
    if (!/^[0-9a-f]{64}$/u.test(response.digest)) throw new Error("Sparse verification digest is invalid");
  } else {
    if (!["boundary", "corrupt", "deadline", "io", "cancelled"].includes(response.kind) || typeof response.message !== "string") {
      throw new Error("Sparse verification worker failure is invalid");
    }
  }
  return response;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, name: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) throw new Error(`Sparse verification ${name} is invalid`);
  return value;
}

function safeAdd(left: number, right: number, name: string): number {
  if (!Number.isSafeInteger(right) || right < 0 || !Number.isSafeInteger(left + right)) throw new Error(`Sparse verification ${name} is invalid`);
  return left + right;
}

function finiteNonnegative(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Sparse verification ${name} is invalid`);
}

/** Pack only an already admitted immutable index; oversized indices use local verification. */
export function packSparseVerifyIntervals(index: SparsePcmIndex): ArrayBuffer | undefined {
  if (index.intervals.length > SPARSE_VERIFY_MAX_INTERVALS) return undefined;
  const packed = new Float64Array(index.intervals.length * 3);
  for (let offset = 0; offset < index.intervals.length; offset += 1) {
    const interval = index.intervals[offset]!;
    packed[offset * 3] = interval.startFrame;
    packed[offset * 3 + 1] = interval.frames;
    packed[offset * 3 + 2] = interval.byteOffset;
  }
  return packed.buffer;
}
