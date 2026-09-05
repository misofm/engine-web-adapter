import { BrowserBootError, scratchBootWithWorker as scratchSdkWorker } from "@misofm/engine/browser";
import type { BootOptions, SessionShape } from "@misofm/engine";
import type { AdapterAssetOverrides } from "./assets.js";
import { EngineWebAdapterError } from "./errors.js";

/** One package-owned scratch boot, retaining the adapter's deployment overrides. */
export async function scratchBootWithWorker(options: {
  readonly document: Uint8Array;
  readonly options: BootOptions;
  readonly moduleUrl: string | URL;
  readonly assets?: AdapterAssetOverrides;
  readonly signal?: AbortSignal;
  readonly requestDeadlineMs?: number;
}): Promise<SessionShape> {
  const factory = options.assets?.createWorker;
  const workerUrl = options.assets?.scratchWorkerUrl;
  try {
    return await scratchSdkWorker({
      document: options.document, options: options.options, moduleUrl: options.moduleUrl,
      ...(workerUrl === undefined ? {} : { scratchWorkerModuleUrl: String(workerUrl) }),
      ...(factory === undefined ? {} : { createWorker: (url, settings) => factory(workerUrl ?? url, settings) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.requestDeadlineMs === undefined ? {} : { requestDeadlineMs: options.requestDeadlineMs }),
    });
  } catch (error) {
    if (error instanceof BrowserBootError) {
      const code = error.operation === "scratch-deadline" ? "session.open" : "capability.module_worker";
      throw new EngineWebAdapterError(code, error.message, { operation: error.operation }, error);
    }
    throw error;
  }
}
