import { Cause, Effect, Exit, Queue } from "effect";
import { beginIngestStage, ownRunnableWorker, configureProcessingDiagnostics, recordWorkerProcessing, deliveredRangeOwner, registerFlacResolver, releaseDecoded, retainDecoded, type IngestDiagnostics } from "./ingest-diagnostics.js";
import { MAXIMUM_CANONICAL_OUTPUT_BYTES } from "./native-flac-decoder.js";
import { EngineWebAdapterError } from "../errors.js";
import { ADAPTER_ASSETS, type AdapterAssetOverrides } from "../assets.js";
import { BoundedStemAdmission, flacPipelineWidths, type FlacProcessingOptions } from "./flac-admission.js";
import { registerFlacResult } from "./flac-result.js";
import { assertStemIdentity } from "./identity.js";
import { readExactFlacRangeEffect, type FlacLocator } from "./flac-delivery.js";
import { FLAC_INPUT_SLOT_BYTES, FlacInputSlotProducer } from "./flac-input-slot.js";
import { FlacWorkerPool, type FlacWorkerPoolOptions } from "./flac-worker-pool.js";
import { IncrementalSha256 } from "./sha256.js";
import {
  DecoderByteSourceError,
  makeDecoderByteSource,
  type DecoderByteSource,
  type DecoderByteSourceOptions,
} from "./decoder-byte-source.js";
import type { FlacWorkerLike, FlacWorkerResponse } from "./flac-worker-protocol.js";
import type { ResolvedStem, StemIdentity, StemProgress, StemResolver } from "./types.js";

export interface FlacDeliveryOptions {
  readonly locate: FlacLocator;
  /** Legacy shared admission, or bounded processing admission with an explicit processing policy. */
  readonly admission?: BoundedStemAdmission;
  /** Opt in to independent, device-aware decode and hashing (up to 16 workers). */
  readonly processing?: FlacProcessingOptions;
  /**
   * The transport every physical range attempt runs through.
   *
   * Defaults to the platform `fetch`. The package owns the request model --
   * exact `Range`, the operation signal, bounded retry -- and an override owns
   * everything outside it.
   */
  readonly fetch?: typeof globalThis.fetch;
  readonly readDeadlineMs?: number;
  /** Main-thread deadline for decoder asset/decode progress. */
  readonly decodeNoProgressMs?: number;
  readonly maximumAttempts?: number;
  readonly memoryBudgetBytes?: number;
  readonly maximumWorkers?: number;
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
  readonly assets?: AdapterAssetOverrides;
  readonly createWorker?: () => FlacWorkerLike;
}

let nextRequestId = 1;

function workerError(message: Extract<FlacWorkerResponse, { type: "error" }>): EngineWebAdapterError {
  const code = message.error.code;
  if (code !== undefined) {
    return new EngineWebAdapterError(code as EngineWebAdapterError["code"], message.error.message, message.error.details ?? {});
  }
  return new EngineWebAdapterError("stem.decode.worker", message.error.message);
}

function decoderSourceError(error: unknown): EngineWebAdapterError {
  if (error instanceof DecoderByteSourceError) {
    if (error.cause instanceof EngineWebAdapterError) {
      return new EngineWebAdapterError(error.cause.code, error.cause.message, error.cause.details, error);
    }
    return new EngineWebAdapterError("stem.decode.worker", error.message, { operation: error.operation }, error);
  }
  if (error instanceof EngineWebAdapterError) return error;
  return new EngineWebAdapterError("stem.decode.worker", "FLAC decoder input lane failed", {}, error);
}

function inputCauseValue(reason: Cause.Reason<unknown>): unknown {
  if (Cause.isFailReason(reason)) {
    return reason.error;
  }
  if (Cause.isDieReason(reason)) return reason.defect;
  const interrupted = new Error("FLAC decoder input lane was interrupted", { cause: reason });
  interrupted.name = "AbortError";
  return interrupted;
}

function shallowCauseValues(value: unknown): ReadonlyArray<unknown> {
  // Cause payloads are opaque objects and may be cyclic. Retain the tagged
  // source error and its immediate payload by reference; never walk an error
  // graph while mapping a failed lane.
  if (value instanceof DecoderByteSourceError && "cause" in value) return [value, value.cause];
  return [value];
}

function inputCauseError(cause: Cause.Cause<unknown>): EngineWebAdapterError {
  const reasons = cause.reasons;
  const values = reasons.map(inputCauseValue);
  const primary = values[0];
  const mapped = decoderSourceError(primary);
  const preserved = new AggregateError(values.flatMap(shallowCauseValues), "FLAC decoder input lane failed");
  if (primary instanceof Error && primary.name === "AbortError") {
    return new EngineWebAdapterError("stem.cancelled", "FLAC decoder input lane was cancelled", {}, preserved);
  }
  return new EngineWebAdapterError(mapped.code, mapped.message, mapped.details, preserved);
}

function mergeInputCause(primary: unknown, exit: Exit.Exit<unknown, unknown>): unknown {
  if (Exit.isSuccess(exit)) return primary;
  const reasons = exit.cause.reasons.map(inputCauseValue);
  if (reasons.length === 0) return primary;
  const mapped = decoderSourceError(primary);
  return new EngineWebAdapterError(mapped.code, mapped.message, mapped.details,
    new AggregateError([...shallowCauseValues(primary), ...reasons.flatMap(shallowCauseValues)], "FLAC decoder input lane failed"));
}

/** Create the advanced low-level native-FLAC resolver used by session integration. */
export function createFlacStemResolver(options: FlacDeliveryOptions): StemResolver {
  // Worker construction is lazy. Snapshot policy and every asset URL now so a
  // caller cannot change the factory after package-owned digest trust is set.
  const assets = options.assets === undefined ? undefined : Object.fromEntries(
    (["scratchWorkerUrl", "flacWorkerUrl", "flacDecoderWasmUrl", "opfsWorkerUrl", "pumpWorkerUrl",
      "feedWorkletModuleUrl", "engineWasmUrl", "engineWorkletModuleUrl", "engineHostModuleUrl", "createWorker"] as const)
      .map(key => [key, options.assets![key]] as const).filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, key === "createWorker" && typeof value === "function"
        ? value.bind(options.assets) : value instanceof URL ? String(value) : value]),
  ) as AdapterAssetOverrides;
  return makeFlacStemResolver({ ...options,
    ...(assets === undefined ? {} : { assets }),
    ...(options.processing === undefined ? {} : { processing: { ...options.processing } }),
  });
}

/** @internal Test-only seam; it is intentionally absent from package entrypoints. */
export function createFlacStemResolverWithSource(options: FlacDeliveryOptions, sourceFactory: DecoderByteSourceFactory): StemResolver {
  return makeFlacStemResolver(options, undefined, undefined, undefined, undefined, sourceFactory);
}

export type DecoderByteSourceFactory = (options: DecoderByteSourceOptions) => DecoderByteSource;

/** A PCM block borrowed from the private chunk consumer. */
export interface BorrowedFlacPcm {
  readonly bytes: Uint8Array;
  readonly release: () => void;
}

/**
 * The private indexed-acquisition seam. It is deliberately not exported from
 * `./stems`; the full-response resolver owns the source factory and consumes
 * the borrowed stream one chunk at a time.
 */
export interface FlacChunkDecodeOptions extends Omit<FlacDeliveryOptions, "locate"> {
  readonly sourceFactory: DecoderByteSourceFactory;
  readonly diagnostics?: IngestDiagnostics;
  readonly workerPool?: FlacWorkerPool;
  readonly downloadAdmission?: BoundedStemAdmission;
  readonly verificationAdmission?: BoundedStemAdmission;
  /** Identity used for worker diagnostics and all operation failures. */
  readonly wholeSourceIdentity: StemIdentity;
  /** Shape of this packed chunk, independent of the whole source identity. */
  readonly chunk: Readonly<{
    readonly expected: import("./types.js").CanonicalPcmExpectation;
    /** Host-computed expected digest for this chunk's packed PCM. */
    readonly pcmSha256: string;
  }>;
}

export interface ResolvedFlacChunk {
  /** One borrowed block at a time; release returns the shared worker credit. */
  readonly output: ReadableStream<BorrowedFlacPcm>;
  readonly expectedFrames: number;
  readonly totalPcmBytes: number;
}

/** @internal Private same-controller invocation for indexed full-response acquisition. */
export function createFlacStemChunkResolver(options: FlacChunkDecodeOptions): {
  resolve(signal?: AbortSignal): Promise<ResolvedFlacChunk>;
} {
  if (!/^[a-f0-9]{64}$/u.test(options.chunk.pcmSha256)) {
    throw new RangeError("private FLAC chunk PCM digest must be lowercase SHA-256");
  }
  const configured = { ...options, locate: undefined as unknown as FlacLocator } as FlacDeliveryOptions;
  const resolver = makeFlacStemResolver(configured, options.diagnostics, options.workerPool,
    options.downloadAdmission, options.verificationAdmission, options.sourceFactory, {
    mode: "borrowed", wholeSourceIdentity: options.wholeSourceIdentity, chunk: options.chunk,
  });
  return {
    resolve(signal) {
      return resolver.resolve(options.wholeSourceIdentity, {
        ...(signal === undefined ? {} : { signal }), expected: options.chunk.expected,
      }).then(result => {
        const output = (result as ResolvedStem & { readonly output?: ReadableStream<BorrowedFlacPcm> }).output;
        if (output === undefined) throw new Error("private FLAC invocation did not expose borrowed output");
        return {
          output,
          expectedFrames: options.chunk.expected.frames,
          totalPcmBytes: options.chunk.expected.canonicalBytes,
        };
      });
    },
  };
}

interface FlacDecodeInvocation {
  readonly mode: "legacy" | "borrowed";
  readonly wholeSourceIdentity?: StemIdentity;
  readonly chunk?: FlacChunkDecodeOptions["chunk"];
}

function makeFlacStemResolver(options: FlacDeliveryOptions, diagnostics?: IngestDiagnostics, sharedPool?: FlacWorkerPool, sharedDownloads?: BoundedStemAdmission, sharedVerification?: BoundedStemAdmission, sourceFactory: DecoderByteSourceFactory = makeDecoderByteSource, invocation: FlacDecodeInvocation = { mode: "legacy" }): StemResolver {
  if (invocation.mode === "legacy" && typeof options.locate !== "function") throw new TypeError("createFlacStemResolver requires locate");
  const decodeNoProgressMs = options.decodeNoProgressMs ?? 30_000;
  if (!Number.isSafeInteger(decodeNoProgressMs) || decodeNoProgressMs < 1) {
    throw new RangeError("decodeNoProgressMs must be positive");
  }
  const widths = flacPipelineWidths(options);
  const downloads = sharedDownloads ?? new BoundedStemAdmission(widths.downloads);
  const verification = sharedVerification ?? new BoundedStemAdmission(widths.verification);
  configureProcessingDiagnostics(diagnostics, widths);
  const workerHashes = invocation.mode === "legacy" && options.processing !== undefined && options.createWorker === undefined &&
    options.assets?.createWorker === undefined && options.assets?.flacWorkerUrl === undefined &&
    options.assets?.flacDecoderWasmUrl === undefined;
  const poolOptions: FlacWorkerPoolOptions = {
    ...(options.processing === undefined ? {} : { processing: options.processing }),
    ...(options.admission === undefined ? {} : { admission: options.admission }),
    ...(options.assets === undefined ? {} : { assets: options.assets }),
    ...(options.createWorker === undefined ? {} : { createWorker: options.createWorker }),
    ...(options.hardwareConcurrency === undefined ? {} : { hardwareConcurrency: options.hardwareConcurrency }),
    ...(options.deviceMemory === undefined ? {} : { deviceMemory: options.deviceMemory }),
    ...(options.memoryBudgetBytes === undefined ? {} : { memoryBudgetBytes: options.memoryBudgetBytes }),
    ...(options.maximumWorkers === undefined ? {} : { maximumWorkers: options.maximumWorkers }),
  };
  const pool = sharedPool ?? new FlacWorkerPool(poolOptions);
  const resolver: StemResolver = {
    resolve(identity, resolveOptions = {}): Promise<ResolvedStem> {
      const parentIdentity = invocation.wholeSourceIdentity ?? identity;
      assertStemIdentity(parentIdentity);
      const controller = new AbortController();
      const requestId = nextRequestId++;
      let worker: FlacWorkerLike | undefined;
      let decoderInput: FlacInputSlotProducer | undefined;
      let ended = false;
      let failure: unknown;
      let verifiedDigest: string | undefined;
      let resumeConsumer: (() => void) | undefined;
      let runnable: ReturnType<typeof ownRunnableWorker>;
      const blocks: ArrayBuffer[] = [];
      let checkedOut: { readonly buffer: ArrayBuffer; readonly release: () => void } | undefined;
      let borrowOutput: ((buffer: ArrayBuffer) => BorrowedFlacPcm) | undefined;
      const retainRange = deliveredRangeOwner(diagnostics);
      const discardBlocks = () => {
        let block: ArrayBuffer | undefined;
        while ((block = blocks.shift()) !== undefined) releaseDecoded(block);
        checkedOut?.release();
      };
      let wake: (() => void) | undefined;
      const notify = () => { const current = wake; wake = undefined; current?.(); };
      let stopActive: ((error: unknown, sendCancel: boolean) => void) | undefined;
      const cancelled = (reason: unknown) => new EngineWebAdapterError(
        "stem.cancelled",
        "FLAC decode was cancelled",
        { identity },
        reason,
      );
      const cancel = (reason: unknown) => {
        const error = cancelled(reason);
        decoderInput?.abort();
        if (stopActive === undefined) {
          discardBlocks();
          controller.abort(error);
        } else stopActive(error, true);
      };
      const abort = () => cancel(resolveOptions.signal?.reason);
      if (resolveOptions.signal?.aborted) abort();
      else resolveOptions.signal?.addEventListener("abort", abort, { once: true });

      const workflow = pool.run({
        signal: controller.signal,
        onTerminated: () => { runnable?.release(); runnable = undefined; },
        ...(resolveOptions.onProgress === undefined ? {} : { onProgress: resolveOptions.onProgress }),
        work: (physical) => new Promise<void>((resolve, reject) => {
          const finishWorker = beginIngestStage(diagnostics, "workers");
          runnable = ownRunnableWorker(diagnostics);
          worker = physical;
          decoderInput = new FlacInputSlotProducer();
          let stopping = false;
          let decodedBytes = 0;
          let decodedFrames = 0;
          const hostPcmHash = invocation.chunk === undefined ? undefined : new IncrementalSha256();
          let networkPending = 0;
          const deliveryState: { totalBytes?: number; etag?: string } = {};
          type InputCommand =
            | { readonly type: "ready" }
            | { readonly type: "input-credit"; readonly message: Extract<FlacWorkerResponse, { type: "input-credit" }> }
            | { readonly type: "complete"; readonly message: Extract<FlacWorkerResponse, { type: "complete" }> };
          const inputQueue = Effect.runSync(Queue.bounded<InputCommand>(1));
          let inputLane: Promise<Exit.Exit<unknown, unknown>> = Promise.resolve(Exit.succeed(undefined));
          let acceptingInput = true;
          let terminal = false;
          // One operation-local owner spans range acquisition and the source
          // continuation. Delivery adopts before progress callbacks; this
          // scope releases if interruption wins before the source clears it.
          let currentBorrow: (() => void) | undefined;
          const adoptBorrow = (release: () => void) => {
            currentBorrow?.();
            currentBorrow = release;
          };
          const releaseBorrow = () => {
            const release = currentBorrow;
            currentBorrow = undefined;
            release?.();
          };
          let sourcePending = 0;
          let preparedMetadata: Readonly<{
            readonly streamInfo: import("./native-flac-metadata.js").NativeFlacStreamInfo;
            readonly expectedFrames: number;
            readonly totalPcmBytes: number;
          }> | undefined;
          let watchdog: ReturnType<typeof setTimeout> | undefined;
          const resetWatchdog = (phase: "decoder-load" | "metadata" | "frame" | "finish") => {
            if (watchdog !== undefined) clearTimeout(watchdog);
            watchdog = undefined;
            if (stopping || networkPending > 0 || sourcePending > 0 || blocks.length + (checkedOut === undefined ? 0 : 1) >= 2) return;
            watchdog = setTimeout(() => stop(new EngineWebAdapterError(
              "stem.decode.stall", `FLAC decoder made no progress for ${decodeNoProgressMs}ms`,
              { identity, phase, milliseconds: decodeNoProgressMs, retryable: false },
            ), true), decodeNoProgressMs);
          };
          const runSource = <A>(effect: Effect.Effect<A, DecoderByteSourceError>, phase: "metadata" | "frame" | "finish") =>
            Effect.gen(function*() {
              sourcePending += 1;
              resetWatchdog(phase);
              try { return yield* effect; }
              finally {
                sourcePending -= 1;
                resetWatchdog(phase);
              }
            });
          resumeConsumer = () => resetWatchdog("frame");
          const cleanup = () => {
            finishWorker();
            resumeConsumer = undefined;
            if (watchdog !== undefined) clearTimeout(watchdog);
            physical.removeEventListener("message", onMessage);
            physical.removeEventListener("error", onWorkerFailure);
            physical.removeEventListener("messageerror", onMessageError);
          };
          const stop = (error: unknown, sendCancel: boolean, successful = false, laneSettled = false) => {
            if (stopping) return;
            stopping = true;
            acceptingInput = false;
            stopActive = undefined;
            cleanup();
            if (!successful) {
              discardBlocks();
              decoderInput?.abort();
            }
            if (sendCancel) {
              try { physical.postMessage({ type: "cancel", requestId }); } catch { /* termination is authoritative */ }
            }
            if (!successful) controller.abort(error);
            if (!successful) physical.terminate();
            void inputLane.then((exit) => {
              if (successful) resolve(); else reject(laneSettled ? error : mergeInputCause(error, exit));
            });
          };
          stopActive = stop;
          const takeBorrowed = (buffer: ArrayBuffer): BorrowedFlacPcm => {
            let released = false;
            const owned = {
              buffer,
              release: () => {
                if (released) return;
                released = true;
                if (checkedOut?.buffer === buffer) checkedOut = undefined;
                releaseDecoded(buffer);
                // Completion closes production. A release racing terminal
                // settlement must never enqueue a late credit.
                if (!stopping && !terminal && worker === physical) {
                  try { physical.postMessage({ type: "output-credit", requestId }); } catch { /* terminal cleanup wins */ }
                }
                resumeConsumer?.();
              },
            };
            checkedOut = owned;
            return { bytes: new Uint8Array(buffer), release: owned.release };
          };
          borrowOutput = takeBorrowed;
          const onWorkerFailure = (event: ErrorEvent) => stop(new EngineWebAdapterError(
            "stem.decode.worker", event.message || "FLAC Worker stopped unexpectedly", {}, event.error,
          ), false);
          const onMessageError = () => stop(
            new EngineWebAdapterError("stem.decode.worker", "FLAC Worker reply could not be cloned"),
            false,
          );
          const range = (phase: "probe" | "metadata" | "audio", start: number, end: number) => {
            networkPending += 1;
            resetWatchdog("frame");
            return readExactFlacRangeEffect({
            locate: options.locate,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...(options.readDeadlineMs === undefined ? {} : { readDeadlineMs: options.readDeadlineMs }),
            ...(options.maximumAttempts === undefined ? {} : { maximumAttempts: options.maximumAttempts }),
            identity, phase, start, end, signal: controller.signal, state: deliveryState,
            retainRange, downloadAdmission: downloads,
            ...(diagnostics === undefined ? {} : { diagnostics }),
            ...(resolveOptions.onProgress === undefined ? {} : { onProgress: resolveOptions.onProgress }),
            onProduced: adoptBorrow,
            onActivity: () => resetWatchdog(phase === "audio" ? "frame" : phase === "metadata" ? "metadata" : "decoder-load"),
            }).pipe(
              Effect.ensuring(Effect.sync(() => {
                networkPending -= 1;
                resetWatchdog(phase === "audio" ? "frame" : "metadata");
              })),
            );
          };
          const inputProgram = Effect.scoped(Effect.gen(function*() {
            yield* Effect.addFinalizer(() => Effect.sync(releaseBorrow));
            const source = sourceFactory({
              identity,
              borrow: { adopt: adoptBorrow, release: releaseBorrow },
              range,
              ...(invocation.chunk?.expected ?? resolveOptions.expected) === undefined ? {} :
                { expected: invocation.chunk?.expected ?? resolveOptions.expected },
            });
            let initialized = false;
            for (;;) {
              const command = yield* Queue.take(inputQueue);
              if (command.type === "ready") {
                if (initialized) return yield* new DecoderByteSourceError({ operation: "prepare", message: "FLAC Worker sent ready twice" });
                preparedMetadata = yield* runSource(source.prepare, "metadata");
                if (invocation.chunk !== undefined && (
                  preparedMetadata.streamInfo.sampleRateHz !== invocation.chunk.expected.sampleRateHz ||
                  preparedMetadata.streamInfo.channels !== invocation.chunk.expected.channels ||
                  preparedMetadata.streamInfo.bitDepth !== invocation.chunk.expected.bitDepth ||
                  preparedMetadata.expectedFrames !== invocation.chunk.expected.frames ||
                  preparedMetadata.totalPcmBytes !== invocation.chunk.expected.canonicalBytes
                )) {
                  return yield* Effect.fail(new EngineWebAdapterError("stem.corrupt", "FLAC chunk preparation does not match its declared shape", {
                    identity, expectedFrames: invocation.chunk.expected.frames,
                    expectedPcmBytes: invocation.chunk.expected.canonicalBytes,
                  }));
                }
                initialized = true;
                try {
                  physical.postMessage({
                    type: "initialize", requestId, streamInfo: preparedMetadata.streamInfo,
                    expectedFrames: preparedMetadata.expectedFrames, totalPcmBytes: preparedMetadata.totalPcmBytes,
                  });
                } catch (cause) {
                  return yield* new DecoderByteSourceError({ operation: "prepare", message: "FLAC decoder initialization could not be sent", cause });
                }
                resetWatchdog("frame");
              } else if (command.type === "input-credit") {
                if (!initialized) return yield* new DecoderByteSourceError({ operation: "read", message: "FLAC Worker requested input before readiness" });
                const message = command.message;
                if (!Number.isSafeInteger(message.maximumBytes) || message.maximumBytes < 1 || message.maximumBytes > FLAC_INPUT_SLOT_BYTES) {
                  return yield* new DecoderByteSourceError({ operation: "read", message: "FLAC Worker requested invalid input credit" });
                }
                const result = yield* runSource(source.read(message.maximumBytes), "frame");
                try {
                  if (stopping || controller.signal.aborted) return;
                  if (result.bytes.byteLength < 1 || result.bytes.byteLength > message.maximumBytes || result.bytes.byteLength > FLAC_INPUT_SLOT_BYTES) {
                    return yield* new DecoderByteSourceError({ operation: "read", message: "FLAC decoder input exceeded its credit" });
                  }
                  decoderInput!.publish(result.bytes, result.end);
                  resetWatchdog("frame");
                } finally { result.release(); }
              } else {
                if (!initialized) return yield* new DecoderByteSourceError({ operation: "finish", message: "FLAC Worker completed before readiness" });
                const message = command.message;
                if (message.pcmBytes !== decodedBytes || message.frames !== decodedFrames ||
                  (options.processing !== undefined && (decodedBytes !== preparedMetadata!.totalPcmBytes || decodedFrames !== preparedMetadata!.expectedFrames)) ||
                  (invocation.chunk !== undefined && (decodedBytes !== invocation.chunk.expected.canonicalBytes || decodedFrames !== invocation.chunk.expected.frames ||
                    hostPcmHash?.digestHex() !== invocation.chunk.pcmSha256)) ||
                  (workerHashes && (message.digest !== identity.slice(7) || !/^[a-f0-9]{64}$/u.test(message.digest)))) {
                  return yield* Effect.fail(new EngineWebAdapterError("stem.corrupt", "FLAC Worker completion does not verify canonical PCM", { identity }));
                }
                if (message.metrics !== undefined) recordWorkerProcessing(diagnostics, message.metrics);
                if (workerHashes) verifiedDigest = message.digest;
                yield* runSource(source.finish, "finish");
                return;
              }
            }
          }));
          const enqueue = (command: InputCommand) => {
            if (!Queue.offerUnsafe(inputQueue, command)) {
              stop(new EngineWebAdapterError("stem.decode.worker", "FLAC Worker input-command queue overflow", {
                identity, limit: 1,
              }), true);
            }
          };
          const onMessage = (event: MessageEvent<FlacWorkerResponse>) => {
            const message = event.data;
            if (stopping || message.requestId !== requestId) return;
            resetWatchdog(message.type === "ready" ? "metadata" : message.type === "complete" ? "finish" : "frame");
            if (message.type === "ready") {
              if (terminal) {
                stop(new EngineWebAdapterError("stem.decode.worker", "FLAC Worker sent readiness after completion", { identity }), true);
                return;
              }
              enqueue({ type: "ready" });
            } else if (message.type === "input-credit") {
              if (!acceptingInput || terminal) {
                stop(new EngineWebAdapterError("stem.decode.worker", "FLAC Worker requested input after completion", { identity }), true);
                return;
              }
              enqueue({ type: "input-credit", message });
            } else if (message.type === "pcm") {
              const expected = invocation.chunk?.expected;
              const frameBytes = expected === undefined ? 0 : expected.channels * (expected.bitDepth / 8);
              if (terminal || !(message.bytes instanceof ArrayBuffer) || message.bytes.byteLength < 1 ||
                message.bytes.byteLength > MAXIMUM_CANONICAL_OUTPUT_BYTES ||
                blocks.length + (checkedOut === undefined ? 0 : 1) >= 2 ||
                (expected !== undefined && (!Number.isSafeInteger(message.frames) || message.frames < 1 ||
                  frameBytes < 1 || message.bytes.byteLength % frameBytes !== 0 ||
                  message.frames !== message.bytes.byteLength / frameBytes))) {
                stop(new EngineWebAdapterError("stem.decode.worker", "FLAC Worker exceeded two unconsumed PCM outputs", {
                  identity, limit: 2,
                }), true);
                return;
              }
              retainDecoded(diagnostics, message.bytes);
              hostPcmHash?.update(message.bytes);
              blocks.push(message.bytes);
              decodedBytes += message.bytes.byteLength;
              decodedFrames += message.frames;
              if (message.metrics !== undefined) recordWorkerProcessing(diagnostics, message.metrics);
              resetWatchdog("frame");
              resolveOptions.onProgress?.({
                stage: "decoding", identity, bytes: decodedBytes,
                totalBytes: message.totalPcmBytes,
                byteKind: "pcm",
              });
              notify();
            } else if (message.type === "complete") {
              if (terminal) {
                stop(new EngineWebAdapterError("stem.decode.worker", "FLAC Worker sent completion twice", { identity }), true);
                return;
              }
              terminal = true;
              acceptingInput = false;
              enqueue({ type: "complete", message });
            } else if (message.type === "error") {
              stop(workerError(message), false);
            }
          };
          physical.addEventListener("message", onMessage);
          physical.addEventListener("error", onWorkerFailure);
          physical.addEventListener("messageerror", onMessageError);
          inputLane = Effect.runPromiseExit(inputProgram, { signal: controller.signal }).then((exit) => {
            if (Exit.isSuccess(exit)) {
              if (!stopping) stop(undefined, false, true);
            } else if (!stopping) {
              stop(inputCauseError(exit.cause), true, false, true);
            }
            return exit;
          });
          resetWatchdog("decoder-load");
          try {
            physical.postMessage({
              type: "start", requestId, identity,
              decoderWasmUrl: String(options.assets?.flacDecoderWasmUrl ?? ADAPTER_ASSETS.flacDecoderWasm),
              inputSlot: decoderInput!.buffers,
              verifyPcm: workerHashes,
              ...(runnable === undefined ? {} : { runnable: runnable.buffer, runnableMask: runnable.mask }),
              ...(invocation.chunk === undefined && resolveOptions.expected === undefined ? {} :
                { expected: invocation.chunk?.expected ?? resolveOptions.expected }),
            });
          } catch (error) { stop(error, false); }
        }),
      }).then(() => {
        worker = undefined;
        ended = true;
        notify();
      }, (error) => {
        worker = undefined;
        failure = error;
        discardBlocks();
        notify();
      }).finally(() => {
        resolveOptions.signal?.removeEventListener("abort", abort);
      });

      const stream = invocation.mode === "legacy" ? new ReadableStream<Uint8Array>({
        cancel(reason) { cancel(reason); return workflow; },
        async pull(streamController) {
          for (;;) {
            const block = blocks.shift();
            if (block !== undefined) {
              try {
                streamController.enqueue(new Uint8Array(block));
              } catch (error) { releaseDecoded(block); throw error; }
              worker?.postMessage({ type: "output-credit", requestId });
              resumeConsumer?.();
              return;
            }
            if (failure !== undefined) throw failure;
            if (ended) { streamController.close(); return; }
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        },
      }, { highWaterMark: 0 }) : undefined;
      const output = invocation.mode === "borrowed" ? new ReadableStream<BorrowedFlacPcm>({
        cancel(reason) { cancel(reason); return workflow; },
        async pull(streamController) {
          for (;;) {
            const block = blocks.shift();
            if (block !== undefined) {
              try { streamController.enqueue(borrowOutput!(block)); }
              catch (error) { releaseDecoded(block); throw error; }
              return;
            }
            if (failure !== undefined) throw failure;
            if (ended) { streamController.close(); return; }
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        },
      }, { highWaterMark: 0 }) : undefined;
      const resolved = {
        ...(stream === undefined ? {} : { stream }),
        ...(output === undefined ? {} : { output }),
        ...((invocation.chunk?.expected ?? resolveOptions.expected) === undefined ? {} :
          { canonicalBytes: (invocation.chunk?.expected ?? resolveOptions.expected)!.canonicalBytes }),
      } as ResolvedStem & { readonly output?: ReadableStream<BorrowedFlacPcm> };
      if (stream !== undefined) registerFlacResult(resolved, workerHashes ? () => verifiedDigest : undefined);
      return Promise.resolve(resolved);
    },
  };
  registerFlacResolver(resolver, collector => makeFlacStemResolver(options, collector, pool, downloads, verification, sourceFactory, invocation),
    options.processing === undefined ? undefined : { limit: widths.processing, verification });
  return resolver;
}
