import { BUNDLED_ENGINE_ASSETS } from "@misofm/engine/assets";

export const ADAPTER_ASSET_FILES = Object.freeze({
  scratchWorker: BUNDLED_ENGINE_ASSETS.scratchWorkerModule.href,
  flacWorker: "./internal/engine-web-flac-worker.js",
  flacDecoderWasm: "./internal/engine-web-flac-decoder.wasm",
  opfsWorker: "./internal/engine-web-opfs-worker.js",
  pumpWorker: "./internal/engine-web-pcm-pump-worker.js",
  feedWorkletModule: BUNDLED_ENGINE_ASSETS.pcmFeedWorklet.href,
} as const);

/** Package-relative deployment URLs; bundlers may rewrite these exact literals. */
export const ADAPTER_ASSETS = Object.freeze({
  scratchWorker: BUNDLED_ENGINE_ASSETS.scratchWorkerModule,
  flacWorker: new URL("./internal/engine-web-flac-worker.js", import.meta.url),
  flacDecoderWasm: new URL("./internal/engine-web-flac-decoder.wasm", import.meta.url),
  opfsWorker: new URL("./internal/engine-web-opfs-worker.js", import.meta.url),
  pumpWorker: new URL("./internal/engine-web-pcm-pump-worker.js", import.meta.url),
  feedWorkletModule: BUNDLED_ENGINE_ASSETS.pcmFeedWorklet,
});

export interface AdapterAssetOverrides {
  readonly scratchWorkerUrl?: string | URL;
  readonly flacWorkerUrl?: string | URL;
  readonly flacDecoderWasmUrl?: string | URL;
  readonly opfsWorkerUrl?: string | URL;
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

export function createFlacWorker(overrides: AdapterAssetOverrides = {}): Worker {
  if (overrides.createWorker !== undefined) {
    return overrides.createWorker(overrides.flacWorkerUrl ?? ADAPTER_ASSETS.flacWorker, { type: "module" });
  }
  if (overrides.flacWorkerUrl !== undefined) return new Worker(overrides.flacWorkerUrl, { type: "module" });
  return new Worker(new URL("./internal/engine-web-flac-worker.js", import.meta.url), { type: "module" });
}

export function createOpfsWorker(overrides: AdapterAssetOverrides = {}): Worker {
  if (overrides.createWorker !== undefined) {
    return overrides.createWorker(overrides.opfsWorkerUrl ?? ADAPTER_ASSETS.opfsWorker, { type: "module" });
  }
  if (overrides.opfsWorkerUrl !== undefined) return new Worker(overrides.opfsWorkerUrl, { type: "module" });
  return new Worker(new URL("./internal/engine-web-opfs-worker.js", import.meta.url), { type: "module" });
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
  return new Worker(BUNDLED_ENGINE_ASSETS.scratchWorkerModule, {
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
