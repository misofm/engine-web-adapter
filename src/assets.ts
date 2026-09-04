export const ADAPTER_ASSET_FILES = Object.freeze({
  scratchWorker: "./internal/engine-web-scratch-worker.js",
  pumpWorker: "./internal/engine-web-pcm-pump-worker.js",
  feedWorkletModule: "./internal/engine-web-feed-worklet.js",
} as const);

/** Package-relative deployment URLs; bundlers may rewrite these exact literals. */
export const ADAPTER_ASSETS = Object.freeze({
  scratchWorker: new URL("./internal/engine-web-scratch-worker.js", import.meta.url),
  pumpWorker: new URL("./internal/engine-web-pcm-pump-worker.js", import.meta.url),
  feedWorkletModule: new URL("./internal/engine-web-feed-worklet.js", import.meta.url),
});

export interface AdapterAssetOverrides {
  readonly scratchWorkerUrl?: string | URL;
  readonly pumpWorkerUrl?: string | URL;
  readonly feedWorkletModuleUrl?: string | URL;
  readonly engineWasmUrl?: string | URL;
  readonly engineWorkletModuleUrl?: string | URL;
  readonly engineHostModuleUrl?: string | URL;
  readonly createWorker?: (
    url: string | URL,
    options: WorkerOptions & { readonly type: "module" },
  ) => Worker;
}

export function createScratchWorker(overrides: AdapterAssetOverrides = {}): Worker {
  if (overrides.createWorker !== undefined) {
    return overrides.createWorker(overrides.scratchWorkerUrl ?? ADAPTER_ASSETS.scratchWorker, {
      type: "module",
    });
  }
  if (overrides.scratchWorkerUrl !== undefined) {
    return new Worker(overrides.scratchWorkerUrl, { type: "module" });
  }
  return new Worker(new URL("./internal/engine-web-scratch-worker.js", import.meta.url), {
    type: "module",
  });
}

export function createPumpWorker(overrides: AdapterAssetOverrides = {}): Worker {
  if (overrides.createWorker !== undefined) {
    return overrides.createWorker(overrides.pumpWorkerUrl ?? ADAPTER_ASSETS.pumpWorker, {
      type: "module",
    });
  }
  if (overrides.pumpWorkerUrl !== undefined) {
    return new Worker(overrides.pumpWorkerUrl, { type: "module" });
  }
  return new Worker(new URL("./internal/engine-web-pcm-pump-worker.js", import.meta.url), {
    type: "module",
  });
}
