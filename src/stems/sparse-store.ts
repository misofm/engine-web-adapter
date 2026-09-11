import { Context, Effect, Layer, ManagedRuntime, Random, Ref, Schema, Scope, Stream } from "effect";

import { EngineWebAdapterError } from "../errors.js";
import { assertStemIdentity } from "./identity.js";
import { canonicalJsonBytes } from "./canonical-json.js";
import { IncrementalSha256 } from "./sha256.js";
import { OpfsStorageBackend, ownsOpfsWriteDeadlines } from "./storage.js";
import type { StemStorageBackend, StemStorageWriter } from "./storage.js";
import { acquireStemLock, sharedFor, type LockLease, type SharedLockState, type WebLockProvider } from "./lock.js";
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
const SUPPORTED_RATES = [44_100, 48_000, 88_200, 96_000] as const;

export interface SparsePcmExpectation {
  readonly identity: StemIdentity;
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frames: number;
  readonly canonicalBytes: number;
}
export interface SparsePcmSpan { readonly startFrame: number; readonly bytes: Uint8Array }
export interface SparsePcmResolved { readonly spans: AsyncIterable<SparsePcmSpan>; readonly index?: SparsePcmIndex }
export interface SparsePcmDescriptor { readonly kind: "sparse-pcm"; readonly data: Blob; readonly index: SparsePcmIndex }
export interface SparsePcmInstallOptions { readonly resolve: (signal: AbortSignal) => Promise<SparsePcmResolved>; readonly signal?: AbortSignal }
export interface SparsePcmStoreOptions { readonly backend?: StemStorageBackend; readonly locks?: WebLockProvider; readonly instanceId?: string; readonly readDeadlineMs?: number }

class SparseBoundaryError extends Schema.TaggedError<SparseBoundaryError>()("SparseBoundaryError", { message: Schema.String, cause: Schema.optionalKey(Schema.Unknown) }) {}
class SparseCorruptError extends Schema.TaggedError<SparseCorruptError>()("SparseCorruptError", { message: Schema.String, cause: Schema.optionalKey(Schema.Unknown) }) {}
class SparseCancelledError extends Schema.TaggedError<SparseCancelledError>()("SparseCancelledError", { message: Schema.String, cause: Schema.optionalKey(Schema.Unknown) }) {}
class SparseDeadlineError extends Schema.TaggedError<SparseDeadlineError>()("SparseDeadlineError", { message: Schema.String, cause: Schema.optionalKey(Schema.Unknown) }) {}
class SparseQuotaError extends Schema.TaggedError<SparseQuotaError>()("SparseQuotaError", { message: Schema.String, cause: Schema.optionalKey(Schema.Unknown) }) {}
class SparseConflictError extends Schema.TaggedError<SparseConflictError>()("SparseConflictError", { message: Schema.String, cause: Schema.optionalKey(Schema.Unknown) }) {}
class SparseIoError extends Schema.TaggedError<SparseIoError>()("SparseIoError", { message: Schema.String, cause: Schema.optionalKey(Schema.Unknown) }) {}
type SparseFailure = SparseBoundaryError | SparseCorruptError | SparseCancelledError | SparseDeadlineError | SparseQuotaError | SparseConflictError | SparseIoError;

const ExpectedSchema = Schema.Struct({
  identity: Schema.String,
  sampleRateHz: Schema.Number,
  channels: Schema.Literals([1, 2]),
  bitDepth: Schema.Literals([16, 24]),
  frames: Schema.Number,
  canonicalBytes: Schema.Number,
});
const SpanSchema = Schema.Struct({ startFrame: Schema.Number, bytes: Schema.Uint8Array });
const MarkerSchema = Schema.Struct({
  activeBytes: Schema.Number,
  bitDepth: Schema.Literals([16, 24]),
  canonicalBytes: Schema.Number,
  channels: Schema.Literals([1, 2]),
  format: Schema.Literal(MARKER_TAG),
  frames: Schema.Number,
  generation: Schema.String,
  identity: Schema.String,
  index: Schema.Unknown,
  payloadName: Schema.String,
  sampleRateHz: Schema.Number,
});

interface BackendShape {
  readonly open: Effect.Effect<void, SparseFailure>;
  readonly exists: (name: string) => Effect.Effect<boolean, SparseFailure>;
  readonly read: (name: string) => Effect.Effect<Blob, SparseFailure>;
  readonly createWriter: (name: string, signal: AbortSignal) => Effect.Effect<StemStorageWriter, SparseFailure>;
  readonly write: (writer: StemStorageWriter, chunk: Uint8Array | string) => Effect.Effect<void, SparseFailure>;
  readonly close: (writer: StemStorageWriter) => Effect.Effect<void, SparseFailure>;
  readonly abort: (writer: StemStorageWriter, reason: unknown) => Effect.Effect<void, never>;
  readonly remove: (name: string) => Effect.Effect<void, SparseFailure>;
  readonly estimate: Effect.Effect<{ readonly quota?: number; readonly usage?: number }, SparseFailure>;
  readonly lock: { readonly locks?: WebLockProvider; readonly shared: SharedLockState; readonly folderName: string };
  readonly instanceId: string;
  readonly readDeadlineMs: number;
  readonly opfsOwnedDeadlines: boolean;
}

class SparseBackend extends Context.Service<SparseBackend, BackendShape>()("engine-web/SparseBackend") {
  static layer(backend: StemStorageBackend, options: { readonly lock: BackendShape["lock"]; readonly instanceId: string; readonly readDeadlineMs: number }): Layer.Layer<SparseBackend> {
    const fail = (operation: string, cause: unknown): SparseFailure => {
      const name = cause && typeof cause === "object" && "name" in cause ? String((cause as { readonly name?: unknown }).name) : "";
      if (name === "AbortError") return new SparseCancelledError({ message: `${operation} was cancelled`, cause });
      if (name === "TimeoutError") return new SparseDeadlineError({ message: `${operation} exceeded its deadline`, cause });
      if (name === "QuotaExceededError") return new SparseQuotaError({ message: `${operation} exceeded quota`, cause });
      return new SparseIoError({ message: `${operation} failed`, cause });
    };
    const promise = <A>(operation: string, run: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, SparseFailure> => Effect.tryPromise({ try: run, catch: (cause) => fail(operation, cause) });
    const timed = <A>(operation: string, run: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A, SparseFailure> => {
      // OPFS worker generations own their own write deadline. Racing their
      // promises here would abandon a physical handle after interruption.
      const base = promise(operation, run);
      if (ownsOpfsWriteDeadlines(backend, options.readDeadlineMs)) return base;
      return base.pipe(Effect.timeout(options.readDeadlineMs), Effect.catchTag("TimeoutError", () => Effect.fail(new SparseDeadlineError({ message: `${operation} exceeded its deadline` }))));
    };
    return Layer.succeed(this, this.of({
      open: timed("storage open", () => backend.open()),
      exists: (name) => timed("storage exists", () => backend.exists(name)),
      read: (name) => timed("storage read", () => backend.read(name)),
      createWriter: (name, signal) => timed("writer create", (effectSignal) => backend.createWriter(name, signal ?? effectSignal)),
      write: (writer, chunk) => timed("writer write", () => writer.write(chunk)),
      close: (writer) => timed("writer close", () => writer.close()),
      abort: (writer, reason) => Effect.tryPromise({ try: () => writer.abort(reason), catch: (cause) => new SparseIoError({ message: "writer abort failed", cause }) }).pipe(Effect.catch(() => Effect.void)),
      remove: (name) => timed("storage remove", () => backend.remove(name)),
      estimate: timed("storage estimate", () => backend.estimate?.() ?? Promise.resolve({})),
      lock: options.lock,
      instanceId: options.instanceId,
      readDeadlineMs: options.readDeadlineMs,
      opfsOwnedDeadlines: ownsOpfsWriteDeadlines(backend, options.readDeadlineMs),
    }));
  }
}

class SparseCoordination extends Context.Service<SparseCoordination, {
  readonly acquire: (identity: StemIdentity, signal: AbortSignal) => Effect.Effect<LockLease, SparseFailure>;
}>()("engine-web/SparseCoordination") {
  static layer: Layer.Layer<SparseCoordination, never, SparseBackend> = Layer.effect(this, Effect.gen(function*() {
    const backend = yield* SparseBackend;
    const acquire = Effect.fn("SparseCoordination.acquire")(function*(identity: StemIdentity, signal: AbortSignal) {
      return yield* Effect.tryPromise({
        try: () => acquireStemLock(backend.lock, identityHex(identity), signal),
        catch: (cause) => new SparseIoError({ message: "Source lock acquisition failed", cause }),
      });
    });
    return SparseCoordination.of({ acquire });
  }));
}

interface Lifecycle { readonly _tag: "opening" | "streaming" | "data-closed" | "marker-writing" | "committed" | "aborting" | "closed" }
interface OperationState { readonly ref: Ref.Ref<Lifecycle>; readonly signal: AbortSignal; readonly dispose: () => void }

class SparseProgram extends Context.Service<SparseProgram, {
  readonly openSource: (expected: unknown, callerSignal?: AbortSignal) => Effect.Effect<SparsePcmDescriptor | undefined, SparseFailure, ScopeRequirement>;
  readonly installSource: (expected: unknown, options: SparsePcmInstallOptions) => Effect.Effect<SparsePcmDescriptor, SparseFailure, ScopeRequirement>;
}>()("engine-web/SparseProgram") {
  static layer: Layer.Layer<SparseProgram, never, SparseBackend | SparseCoordination | SparseLifecycle> = Layer.effect(this, Effect.gen(function*() {
    const backend = yield* SparseBackend;
    const coordination = yield* SparseCoordination;
    const lifecycle = yield* SparseLifecycle;
    const openSource = Effect.fn("SparseProgram.openSource")(function*(input: unknown, callerSignal?: AbortSignal) {
      const expected = yield* decodeExpected(input);
      const operation = yield* makeOperation(lifecycle.signal, callerSignal);
      yield* Ref.set(operation.ref, { _tag: "opening" } as Lifecycle);
      const lease = yield* Effect.acquireRelease(coordination.acquire(expected.identity, operation.signal), (held) => Effect.promise(() => held.release().catch(() => undefined)), { interruptible: true });
      yield* backend.open;
      const marker = markerName(expected.identity);
      if (!(yield* backend.exists(marker))) {
        operation.dispose();
        return undefined;
      }
      const record = yield* readMarker(backend, marker, operation.signal);
      const descriptor = yield* verifyMarker(backend, record, expected, operation.signal);
      yield* Ref.set(operation.ref, { _tag: "closed" } as Lifecycle);
      yield* Effect.succeed(lease);
      operation.dispose();
      return descriptor;
    });
    const installSource = Effect.fn("SparseProgram.installSource")(function*(input: unknown, options: SparsePcmInstallOptions) {
      const expected = yield* decodeExpected(input);
      if (typeof options?.resolve !== "function") return yield* new SparseBoundaryError({ message: "Sparse PCM install needs a resolve callback" });
      const operation = yield* makeOperation(lifecycle.signal, options.signal);
      const lease = yield* Effect.acquireRelease(coordination.acquire(expected.identity, operation.signal), (held) => Effect.promise(() => held.release().catch(() => undefined)), { interruptible: true });
      yield* backend.open;
      const marker = markerName(expected.identity);
      if (yield* backend.exists(marker)) {
        const descriptor = yield* verifyMarker(backend, yield* readMarker(backend, marker, operation.signal), expected, operation.signal);
        operation.dispose();
        return descriptor;
      }
      const resolved = yield* resolveSource(options.resolve, operation.signal);
      const asserted = yield* admitOptionalIndex(resolved.index, expected);
      const generation = yield* uniqueGeneration(backend, expected.identity);
      const dataName = payloadName(expected.identity, generation);
      const markerValue = yield* ingestAndCommit(backend, expected, resolved.spans, asserted, dataName, generation, operation);
      const descriptor = yield* verifyMarker(backend, markerValue, expected, operation.signal);
      yield* Ref.set(operation.ref, { _tag: "committed" } as Lifecycle);
      operation.dispose();
      return descriptor;
    });
    return SparseProgram.of({ openSource, installSource });
  }));
}

type ScopeRequirement = Scope.Scope;
class SparseLifecycle extends Context.Service<SparseLifecycle, { readonly signal: AbortSignal }>()("engine-web/SparseLifecycle") {}

export class VerifiedSparsePcmStore {
  readonly #runtime: ManagedRuntime.ManagedRuntime<SparseProgram, never>;
  readonly #closedController = new AbortController();
  readonly #active = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(options: SparsePcmStoreOptions = {}) {
    const backend = options.backend ?? new OpfsStorageBackend();
    const locks = options.locks ?? browserLocks();
    const shared = sharedFor(backend);
    const folderName = backend.folderName ?? "miso-engine-web-stems-v1";
    const instanceId = safeFilePart(options.instanceId ?? randomInstanceId());
    const readDeadlineMs = positiveDeadline(options.readDeadlineMs ?? 30_000);
    const lock = { ...(locks === undefined ? {} : { locks }), shared, folderName };
    const lifecycle = Layer.succeed(SparseLifecycle, SparseLifecycle.of({ signal: this.#closedController.signal }));
    const backendLayer = SparseBackend.layer(backend, { lock, instanceId, readDeadlineMs });
    this.#runtime = ManagedRuntime.make(SparseProgram.layer.pipe(Layer.provide(SparseCoordination.layer), Layer.provide(backendLayer), Layer.provide(lifecycle)));
  }

  openSource(expected: SparsePcmExpectation, options: { readonly signal?: AbortSignal } = {}): Promise<SparsePcmDescriptor | undefined> {
    this.assertOpen();
    return this.track(this.#runtime.runPromise(Effect.scoped(SparseProgram.use((program) => program.openSource(expected, options.signal)))));
  }

  installSource(expected: SparsePcmExpectation, options: SparsePcmInstallOptions): Promise<SparsePcmDescriptor> {
    this.assertOpen();
    return this.track(this.#runtime.runPromise(Effect.scoped(SparseProgram.use((program) => program.installSource(expected, options)))));
  }

  async close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = (async () => {
      this.#closedController.abort(new DOMException("Sparse store closed", "AbortError"));
      await Promise.allSettled([...this.#active]);
      await this.#runtime.dispose();
    })();
    return this.#closing;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.catch((error) => { throw mapPublicError(error); });
    this.#active.add(tracked);
    void tracked.then(() => this.#active.delete(tracked), () => this.#active.delete(tracked));
    return tracked;
  }
  private assertOpen(): void { if (this.#closed) throw new EngineWebAdapterError("session.closed", "Sparse PCM store is closed"); }
}

function decodeExpected(input: unknown): Effect.Effect<SparsePcmExpectation, SparseBoundaryError> {
  return Schema.decodeUnknownEffect(ExpectedSchema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError((cause) => new SparseBoundaryError({ message: "Sparse PCM expectation schema is invalid", cause })),
    Effect.flatMap((value) => Effect.try({ try: () => normalizeExpectation(value), catch: (cause) => new SparseBoundaryError({ message: "Sparse PCM expectation is invalid", cause }) })),
  );
}

function makeOperation(storeSignal: AbortSignal, callerSignal: AbortSignal | undefined): Effect.Effect<OperationState, never, ScopeRequirement> {
  return Effect.gen(function*() {
    const effectSignal = yield* Effect.abortSignal;
    const controller = new AbortController();
    const forward = (signal: AbortSignal) => { if (signal.aborted) controller.abort(signal.reason); else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true }); };
    forward(storeSignal); forward(effectSignal); if (callerSignal !== undefined) forward(callerSignal);
    const ref = yield* Ref.make<Lifecycle>({ _tag: "opening" });
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort(new DOMException("Operation interrupted", "AbortError"))));
    return { ref, signal: controller.signal, dispose: () => controller.abort() };
  });
}

function normalizeExpectation(value: { readonly identity: string; readonly sampleRateHz: number; readonly channels: 1 | 2; readonly bitDepth: 16 | 24; readonly frames: number; readonly canonicalBytes: number }): SparsePcmExpectation {
  assertStemIdentity(value.identity);
  if (!(SUPPORTED_RATES as readonly number[]).includes(value.sampleRateHz)) throw new RangeError("sampleRateHz is outside the supported browser rates");
  if (!Number.isSafeInteger(value.frames) || value.frames <= 0) throw new RangeError("frames must be a positive safe integer");
  const canonicalBytes = value.frames * value.channels * (value.bitDepth / 8);
  if (!Number.isSafeInteger(canonicalBytes) || value.canonicalBytes !== canonicalBytes) throw new RangeError("canonicalBytes disagrees with PCM shape");
  return Object.freeze({ ...value, identity: value.identity as StemIdentity });
}

function identityHex(identity: StemIdentity): string { return identity.slice(7); }
function markerName(identity: StemIdentity): string { return `sparse-pcm-v1-commit-${identityHex(identity)}.json`; }
function payloadName(identity: StemIdentity, generation: string): string { return `sparse-pcm-v1-data-${identityHex(identity)}-${safeFilePart(generation)}`; }
function browserLocks(): WebLockProvider | undefined { return globalThis.navigator?.locks as unknown as WebLockProvider | undefined; }
function randomInstanceId(): string { return globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? "sparse-store"; }
function safeFilePart(value: string): string { const part = value.replace(/[^a-zA-Z0-9_-]/gu, "_"); if (part.length === 0 || part.length > 128) throw new RangeError("instanceId is not a bounded file component"); return part; }
function positiveDeadline(value: number): number { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("readDeadlineMs must be positive"); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function checkSignal(signal: AbortSignal): Effect.Effect<void, SparseCancelledError> { return signal.aborted ? Effect.fail(new SparseCancelledError({ message: "Sparse operation was cancelled", cause: signal.reason })) : Effect.void; }

function resolveSource(resolve: SparsePcmInstallOptions["resolve"], signal: AbortSignal): Effect.Effect<SparsePcmResolved, SparseFailure> {
  return Effect.tryPromise({ try: () => resolve(signal), catch: (cause) => isAbort(cause) ? new SparseCancelledError({ message: "Sparse resolver was cancelled", cause }) : new SparseIoError({ message: "Sparse resolver failed", cause }) }).pipe(
    Effect.flatMap((value) => Effect.try({ try: () => { if (!isRecord(value) || typeof (value.spans as { readonly [Symbol.asyncIterator]?: unknown } | undefined)?.[Symbol.asyncIterator] !== "function") throw new Error("resolver spans must be an AsyncIterable"); return value as SparsePcmResolved; }, catch: (cause) => new SparseBoundaryError({ message: "Sparse resolver result is invalid", cause }) })),
  );
}

function admitOptionalIndex(value: SparsePcmIndex | undefined, expected: SparsePcmExpectation): Effect.Effect<SparsePcmIndex | undefined, SparseFailure> {
  if (value === undefined) return Effect.succeed(undefined);
  return Effect.try({ try: () => { const index = validateSparsePcmIndex(value); compareIndexShape(index, expected); return index; }, catch: (cause) => new SparseBoundaryError({ message: "Sparse upfront index is invalid", cause }) });
}

function uniqueGeneration(backend: BackendShape, identity: StemIdentity): Effect.Effect<string, SparseFailure> {
  return Effect.gen(function*() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const random = yield* Random.nextInt;
      const generation = `${backend.instanceId}-${Math.abs(random)}-${attempt}`;
      if (!(yield* backend.exists(payloadName(identity, generation)))) return generation;
    }
    return yield* new SparseConflictError({ message: "Unable to allocate an unpublished sparse generation without collision" });
  });
}

function ingestAndCommit(backend: BackendShape, expected: SparsePcmExpectation, source: AsyncIterable<SparsePcmSpan>, asserted: SparsePcmIndex | undefined, dataName: string, generation: string, operation: OperationState): Effect.Effect<Marker, SparseFailure, ScopeRequirement> {
  let dataOwned = false;
  let markerOwned = false;
  let markerCommitted = false;
  const cleanup = Effect.gen(function*() {
    if (markerOwned && !markerCommitted) yield* backend.remove(markerName(expected.identity)).pipe(Effect.catch(() => Effect.void));
    if (dataOwned && !markerCommitted) yield* backend.remove(dataName).pipe(Effect.catch(() => Effect.void));
  });
  const transaction = Effect.scoped(Effect.gen(function*() {
      yield* Ref.set(operation.ref, { _tag: "streaming" } as Lifecycle);
    let dataClosed = false;
    const dataWriter = yield* Effect.acquireRelease(backend.createWriter(dataName, operation.signal), (writer) => dataClosed ? Effect.void : backend.abort(writer, "data writer scope closed"), { interruptible: true });
    dataOwned = true;
    const intervals: SparsePcmInterval[] = [];
    const hash = new IncrementalSha256();
    let previousEnd = 0;
    let activeBytes = 0;
    let metadataBytes = 0;
    const frameBytes = expected.channels * (expected.bitDepth / 8);
    const processSpan = Effect.fn("SparseProgram.processSpan")(function*(raw: unknown) {
      yield* checkSignal(operation.signal);
      yield* preflightSpan(raw);
      const span = yield* decodeSpan(raw);
      if (!Number.isSafeInteger(span.startFrame) || span.startFrame < previousEnd || span.startFrame + span.bytes.byteLength / frameBytes > expected.frames || span.bytes.byteLength === 0 || span.bytes.byteLength > MAX_SPAN_BYTES || span.bytes.byteLength % frameBytes !== 0) return yield* new SparseBoundaryError({ message: "Sparse span is outside its bounded frame-aligned range" });
      const spanFrames = span.bytes.byteLength / frameBytes;
      const prior = intervals[intervals.length - 1];
      const nextIsAdjacent = prior !== undefined && prior.startFrame + prior.frames === span.startFrame;
      if (!nextIsAdjacent) {
        if (intervals.length >= SPARSE_PCM_MAX_INTERVALS) return yield* new SparseBoundaryError({ message: "Sparse interval count exceeds its bound" });
        metadataBytes += JSON.stringify({ byteOffset: activeBytes, frames: spanFrames, startFrame: span.startFrame }).length + 1;
        if (metadataBytes > MAX_MARKER_BYTES - 2048) return yield* new SparseBoundaryError({ message: "Sparse marker metadata exceeds its bound" });
      }
      yield* hashZeros(hash, (span.startFrame - previousEnd) * frameBytes, operation.signal);
      hash.update(span.bytes);
      // The backend's usage snapshot excludes this still-open generation on
      // deterministic backends; include the pending active bytes exactly once.
      yield* quotaCheck(backend, activeBytes + span.bytes.byteLength + 2048);
      yield* backend.write(dataWriter, span.bytes);
      if (nextIsAdjacent && prior !== undefined) intervals[intervals.length - 1] = Object.freeze({ startFrame: prior.startFrame, frames: prior.frames + spanFrames, byteOffset: prior.byteOffset });
      else intervals.push(Object.freeze({ startFrame: span.startFrame, frames: spanFrames, byteOffset: activeBytes }));
      activeBytes += span.bytes.byteLength;
      previousEnd = span.startFrame + spanFrames;
    });
    const cancellable = cancellableIterable(source, operation.signal);
    const stream = Stream.fromAsyncIterable(cancellable, (cause) => isAbort(cause)
      ? new SparseCancelledError({ message: "Sparse resolver stream was cancelled", cause })
      : new SparseIoError({ message: "Sparse resolver stream failed", cause }));
    yield* Stream.runForEach(stream, processSpan);
    yield* hashZeros(hash, (expected.frames - previousEnd) * frameBytes, operation.signal);
    const index = yield* Effect.try({ try: () => validateSparsePcmIndex({ format: SPARSE_PCM_FORMAT, identity: expected.identity, sampleRateHz: expected.sampleRateHz, channels: expected.channels, bitDepth: expected.bitDepth, frames: expected.frames, intervals, activeBytes, canonicalBytes: expected.canonicalBytes }, activeBytes), catch: (cause) => new SparseCorruptError({ message: "Derived sparse index is invalid", cause }) });
    if (asserted !== undefined) compareIndexes(asserted, index);
    if (hash.digestHex() !== identityHex(expected.identity)) return yield* new SparseCorruptError({ message: "Sparse active spans do not match canonical identity" });
    if (dataClosed) return yield* new SparseCorruptError({ message: "Sparse data writer closed unexpectedly" });
    yield* backend.close(dataWriter);
    dataClosed = true;
    yield* Ref.set(operation.ref, { _tag: "data-closed" } as Lifecycle);
    const marker = makeMarker(expected, index, dataName, generation);
    const markerBytes = canonicalJsonBytes(marker);
    if (markerBytes.byteLength > MAX_MARKER_BYTES) return yield* new SparseCorruptError({ message: "Sparse marker exceeds its bound" });
    yield* quotaCheck(backend, markerBytes.byteLength);
    yield* Ref.set(operation.ref, { _tag: "marker-writing" } as Lifecycle);
    let markerClosed = false;
    const markerWriter = yield* Effect.acquireRelease(backend.createWriter(markerName(expected.identity), operation.signal), (writer) => markerClosed ? Effect.void : backend.abort(writer, "marker writer scope closed"), { interruptible: true });
    markerOwned = true;
    yield* backend.write(markerWriter, markerBytes);
    yield* backend.close(markerWriter);
    markerClosed = true;
    markerCommitted = markerClosed;
    return marker;
  }));
  return transaction.pipe(Effect.onError(() => cleanup));
}

function preflightSpan(value: unknown): Effect.Effect<void, SparseBoundaryError> {
  if (!isRecord(value) || !(value.bytes instanceof Uint8Array)) return Effect.fail(new SparseBoundaryError({ message: "Sparse span must contain a Uint8Array" }));
  if (value.bytes.byteLength > MAX_SPAN_BYTES || value.bytes.byteLength === 0) return Effect.fail(new SparseBoundaryError({ message: "Sparse span byte length is outside its bound" }));
  return Effect.void;
}
function decodeSpan(value: unknown): Effect.Effect<{ readonly startFrame: number; readonly bytes: Uint8Array }, SparseBoundaryError> {
  return Schema.decodeUnknownEffect(SpanSchema, { onExcessProperty: "error" })(value).pipe(Effect.mapError((cause) => new SparseBoundaryError({ message: "Sparse span schema is invalid", cause })));
}
function cancellableIterable(source: AsyncIterable<SparsePcmSpan>, signal: AbortSignal): AsyncIterable<unknown> {
  return { [Symbol.asyncIterator]: () => {
    const iterator = source[Symbol.asyncIterator]();
    return {
      next: () => raceAbort(iterator.next(), signal),
      return: async () => { if (!signal.aborted) signal.dispatchEvent(new Event("abort")); return iterator.return?.() ?? { done: true, value: undefined }; },
    };
  } };
}
function raceAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => { const abort = () => reject(signal.reason ?? new DOMException("Operation aborted", "AbortError")); signal.addEventListener("abort", abort, { once: true }); Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)); });
}
function hashZeros(hash: IncrementalSha256, bytes: number, signal: AbortSignal): Effect.Effect<void, SparseFailure> {
  return Effect.fn("SparseProgram.hashZeros")(function*() {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return yield* new SparseCorruptError({ message: "Sparse zero gap arithmetic is unsafe" });
    for (let offset = 0; offset < bytes; offset += ZERO_BLOCK.byteLength) {
      yield* checkSignal(signal);
      hash.update(ZERO_BLOCK.subarray(0, Math.min(ZERO_BLOCK.byteLength, bytes - offset)));
      yield* Effect.yieldNow;
    }
  })();
}

function readMarker(backend: BackendShape, name: string, signal: AbortSignal): Effect.Effect<Marker, SparseFailure> {
  return Effect.fn("SparseProgram.readMarker")(function*() {
    yield* checkSignal(signal);
    const blob = yield* backend.read(name);
    if (!Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > MAX_MARKER_BYTES) return yield* new SparseCorruptError({ message: "Sparse marker is outside its bounded byte size" });
    const bytes = yield* Effect.tryPromise({ try: () => blob.arrayBuffer(), catch: (cause) => new SparseIoError({ message: "Sparse marker read failed", cause }) });
    const value = yield* Effect.try({ try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown, catch: (cause) => new SparseCorruptError({ message: "Sparse marker JSON is invalid", cause }) });
    const decoded = yield* Schema.decodeUnknownEffect(MarkerSchema, { onExcessProperty: "error" })(value).pipe(Effect.mapError((cause) => new SparseCorruptError({ message: "Sparse marker schema is invalid", cause })));
    const index = yield* Effect.try({ try: () => validateSparsePcmIndex(decoded.index, decoded.activeBytes), catch: (cause) => new SparseCorruptError({ message: "Sparse marker index is invalid", cause }) });
    const marker = Object.freeze({ ...decoded, index }) as Marker;
    const canonical = canonicalJsonBytes(marker);
    if (!sameBytes(canonical, new Uint8Array(bytes))) return yield* new SparseCorruptError({ message: "Sparse marker is not canonical JSON" });
    return marker;
  })();
}

interface Marker { readonly format: typeof MARKER_TAG; readonly identity: StemIdentity; readonly sampleRateHz: number; readonly channels: 1 | 2; readonly bitDepth: 16 | 24; readonly frames: number; readonly canonicalBytes: number; readonly activeBytes: number; readonly index: SparsePcmIndex; readonly payloadName: string; readonly generation: string }
function makeMarker(expected: SparsePcmExpectation, index: SparsePcmIndex, payload: string, generation: string): Marker { return Object.freeze({ format: MARKER_TAG, identity: expected.identity, sampleRateHz: expected.sampleRateHz, channels: expected.channels, bitDepth: expected.bitDepth, frames: expected.frames, canonicalBytes: expected.canonicalBytes, activeBytes: index.activeBytes, index, payloadName: payload, generation }); }
function verifyMarker(backend: BackendShape, marker: Marker, expected: SparsePcmExpectation, signal: AbortSignal): Effect.Effect<SparsePcmDescriptor, SparseFailure> {
  return Effect.fn("SparseProgram.verifyMarker")(function*() {
    if (marker.format !== MARKER_TAG || marker.identity !== expected.identity || marker.sampleRateHz !== expected.sampleRateHz || marker.channels !== expected.channels || marker.bitDepth !== expected.bitDepth || marker.frames !== expected.frames || marker.canonicalBytes !== expected.canonicalBytes || marker.activeBytes !== marker.index.activeBytes || marker.payloadName !== payloadName(expected.identity, marker.generation)) return yield* new SparseCorruptError({ message: "Sparse marker conflicts with the expectation" });
    compareIndexShape(marker.index, expected);
    const data = yield* backend.read(marker.payloadName);
    if (data.size !== marker.activeBytes) return yield* new SparseCorruptError({ message: "Sparse payload length conflicts with its index" });
    const hash = new IncrementalSha256();
    let payloadCursor = 0;
    let frameCursor = 0;
    const frameBytes = expected.channels * (expected.bitDepth / 8);
    for (const interval of marker.index.intervals) {
      yield* hashZeros(hash, (interval.startFrame - frameCursor) * frameBytes, signal);
      for (let offset = 0; offset < interval.frames * frameBytes; offset += MAX_SPAN_BYTES) {
        yield* checkSignal(signal);
        const end = Math.min(offset + MAX_SPAN_BYTES, interval.frames * frameBytes);
        const bytes = yield* Effect.tryPromise({ try: () => data.slice(payloadCursor + offset, payloadCursor + end).arrayBuffer(), catch: (cause) => new SparseIoError({ message: "Sparse payload read failed", cause }) });
        if (bytes.byteLength !== end - offset) return yield* new SparseCorruptError({ message: "Sparse payload read was short" });
        hash.update(new Uint8Array(bytes));
      }
      payloadCursor += interval.frames * frameBytes;
      frameCursor = interval.startFrame + interval.frames;
    }
    yield* hashZeros(hash, (expected.frames - frameCursor) * frameBytes, signal);
    if (payloadCursor !== data.size || hash.digestHex() !== identityHex(expected.identity)) return yield* new SparseCorruptError({ message: "Sparse payload failed canonical verification" });
    return Object.freeze({ kind: "sparse-pcm", data, index: marker.index });
  })();
}

function compareIndexShape(index: SparsePcmIndex, expected: SparsePcmExpectation): void { if (index.identity !== expected.identity || index.sampleRateHz !== expected.sampleRateHz || index.channels !== expected.channels || index.bitDepth !== expected.bitDepth || index.frames !== expected.frames || index.canonicalBytes !== expected.canonicalBytes) throw new EngineWebAdapterError("stem.invalid_declaration", "Sparse PCM index shape conflicts with expectation"); }
function compareIndexes(a: SparsePcmIndex, b: SparsePcmIndex): void { if (a.activeBytes !== b.activeBytes || a.canonicalBytes !== b.canonicalBytes || a.intervals.length !== b.intervals.length || a.intervals.some((x, i) => x.startFrame !== b.intervals[i]!.startFrame || x.frames !== b.intervals[i]!.frames || x.byteOffset !== b.intervals[i]!.byteOffset)) throw new EngineWebAdapterError("stem.corrupt", "Sparse resolver index disagrees with derived spans"); }
function sameBytes(a: Uint8Array, b: Uint8Array): boolean { return a.byteLength === b.byteLength && a.every((value, index) => value === b[index]); }
function quotaCheck(backend: BackendShape, additional: number): Effect.Effect<void, SparseFailure> { return Effect.gen(function*() { const estimate = yield* backend.estimate; if (estimate.quota !== undefined && estimate.usage !== undefined && (!Number.isSafeInteger(additional) || estimate.usage + additional > estimate.quota)) return yield* new SparseQuotaError({ message: "Sparse storage quota is insufficient" }); }); }
function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError" || error instanceof Error && error.name === "AbortError"; }
function mapPublicError(error: unknown): unknown {
  if (error instanceof EngineWebAdapterError) return error;
  if (error instanceof SparseCancelledError) return new EngineWebAdapterError("stem.cancelled", error.message, {}, error.cause);
  if (error instanceof SparseDeadlineError) return new EngineWebAdapterError("stem.read_deadline", error.message, {}, error.cause);
  if (error instanceof SparseQuotaError) return new EngineWebAdapterError("stem.quota", error.message, {}, error.cause);
  if (error instanceof SparseBoundaryError) return new EngineWebAdapterError("stem.invalid_declaration", error.message, {}, error.cause);
  if (error instanceof SparseConflictError || error instanceof SparseCorruptError) return new EngineWebAdapterError("stem.corrupt", error.message, {}, error.cause);
  if (error instanceof SparseIoError) return new EngineWebAdapterError("stem.corrupt", error.message, {}, error.cause);
  return isAbort(error) ? new EngineWebAdapterError("stem.cancelled", "Sparse operation was cancelled", {}, error) : error;
}
