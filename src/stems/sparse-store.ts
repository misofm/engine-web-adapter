import { Context, Effect, Layer, ManagedRuntime, Option, Random, Ref, Schema, Scope, Stream } from "effect";

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
const InstallOptionsSchema = Schema.Struct({ resolve: Schema.Unknown, signal: Schema.optionalKey(Schema.Unknown) });
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
    const writerSignals = new WeakMap<StemStorageWriter, AbortSignal>();
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
    const physical = <A>(operation: string, writer: StemStorageWriter | undefined, run: () => PromiseLike<A>): Effect.Effect<A, SparseFailure> => {
      const effect = Effect.callback<A, SparseFailure>((resume, effectSignal) => {
        let pending: Promise<A>;
        try { pending = Promise.resolve(run()); }
        catch (cause) { resume(Effect.fail(fail(operation, cause))); return; }
        const requestedSignal = writer === undefined ? undefined : writerSignals.get(writer);
        let settled = false;
        const finish = (result: Effect.Effect<A, SparseFailure>) => { if (!settled) { settled = true; requestedSignal?.removeEventListener("abort", onAbort); resume(result); } };
        const onAbort = () => {
          const abortPromise = writer === undefined
            ? Promise.resolve()
            : writer.abort(new DOMException("Physical operation interrupted", "AbortError"));
          void Promise.allSettled([pending, abortPromise]).then((results) => {
            const abortResult = results[1];
            finish(abortResult?.status === "rejected" ? Effect.fail(fail(operation, abortResult.reason)) : Effect.fail(new SparseCancelledError({ message: `${operation} was cancelled` })));
          });
        };
        requestedSignal?.addEventListener("abort", onAbort, { once: true });
        pending.then(
          (value) => { if (!effectSignal.aborted && !requestedSignal?.aborted) finish(Effect.succeed(value)); },
          (cause) => { if (!effectSignal.aborted && !requestedSignal?.aborted) finish(Effect.fail(fail(operation, cause))); },
        );
        return Effect.promise(async () => {
          requestedSignal?.removeEventListener("abort", onAbort);
          let abortFailure: unknown;
          if (writer !== undefined) {
            try { await writer.abort(new DOMException("Physical operation interrupted", "AbortError")); }
            catch (cause) { abortFailure = cause; }
          }
          // An abort failure does not cancel the obligation to wait for the
          // physical mutation. Never remove or unlock while a late write can
          // still settle against the owned file.
          await Promise.allSettled([pending]);
          if (abortFailure !== undefined) throw abortFailure;
        });
      });
      if (ownsOpfsWriteDeadlines(backend, options.readDeadlineMs)) return effect;
      return effect.pipe(Effect.timeout(options.readDeadlineMs), Effect.catchTag("TimeoutError", () => Effect.fail(new SparseDeadlineError({ message: `${operation} exceeded its deadline` }))));
    };
    const createWriter = (name: string, requestedSignal: AbortSignal): Effect.Effect<StemStorageWriter, SparseFailure> => Effect.callback<StemStorageWriter, SparseFailure>((resume, effectSignal) => {
      const signal = requestedSignal;
      let pending: Promise<StemStorageWriter>;
      try { pending = Promise.resolve(backend.createWriter(name, signal)); }
      catch (cause) { resume(Effect.fail(fail("writer create", cause))); return; }
      let settled = false;
      const complete = (result: Effect.Effect<StemStorageWriter, SparseFailure>) => { if (!settled) { settled = true; signal.removeEventListener("abort", onAbort); resume(result); } };
      const onAbort = () => {
        void pending.then(async (writer) => {
          try {
            await writer.abort(new DOMException("Physical writer acquisition interrupted", "AbortError"));
            complete(Effect.fail(new SparseCancelledError({ message: "Sparse writer acquisition was cancelled" })));
          } catch (cause) {
            complete(Effect.fail(fail("writer abort", cause)));
          }
        }, (cause) => complete(Effect.fail(isAbort(cause) ? new SparseCancelledError({ message: "Sparse writer acquisition was cancelled", cause }) : fail("writer create", cause))));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (writer) => { if (!signal.aborted && !effectSignal.aborted) { writerSignals.set(writer, signal); complete(Effect.succeed(writer)); } else onAbort(); },
        (cause) => { if (!effectSignal.aborted) complete(Effect.fail(signal.aborted || isAbort(cause) ? new SparseCancelledError({ message: "Sparse writer acquisition was cancelled", cause }) : fail("writer create", cause))); },
      );
      return Effect.promise(async () => {
        signal.removeEventListener("abort", onAbort);
        let writer: StemStorageWriter;
        try { writer = await pending; }
        catch { return; } // a rejected create has no physical writer to abort
        await writer.abort(new DOMException("Physical writer acquisition interrupted", "AbortError"));
      });
    });
    const createTimed = (name: string, signal: AbortSignal): Effect.Effect<StemStorageWriter, SparseFailure> => {
      const effect = createWriter(name, signal);
      return ownsOpfsWriteDeadlines(backend, options.readDeadlineMs) ? effect : effect.pipe(Effect.timeout(options.readDeadlineMs), Effect.catchTag("TimeoutError", () => Effect.fail(new SparseDeadlineError({ message: "writer create exceeded its deadline" }))));
    };
    const removePhysical = (name: string): Effect.Effect<void, SparseFailure> => Effect.callback<void, SparseFailure>((resume, effectSignal) => {
      let pending: Promise<void>;
      try { pending = Promise.resolve(backend.remove(name)); }
      catch (cause) { resume(Effect.fail(fail("storage remove", cause))); return; }
      pending.then(
        () => { if (!effectSignal.aborted) resume(Effect.succeed(undefined)); },
        (cause) => { if (!effectSignal.aborted) resume(Effect.fail(fail("storage remove", cause))); },
      );
      return Effect.promise(() => pending);
    });
    return Layer.succeed(this, this.of({
      open: timed("storage open", () => backend.open()),
      exists: (name) => timed("storage exists", () => backend.exists(name)),
      read: (name) => timed("storage read", () => backend.read(name)),
      createWriter: (name, signal) => createTimed(name, signal),
      write: (writer, chunk) => physical("writer write", writer, () => writer.write(chunk)).pipe(Effect.asVoid),
      close: (writer) => physical("writer close", writer, () => writer.close()).pipe(Effect.asVoid),
      abort: (writer, reason) => Effect.promise(() => writer.abort(reason)),
      remove: removePhysical,
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
      return yield* Effect.callback<LockLease, SparseFailure>((resume, effectSignal) => {
        const pending = acquireStemLock(backend.lock, identityHex(identity), signal);
        let acquired: LockLease | undefined;
        let releasePromise: Promise<void> | undefined;
        const releaseOnce = (lease: LockLease): Promise<void> => {
          if (releasePromise === undefined) releasePromise = lease.release();
          return releasePromise;
        };
        pending.then(
          async (lease) => {
            acquired = lease;
            if (!effectSignal.aborted && !signal.aborted) { resume(Effect.succeed(lease)); return; }
            try {
              await releaseOnce(lease);
              resume(Effect.fail(new SparseCancelledError({ message: "Source lock acquisition was cancelled" })));
            } catch (cause) {
              resume(Effect.fail(new SparseIoError({ message: "Source lock release after cancellation failed", cause })));
            }
          },
          (cause) => { if (!effectSignal.aborted) resume(Effect.fail(isAbort(cause) || signal.aborted ? new SparseCancelledError({ message: "Source lock acquisition was cancelled", cause }) : new SparseIoError({ message: "Source lock acquisition failed", cause }))); },
        );
        return Effect.promise(async () => {
          let lease = acquired;
          if (lease === undefined) {
            try { lease = await pending; }
            catch { return; }
            acquired = lease;
          }
          await releaseOnce(lease);
        });
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
      const lease = yield* Effect.acquireRelease(coordination.acquire(expected.identity, operation.signal), (held) => Effect.promise(() => held.release()), { interruptible: true });
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
      const checkedOptions = yield* decodeInstallOptions(options);
      const operation = yield* makeOperation(lifecycle.signal, checkedOptions.signal);
      const lease = yield* Effect.acquireRelease(coordination.acquire(expected.identity, operation.signal), (held) => Effect.promise(() => held.release()), { interruptible: true });
      yield* backend.open;
      const marker = markerName(expected.identity);
      if (yield* backend.exists(marker)) {
        const descriptor = yield* verifyMarker(backend, yield* readMarker(backend, marker, operation.signal), expected, operation.signal);
        operation.dispose();
        return descriptor;
      }
      const resolved = yield* resolveSource(checkedOptions.resolve, operation.signal, backend.readDeadlineMs);
      // Resolve owns the child abort controller as soon as it succeeds. Keep
      // the iterator in a scope before any index/generation admission can
      // fail; otherwise a resolver that has already handed us a generator
      // never receives its return() callback on an early rejection.
      const source = yield* Effect.acquireRelease(
        Effect.try({
          try: () => makeSourceLease(resolved.spans, resolved.sourceController),
          catch: (cause) => new SparseBoundaryError({ message: "Sparse resolver stream cannot be acquired", cause }),
        }),
        (lease) => Effect.promise(() => lease.close()),
        { interruptible: true },
      );
      const asserted = yield* admitOptionalIndex(resolved.index, expected);
      const generation = yield* uniqueGeneration(backend, expected.identity);
      const dataName = payloadName(expected.identity, generation);
      if (asserted !== undefined) {
        const knownMarker = canonicalJsonBytes(makeMarker(expected, asserted, dataName, generation));
        if (knownMarker.byteLength > MAX_MARKER_BYTES) return yield* new SparseBoundaryError({ message: "Sparse known index marker exceeds its bound" });
        yield* quotaCheck(backend, asserted.activeBytes + knownMarker.byteLength);
      }
      const committed = yield* ingestAndCommit(backend, expected, source, asserted, dataName, generation, operation);
      const descriptor = Object.freeze({ kind: "sparse-pcm" as const, data: committed.data, index: committed.marker.index });
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
  return Effect.gen(function*() {
    yield* preflightExpected(input);
    const value = yield* Schema.decodeUnknownEffect(ExpectedSchema, { onExcessProperty: "error" })(input).pipe(Effect.mapError((cause) => new SparseBoundaryError({ message: "Sparse PCM expectation schema is invalid", cause })));
    return yield* Effect.try({ try: () => normalizeExpectation(value), catch: (cause) => new SparseBoundaryError({ message: "Sparse PCM expectation is invalid", cause }) });
  });
}

function preflightExpected(input: unknown): Effect.Effect<void, SparseBoundaryError> {
  return Effect.try({ try: () => {
    if (!isRecord(input) || Object.getOwnPropertySymbols(input).length !== 0) throw new Error("expectation must be a plain object");
    const keys = Object.keys(input).sort();
    const expected = ["bitDepth", "canonicalBytes", "channels", "frames", "identity", "sampleRateHz"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("expectation keys are not exact");
    const candidate = input as Record<string, unknown>;
    if (typeof candidate.identity !== "string" || candidate.identity.length > 71) throw new Error("identity is outside its bound");
    for (const key of ["sampleRateHz", "channels", "bitDepth", "frames", "canonicalBytes"]) {
      if (typeof candidate[key] !== "number" || !Number.isSafeInteger(candidate[key])) throw new Error(`${key} is not a safe integer`);
    }
    const channels = candidate.channels as number;
    const bitDepth = candidate.bitDepth as number;
    const frames = candidate.frames as number;
    const product = frames * channels * (bitDepth / 8);
    if (!Number.isSafeInteger(product) || product < 1) throw new Error("canonical PCM product is outside its bound");
  }, catch: (cause) => new SparseBoundaryError({ message: "Sparse expectation failed bounded preflight", cause }) });
}

function decodeInstallOptions(input: unknown): Effect.Effect<SparsePcmInstallOptions, SparseBoundaryError> {
  return Effect.gen(function*() {
    if (!isRecord(input) || Object.getOwnPropertySymbols(input).length !== 0 || Object.keys(input).some((key) => key !== "resolve" && key !== "signal")) return yield* new SparseBoundaryError({ message: "Sparse install options contain unknown keys" });
    const value = yield* Schema.decodeUnknownEffect(InstallOptionsSchema, { onExcessProperty: "error" })(input).pipe(Effect.mapError((cause) => new SparseBoundaryError({ message: "Sparse install options schema is invalid", cause })));
    if (typeof value.resolve !== "function") return yield* new SparseBoundaryError({ message: "Sparse PCM install needs a resolve callback" });
    if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) return yield* new SparseBoundaryError({ message: "Sparse install signal is invalid" });
    return value as SparsePcmInstallOptions;
  });
}

function makeOperation(storeSignal: AbortSignal, callerSignal: AbortSignal | undefined): Effect.Effect<OperationState, never, ScopeRequirement> {
  return Effect.gen(function*() {
    const effectSignal = yield* Effect.abortSignal;
    const controller = new AbortController();
    const unregister: Array<() => void> = [];
    const forward = (signal: AbortSignal) => {
      if (signal.aborted) controller.abort(signal.reason);
      else {
        const listener = () => controller.abort(signal.reason);
        signal.addEventListener("abort", listener, { once: true });
        unregister.push(() => signal.removeEventListener("abort", listener));
      }
    };
    forward(storeSignal); forward(effectSignal); if (callerSignal !== undefined) forward(callerSignal);
    const ref = yield* Ref.make<Lifecycle>({ _tag: "opening" });
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      for (const remove of unregister.splice(0)) remove();
      controller.abort(new DOMException("Operation interrupted", "AbortError"));
    };
    yield* Effect.addFinalizer(() => Effect.sync(dispose));
    return { ref, signal: controller.signal, dispose };
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

interface ResolvedInput extends SparsePcmResolved { readonly sourceController: AbortController }
function resolveSource(resolve: SparsePcmInstallOptions["resolve"], signal: AbortSignal, deadlineMs: number): Effect.Effect<ResolvedInput, SparseFailure> {
  return Effect.gen(function*() {
    const child = new AbortController();
    if (signal.aborted) child.abort(signal.reason);
    else signal.addEventListener("abort", () => child.abort(signal.reason), { once: true });
    const resolving = Effect.callback<SparsePcmResolved, SparseFailure>((resume, effectSignal) => {
      let pending: Promise<SparsePcmResolved>;
      try { pending = Promise.resolve(resolve(child.signal)); }
      catch (cause) { resume(Effect.fail(isAbort(cause) ? new SparseCancelledError({ message: "Sparse resolver was cancelled", cause }) : new SparseIoError({ message: "Sparse resolver failed", cause }))); return Effect.sync(() => { child.abort(cause); }); }
      pending.then(
        (resolved) => { if (!effectSignal.aborted) resume(Effect.succeed(resolved)); },
        (cause) => { if (!effectSignal.aborted) resume(Effect.fail(isAbort(cause) ? new SparseCancelledError({ message: "Sparse resolver was cancelled", cause }) : new SparseIoError({ message: "Sparse resolver failed", cause }))); },
      );
      return Effect.promise(async () => {
        child.abort(new DOMException("Sparse resolver interrupted", "AbortError"));
        await settlePhysical(pending);
      });
    }).pipe(
      Effect.timeout(deadlineMs),
      Effect.catchTag("TimeoutError", () => Effect.fail(new SparseDeadlineError({ message: "Sparse resolver exceeded its deadline" }))),
    );
    const value = yield* resolving;
    return yield* Effect.try({ try: () => {
      if (!isRecord(value) || typeof (value.spans as { readonly [Symbol.asyncIterator]?: unknown } | undefined)?.[Symbol.asyncIterator] !== "function") throw new Error("resolver spans must be an AsyncIterable");
      return { ...value, sourceController: child } as ResolvedInput;
    }, catch: (cause) => new SparseBoundaryError({ message: "Sparse resolver result is invalid", cause }) });
  });
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

interface CommittedSparse { readonly marker: Marker; readonly data: Blob }
function ingestAndCommit(backend: BackendShape, expected: SparsePcmExpectation, source: SourceLease, asserted: SparsePcmIndex | undefined, dataName: string, generation: string, operation: OperationState): Effect.Effect<CommittedSparse, SparseFailure, ScopeRequirement> {
  let dataOwned = false;
  let markerOwned = false;
  let markerCommitted = false;
  const cleanup = Effect.gen(function*() {
    if (markerOwned && !markerCommitted) yield* backend.remove(markerName(expected.identity));
    if (dataOwned && !markerCommitted) yield* backend.remove(dataName);
  });
  const transaction = Effect.scoped(Effect.gen(function*() {
      yield* Ref.set(operation.ref, { _tag: "streaming" } as Lifecycle);
    let dataClosed = false;
    dataOwned = true;
    // Reserve the unpublished name before asking the backend to create it.
    // A backend may create a file and then reject/cancel the create promise;
    // cleanup must still know that this transaction owns that name.
    const dataWriter = yield* Effect.acquireRelease(backend.createWriter(dataName, operation.signal), (writer) => dataClosed ? Effect.void : backend.abort(writer, "data writer scope closed"), { interruptible: true });
    const intervals: SparsePcmInterval[] = [];
    const hash = new IncrementalSha256();
    let previousEnd = 0;
    let activeBytes = 0;
    let intervalBytes = 0;
    const frameBytes = expected.channels * (expected.bitDepth / 8);
    const processSpan = Effect.fn("SparseProgram.processSpan")(function*(raw: unknown) {
      yield* checkSignal(operation.signal);
      yield* preflightSpan(raw);
      const span = yield* decodeSpan(raw);
      if (!Number.isSafeInteger(span.startFrame) || span.startFrame < previousEnd || span.startFrame + span.bytes.byteLength / frameBytes > expected.frames || span.bytes.byteLength === 0 || span.bytes.byteLength > MAX_SPAN_BYTES || span.bytes.byteLength % frameBytes !== 0) return yield* new SparseBoundaryError({ message: "Sparse span is outside its bounded frame-aligned range" });
      const spanFrames = span.bytes.byteLength / frameBytes;
      const prior = intervals[intervals.length - 1];
      const nextIsAdjacent = prior !== undefined && prior.startFrame + prior.frames === span.startFrame;
      const prospective = nextIsAdjacent && prior !== undefined
        ? { startFrame: prior.startFrame, frames: prior.frames + spanFrames, byteOffset: prior.byteOffset }
        : { startFrame: span.startFrame, frames: spanFrames, byteOffset: activeBytes };
      if (!nextIsAdjacent) {
        if (intervals.length >= SPARSE_PCM_MAX_INTERVALS) return yield* new SparseBoundaryError({ message: "Sparse interval count exceeds its bound" });
        intervalBytes += encodedIntervalBytes(prospective) + (intervals.length === 0 ? 0 : 1);
      } else if (prior !== undefined) {
        intervalBytes += encodedIntervalBytes(prospective) - encodedIntervalBytes(prior);
      }
      if (prospectiveMarkerBytes(expected, generation, dataName, activeBytes + span.bytes.byteLength, intervalBytes) > MAX_MARKER_BYTES) return yield* new SparseBoundaryError({ message: "Sparse marker metadata exceeds its bound" });
      yield* hashZeros(hash, (span.startFrame - previousEnd) * frameBytes, operation.signal);
      hash.update(span.bytes);
      // A deterministic backend only accounts a generation when its writer
      // closes. OPFS already accounts the persisted active file, so reserve
      // just this write plus the exact prospective marker there. The first
      // known-index admission above runs before that file exists.
      // `usage` is the only truthful physical-space observation available at
      // this seam: some backends account an open writer immediately while the
      // deterministic backend accounts it on close. Reserve only the next
      // physical write and exact prospective marker. Accumulated active bytes
      // are either already in usage or are covered by the final close quota
      // result, so counting them again would reject valid sparse sources.
      const quotaBytes = span.bytes.byteLength + prospectiveMarkerBytes(expected, generation, dataName, activeBytes + span.bytes.byteLength, intervalBytes);
      yield* quotaCheck(backend, quotaBytes);
      yield* backend.write(dataWriter, span.bytes);
      if (nextIsAdjacent && prior !== undefined) intervals[intervals.length - 1] = Object.freeze({ startFrame: prior.startFrame, frames: prior.frames + spanFrames, byteOffset: prior.byteOffset });
      else intervals.push(Object.freeze({ startFrame: span.startFrame, frames: spanFrames, byteOffset: activeBytes }));
      activeBytes += span.bytes.byteLength;
      previousEnd = span.startFrame + spanFrames;
    });
    const stream = sourceStream(source, backend.readDeadlineMs);
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
    markerOwned = true;
    // The marker is visible only after close, but its ordinary file entry may
    // exist as soon as create is attempted. Register ownership before that
    // attempt so a partial create is removed only after physical abort.
    const markerWriter = yield* Effect.acquireRelease(backend.createWriter(markerName(expected.identity), operation.signal), (writer) => markerClosed ? Effect.void : backend.abort(writer, "marker writer scope closed"), { interruptible: true });
    yield* backend.write(markerWriter, markerBytes);
    yield* backend.close(markerWriter);
    markerClosed = true;
    yield* checkSignal(operation.signal);
    const data = yield* backend.read(dataName);
    if (data.size !== index.activeBytes) return yield* new SparseCorruptError({ message: "Sparse payload length changed before commit" });
    yield* checkSignal(operation.signal);
    markerCommitted = markerClosed;
    return { marker, data };
  }));
  return transaction.pipe(Effect.onError(() => cleanup.pipe(Effect.orDie)));
}

function preflightSpan(value: unknown): Effect.Effect<void, SparseBoundaryError> {
  if (!isRecord(value) || !(value.bytes instanceof Uint8Array)) return Effect.fail(new SparseBoundaryError({ message: "Sparse span must contain a Uint8Array" }));
  if (value.bytes.byteLength > MAX_SPAN_BYTES || value.bytes.byteLength === 0) return Effect.fail(new SparseBoundaryError({ message: "Sparse span byte length is outside its bound" }));
  return Effect.void;
}
function decodeSpan(value: unknown): Effect.Effect<{ readonly startFrame: number; readonly bytes: Uint8Array }, SparseBoundaryError> {
  return Schema.decodeUnknownEffect(SpanSchema, { onExcessProperty: "error" })(value).pipe(Effect.mapError((cause) => new SparseBoundaryError({ message: "Sparse span schema is invalid", cause })));
}
interface SourceLease {
  readonly next: () => Promise<IteratorResult<SparsePcmSpan>>;
  readonly markEof: () => void;
  readonly abortPending: () => Promise<void>;
  readonly close: () => Promise<void>;
}

function makeSourceLease(source: AsyncIterable<SparsePcmSpan>, controller: AbortController): SourceLease {
  const iterator = source[Symbol.asyncIterator]();
  let normalEof = false;
  let closed = false;
  let pending: Promise<IteratorResult<SparsePcmSpan>> | undefined;
  let closing: Promise<void> | undefined;
  const next = (): Promise<IteratorResult<SparsePcmSpan>> => {
    if (closed) return Promise.reject(new DOMException("Sparse resolver stream is closed", "AbortError"));
    let read: Promise<IteratorResult<SparsePcmSpan>>;
    try { read = Promise.resolve(iterator.next()); }
    catch (cause) { return Promise.reject(cause); }
    pending = read;
    read.then(
      () => { if (pending === read) pending = undefined; },
      () => { if (pending === read) pending = undefined; },
    );
    return read;
  };
  const abortPending = async (): Promise<void> => {
    if (!normalEof && !controller.signal.aborted) controller.abort(new DOMException("Sparse resolver stream interrupted", "AbortError"));
    const active = pending;
    if (active !== undefined) await settlePhysical(active);
  };
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closed = true;
    closing = (async () => {
      await abortPending();
      if (!normalEof && iterator.return !== undefined) {
        const returned = Promise.resolve(iterator.return());
        await settlePhysical(returned);
      }
    })();
    return closing;
  };
  return { next, markEof: () => { normalEof = true; }, abortPending, close };
}

function sourceStream(source: SourceLease, deadlineMs: number): Stream.Stream<SparsePcmSpan, SparseFailure> {
  const next = Effect.callback<IteratorResult<SparsePcmSpan>, SparseFailure>((resume, effectSignal) => {
    let read: Promise<IteratorResult<SparsePcmSpan>>;
    try { read = source.next(); }
    catch (cause) { resume(Effect.fail(new SparseIoError({ message: "Sparse resolver stream pull failed", cause }))); return Effect.void; }
    read.then(
      (result) => { if (!effectSignal.aborted) resume(Effect.succeed(result)); },
      (cause) => { if (!effectSignal.aborted) resume(Effect.fail(isAbort(cause) ? new SparseCancelledError({ message: "Sparse resolver stream was cancelled", cause }) : new SparseIoError({ message: "Sparse resolver stream failed", cause }))); },
    );
    return Effect.promise(() => source.abortPending());
  }).pipe(
    Effect.timeout(deadlineMs),
    Effect.catchTag("TimeoutError", () => Effect.fail(new SparseDeadlineError({ message: "Sparse resolver stream exceeded its deadline" }))),
  );
  const pull = Effect.fn("SparseProgram.pullSpan")(function*() {
    const result = yield* next;
    if (result.done) {
      source.markEof();
      return [[], Option.none()] as const;
    }
    return [[result.value], Option.some(undefined)] as const;
  });
  return Stream.paginate(undefined, () => pull()).pipe(Stream.ensuring(Effect.promise(() => source.close())));
}

/** Internal node-test seam; intentionally omitted from the `/stems` barrel. */
export function sparseSourceProgramForTest(source: AsyncIterable<SparsePcmSpan>, controller: AbortController, deadlineMs: number) {
  return Effect.scoped(Effect.gen(function*() {
    const lease = yield* Effect.acquireRelease(
      Effect.try({ try: () => makeSourceLease(source, controller), catch: (cause) => new SparseBoundaryError({ message: "Sparse resolver stream cannot be acquired", cause }) }),
      (value) => Effect.promise(() => value.close()),
      { interruptible: true },
    );
    return yield* Stream.runCollect(sourceStream(lease, deadlineMs));
  }));
}

async function settlePhysical<T>(promise: PromiseLike<T>): Promise<void> {
  await Promise.resolve(promise).then(() => undefined, () => undefined);
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
    const bytes = yield* readBlobBytes(backend, blob, 0, blob.size, signal, "Sparse marker read");
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
function encodedIntervalBytes(interval: SparsePcmInterval): number { return canonicalJsonBytes({ byteOffset: interval.byteOffset, frames: interval.frames, startFrame: interval.startFrame }).byteLength; }
function prospectiveMarkerBytes(expected: SparsePcmExpectation, generation: string, payload: string, activeBytes: number, intervalBytes: number): number {
  const empty = {
    format: SPARSE_PCM_FORMAT,
    identity: expected.identity,
    sampleRateHz: expected.sampleRateHz,
    channels: expected.channels,
    bitDepth: expected.bitDepth,
    frames: expected.frames,
    intervals: [] as readonly SparsePcmInterval[],
    activeBytes,
    canonicalBytes: expected.canonicalBytes,
  } as SparsePcmIndex;
  const base = canonicalJsonBytes(makeMarker(expected, empty, payload, generation)).byteLength;
  // `intervalBytes` contains the interval objects and commas. The empty
  // marker already contains the array brackets, so the exact replacement is
  // the base plus the encoded interval contents.
  return base + intervalBytes;
}
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
        const bytes = yield* readBlobBytes(backend, data, payloadCursor + offset, payloadCursor + end, signal, "Sparse payload read");
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

function readBlobBytes(backend: BackendShape, blob: Blob, start: number, end: number, signal: AbortSignal, operation: string): Effect.Effect<ArrayBuffer, SparseFailure> {
  return Effect.gen(function*() {
    yield* checkSignal(signal);
    const bytes = yield* Effect.tryPromise({
      try: () => blob.slice(start, end).arrayBuffer(),
      catch: (cause) => isAbort(cause)
        ? new SparseCancelledError({ message: `${operation} was cancelled`, cause })
        : new SparseIoError({ message: `${operation} failed`, cause }),
    }).pipe(
      Effect.timeout(backend.readDeadlineMs),
      Effect.catchTag("TimeoutError", () => Effect.fail(new SparseDeadlineError({ message: `${operation} exceeded its deadline` }))),
    );
    yield* checkSignal(signal);
    return bytes;
  });
}

function compareIndexShape(index: SparsePcmIndex, expected: SparsePcmExpectation): void { if (index.identity !== expected.identity || index.sampleRateHz !== expected.sampleRateHz || index.channels !== expected.channels || index.bitDepth !== expected.bitDepth || index.frames !== expected.frames || index.canonicalBytes !== expected.canonicalBytes) throw new EngineWebAdapterError("stem.invalid_declaration", "Sparse PCM index shape conflicts with expectation"); }
function compareIndexes(a: SparsePcmIndex, b: SparsePcmIndex): void { if (a.activeBytes !== b.activeBytes || a.canonicalBytes !== b.canonicalBytes || a.intervals.length !== b.intervals.length || a.intervals.some((x, i) => x.startFrame !== b.intervals[i]!.startFrame || x.frames !== b.intervals[i]!.frames || x.byteOffset !== b.intervals[i]!.byteOffset)) throw new EngineWebAdapterError("stem.corrupt", "Sparse resolver index disagrees with derived spans"); }
function sameBytes(a: Uint8Array, b: Uint8Array): boolean { return a.byteLength === b.byteLength && a.every((value, index) => value === b[index]); }
function quotaCheck(backend: BackendShape, additional: number): Effect.Effect<void, SparseFailure> { return Effect.gen(function*() { const estimate = yield* backend.estimate; if (estimate.quota !== undefined && estimate.usage !== undefined && (!Number.isSafeInteger(additional) || additional < 0 || estimate.usage + additional > estimate.quota)) return yield* new SparseQuotaError({ message: "Sparse storage quota is insufficient" }); }); }
function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError" || error instanceof Error && error.name === "AbortError"; }
function isTimeout(error: unknown): boolean { return error instanceof DOMException && error.name === "TimeoutError" || error instanceof Error && error.name === "TimeoutError"; }
function mapPublicError(error: unknown): unknown {
  if (error instanceof EngineWebAdapterError) return error;
  const preserved = nestedAdapterError(error);
  if (preserved !== undefined) return preserved;
  if (error instanceof SparseCancelledError) return new EngineWebAdapterError("stem.cancelled", error.message, {}, error.cause);
  if (error instanceof SparseDeadlineError) return new EngineWebAdapterError("stem.read_deadline", error.message, {}, error.cause);
  if (error instanceof SparseQuotaError) return new EngineWebAdapterError("stem.quota", error.message, {}, error.cause);
  if (error instanceof SparseBoundaryError) return new EngineWebAdapterError("stem.invalid_declaration", error.message, {}, error.cause);
  if (error instanceof SparseConflictError || error instanceof SparseCorruptError) return new EngineWebAdapterError("stem.corrupt", error.message, {}, error.cause);
  if (error instanceof SparseIoError) return new EngineWebAdapterError("stem.corrupt", error.message, {}, error.cause);
  return isAbort(error) ? new EngineWebAdapterError("stem.cancelled", "Sparse operation was cancelled", {}, error) : error;
}
function nestedAdapterError(error: unknown): EngineWebAdapterError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof EngineWebAdapterError) return current;
    if (typeof current !== "object" || current === null || !("cause" in current)) return undefined;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return current instanceof EngineWebAdapterError ? current : undefined;
}
