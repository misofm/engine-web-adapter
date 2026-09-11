import { CanonicalPcmPump, PCM_DRIVE_PASSES } from "../stems/pump.js";
import type { PumpWorkerRequest, PumpWorkerResponse } from "../stems/worker-protocol.js";
import type { StemIdentity } from "../stems/types.js";
import { Effect, Schema } from "effect";

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
  const queued = tail.then(() => runMessage(event.data));
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
  if (message.type === "initialize-sparse") {
    stopDriving();
    pump?.close();
    if (!Number.isSafeInteger(message.idleMs) || message.idleMs < 0 ||
        typeof message.generation !== "bigint" || message.generation < 0n) {
      throw new TypeError("Sparse PCM Worker initialization options are invalid");
    }
    pump = CanonicalPcmPump.createSparse({
      assets: message.assets,
      sources: message.sources,
      windowFrames: message.windowFrames,
      generation: message.generation,
    });
    idleMs = message.idleMs;
    scope.postMessage({
      type: "initialized", requestId: message.requestId,
      bounds: {
        windowBytes: pump.maximumWindowBytes,
        ringBytes: pump.ringBytes,
        maximumReadScratchBytes: pump.maximumReadScratchBytes,
      },
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

const SparseInitializeSchema = Schema.Struct({
  type: Schema.Literal("initialize-sparse"),
  requestId: Schema.Number,
  sources: Schema.Array(Schema.Unknown),
  assets: Schema.Array(Schema.Unknown),
  windowFrames: Schema.Number,
  generation: Schema.BigInt,
  idleMs: Schema.Number,
});

function runMessage(raw: unknown): Promise<void> {
  return Effect.runPromise(Effect.gen(function* () {
    const message = yield* Effect.try({
      try: () => decodeMessage(raw),
      catch: (cause) => cause,
    });
    yield* Effect.tryPromise({
      try: () => handle(message),
      catch: (cause) => cause,
    });
  }));
}

function decodeMessage(raw: unknown): PumpWorkerRequest {
  if (!isRecord(raw) || raw.type !== "initialize-sparse") return raw as PumpWorkerRequest;
  const sources = raw.sources;
  const assets = raw.assets;
  if (!Array.isArray(sources) || !Array.isArray(assets)) {
    throw new RangeError("Sparse PCM Worker message arrays exceed their bounded count");
  }
  if (Object.keys(raw).length !== 7) throw new TypeError("Sparse PCM Worker message has unknown keys");
  const decoded = Schema.decodeUnknownSync(SparseInitializeSchema)(raw);
  if (!Number.isSafeInteger(decoded.requestId) || decoded.requestId < 0 ||
      !Number.isSafeInteger(decoded.windowFrames) || decoded.windowFrames <= 0 || decoded.windowFrames > 8192 ||
      !Number.isSafeInteger(decoded.idleMs) || decoded.idleMs < 0) {
    throw new RangeError("Sparse PCM Worker message bounds are invalid");
  }
  return decoded as PumpWorkerRequest;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    const outcome = await enqueue(() => driveToken === token ? pump?.pumpUntilBlocked(PCM_DRIVE_PASSES, false) : undefined);
    if (driveToken !== token || outcome === undefined) return;
    if (outcome.finished) { driveToken = undefined; return; }
    await sleep(outcome.chunks === 0 ? idleMs : 0);
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
