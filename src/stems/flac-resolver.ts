import type { Layer } from "effect";
import type { HttpClient } from "effect/unstable/http";

import { EngineWebAdapterError } from "../errors.js";
import type { AdapterAssetOverrides } from "../assets.js";
import type { BoundedStemAdmission } from "./flac-admission.js";
import { assertStemIdentity } from "./identity.js";
import { readExactFlacRange, type FlacLocator } from "./flac-delivery.js";
import { MAXIMUM_DELIVERY_CHUNK_BYTES } from "./flac-metadata.js";
import { FlacWorkerPool, type FlacWorkerPoolOptions } from "./flac-worker-pool.js";
import type { FlacWorkerLike, FlacWorkerResponse } from "./flac-worker-protocol.js";
import type { ResolvedStem, StemIdentity, StemProgress, StemResolver } from "./types.js";

export interface FlacDeliveryOptions {
  readonly locate: FlacLocator;
  /** Optional shared admission used to bound both decode and cache verification. */
  readonly admission?: BoundedStemAdmission;
  readonly httpClient?: HttpClient.HttpClient;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly readDeadlineMs?: number;
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

/** Create the advanced low-level dense-FLAC resolver used by session integration. */
export function createFlacStemResolver(options: FlacDeliveryOptions): StemResolver {
  if (typeof options.locate !== "function") throw new TypeError("createFlacStemResolver requires locate");
  const poolOptions: FlacWorkerPoolOptions = {
    ...(options.admission === undefined ? {} : { admission: options.admission }),
    ...(options.assets === undefined ? {} : { assets: options.assets }),
    ...(options.createWorker === undefined ? {} : { createWorker: options.createWorker }),
    ...(options.hardwareConcurrency === undefined ? {} : { hardwareConcurrency: options.hardwareConcurrency }),
    ...(options.deviceMemory === undefined ? {} : { deviceMemory: options.deviceMemory }),
    ...(options.memoryBudgetBytes === undefined ? {} : { memoryBudgetBytes: options.memoryBudgetBytes }),
    ...(options.maximumWorkers === undefined ? {} : { maximumWorkers: options.maximumWorkers }),
  };
  const pool = new FlacWorkerPool(poolOptions);
  return {
    resolve(identity, resolveOptions = {}): Promise<ResolvedStem> {
      assertStemIdentity(identity);
      const controller = new AbortController();
      const requestId = nextRequestId++;
      let worker: FlacWorkerLike | undefined;
      let ended = false;
      let failure: unknown;
      const blocks: ArrayBuffer[] = [];
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
          let stopping = false;
          let offset = 0;
          let totalBytes: number | undefined;
          const deliveryState: { totalBytes?: number; etag?: string } = {};
          let inputTail = Promise.resolve();
          const cleanup = () => {
            physical.removeEventListener("message", onMessage);
            physical.removeEventListener("error", onWorkerFailure);
            physical.removeEventListener("messageerror", onMessageError);
          };
          const stop = (error: unknown, sendCancel: boolean, successful = false) => {
            if (stopping) return;
            stopping = true;
            stopActive = undefined;
            cleanup();
            if (sendCancel) {
              try { physical.postMessage({ type: "cancel", requestId }); } catch { /* termination is authoritative */ }
            }
            if (!successful) controller.abort(error);
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
          const handleCredit = async (message: Extract<FlacWorkerResponse, { type: "input-credit" }>) => {
            if (stopping) return;
            if (totalBytes !== undefined && offset === totalBytes) {
              if (stopping) return;
              physical.postMessage({ type: "finish", requestId });
              return;
            }
            if (!Number.isSafeInteger(message.maximumBytes) || message.maximumBytes < 1 || message.maximumBytes > MAXIMUM_DELIVERY_CHUNK_BYTES) {
              throw new EngineWebAdapterError("stem.decode.worker", "FLAC Worker requested invalid input credit");
            }
            const length = totalBytes === undefined ? message.maximumBytes : Math.min(message.maximumBytes, totalBytes - offset);
            const result = await readExactFlacRange({
              locate: options.locate,
              ...(options.httpClient === undefined ? {} : { httpClient: options.httpClient }),
              ...(options.httpClientLayer === undefined ? {} : { httpClientLayer: options.httpClientLayer }),
              ...(options.readDeadlineMs === undefined ? {} : { readDeadlineMs: options.readDeadlineMs }),
              ...(options.maximumAttempts === undefined ? {} : { maximumAttempts: options.maximumAttempts }),
              identity,
              phase: message.phase,
              start: offset,
              end: offset + length - 1,
              signal: controller.signal,
              state: deliveryState,
              ...(resolveOptions.onProgress === undefined ? {} : { onProgress: resolveOptions.onProgress }),
            });
            if (stopping || controller.signal.aborted) return;
            totalBytes = result.totalBytes;
            offset += result.bytes.byteLength;
            const bytes = result.bytes.buffer as ArrayBuffer;
            if (stopping || controller.signal.aborted) return;
            physical.postMessage({ type: "input", requestId, bytes, totalFlacBytes: totalBytes }, [bytes]);
          };
          const onMessage = (event: MessageEvent<FlacWorkerResponse>) => {
            const message = event.data;
            if (stopping || message.requestId !== requestId) return;
            if (message.type === "input-credit") {
              const input = inputTail.then(() => handleCredit(message));
              inputTail = input.catch(() => undefined);
              void input.catch((error) => stop(error, true));
            } else if (message.type === "pcm") {
              blocks.push(message.bytes);
              resolveOptions.onProgress?.({
                stage: "decoding", identity, bytes: blocks.reduce((sum, block) => sum + block.byteLength, 0),
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
          try {
            physical.postMessage({
              type: "start", requestId, identity,
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
              streamController.enqueue(new Uint8Array(block));
              worker?.postMessage({ type: "output-credit", requestId });
              return;
            }
            if (failure !== undefined) throw failure;
            if (ended) { streamController.close(); return; }
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        },
      });
      return Promise.resolve({
        stream,
        ...(resolveOptions.expected === undefined ? {} : { canonicalBytes: resolveOptions.expected.canonicalBytes }),
      });
    },
  };
}
