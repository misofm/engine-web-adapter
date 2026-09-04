import type { BootOptions, SessionShape } from "@misofm/engine";

import { createScratchWorker } from "./assets.js";
import type { AdapterAssetOverrides } from "./assets.js";
import { EngineWebAdapterError } from "./errors.js";

export interface ScratchBootRequest {
  readonly type: "scratch";
  readonly requestId: number;
  readonly moduleUrl: string;
  readonly document: Uint8Array;
  readonly options: BootOptions;
}
export type ScratchBootReply =
  | { readonly type: "scratch-result"; readonly requestId: number; readonly ok: true; readonly shape: SessionShape }
  | { readonly type: "scratch-result"; readonly requestId: number; readonly ok: false; readonly error: { readonly name: string; readonly message: string } };

export async function scratchBootWithWorker(options: {
  readonly document: Uint8Array;
  readonly options: BootOptions;
  readonly moduleUrl: string | URL;
  readonly assets?: AdapterAssetOverrides;
  readonly signal?: AbortSignal;
}): Promise<SessionShape> {
  options.signal?.throwIfAborted();
  let worker: Worker;
  try {
    worker = createScratchWorker(options.assets);
  } catch (error) {
    throw new EngineWebAdapterError("capability.module_worker", "Scratch module Worker could not start", {}, error);
  }
  return new Promise<SessionShape>((resolve, reject) => {
    const requestId = 1;
    const abort = () => finish(() => reject(options.signal?.reason ?? new DOMException("Scratch boot aborted", "AbortError")));
    const error = (event: ErrorEvent) => finish(() => reject(event.error ?? new Error(event.message)));
    const message = (event: MessageEvent<ScratchBootReply>) => {
      if (event.data.requestId !== requestId) return;
      finish(() => event.data.ok ? resolve(event.data.shape) : reject(Object.assign(new Error(event.data.error.message), { name: event.data.error.name })));
    };
    function finish(settle: () => void) {
      options.signal?.removeEventListener("abort", abort);
      worker.removeEventListener("error", error);
      worker.removeEventListener("message", message);
      worker.terminate();
      settle();
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.addEventListener("error", error);
    worker.addEventListener("message", message);
    worker.postMessage({
      type: "scratch", requestId, moduleUrl: String(options.moduleUrl),
      document: options.document, options: options.options,
    } satisfies ScratchBootRequest);
  });
}
