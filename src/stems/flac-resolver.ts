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
      const abort = () => controller.abort(resolveOptions.signal?.reason);
      if (resolveOptions.signal?.aborted) abort();
      else resolveOptions.signal?.addEventListener("abort", abort, { once: true });
      const requestId = nextRequestId++;
      let worker: FlacWorkerLike | undefined;
      let ended = false;
      let failure: unknown;
      const blocks: ArrayBuffer[] = [];
      let wake: (() => void) | undefined;
      const notify = () => { const current = wake; wake = undefined; current?.(); };

      const workflow = pool.run({
        signal: controller.signal,
        ...(resolveOptions.onProgress === undefined ? {} : { onProgress: resolveOptions.onProgress }),
        work: (physical) => new Promise<void>((resolve, reject) => {
          worker = physical;
          let settled = false;
          let offset = 0;
          let totalBytes: number | undefined;
          const deliveryState: { totalBytes?: number; etag?: string } = {};
          let inputTail = Promise.resolve();
          const settle = (error?: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error === undefined) resolve(); else reject(error);
          };
          const onAbort = () => {
            try { physical.postMessage({ type: "cancel", requestId }); } catch { /* termination is authoritative */ }
            settle(new EngineWebAdapterError("stem.cancelled", "FLAC decode was cancelled", {}, controller.signal.reason));
          };
          const onWorkerFailure = (event: ErrorEvent) => settle(new EngineWebAdapterError(
            "stem.decode.worker", event.message || "FLAC Worker stopped unexpectedly", {}, event.error,
          ));
          const onMessageError = () => settle(new EngineWebAdapterError("stem.decode.worker", "FLAC Worker reply could not be cloned"));
          const cleanup = () => {
            controller.signal.removeEventListener("abort", onAbort);
            physical.removeEventListener("message", onMessage);
            physical.removeEventListener("error", onWorkerFailure);
            physical.removeEventListener("messageerror", onMessageError);
          };
          const handleCredit = async (message: Extract<FlacWorkerResponse, { type: "input-credit" }>) => {
            if (settled) return;
            if (totalBytes !== undefined && offset === totalBytes) {
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
            totalBytes = result.totalBytes;
            offset += result.bytes.byteLength;
            const bytes = result.bytes.buffer as ArrayBuffer;
            physical.postMessage({ type: "input", requestId, bytes, totalFlacBytes: totalBytes }, [bytes]);
          };
          const onMessage = (event: MessageEvent<FlacWorkerResponse>) => {
            const message = event.data;
            if (settled || message.requestId !== requestId) return;
            if (message.type === "input-credit") {
              inputTail = inputTail.then(() => handleCredit(message)).catch((error) => {
                try { physical.postMessage({ type: "cancel", requestId }); } catch { /* terminate below */ }
                settle(error);
              });
            } else if (message.type === "pcm") {
              blocks.push(message.bytes);
              resolveOptions.onProgress?.({
                stage: "decoding", identity, bytes: blocks.reduce((sum, block) => sum + block.byteLength, 0),
                totalBytes: message.totalPcmBytes,
                byteKind: "pcm",
              });
              notify();
            } else if (message.type === "complete") {
              ended = true;
              notify();
              settle();
            } else if (message.type === "error") {
              const error = workerError(message);
              failure = error;
              notify();
              settle(error);
            }
          };
          controller.signal.addEventListener("abort", onAbort, { once: true });
          physical.addEventListener("message", onMessage);
          physical.addEventListener("error", onWorkerFailure);
          physical.addEventListener("messageerror", onMessageError);
          try {
            physical.postMessage({
              type: "start", requestId, identity,
              ...(resolveOptions.expected === undefined ? {} : { expected: resolveOptions.expected }),
            });
          } catch (error) { settle(error); }
        }),
      }).catch((error) => {
        failure = error;
        notify();
      }).finally(() => {
        worker = undefined;
        resolveOptions.signal?.removeEventListener("abort", abort);
      });

      const stream = new ReadableStream<Uint8Array>({
        cancel(reason) { controller.abort(reason); return workflow; },
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
