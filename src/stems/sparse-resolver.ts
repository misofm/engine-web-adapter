import { Cause, Channel, Context, Effect, Exit, Fiber, Pull, Schema, Scope, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { EngineWebAdapterError } from "../errors.js";
import { BoundedStemAdmission, flacPipelineWidths } from "./flac-admission.js";
import { createFlacStemChunkResolver, type BorrowedFlacPcm, type FlacChunkDecodeOptions } from "./flac-resolver.js";
import { DecoderByteSourceError, makeFiniteDecoderByteSource } from "./decoder-byte-source.js";
import { FlacWorkerPool } from "./flac-worker-pool.js";
import {
  SPARSE_STEM_HEADER_BYTES,
  admitSparseStemHeader,
  admitSparseStemManifest,
  assertSparseStemSessionBinding,
  type SparseStemChunk,
  type SparseStemInterval,
  type SparseStemManifest,
} from "./sparse-format.js";
import type { AdapterAssetOverrides } from "../assets.js";
import type { SparsePcmExpectation, SparsePcmResolved, SparsePcmSpan } from "./sparse-store.js";
import { openSparseResponse, type SparseResponseCursor } from "./sparse-response.js";
import { sparseProgressReporter, type SparseProgressReporter } from "./progress.js";
import type { SparseStemResolverContext, StemIdentity, StemProgress } from "./types.js";

export type SparseStemLocator = (
  identity: StemIdentity,
  options: { readonly signal: AbortSignal },
) => string | URL | Request | Promise<string | URL | Request>;

export interface SparseStemDeliveryOptions extends Pick<FlacChunkDecodeOptions,
  "fetch" | "readDeadlineMs" | "decodeNoProgressMs" | "admission" |
  "memoryBudgetBytes" | "maximumWorkers" | "hardwareConcurrency" |
  "deviceMemory" | "assets" | "createWorker"
> {
  readonly locate: SparseStemLocator;
}

const SparseDeliveryOptionsSchema = Schema.Struct({
  locate: Schema.Unknown,
  readDeadlineMs: Schema.optionalKey(Schema.Number),
  decodeNoProgressMs: Schema.optionalKey(Schema.Number),
});

function validateOptions(options: SparseStemDeliveryOptions): void {
  const parsed = Schema.decodeUnknownSync(SparseDeliveryOptionsSchema)(options);
  if (typeof parsed.locate !== "function") throw new TypeError("createSparseStemResolver requires locate");
  for (const [name, value] of [["readDeadlineMs", parsed.readDeadlineMs], ["decodeNoProgressMs", parsed.decodeNoProgressMs]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new RangeError(`${name} must be positive`);
  }
}

function snapshotResolverContext(input: SparseStemResolverContext | undefined): SparseStemResolverContext {
  if (input === undefined) return Object.freeze({});
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input) || Object.getOwnPropertySymbols(input).length !== 0) {
      throw new TypeError("sparse resolver context must be a plain object");
    }
    const keys = Object.keys(input);
    if (keys.length > 1 || (keys.length === 1 && keys[0] !== "onProgress")) {
      throw new TypeError("sparse resolver context has an unknown key");
    }
    const onProgress = input.onProgress;
    if (onProgress !== undefined && typeof onProgress !== "function") {
      throw new TypeError("sparse resolver context onProgress must be a function");
    }
    return Object.freeze(onProgress === undefined ? {} : { onProgress });
  } catch (cause) {
    if (cause instanceof TypeError && cause.message.startsWith("sparse resolver context")) throw cause;
    throw new TypeError("sparse resolver context could not be snapshotted", { cause });
  }
}

function safeFrameBytes(expected: SparsePcmExpectation): number {
  const frameBytes = expected.channels * (expected.bitDepth / 8);
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 1 || !Number.isSafeInteger(expected.frames) || expected.frames < 1 ||
    expected.canonicalBytes !== expected.frames * frameBytes) {
    throw new EngineWebAdapterError("stem.invalid_declaration", "Sparse source expectation has unsafe canonical PCM shape", { expected });
  }
  if (![44_100, 48_000, 88_200, 96_000].includes(expected.sampleRateHz)) {
    throw new EngineWebAdapterError("stem.invalid_declaration", "Sparse source expectation uses an unsupported sample rate", { expected });
  }
  return frameBytes;
}

function payloadBytes(manifest: SparseStemManifest): number {
  const last = manifest.chunks[manifest.chunks.length - 1];
  return last === undefined ? 0 : last.offset + last.bytes;
}

function chunkExpected(manifest: SparseStemManifest, chunk: SparseStemChunk): SparsePcmExpectation {
  const frameBytes = manifest.channels * (manifest.bitDepth / 8);
  return {
    identity: manifest.identity,
    sampleRateHz: manifest.sampleRateHz,
    channels: manifest.channels,
    bitDepth: manifest.bitDepth,
    frames: chunk.frames,
    canonicalBytes: chunk.frames * frameBytes,
  };
}

function sourceFactory(
  cursor: SparseResponseCursor,
  chunk: SparseStemChunk,
): FlacChunkDecodeOptions["sourceFactory"] {
  let consumed = 0;
  return (options) => makeFiniteDecoderByteSource(
    options,
    Effect.fn("SparseFiniteSource.read")(function*(maximumBytes: number) {
      const remaining = chunk.bytes - consumed;
      if (remaining < 1) return yield* new DecoderByteSourceError({ operation: "read", message: "Sparse finite source was read beyond its declared chunk" });
      const result = yield* cursor.readChunk(Math.min(maximumBytes, remaining), options.borrow?.adopt).pipe(
        Effect.mapError((cause) => cause instanceof DecoderByteSourceError
          ? cause
          : new DecoderByteSourceError({ operation: "read", message: cause.message, cause })),
      );
      consumed += result.bytes.byteLength;
      if (consumed > chunk.bytes) {
        result.release();
        return yield* new DecoderByteSourceError({ operation: "read", message: "Sparse finite source crossed its chunk extent" });
      }
      return { ...result, end: consumed === chunk.bytes };
    }),
    chunk.bytes,
    chunk.flacSha256,
  );
}

interface CurrentBlock {
  readonly value: BorrowedFlacPcm;
  readonly startPackedFrame: number;
  readonly frames: number;
  offsetFrames: number;
}

interface SparsePullState {
  readonly cursor: SparseResponseCursor;
  readonly manifest: SparseStemManifest;
  readonly expected: SparsePcmExpectation;
  readonly frameBytes: number;
  readonly pool: FlacWorkerPool;
  readonly options: Omit<SparseStemDeliveryOptions, "locate"> & { readonly locate: SparseStemLocator };
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly payloadStart: number;
  readonly progress: SparseProgressReporter;
  chunkIndex: number;
  currentChunk: SparseStemChunk | undefined;
  currentReader: ReadableStreamDefaultReader<BorrowedFlacPcm> | undefined;
  currentBlock: CurrentBlock | undefined;
  chunkFrames: number;
  chunkDecodedBytes: number;
  decodedBytes: number;
  packedFrame: number;
  intervalIndex: number;
  done: boolean;
  activeResolve: Promise<import("./flac-resolver.js").ResolvedFlacChunk> | undefined;
  activeOutput: ReadableStream<import("./flac-resolver.js").BorrowedFlacPcm> | undefined;
}

function intervalEnd(interval: SparseStemInterval): number {
  return interval.packedFrameOffset + interval.frames;
}

function expectedPackedFrames(manifest: SparseStemManifest): number {
  const last = manifest.intervals[manifest.intervals.length - 1];
  return last === undefined ? 0 : intervalEnd(last);
}

function mapNextBlock(state: SparsePullState): SparsePcmSpan {
  const block = state.currentBlock;
  if (block === undefined) throw new EngineWebAdapterError("stem.corrupt", "Sparse mapper has no decoder block", { identity: state.expected.identity });
  while (state.intervalIndex < state.manifest.intervals.length &&
    state.packedFrame >= intervalEnd(state.manifest.intervals[state.intervalIndex]!)) state.intervalIndex += 1;
  const interval = state.manifest.intervals[state.intervalIndex];
  if (interval === undefined || state.packedFrame < interval.packedFrameOffset || state.packedFrame >= intervalEnd(interval)) {
    throw new EngineWebAdapterError("stem.corrupt", "Sparse decoder block falls outside admitted active intervals", { identity: state.expected.identity, packedFrame: state.packedFrame });
  }
  const maxFrames = Math.max(1, Math.floor(128 * 1024 / state.frameBytes));
  const blockEnd = block.startPackedFrame + block.frames;
  const end = Math.min(blockEnd, intervalEnd(interval), state.packedFrame + maxFrames);
  if (end <= state.packedFrame) throw new EngineWebAdapterError("stem.corrupt", "Sparse mapper made no frame progress", { identity: state.expected.identity });
  const frames = end - state.packedFrame;
  const startInBlock = state.packedFrame - block.startPackedFrame;
  const startByte = startInBlock * state.frameBytes;
  const endByte = startByte + frames * state.frameBytes;
  const bytes = block.value.bytes.subarray(startByte, endByte);
  if (bytes.byteLength !== frames * state.frameBytes) throw new EngineWebAdapterError("stem.corrupt", "Sparse decoder block view is not frame aligned", { identity: state.expected.identity });
  const span = {
    startFrame: interval.startFrame + (state.packedFrame - interval.packedFrameOffset),
    bytes,
  } satisfies SparsePcmSpan;
  state.packedFrame = end;
  state.chunkFrames += frames;
  block.offsetFrames = end - block.startPackedFrame;
  return span;
}

function wrapPrivateRead(
  read: () => Promise<IteratorResult<BorrowedFlacPcm>>,
  identity: StemIdentity,
): Effect.Effect<IteratorResult<BorrowedFlacPcm>, EngineWebAdapterError> {
  return Effect.tryPromise({
    try: read,
    catch: (cause) => cause instanceof EngineWebAdapterError
      ? cause
      : new EngineWebAdapterError("stem.decode.worker", "Sparse FLAC output read failed", { identity }, cause),
  });
}

const nextSparseSpan = Effect.fn("SparseResolver.nextSpan")(function*(state: SparsePullState) {
    if (state.done) return yield* Cause.done();
    for (;;) {
      const previous = state.currentBlock;
      if (previous !== undefined && previous.offsetFrames >= previous.frames) {
        previous.value.release();
        state.currentBlock = undefined;
      }
      if (state.currentBlock !== undefined) return [mapNextBlock(state)] as const;

      if (state.currentReader !== undefined) {
        const next = yield* wrapPrivateRead(() => state.currentReader!.read(), state.expected.identity);
        if (!next.done) {
          const bytes = next.value.bytes;
          if (bytes.byteLength < 1 || bytes.byteLength % state.frameBytes !== 0 || bytes.byteLength > 384 * 1024 ||
            next.value.bytes.buffer.byteLength > 384 * 1024) {
            next.value.release();
            return yield* Effect.fail(new EngineWebAdapterError("stem.corrupt", "Sparse decoder output has an unsafe PCM block shape", { identity: state.expected.identity }));
          }
          const frames = bytes.byteLength / state.frameBytes;
          state.currentBlock = { value: next.value, startPackedFrame: state.packedFrame, frames, offsetFrames: 0 };
          continue;
        }
        state.currentReader.releaseLock();
        state.currentReader = undefined;
        state.activeOutput = undefined;
        const chunk = state.currentChunk;
        if (chunk === undefined || state.chunkFrames !== chunk.frames) {
          return yield* Effect.fail(new EngineWebAdapterError("stem.corrupt", "Sparse decoder output did not cover its declared chunk", {
            identity: state.expected.identity,
            expectedFrames: chunk?.frames,
            actualFrames: state.chunkFrames,
          }));
        }
        state.currentChunk = undefined;
        state.chunkIndex += 1;
        state.chunkFrames = 0;
        state.chunkDecodedBytes = 0;
        continue;
      }

      const chunk = state.manifest.chunks[state.chunkIndex];
      if (chunk === undefined) {
        if (state.packedFrame !== expectedPackedFrames(state.manifest)) return yield* Effect.fail(new EngineWebAdapterError("stem.corrupt", "Sparse packed frame endpoint changed during mapping", { identity: state.expected.identity }));
        yield* state.cursor.assertEof;
        state.done = true;
        return yield* Cause.done();
      }
      const expectedPosition = state.payloadStart + chunk.offset;
      if (state.cursor.position !== expectedPosition) return yield* Effect.fail(new EngineWebAdapterError("stem.corrupt", "Sparse finite source cursor is not at its admitted chunk", { identity: state.expected.identity, expectedPosition, actualPosition: state.cursor.position }));
      const onChunkProgress = (progress: StemProgress): void => {
        if (progress.stage === "decoding" && progress.byteKind === "pcm") {
          if (!Number.isSafeInteger(progress.bytes) || progress.bytes < state.chunkDecodedBytes ||
            !Number.isSafeInteger(progress.totalBytes) || progress.totalBytes < 1) return;
          const delta = progress.bytes - state.chunkDecodedBytes;
          const next = state.decodedBytes + delta;
          if (!Number.isSafeInteger(next) || next > state.expected.canonicalBytes) return;
          state.chunkDecodedBytes = progress.bytes;
          state.decodedBytes = next;
          state.progress.emit({
            ...progress,
            identity: state.expected.identity,
            bytes: next,
            totalBytes: state.expected.canonicalBytes,
            byteKind: "pcm",
          });
          return;
        }
        state.progress.emit(progress);
      };
      const chunkOptions: FlacChunkDecodeOptions & { readonly onProgress: (progress: StemProgress) => void } = {
        ...state.options,
        workerPool: state.pool,
        wholeSourceIdentity: state.expected.identity,
        chunk: { expected: chunkExpected(state.manifest, chunk), pcmSha256: chunk.pcmSha256 },
        sourceFactory: sourceFactory(state.cursor, chunk),
        onProgress: onChunkProgress,
      };
      const resolver = createFlacStemChunkResolver(chunkOptions);
      const resolving = resolver.resolve(state.signal);
      const tracked = resolving.then((result) => {
        state.activeOutput = result.output;
        return result;
      }).finally(() => {
        if (state.activeResolve === tracked) state.activeResolve = undefined;
      });
      state.activeResolve = tracked;
      const result = yield* Effect.tryPromise({
        try: () => tracked,
        catch: (cause) => cause instanceof EngineWebAdapterError
          ? cause
          : new EngineWebAdapterError("stem.decode.worker", "Sparse FLAC chunk resolution failed", { identity: state.expected.identity }, cause),
      });
      state.currentChunk = chunk;
      state.chunkFrames = 0;
      state.currentReader = result.output.getReader();
    }
});

function shallowCleanupPrimary(value: unknown): EngineWebAdapterError | undefined {
  if (value instanceof EngineWebAdapterError) return value;
  if (value instanceof AggregateError) return value.errors.find((error): error is EngineWebAdapterError => error instanceof EngineWebAdapterError);
  if (Cause.isCause(value)) {
    for (const reason of value.reasons) {
      const payload = Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : undefined;
      if (payload instanceof EngineWebAdapterError) return payload;
      if (payload instanceof AggregateError) {
        const primary = payload.errors.find((error): error is EngineWebAdapterError => error instanceof EngineWebAdapterError);
        if (primary !== undefined) return primary;
      }
    }
  }
  return undefined;
}

function closeFailure(identity: StemIdentity, operation: string, errors: readonly unknown[]): EngineWebAdapterError {
  const primary = errors.map(shallowCleanupPrimary).find((error): error is EngineWebAdapterError => error !== undefined);
  const details = primary === undefined ? { identity, operation } : primary.details;
  const code = primary?.code ?? "stem.delivery.http";
  const message = primary?.message ?? `Sparse ${operation} cleanup failed`;
  return new EngineWebAdapterError(code, message, details, new AggregateError([...errors], `Sparse ${operation} cleanup failed`));
}

function operationFailure(identity: StemIdentity, cause: Cause.Cause<unknown>, cleanup?: unknown): EngineWebAdapterError {
  if (cleanup instanceof EngineWebAdapterError) {
    return new EngineWebAdapterError(cleanup.code, cleanup.message, cleanup.details, new AggregateError([cleanup, cause], "Sparse stream operation and cleanup failed"));
  }
  const primary = Cause.squash(cause);
  const details = primary instanceof EngineWebAdapterError ? primary.details : { identity };
  const code = primary instanceof EngineWebAdapterError ? primary.code : "stem.delivery.http";
  const message = primary instanceof Error ? primary.message : "Sparse stream operation failed";
  const preserved = cleanup === undefined
    ? new AggregateError([primary, cause], "Sparse stream operation failed")
    : new AggregateError([cleanup, primary, cause], "Sparse stream operation and cleanup failed");
  return new EngineWebAdapterError(code, message, details, preserved);
}

/** Keep one explicit Effect Scope for the lazy stream and physical resources. */
type SparsePullChunk = readonly [SparsePcmSpan, ...SparsePcmSpan[]];

function scopedAsyncIterable(
  stream: Stream.Stream<SparsePcmSpan, EngineWebAdapterError>,
  identity: StemIdentity,
  onClose?: () => void,
): AsyncIterable<SparsePcmSpan> {
  return {
    [Symbol.asyncIterator]() {
      const context = Context.empty();
      const runPromise = Effect.runPromiseWith(context);
      const runPromiseExit = Effect.runPromiseExitWith(context);
      const runFork = Effect.runForkWith(context);
      const scope = Scope.makeUnsafe();
      let pull: Pull.Pull<SparsePullChunk, EngineWebAdapterError | Cause.Done<void>> | undefined;
      let currentIter: Iterator<SparsePcmSpan> | undefined;
      let currentFiber: Fiber.Fiber<SparsePullChunk, EngineWebAdapterError | Cause.Done<void>> | undefined;
      let closePromise: Promise<IteratorResult<SparsePcmSpan>> | undefined;
      const close = (exit: Exit.Exit<unknown, unknown>): Promise<IteratorResult<SparsePcmSpan>> => {
        if (closePromise !== undefined) return closePromise;
        const fiber = currentFiber;
        closePromise = (async () => {
          onClose?.();
          const failures: unknown[] = [];
          if (fiber !== undefined) {
            try {
              const interrupted = await runPromiseExit(Fiber.interrupt(fiber));
              if (Exit.isFailure(interrupted)) failures.push(interrupted.cause);
            } catch (cause) { failures.push(cause); }
          }
          try {
            const closed = await runPromiseExit(Scope.close(scope, exit));
            if (Exit.isFailure(closed)) failures.push(closed.cause);
          } catch (cause) { failures.push(cause); }
          if (failures.length > 0) throw closeFailure(identity, "stream", failures);
          return { done: true, value: undefined };
        })();
        return closePromise;
      };
      const reportFailure = async (exit: Exit.Exit<unknown, unknown>): Promise<never> => {
        try { await close(exit); }
        catch (cleanup) {
          if (Exit.isFailure(exit)) throw operationFailure(identity, exit.cause, cleanup);
          throw cleanup;
        }
        if (Exit.isFailure(exit)) throw operationFailure(identity, exit.cause);
        throw new Error("Sparse stream failed without an operation cause");
      };
      return {
        async next(): Promise<IteratorResult<SparsePcmSpan>> {
          if (closePromise !== undefined) return closePromise;
          if (currentFiber !== undefined) {
            return Promise.reject(new EngineWebAdapterError("stem.delivery.range", "Sparse stream iterator has a pending pull", { identity }));
          }
          if (currentIter !== undefined) {
            const next = currentIter.next();
            if (!next.done) return next;
            currentIter = undefined;
          }
          const fiber = runFork(
            pull ?? Effect.flatMap(Channel.toPullScoped(stream.channel, scope), (nextPull) => {
              pull = nextPull;
              return nextPull;
            }),
          );
          currentFiber = fiber;
          const exit = await runPromise(Fiber.await(fiber));
          if (currentFiber === fiber) currentFiber = undefined;
          if (Exit.isSuccess(exit)) {
            currentIter = exit.value[Symbol.iterator]();
            return currentIter.next();
          }
          if (Pull.isDoneCause(exit.cause)) return close(Exit.void);
          return reportFailure(exit);
        },
        return() { return close(Exit.void); },
        async throw(error: unknown): Promise<IteratorResult<SparsePcmSpan>> {
          await reportFailure(Exit.die(error));
          throw error;
        },
      };
    },
  };
}

function snapshotOptions(options: SparseStemDeliveryOptions): Omit<SparseStemDeliveryOptions, "locate"> & { readonly locate: SparseStemLocator } {
  const {
    locate, fetch, readDeadlineMs, decodeNoProgressMs, admission,
    memoryBudgetBytes, maximumWorkers, hardwareConcurrency, deviceMemory,
    assets: sourceAssets, createWorker,
  } = options;
  const assets = sourceAssets === undefined ? undefined : (() => {
    const scratchWorkerUrl = sourceAssets.scratchWorkerUrl;
    const flacWorkerUrl = sourceAssets.flacWorkerUrl;
    const flacDecoderWasmUrl = sourceAssets.flacDecoderWasmUrl;
    const opfsWorkerUrl = sourceAssets.opfsWorkerUrl;
    const pumpWorkerUrl = sourceAssets.pumpWorkerUrl;
    const feedWorkletModuleUrl = sourceAssets.feedWorkletModuleUrl;
    const engineWasmUrl = sourceAssets.engineWasmUrl;
    const engineWorkletModuleUrl = sourceAssets.engineWorkletModuleUrl;
    const engineHostModuleUrl = sourceAssets.engineHostModuleUrl;
    const assetCreateWorker = sourceAssets.createWorker;
    return {
      ...(scratchWorkerUrl === undefined ? {} : { scratchWorkerUrl: scratchWorkerUrl instanceof URL ? String(scratchWorkerUrl) : scratchWorkerUrl }),
      ...(flacWorkerUrl === undefined ? {} : { flacWorkerUrl: flacWorkerUrl instanceof URL ? String(flacWorkerUrl) : flacWorkerUrl }),
      ...(flacDecoderWasmUrl === undefined ? {} : { flacDecoderWasmUrl: flacDecoderWasmUrl instanceof URL ? String(flacDecoderWasmUrl) : flacDecoderWasmUrl }),
      ...(opfsWorkerUrl === undefined ? {} : { opfsWorkerUrl: opfsWorkerUrl instanceof URL ? String(opfsWorkerUrl) : opfsWorkerUrl }),
      ...(pumpWorkerUrl === undefined ? {} : { pumpWorkerUrl: pumpWorkerUrl instanceof URL ? String(pumpWorkerUrl) : pumpWorkerUrl }),
      ...(feedWorkletModuleUrl === undefined ? {} : { feedWorkletModuleUrl: feedWorkletModuleUrl instanceof URL ? String(feedWorkletModuleUrl) : feedWorkletModuleUrl }),
      ...(engineWasmUrl === undefined ? {} : { engineWasmUrl: engineWasmUrl instanceof URL ? String(engineWasmUrl) : engineWasmUrl }),
      ...(engineWorkletModuleUrl === undefined ? {} : { engineWorkletModuleUrl: engineWorkletModuleUrl instanceof URL ? String(engineWorkletModuleUrl) : engineWorkletModuleUrl }),
      ...(engineHostModuleUrl === undefined ? {} : { engineHostModuleUrl: engineHostModuleUrl instanceof URL ? String(engineHostModuleUrl) : engineHostModuleUrl }),
      ...(assetCreateWorker === undefined ? {} : { createWorker: assetCreateWorker.bind(sourceAssets) }),
    } as AdapterAssetOverrides;
  })();
  return {
    locate,
    ...(fetch === undefined ? {} : { fetch }),
    ...(readDeadlineMs === undefined ? {} : { readDeadlineMs }),
    ...(decodeNoProgressMs === undefined ? {} : { decodeNoProgressMs }),
    ...(admission === undefined ? {} : { admission }),
    ...(memoryBudgetBytes === undefined ? {} : { memoryBudgetBytes }),
    ...(maximumWorkers === undefined ? {} : { maximumWorkers }),
    ...(hardwareConcurrency === undefined ? {} : { hardwareConcurrency }),
    ...(deviceMemory === undefined ? {} : { deviceMemory }),
    ...(assets === undefined ? {} : { assets }),
    ...(createWorker === undefined ? {} : { createWorker }),
  };
}

export function createSparseStemResolver(
  options: SparseStemDeliveryOptions,
): (expected: SparsePcmExpectation, signal: AbortSignal, context?: SparseStemResolverContext) => Promise<SparsePcmResolved> {
  const snapshot = snapshotOptions(options);
  validateOptions(snapshot);
  const widths = flacPipelineWidths(snapshot);
  const pool = new FlacWorkerPool({
    ...(snapshot.admission === undefined ? {} : { admission: snapshot.admission }),
    ...(snapshot.assets === undefined ? {} : { assets: snapshot.assets }),
    ...(snapshot.createWorker === undefined ? {} : { createWorker: snapshot.createWorker }),
    ...(snapshot.hardwareConcurrency === undefined ? {} : { hardwareConcurrency: snapshot.hardwareConcurrency }),
    ...(snapshot.deviceMemory === undefined ? {} : { deviceMemory: snapshot.deviceMemory }),
    ...(snapshot.memoryBudgetBytes === undefined ? {} : { memoryBudgetBytes: snapshot.memoryBudgetBytes }),
    ...(snapshot.maximumWorkers === undefined ? {} : { maximumWorkers: snapshot.maximumWorkers }),
  });
  const downloadAdmission = new BoundedStemAdmission(widths.downloads);

  return async (expected, signal, context) => {
    const checkedContext = snapshotResolverContext(context);
    const progress = sparseProgressReporter(checkedContext.onProgress, expected.identity);
    let handedOff = false;
    try {
      const frameBytes = safeFrameBytes(expected);
      if (signal.aborted) throw new EngineWebAdapterError("stem.cancelled", "Sparse installation was cancelled before acquisition", { identity: expected.identity }, signal.reason);
      const acquisition = Effect.gen(function*() {
      const operation = new AbortController();
      const onAbort = () => operation.abort(signal.reason);
      if (signal.aborted) operation.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        signal.removeEventListener("abort", onAbort);
        operation.abort(new DOMException("Sparse stream scope closed", "AbortError"));
      }));
      let responseStage: "probing" | "fetching" = "probing";
      let responseTotal: number | undefined;
      const reportResponse = (bytes: number): void => {
        if (responseTotal === undefined) return;
        progress.emit({
          stage: responseStage,
          identity: expected.identity,
          bytes,
          totalBytes: responseTotal,
          byteKind: "flac",
        });
      };
      const cursor = yield* openSparseResponse({
        identity: expected.identity,
        locate: snapshot.locate,
        ...(snapshot.fetch === undefined ? {} : { fetch: snapshot.fetch }),
        readDeadlineMs: snapshot.readDeadlineMs ?? 30_000,
        admission: downloadAdmission,
        signal: operation.signal,
        abortOperation: operation.abort.bind(operation),
        onProgress: reportResponse,
      });
      const header = yield* cursor.readExact(SPARSE_STEM_HEADER_BYTES);
      const headerAdmission = yield* Effect.try({ try: () => admitSparseStemHeader(header), catch: cause => cause instanceof EngineWebAdapterError ? cause : new EngineWebAdapterError("stem.corrupt", "Sparse header admission failed", { identity: expected.identity }, cause) });
      const encodedManifest = yield* cursor.readExact(headerAdmission.manifestBytes);
      const manifest = yield* Effect.try({ try: () => admitSparseStemManifest(encodedManifest), catch: cause => cause instanceof EngineWebAdapterError ? cause : new EngineWebAdapterError("stem.corrupt", "Sparse manifest admission failed", { identity: expected.identity }, cause) });
      yield* Effect.try({ try: () => assertSparseStemSessionBinding(manifest, expected), catch: cause => cause instanceof EngineWebAdapterError ? cause : new EngineWebAdapterError("stem.invalid_declaration", "Sparse manifest does not match its session source", { identity: expected.identity }, cause) });
      const payload = payloadBytes(manifest);
      responseTotal = headerAdmission.payloadStart + payload;
      yield* cursor.assertContentLength(responseTotal);
      progress.emit({ stage: "probing", identity: expected.identity, bytes: cursor.position, totalBytes: responseTotal, byteKind: "flac" });
      responseStage = "fetching";
      progress.emit({ stage: "fetching", identity: expected.identity, bytes: cursor.position, totalBytes: responseTotal, byteKind: "flac" });
      const state: SparsePullState = {
        cursor,
        manifest,
        expected,
        frameBytes,
        pool,
        options: snapshot,
        signal: operation.signal,
        abort: () => operation.abort(new DOMException("Sparse stream scope closed", "AbortError")),
        payloadStart: headerAdmission.payloadStart,
        progress,
        chunkIndex: 0,
        currentChunk: undefined,
        currentReader: undefined,
        currentBlock: undefined,
        chunkFrames: 0,
        chunkDecodedBytes: 0,
        decodedBytes: 0,
        packedFrame: 0,
        intervalIndex: 0,
        done: false,
        activeResolve: undefined,
        activeOutput: undefined,
      };
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        const failures: unknown[] = [];
        state.abort();
        const reader = state.currentReader;
        state.currentReader = undefined;
        if (reader !== undefined) {
          try { await reader.cancel(); } catch (cause) { failures.push(cause); }
          try { reader.releaseLock(); } catch (cause) { failures.push(cause); }
        }
        const resolving = state.activeResolve;
        if (resolving !== undefined) {
          try { await resolving; } catch (cause) { failures.push(cause); }
        }
        if (reader === undefined && state.activeOutput !== undefined) {
          try { await state.activeOutput.cancel(); } catch (cause) { failures.push(cause); }
        }
        const block = state.currentBlock;
        state.currentBlock = undefined;
        if (block !== undefined) {
          try { block.value.release(); } catch (cause) { failures.push(cause); }
        }
        if (failures.length > 0) throw closeFailure(state.expected.identity, "decoder", failures);
      }));
      return Stream.fromPull(Effect.succeed(nextSparseSpan(state)));
      });
      const stream = Stream.unwrap(acquisition).pipe(Stream.provide(FetchHttpClient.layer));
      handedOff = true;
      return { spans: scopedAsyncIterable(stream as Stream.Stream<SparsePcmSpan, EngineWebAdapterError>, expected.identity, progress.close) };
    } finally {
      if (!handedOff) progress.close();
    }
  };
}
