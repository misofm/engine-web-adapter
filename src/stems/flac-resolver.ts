import { deliveredRangeOwner, registerFlacResolver, releaseDecoded, retainDecoded, type IngestDiagnostics } from "./ingest-diagnostics.js";
import { MAXIMUM_CANONICAL_OUTPUT_BYTES } from "./native-flac-decoder.js";
import { EngineWebAdapterError } from "../errors.js";
import { ADAPTER_ASSETS, type AdapterAssetOverrides } from "../assets.js";
import type { BoundedStemAdmission } from "./flac-admission.js";
import { assertStemIdentity } from "./identity.js";
import { readExactFlacRange, type FlacLocator } from "./flac-delivery.js";
import { FLAC_INPUT_SLOT_BYTES, FlacInputSlotProducer } from "./flac-input-slot.js";
import { FlacWorkerPool, type FlacWorkerPoolOptions } from "./flac-worker-pool.js";
import {
  NativeFlacMetadataScanner,
  NATIVE_FLAC_STREAMINFO_PROBE_BYTES,
  parseNativeFlacStreamInfo,
} from "./native-flac-metadata.js";
import type { FlacWorkerLike, FlacWorkerResponse } from "./flac-worker-protocol.js";
import type { ResolvedStem, StemIdentity, StemProgress, StemResolver } from "./types.js";

export interface FlacDeliveryOptions {
  readonly locate: FlacLocator;
  /** Optional shared admission used to bound both decode and cache verification. */
  readonly admission?: BoundedStemAdmission;
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

/** Create the advanced low-level native-FLAC resolver used by session integration. */
export function createFlacStemResolver(options: FlacDeliveryOptions): StemResolver {
  return makeFlacStemResolver(options);
}

function makeFlacStemResolver(options: FlacDeliveryOptions, diagnostics?: IngestDiagnostics, sharedPool?: FlacWorkerPool): StemResolver {
  if (typeof options.locate !== "function") throw new TypeError("createFlacStemResolver requires locate");
  const decodeNoProgressMs = options.decodeNoProgressMs ?? 30_000;
  if (!Number.isSafeInteger(decodeNoProgressMs) || decodeNoProgressMs < 1) {
    throw new RangeError("decodeNoProgressMs must be positive");
  }
  const poolOptions: FlacWorkerPoolOptions = {
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
      assertStemIdentity(identity);
      const controller = new AbortController();
      const requestId = nextRequestId++;
      let worker: FlacWorkerLike | undefined;
      let decoderInput: FlacInputSlotProducer | undefined;
      let ended = false;
      let failure: unknown;
      const blocks: ArrayBuffer[] = [];
      const retainRange = deliveredRangeOwner(diagnostics);
      const discardBlocks = () => {
        let block: ArrayBuffer | undefined;
        while ((block = blocks.shift()) !== undefined) releaseDecoded(block);
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
        discardBlocks();
        decoderInput?.abort();
        if (stopActive === undefined) controller.abort(error);
        else stopActive(error, true);
      };
      const abort = () => cancel(resolveOptions.signal?.reason);
      if (resolveOptions.signal?.aborted) abort();
      else resolveOptions.signal?.addEventListener("abort", abort, { once: true });

      const workflow = pool.run({
        signal: controller.signal,
        ...(resolveOptions.onProgress === undefined ? {} : { onProgress: resolveOptions.onProgress }),
        work: (physical) => new Promise<void>((resolve, reject) => {
          worker = physical;
          decoderInput = new FlacInputSlotProducer();
          let stopping = false;
          let offset = 0;
          let totalBytes: number | undefined;
          let decodedBytes = 0;
          const deliveryState: { totalBytes?: number; etag?: string } = {};
          let inputTail = Promise.resolve();
          let watchdog: ReturnType<typeof setTimeout> | undefined;
          const resetWatchdog = (phase: "decoder-load" | "metadata" | "frame" | "finish") => {
            if (stopping) return;
            if (watchdog !== undefined) clearTimeout(watchdog);
            watchdog = setTimeout(() => stop(new EngineWebAdapterError(
              "stem.decode.stall", `FLAC decoder made no progress for ${decodeNoProgressMs}ms`,
              { identity, phase, milliseconds: decodeNoProgressMs, retryable: false },
            ), true), decodeNoProgressMs);
          };
          const cleanup = () => {
            if (watchdog !== undefined) clearTimeout(watchdog);
            physical.removeEventListener("message", onMessage);
            physical.removeEventListener("error", onWorkerFailure);
            physical.removeEventListener("messageerror", onMessageError);
          };
          const stop = (error: unknown, sendCancel: boolean, successful = false) => {
            if (stopping) return;
            stopping = true;
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
            void inputTail.then(() => {
              if (successful) resolve(); else reject(error);
            });
          };
          stopActive = stop;
          const onWorkerFailure = (event: ErrorEvent) => stop(new EngineWebAdapterError(
            "stem.decode.worker", event.message || "FLAC Worker stopped unexpectedly", {}, event.error,
          ), false);
          const onMessageError = () => stop(
            new EngineWebAdapterError("stem.decode.worker", "FLAC Worker reply could not be cloned"),
            false,
          );
          const range = (phase: "probe" | "metadata" | "audio", start: number, end: number) => readExactFlacRange({
            locate: options.locate,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...(options.readDeadlineMs === undefined ? {} : { readDeadlineMs: options.readDeadlineMs }),
            ...(options.maximumAttempts === undefined ? {} : { maximumAttempts: options.maximumAttempts }),
            identity, phase, start, end, signal: controller.signal, state: deliveryState,
            retainRange,
            ...(resolveOptions.onProgress === undefined ? {} : { onProgress: resolveOptions.onProgress }),
            onActivity: () => resetWatchdog(phase === "audio" ? "frame" : phase === "metadata" ? "metadata" : "decoder-load"),
          });
          const prepare = async () => {
            const parsed = await (async () => {
              const probe = await range("probe", 0, NATIVE_FLAC_STREAMINFO_PROBE_BYTES - 1);
              try {
                totalBytes = probe.totalBytes;
                return parseNativeFlacStreamInfo(probe.bytes, resolveOptions.expected);
              } finally { probe.release(); }
            })();
            const scanner = new NativeFlacMetadataScanner(parsed.streamInfoIsFinal);
            offset = NATIVE_FLAC_STREAMINFO_PROBE_BYTES;
            while (!scanner.complete) {
              const header = await range("metadata", scanner.nextHeaderOffset, scanner.nextHeaderOffset + 3);
              try { offset = scanner.acceptHeader(header.bytes, header.totalBytes).nextOffset; }
              finally { header.release(); }
            }
            if (totalBytes === undefined || offset >= totalBytes) throw new EngineWebAdapterError("stem.flac.invalid", "FLAC has no compressed audio suffix");
            const expectedFrames = resolveOptions.expected?.frames ?? parsed.streamInfo.totalSamples;
            if (expectedFrames === 0) {
              throw new EngineWebAdapterError("stem.flac.shape", "Unknown FLAC total samples require a compiled source declaration");
            }
            const totalPcmBytes = resolveOptions.expected?.canonicalBytes ??
              expectedFrames * parsed.streamInfo.channels * (parsed.streamInfo.bitDepth / 8);
            physical.postMessage({
              type: "initialize", requestId, streamInfo: parsed.streamInfo, expectedFrames, totalPcmBytes,
            });
            resetWatchdog("frame");
          };
          const handleCredit = async (message: Extract<FlacWorkerResponse, { type: "input-credit" }>) => {
            if (stopping) return;
            if (totalBytes === undefined || offset >= totalBytes) throw new EngineWebAdapterError("stem.decode.worker", "FLAC Worker requested input outside the audio suffix");
            if (!Number.isSafeInteger(message.maximumBytes) || message.maximumBytes < 1 || message.maximumBytes > FLAC_INPUT_SLOT_BYTES) {
              throw new EngineWebAdapterError("stem.decode.worker", "FLAC Worker requested invalid input credit");
            }
            const length = Math.min(message.maximumBytes, totalBytes - offset);
            const result = await range("audio", offset, offset + length - 1);
            try {
              if (stopping || controller.signal.aborted) return;
              offset += result.bytes.byteLength;
              decoderInput!.publish(result.bytes, offset === totalBytes);
              resetWatchdog("frame");
            } finally { result.release(); }
          };
          const onMessage = (event: MessageEvent<FlacWorkerResponse>) => {
            const message = event.data;
            if (stopping || message.requestId !== requestId) return;
            resetWatchdog(message.type === "ready" ? "metadata" : message.type === "complete" ? "finish" : "frame");
            if (message.type === "ready") {
              const input = inputTail.then(prepare);
              inputTail = input.catch(() => undefined);
              void input.catch((error) => stop(error, true));
            } else if (message.type === "input-credit") {
              const input = inputTail.then(() => handleCredit(message));
              inputTail = input.catch(() => undefined);
              void input.catch((error) => stop(error, true));
            } else if (message.type === "pcm") {
              if (!(message.bytes instanceof ArrayBuffer) || message.bytes.byteLength > MAXIMUM_CANONICAL_OUTPUT_BYTES || blocks.length >= 2) {
                stop(new EngineWebAdapterError("stem.decode.worker", "FLAC Worker exceeded two unconsumed PCM outputs", {
                  identity, limit: 2,
                }), true);
                return;
              }
              retainDecoded(diagnostics, message.bytes);
              blocks.push(message.bytes);
              decodedBytes += message.bytes.byteLength;
              resolveOptions.onProgress?.({
                stage: "decoding", identity, bytes: decodedBytes,
                totalBytes: message.totalPcmBytes,
                byteKind: "pcm",
              });
              notify();
            } else if (message.type === "complete") {
              stop(undefined, false, true);
            } else if (message.type === "error") {
              stop(workerError(message), false);
            }
          };
          physical.addEventListener("message", onMessage);
          physical.addEventListener("error", onWorkerFailure);
          physical.addEventListener("messageerror", onMessageError);
          resetWatchdog("decoder-load");
          try {
            physical.postMessage({
              type: "start", requestId, identity,
              decoderWasmUrl: String(options.assets?.flacDecoderWasmUrl ?? ADAPTER_ASSETS.flacDecoderWasm),
              inputSlot: decoderInput!.buffers,
              ...(resolveOptions.expected === undefined ? {} : { expected: resolveOptions.expected }),
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

      const stream = new ReadableStream<Uint8Array>({
        cancel(reason) { cancel(reason); return workflow; },
        async pull(streamController) {
          for (;;) {
            const block = blocks.shift();
            if (block !== undefined) {
              try {
                streamController.enqueue(new Uint8Array(block));
              } catch (error) { releaseDecoded(block); throw error; }
              worker?.postMessage({ type: "output-credit", requestId });
              return;
            }
            if (failure !== undefined) throw failure;
            if (ended) { streamController.close(); return; }
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        },
      }, { highWaterMark: 0 });
      return Promise.resolve({
        stream,
        ...(resolveOptions.expected === undefined ? {} : { canonicalBytes: resolveOptions.expected.canonicalBytes }),
      });
    },
  };
  registerFlacResolver(resolver, collector => makeFlacStemResolver(options, collector, pool));
  return resolver;
}
