import { CanonicalPcmPump } from "../stems/pump.js";
import type { PumpWorkerRequest, PumpWorkerResponse } from "../stems/worker-protocol.js";
import type { StemIdentity } from "../stems/types.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<PumpWorkerRequest>) => void) | null;
  postMessage(message: PumpWorkerResponse): void;
  close?: () => void;
}

const scope = ((globalThis as unknown as { readonly self?: WorkerScope }).self ?? globalThis) as unknown as WorkerScope;
let pump: CanonicalPcmPump | undefined;
let tail = Promise.resolve();
let driveToken: object | undefined;
let idleWake: (() => void) | undefined;
let idleMs = 4;

scope.onmessage = (event) => {
  const queued = tail.then(() => handle(event.data));
  tail = queued.then(() => undefined, () => undefined);
  void queued.catch((error: unknown) => {
    scope.postMessage({
      type: "pump-error",
      ...(typeof event.data?.requestId === "number" ? { requestId: event.data.requestId } : {}),
      error: serialize(error),
    });
  });
};

async function handle(message: PumpWorkerRequest): Promise<void> {
  if (message.type === "initialize") {
    stopDriving();
    pump?.close();
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
    idleMs = message.idleMs;
    scope.postMessage({
      type: "initialized", requestId: message.requestId,
      bounds: { windowBytes: pump.maximumWindowBytes, ringBytes: pump.ringBytes },
    });
    startDriving();
    return;
  }
  if (message.type === "seek") {
    if (pump === undefined) throw new Error("PCM pump Worker is not initialized");
    const generation = await pump.seekFrames(message.frame);
    scope.postMessage({ type: "sought", requestId: message.requestId, generation });
    idleWake?.();
    startDriving();
    return;
  }
  stopDriving();
  pump?.close(); pump = undefined;
  scope.postMessage({ type: "stopped", requestId: message.requestId });
  scope.close?.();
}

function startDriving(): void {
  if (driveToken !== undefined || pump === undefined) return;
  const token = {};
  driveToken = token;
  void drive(token).catch((error: unknown) => {
    if (driveToken === token) {
      driveToken = undefined;
      pump?.close(error);
      scope.postMessage({ type: "pump-error", error: serialize(error) });
    }
  }).finally(() => { if (driveToken === token) driveToken = undefined; });
}

function stopDriving(): void {
  driveToken = undefined;
  idleWake?.();
}

async function drive(token: object): Promise<void> {
  while (driveToken === token) {
    // Every tick is appended to the same queue as seek and stop. No cursor,
    // generation, or window mutation can interleave with an in-flight tick.
    const outcome = await enqueue(() => driveToken === token ? pump?.pumpUntilBlocked() : undefined);
    if (driveToken !== token || outcome === undefined) return;
    if (outcome.finished) { driveToken = undefined; return; }
    if (outcome.chunks === 0) await sleep(idleMs);
  }
}

function enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
  const queued = tail.then(operation);
  tail = queued.then(() => undefined, () => undefined);
  return queued;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); if (idleWake === finish) idleWake = undefined; resolve(); };
    const timer = setTimeout(finish, milliseconds);
    idleWake = finish;
  });
}

function serialize(error: unknown): { readonly name: string; readonly message: string; readonly code?: string } {
  if (error instanceof Error) {
    const code = "code" in error ? String((error as Error & { code?: unknown }).code) : undefined;
    return { name: error.name, message: error.message, ...(code === undefined ? {} : { code }) };
  }
  return { name: "Error", message: String(error) };
}
