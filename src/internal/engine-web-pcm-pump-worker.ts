import { CanonicalPcmPump, SelfDrivingPcmPump } from "../stems/pump.js";
import type { PumpWorkerRequest, PumpWorkerResponse } from "../stems/worker-protocol.js";
import type { StemIdentity } from "../stems/types.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<PumpWorkerRequest>) => void) | null;
  postMessage(message: PumpWorkerResponse): void;
  close?: () => void;
}

const scope = ((globalThis as unknown as { readonly self?: WorkerScope }).self ?? globalThis) as unknown as WorkerScope;
let pump: CanonicalPcmPump | undefined;
let driver: SelfDrivingPcmPump | undefined;
let tail = Promise.resolve();

scope.onmessage = (event) => {
  tail = tail.then(() => handle(event.data)).catch((error: unknown) => {
    scope.postMessage({
      type: "pump-error",
      ...(typeof event.data?.requestId === "number" ? { requestId: event.data.requestId } : {}),
      error: serialize(error),
    });
  });
};

async function handle(message: PumpWorkerRequest): Promise<void> {
  if (message.type === "initialize") {
    driver?.close();
    const blobs = new Map<StemIdentity, Blob>(message.sources.map((source) => [source.identity, source.blob]));
    pump = new CanonicalPcmPump({
      lease: { async read(identity) {
        const blob = blobs.get(identity);
        if (blob === undefined) throw new Error(`Verified Blob missing for ${identity}`);
        return blob;
      } },
      sources: message.sources.map(({ blob: _blob, ...source }) => source),
      windowFrames: message.windowFrames,
      generation: message.generation,
    });
    driver = new SelfDrivingPcmPump(pump, message.idleMs, (error) => {
      scope.postMessage({ type: "pump-error", error: serialize(error) });
    });
    scope.postMessage({
      type: "initialized", requestId: message.requestId,
      bounds: { windowBytes: pump.maximumWindowBytes, ringBytes: pump.ringBytes },
    });
    driver.start();
    return;
  }
  if (message.type === "seek") {
    if (driver === undefined) throw new Error("PCM pump Worker is not initialized");
    const generation = await driver.seekFrames(message.frame);
    scope.postMessage({ type: "sought", requestId: message.requestId, generation });
    return;
  }
  driver?.close(); driver = undefined; pump = undefined;
  scope.postMessage({ type: "stopped", requestId: message.requestId });
  scope.close?.();
}

function serialize(error: unknown): { readonly name: string; readonly message: string; readonly code?: string } {
  if (error instanceof Error) {
    const code = "code" in error ? String((error as Error & { code?: unknown }).code) : undefined;
    return { name: error.name, message: error.message, ...(code === undefined ? {} : { code }) };
  }
  return { name: "Error", message: String(error) };
}
