import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";

import { EngineWebAdapterError } from "../errors.js";
import { assertStemIdentity } from "./identity.js";
import { canonicalJsonBytes } from "./canonical-json.js";
import { deadline, IncrementalSha256 } from "./sha256.js";
import { OpfsStorageBackend } from "./storage.js";
import type { StemStorageBackend, StemStorageWriter } from "./storage.js";
import { sharedFor, withNamedLock, type SharedLockState, type WebLockProvider } from "./lock.js";
import {
  SPARSE_PCM_FORMAT,
  SPARSE_PCM_MAX_INDEX_BYTES,
  SPARSE_PCM_MAX_INTERVALS,
  validateSparsePcmIndex,
  type SparsePcmIndex,
  type SparsePcmInterval,
} from "./sparse-pcm.js";
import type { StemIdentity } from "./types.js";

const MAX_MARKER_BYTES = 8 * 1024 * 1024;
const MAX_SPAN_BYTES = 128 * 1024;
const ZERO_BLOCK = new Uint8Array(64 * 1024);
const MARKER_TAG = "miso_sparse_pcm_commit_v1" as const;

export interface SparsePcmExpectation {
  readonly identity: StemIdentity;
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frames: number;
  readonly canonicalBytes: number;
}

export interface SparsePcmSpan { readonly startFrame: number; readonly bytes: Uint8Array }
export interface SparsePcmResolved {
  readonly spans: AsyncIterable<SparsePcmSpan>;
  readonly index?: SparsePcmIndex;
}
export interface SparsePcmDescriptor {
  readonly kind: "sparse-pcm";
  readonly data: Blob;
  readonly index: SparsePcmIndex;
}
export interface SparsePcmInstallOptions {
  readonly resolve: (signal: AbortSignal) => Promise<SparsePcmResolved>;
  readonly signal?: AbortSignal;
}
export interface SparsePcmStoreOptions {
  readonly backend?: StemStorageBackend;
  readonly locks?: WebLockProvider;
  readonly instanceId?: string;
  readonly readDeadlineMs?: number;
}

class SparseBoundaryError extends Schema.TaggedError<SparseBoundaryError>()("SparseBoundaryError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
}) {}
class SparseCorruptError extends Schema.TaggedError<SparseCorruptError>()("SparseCorruptError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
}) {}
class SparseIoError extends Schema.TaggedError<SparseIoError>()("SparseIoError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

const ExpectedSchema = Schema.Struct({
  identity: Schema.String,
  sampleRateHz: Schema.Number,
  channels: Schema.Literals([1, 2]),
  bitDepth: Schema.Literals([16, 24]),
  frames: Schema.Number,
  canonicalBytes: Schema.Number,
});
const decodeExpected = Schema.decodeUnknownEffect(ExpectedSchema, { onExcessProperty: "error" });

interface SparseBackendShape {
  readonly open: () => Promise<void>;
  readonly exists: (name: string) => Promise<boolean>;
  readonly read: (name: string) => Promise<Blob>;
  readonly createWriter: (name: string, signal?: AbortSignal) => Promise<StemStorageWriter>;
  readonly remove: (name: string) => Promise<void>;
  readonly lock: { readonly locks?: WebLockProvider; readonly shared: SharedLockState; readonly folderName: string };
  readonly nextGeneration: () => string;
  readonly readDeadlineMs: number;
}

class SparseBackend extends Context.Service<SparseBackend, { readonly raw: SparseBackendShape }>()("engine-web/SparseBackend") {
  static layer(backend: StemStorageBackend, lock: SparseBackendShape["lock"], nextGeneration: () => string, readDeadlineMs: number): Layer.Layer<SparseBackend> {
    return Layer.succeed(this, this.of({ raw: {
      open: () => backend.open(),
      exists: (name) => backend.exists(name),
      read: (name) => backend.read(name),
      createWriter: (name, signal) => backend.createWriter(name, signal),
      remove: (name) => backend.remove(name),
      lock,
      nextGeneration,
      readDeadlineMs,
    } }));
  }
}

interface SparseProgramShape {
  readonly openSource: (expected: SparsePcmExpectation, signal?: AbortSignal) => Effect.Effect<SparsePcmDescriptor | undefined, SparseBoundaryError | SparseCorruptError | SparseIoError>;
  readonly installSource: (expected: SparsePcmExpectation, options: SparsePcmInstallOptions) => Effect.Effect<SparsePcmDescriptor, SparseBoundaryError | SparseCorruptError | SparseIoError>;
}

class SparseProgram extends Context.Service<SparseProgram, SparseProgramShape>()("engine-web/SparseProgram") {
  static layer: Layer.Layer<SparseProgram, never, SparseBackend> = Layer.effect(
    this,
    Effect.gen(function*() {
      const backend = yield* SparseBackend;
      const openSource = Effect.fn("SparseProgram.openSource")(function*(expected: SparsePcmExpectation, signal?: AbortSignal) {
        const checked = yield* decodeExpected(expected).pipe(
          Effect.mapError((cause) => new SparseBoundaryError({ message: "Sparse PCM expectation schema is invalid", cause })),
        );
        const normalized = yield* Effect.try({
          try: () => normalizeExpectation(checked),
          catch: (cause) => new SparseBoundaryError({ message: "Sparse PCM expectation is invalid", cause }),
        });
        return yield* Effect.tryPromise({
          try: (effectSignal) => openRaw(backend.raw, normalized, signal ?? effectSignal),
          catch: (cause) => classifyEffectFailure(cause),
        });
      });
      const installSource = Effect.fn("SparseProgram.installSource")(function*(expected: SparsePcmExpectation, options: SparsePcmInstallOptions) {
        const checked = yield* decodeExpected(expected).pipe(
          Effect.mapError((cause) => new SparseBoundaryError({ message: "Sparse PCM expectation schema is invalid", cause })),
        );
        const normalized = yield* Effect.try({
          try: () => normalizeExpectation(checked),
          catch: (cause) => new SparseBoundaryError({ message: "Sparse PCM expectation is invalid", cause }),
        });
        if (typeof options?.resolve !== "function") return yield* new SparseBoundaryError({ message: "Sparse PCM install needs a resolve callback" });
        return yield* Effect.tryPromise({
          try: (effectSignal) => installRaw(backend.raw, normalized, options, signalOr(effectSignal, options.signal)),
          catch: (cause) => classifyEffectFailure(cause),
        });
      });
      return SparseProgram.of({ openSource, installSource });
    }),
  );
}

export class VerifiedSparsePcmStore {
  readonly #backend: StemStorageBackend;
  readonly #locks: WebLockProvider | undefined;
  readonly #shared: SharedLockState;
  readonly #folderName: string;
  readonly #instanceId: string;
  readonly #readDeadlineMs: number;
  readonly #runtime: ManagedRuntime.ManagedRuntime<SparseProgram, never>;
  #generation = 0;
  #closed = false;

  constructor(options: SparsePcmStoreOptions = {}) {
    const backend = options.backend ?? defaultBackend();
    this.#backend = backend;
    this.#locks = options.locks ?? browserLocks();
    this.#shared = sharedFor(backend);
    this.#folderName = backend.folderName ?? "miso-engine-web-stems-v1";
    this.#instanceId = options.instanceId ?? randomInstanceId();
    this.#readDeadlineMs = positiveDeadline(options.readDeadlineMs ?? 30_000);
    const lock = {
      ...(this.#locks === undefined ? {} : { locks: this.#locks }),
      shared: this.#shared,
      folderName: this.#folderName,
    };
    this.#runtime = ManagedRuntime.make(SparseProgram.layer.pipe(Layer.provide(SparseBackend.layer(backend, lock, () => this.#nextGeneration(), this.#readDeadlineMs))));
  }

  async openSource(expected: SparsePcmExpectation, options: { readonly signal?: AbortSignal } = {}): Promise<SparsePcmDescriptor | undefined> {
    this.assertOpen();
    try {
      return await this.#runtime.runPromise(SparseProgram.use((program) => program.openSource(expected, options.signal)));
    } catch (error) { throw mapPublicError(error); }
  }

  async installSource(expected: SparsePcmExpectation, options: SparsePcmInstallOptions): Promise<SparsePcmDescriptor> {
    this.assertOpen();
    try {
      return await this.#runtime.runPromise(SparseProgram.use((program) => program.installSource(expected, options)));
    } catch (error) { throw mapPublicError(error); }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#runtime.dispose();
  }

  #nextGeneration(): string {
    this.#generation += 1;
    return `${safeFilePart(this.#instanceId)}-${this.#generation}`;
  }

  private assertOpen(): void { if (this.#closed) throw new EngineWebAdapterError("session.closed", "Sparse PCM store is closed"); }
}

function signalOr(effectSignal: AbortSignal, requested: AbortSignal | undefined): AbortSignal {
  return requested ?? effectSignal;
}

function defaultBackend(): StemStorageBackend { return new OpfsStorageBackend(); }

function browserLocks(): WebLockProvider | undefined {
  return globalThis.navigator?.locks as unknown as WebLockProvider | undefined;
}

function randomInstanceId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  return id === undefined ? "sparse-store" : id.replaceAll("-", "");
}

function positiveDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("readDeadlineMs must be a positive safe integer");
  return value;
}

function safeFilePart(value: string): string {
  const part = value.replace(/[^a-zA-Z0-9_-]/gu, "_");
  if (part.length === 0 || part.length > 128) throw new RangeError("instanceId cannot form a bounded file name");
  return part;
}

function normalizeExpectation(value: { readonly identity: string; readonly sampleRateHz: number; readonly channels: 1 | 2; readonly bitDepth: 16 | 24; readonly frames: number; readonly canonicalBytes: number }): SparsePcmExpectation {
  assertStemIdentity(value.identity);
  if (!Number.isSafeInteger(value.sampleRateHz) || value.sampleRateHz <= 0) throw new RangeError("sampleRateHz must be positive");
  if (!Number.isSafeInteger(value.frames) || value.frames <= 0) throw new RangeError("frames must be positive");
  const frameBytes = value.channels * (value.bitDepth / 8);
  const canonicalBytes = value.frames * frameBytes;
  if (!Number.isSafeInteger(canonicalBytes) || value.canonicalBytes !== canonicalBytes) throw new RangeError("canonicalBytes disagrees with PCM shape");
  return Object.freeze({ ...value, identity: value.identity as StemIdentity });
}

function identityHex(identity: StemIdentity): string { return identity.slice("sha256:".length); }
function markerName(identity: StemIdentity): string { return `sparse-pcm-v1-commit-${identityHex(identity)}.json`; }
function payloadName(identity: StemIdentity, generation: string): string { return `sparse-pcm-v1-data-${identityHex(identity)}-${safeFilePart(generation)}`; }

async function openRaw(backend: SparseBackendShape, expected: SparsePcmExpectation, signal: AbortSignal): Promise<SparsePcmDescriptor | undefined> {
  await bounded(backend, backend.open(), signal);
  const name = markerName(expected.identity);
  return withSourceLock(backend, expected.identity, expected, signal, async () => {
    if (!(await bounded(backend, backend.exists(name), signal))) return undefined;
    const marker = await readMarker(backend, name, signal);
    const descriptor = await verifyMarker(backend, marker, expected, signal);
    return descriptor;
  });
}

async function installRaw(backend: SparseBackendShape, expected: SparsePcmExpectation, options: SparsePcmInstallOptions, signal: AbortSignal): Promise<SparsePcmDescriptor> {
  await bounded(backend, backend.open(), signal);
  return withSourceLock(backend, expected.identity, expected, signal, async () => {
    const marker = markerName(expected.identity);
    if (await bounded(backend, backend.exists(marker), signal)) {
      const committed = await verifyMarker(backend, await readMarker(backend, marker, signal), expected, signal);
      return committed;
    }
    signal.throwIfAborted();
    const resolved = await options.resolve(signal);
    if (!isRecord(resolved) || typeof (resolved.spans as { readonly [Symbol.asyncIterator]?: unknown } | undefined)?.[Symbol.asyncIterator] !== "function") {
      throw new EngineWebAdapterError("stem.corrupt", "Sparse resolver did not return an AsyncIterable");
    }
    const asserted = resolved.index === undefined ? undefined : validateSparsePcmIndex(resolved.index);
    if (asserted !== undefined) compareIndexShape(asserted, expected);
    const generation = safeFilePart(backend.nextGeneration());
    const dataFile = payloadName(expected.identity, generation);
    let writer: StemStorageWriter | undefined;
    let markerWriter: StemStorageWriter | undefined;
    let markerPublished = false;
    try {
      writer = await bounded(backend, backend.createWriter(dataFile, signal), signal);
      const accumulated = await consumeSpans(writer, resolved.spans, expected, signal, backend.readDeadlineMs);
      if (asserted !== undefined) compareIndexes(asserted, accumulated.index);
      if (accumulated.index.activeBytes > SPARSE_PCM_MAX_INDEX_BYTES * 1024) {
        throw new EngineWebAdapterError("stem.corrupt", "Sparse active payload exceeds bounded admission");
      }
      await bounded(backend, writer.close(), signal);
      writer = undefined;
      const markerValue = makeMarker(expected, accumulated.index, dataFile, generation);
      const markerBytes = canonicalJsonBytes(markerValue);
      if (markerBytes.byteLength > MAX_MARKER_BYTES) throw new EngineWebAdapterError("stem.corrupt", "Sparse commit marker exceeds its bounded size");
      signal.throwIfAborted();
      markerWriter = await bounded(backend, backend.createWriter(marker, signal), signal);
      await bounded(backend, markerWriter.write(markerBytes), signal);
      await bounded(backend, markerWriter.close(), signal);
      markerWriter = undefined;
      markerPublished = true;
      signal.throwIfAborted();
      const data = await bounded(backend, backend.read(dataFile), signal);
      return Object.freeze({ kind: "sparse-pcm", data, index: accumulated.index });
    } catch (error) {
      await writer?.abort(error).catch(() => undefined);
      await markerWriter?.abort(error).catch(() => undefined);
      if (markerPublished) await deadline(backend.remove(marker), backend.readDeadlineMs).catch(() => undefined);
      await deadline(backend.remove(dataFile), backend.readDeadlineMs).catch(() => undefined);
      throw error;
    } finally {
      // The resolver sees the same signal as backend I/O. Return is attempted
      // only after any owned writer has physically aborted/settled.
      // consumeSpans owns and closes the pull iterator before returning.
    }
  });
}

async function bounded<T>(backend: SparseBackendShape, operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return deadline(operation, backend.readDeadlineMs, signal);
}

async function withSourceLock<T>(backend: SparseBackendShape, identity: StemIdentity, _expected: SparsePcmExpectation, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return withNamedLock(backend.lock.locks, backend.lock.shared, `miso:engine-web:v1:stem:${identityHex(identity)}`, signal, () =>
    withNamedLock(backend.lock.locks, backend.lock.shared, `miso:stem-store:v1:${backend.lock.folderName}:ingest:${identityHex(identity)}`, signal, work));
}

interface Accumulated { readonly index: SparsePcmIndex; readonly hash: string }

async function consumeSpans(writer: StemStorageWriter, source: AsyncIterable<SparsePcmSpan>, expected: SparsePcmExpectation, signal: AbortSignal, readDeadlineMs: number): Promise<Accumulated> {
  const iterator = source[Symbol.asyncIterator]();
  const hash = new IncrementalSha256();
  const intervals: SparsePcmInterval[] = [];
  const frameBytes = expected.channels * (expected.bitDepth / 8);
  let previousEnd = 0;
  let activeBytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await iterator.next();
      if (next.done) break;
      const span = admitSpan(next.value, expected, previousEnd);
      await hashZeros(hash, (span.startFrame - previousEnd) * frameBytes, signal);
      hash.update(span.bytes);
      await deadline(writer.write(span.bytes), readDeadlineMs, signal);
      const byteOffset = activeBytes;
      activeBytes += span.bytes.byteLength;
      if (!Number.isSafeInteger(activeBytes)) throw new EngineWebAdapterError("stem.corrupt", "Sparse active byte arithmetic is unsafe");
      const prior = intervals[intervals.length - 1];
      if (prior !== undefined && prior.startFrame + prior.frames === span.startFrame) {
        intervals[intervals.length - 1] = Object.freeze({ startFrame: prior.startFrame, frames: prior.frames + span.bytes.byteLength / frameBytes, byteOffset: prior.byteOffset });
      } else {
        if (intervals.length >= SPARSE_PCM_MAX_INTERVALS) throw new EngineWebAdapterError("stem.corrupt", "Sparse interval count exceeds its bound");
        intervals.push(Object.freeze({ startFrame: span.startFrame, frames: span.bytes.byteLength / frameBytes, byteOffset }));
      }
      previousEnd = span.startFrame + span.bytes.byteLength / frameBytes;
    }
    await hashZeros(hash, (expected.frames - previousEnd) * frameBytes, signal);
    const index = validateSparsePcmIndex({ format: SPARSE_PCM_FORMAT, identity: expected.identity, sampleRateHz: expected.sampleRateHz, channels: expected.channels, bitDepth: expected.bitDepth, frames: expected.frames, intervals, activeBytes, canonicalBytes: expected.canonicalBytes }, activeBytes);
    if (index.canonicalBytes !== expected.canonicalBytes || hash.digestHex() !== identityHex(expected.identity)) {
      throw new EngineWebAdapterError("stem.corrupt", "Sparse spans do not match the declared canonical identity or shape");
    }
    return { index, hash: identityHex(expected.identity) };
  } finally {
    await iterator.return?.();
  }
}

function admitSpan(value: unknown, expected: SparsePcmExpectation, previousEnd: number): SparsePcmSpan {
  const decoded = Schema.decodeUnknownSync(Schema.Struct({ startFrame: Schema.Number, bytes: Schema.Uint8Array }), { onExcessProperty: "error" })(value);
  const bytes = decoded.bytes;
  const frameBytes = expected.channels * (expected.bitDepth / 8);
  if (!Number.isSafeInteger(decoded.startFrame) || decoded.startFrame < previousEnd || decoded.startFrame + bytes.byteLength / frameBytes > expected.frames) throw new EngineWebAdapterError("stem.corrupt", "Sparse span overlaps or exceeds the source");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SPAN_BYTES || bytes.byteLength % frameBytes !== 0) throw new EngineWebAdapterError("stem.corrupt", "Sparse span size is not a bounded frame-aligned payload");
  return { startFrame: decoded.startFrame, bytes };
}

async function hashZeros(hash: IncrementalSha256, bytes: number, signal: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new EngineWebAdapterError("stem.corrupt", "Sparse zero-gap arithmetic is unsafe");
  for (let offset = 0; offset < bytes; offset += ZERO_BLOCK.byteLength) {
    signal.throwIfAborted();
    hash.update(ZERO_BLOCK.subarray(0, Math.min(ZERO_BLOCK.byteLength, bytes - offset)));
    await Promise.resolve();
  }
}

async function verifyMarker(backend: SparseBackendShape, marker: Marker, expected: SparsePcmExpectation, signal: AbortSignal): Promise<SparsePcmDescriptor> {
  if (
    marker.format !== MARKER_TAG || marker.identity !== expected.identity ||
    marker.sampleRateHz !== expected.sampleRateHz || marker.channels !== expected.channels ||
    marker.bitDepth !== expected.bitDepth || marker.frames !== expected.frames ||
    marker.canonicalBytes !== expected.canonicalBytes || marker.activeBytes !== marker.index.activeBytes ||
    marker.payloadName !== payloadName(expected.identity, marker.generation)
  ) throw new EngineWebAdapterError("stem.corrupt", "Sparse commit marker conflicts with the expectation");
  compareIndexShape(marker.index, expected);
  const data = await bounded(backend, backend.read(marker.payloadName), signal);
  if (data.size !== marker.activeBytes || data.size !== marker.index.activeBytes) throw new EngineWebAdapterError("stem.corrupt", "Sparse payload length conflicts with its index");
  const hash = new IncrementalSha256();
  let payloadCursor = 0;
  let frameCursor = 0;
  const frameBytes = expected.channels * (expected.bitDepth / 8);
  for (const interval of marker.index.intervals) {
    await hashZeros(hash, (interval.startFrame - frameCursor) * frameBytes, signal);
    for (let offset = 0; offset < interval.frames * frameBytes; offset += MAX_SPAN_BYTES) {
      signal.throwIfAborted();
      const part = new Uint8Array(await data.slice(payloadCursor + offset, payloadCursor + Math.min(offset + MAX_SPAN_BYTES, interval.frames * frameBytes)).arrayBuffer());
      if (part.byteLength === 0) throw new EngineWebAdapterError("stem.corrupt", "Sparse payload read was short");
      hash.update(part);
    }
    payloadCursor += interval.frames * frameBytes;
    frameCursor = interval.startFrame + interval.frames;
  }
  await hashZeros(hash, (expected.frames - frameCursor) * frameBytes, signal);
  if (payloadCursor !== data.size || hash.digestHex() !== identityHex(expected.identity)) throw new EngineWebAdapterError("stem.corrupt", "Sparse payload failed canonical verification");
  return Object.freeze({ kind: "sparse-pcm", data, index: marker.index });
}

interface Marker {
  readonly format: typeof MARKER_TAG;
  readonly identity: StemIdentity;
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frames: number;
  readonly canonicalBytes: number;
  readonly activeBytes: number;
  readonly index: SparsePcmIndex;
  readonly payloadName: string;
  readonly generation: string;
}

function makeMarker(expected: SparsePcmExpectation, index: SparsePcmIndex, payload: string, generation: string): Marker {
  return Object.freeze({ format: MARKER_TAG, identity: expected.identity, sampleRateHz: expected.sampleRateHz, channels: expected.channels, bitDepth: expected.bitDepth, frames: expected.frames, canonicalBytes: expected.canonicalBytes, activeBytes: index.activeBytes, index, payloadName: payload, generation });
}

async function readMarker(backend: SparseBackendShape, name: string, signal: AbortSignal): Promise<Marker> {
  const blob = await bounded(backend, backend.read(name), signal);
  if (!Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > MAX_MARKER_BYTES) throw new EngineWebAdapterError("stem.corrupt", "Sparse commit marker exceeds its bounded size");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  signal.throwIfAborted();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (cause) { throw new EngineWebAdapterError("stem.corrupt", "Sparse commit marker is not canonical JSON", {}, cause); }
  const decoded = Schema.decodeUnknownSync(Schema.Unknown)(value);
  if (!isRecord(decoded)) throw new EngineWebAdapterError("stem.corrupt", "Sparse commit marker is not an object");
  const keys = Object.keys(decoded).sort();
  const required = ["activeBytes", "bitDepth", "canonicalBytes", "channels", "format", "frames", "generation", "identity", "index", "payloadName", "sampleRateHz"];
  if (keys.length !== required.length || keys.some((key, i) => key !== required[i])) throw new EngineWebAdapterError("stem.corrupt", "Sparse commit marker keys are not exact");
  const marker = decoded as unknown as Marker;
  const index = validateSparsePcmIndex(marker.index, marker.activeBytes);
  if (canonicalJsonBytes({ ...marker, index }).byteLength !== bytes.byteLength || !sameBytes(canonicalJsonBytes({ ...marker, index }), bytes)) throw new EngineWebAdapterError("stem.corrupt", "Sparse commit marker is not canonical");
  return Object.freeze({ ...marker, index });
}

function compareIndexShape(index: SparsePcmIndex, expected: SparsePcmExpectation): void {
  if (index.identity !== expected.identity || index.sampleRateHz !== expected.sampleRateHz || index.channels !== expected.channels || index.bitDepth !== expected.bitDepth || index.frames !== expected.frames || index.canonicalBytes !== expected.canonicalBytes) throw new EngineWebAdapterError("stem.invalid_declaration", "Sparse PCM index shape conflicts with the expectation");
}
function compareIndexes(a: SparsePcmIndex, b: SparsePcmIndex): void {
  if (a.activeBytes !== b.activeBytes || a.canonicalBytes !== b.canonicalBytes || a.intervals.length !== b.intervals.length || a.intervals.some((x, i) => x.startFrame !== b.intervals[i]!.startFrame || x.frames !== b.intervals[i]!.frames || x.byteOffset !== b.intervals[i]!.byteOffset)) throw new EngineWebAdapterError("stem.corrupt", "Sparse resolver index disagrees with derived spans");
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean { return a.byteLength === b.byteLength && a.every((value, index) => value === b[index]); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function classifyEffectFailure(cause: unknown): SparseBoundaryError | SparseCorruptError | SparseIoError {
  if (cause instanceof SparseBoundaryError || cause instanceof SparseCorruptError || cause instanceof SparseIoError) return cause;
  if (cause instanceof EngineWebAdapterError && cause.code === "stem.corrupt") return new SparseCorruptError({ message: cause.message, cause });
  return new SparseIoError({ message: cause instanceof Error ? cause.message : "Sparse storage operation failed", cause });
}

function mapPublicError(error: unknown): unknown {
  if (error instanceof EngineWebAdapterError) return error;
  if (error instanceof SparseBoundaryError) return new EngineWebAdapterError("stem.invalid_declaration", error.message, {}, error.cause);
  if (error instanceof SparseCorruptError) return new EngineWebAdapterError("stem.corrupt", error.message, {}, error.cause);
  if (error instanceof SparseIoError) {
    const name = error.cause && typeof error.cause === "object" && "name" in error.cause ? String((error.cause as { readonly name?: unknown }).name) : "";
    return new EngineWebAdapterError(name === "QuotaExceededError" ? "stem.quota" : name === "TimeoutError" ? "stem.read_deadline" : "stem.corrupt", error.message, {}, error.cause);
  }
  if (isAbort(error)) return new EngineWebAdapterError("stem.cancelled", "Sparse PCM operation was cancelled", {}, error);
  return error;
}
function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError" || error instanceof Error && error.name === "AbortError"; }
