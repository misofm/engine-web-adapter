import { createPumpWorker } from "../assets.js";
import type { AdapterAssetOverrides } from "../assets.js";
import { EngineWebAdapterError } from "../errors.js";
import { Effect } from "effect";
import type { PumpAllocation } from "../session-types.js";
import { PCM_WINDOW_FRAMES } from "./pump.js";
import type { PcmPumpSource, SparsePcmPumpSource } from "./pump.js";
import { validateSparsePcmIndex } from "./sparse-pcm.js";
import type { SparsePcmIndex } from "./sparse-pcm.js";
import type { SparsePcmDescriptor } from "./sparse-store.js";
import type { PumpWorkerRequest, PumpWorkerResponse } from "./worker-protocol.js";
import type { StemSessionLease } from "./types.js";
import type { StemIdentity } from "./types.js";

export interface PumpWorkerLike {
  postMessage(message: PumpWorkerRequest): void;
  terminate(): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void;
}

export class PcmPumpWorkerClient {
  readonly #worker: PumpWorkerLike;
  readonly #pending = new Map<number, { resolve(value: PumpWorkerResponse): void; reject(reason: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  readonly #onMessage = (event: MessageEvent<PumpWorkerResponse>) => this.#receive(event.data);
  readonly #onWorkerError = (event: ErrorEvent) => {
    event.preventDefault?.();
    this.#terminate(event.error ?? new Error(event.message));
  };
  readonly #onMessageError = () => this.#terminate(new EngineWebAdapterError("session.open", "PCM pump Worker message could not be cloned"));
  readonly #requestDeadlineMs: number;
  #allocation!: PumpAllocation;
  get allocation(): PumpAllocation { return this.#allocation; }
  #reportFailure!: (reason: unknown) => void;
  /** Fulfilled rather than rejected so an unused failure observer cannot leak a rejection. */
  readonly failure = new Promise<unknown>((resolve) => { this.#reportFailure = resolve; });

  #detachAbort: (() => void) | undefined;
  #failureReason: unknown;
  #requestId = 1;
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  private constructor(worker: PumpWorkerLike, requestDeadlineMs: number) {
    this.#worker = worker;
    this.#requestDeadlineMs = requestDeadlineMs;
    worker.addEventListener("message", this.#onMessage);
    worker.addEventListener("error", this.#onWorkerError);
    worker.addEventListener("messageerror", this.#onMessageError);
  }

  static async create(options: {
    readonly lease: Pick<StemSessionLease, "read">;
    readonly sources: readonly PcmPumpSource[];
    readonly windowFrames?: number;
    readonly idleMs?: number;
    readonly generation?: bigint;
    readonly assets?: AdapterAssetOverrides;
    readonly worker?: PumpWorkerLike;
    readonly signal?: AbortSignal;
    readonly requestDeadlineMs?: number;
  }): Promise<PcmPumpWorkerClient> {
    const worker = options.worker ?? createPumpWorker(options.assets) as unknown as PumpWorkerLike;
    const deadline = options.requestDeadlineMs ?? 5_000;
    if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new RangeError("requestDeadlineMs must be positive");
    const client = new PcmPumpWorkerClient(worker, deadline);
    try {
      const windowFrames = options.windowFrames ?? PCM_WINDOW_FRAMES;
      if (!Number.isSafeInteger(windowFrames) || windowFrames <= 0) throw new RangeError("windowFrames must be positive");
      options.signal?.throwIfAborted();
      if (options.signal !== undefined) {
        const abort = () => client.#terminate(options.signal?.reason ?? new DOMException("PCM pump Worker aborted", "AbortError"), false);
        options.signal.addEventListener("abort", abort, { once: true });
        client.#detachAbort = () => options.signal?.removeEventListener("abort", abort);
      }
      const blobs = new Map<string, Blob>();
      for (const source of options.sources) {
        options.signal?.throwIfAborted();
        blobs.set(source.identity, blobs.get(source.identity) ?? await options.lease.read(source.identity));
      }
      options.signal?.throwIfAborted();
      const requestId = client.#next();
      const reply = await client.#request({
        type: "initialize",
        requestId,
        sources: options.sources.map((source) => ({ ...source, blob: blobs.get(source.identity)! })),
        windowFrames,
        idleMs: options.idleMs ?? 4,
        generation: options.generation ?? 1n,
      });
      // A Worker may resolve initialize and the constructor signal may abort
      // later in that same task, before this async continuation runs.
      client.#throwIfTerminated();
      options.signal?.throwIfAborted();
      if (reply.type !== "initialized" || !reply.bounds ||
          !Number.isSafeInteger(reply.bounds.windowBytes) || reply.bounds.windowBytes < 0 ||
          (options.sources.length > 0 && reply.bounds.windowBytes === 0) ||
          !Number.isSafeInteger(reply.bounds.ringBytes) ||
          reply.bounds.ringBytes !== options.sources.reduce((bytes, source) => bytes + source.ring.byteLength, 0)) {
        throw new EngineWebAdapterError("session.open", "PCM pump Worker returned invalid initialization bounds");
      }
      client.#allocation = Object.freeze({ windowFrames, maximumWindowBytes: reply.bounds.windowBytes });
      return client;
    } catch (error) {
      client.#terminate(error);
      throw error;
    }
  }

  static async createSparse(options: {
    readonly lease: Pick<{ read(identity: string): Promise<SparsePcmDescriptor> }, "read">;
    readonly sources: readonly SparsePcmPumpSource[];
    readonly windowFrames?: number;
    readonly idleMs?: number;
    readonly generation?: bigint;
    readonly assets?: AdapterAssetOverrides;
    readonly worker?: PumpWorkerLike;
    readonly signal?: AbortSignal;
    readonly requestDeadlineMs?: number;
  }): Promise<PcmPumpWorkerClient> {
    const worker = options.worker ?? createPumpWorker(options.assets) as unknown as PumpWorkerLike;
    const deadline = options.requestDeadlineMs ?? 5_000;
    if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new RangeError("requestDeadlineMs must be positive");
    const client = new PcmPumpWorkerClient(worker, deadline);
    try {
      const windowFrames = options.windowFrames ?? PCM_WINDOW_FRAMES;
      if (!Number.isSafeInteger(windowFrames) || windowFrames <= 0 || windowFrames > PCM_WINDOW_FRAMES) throw new RangeError("Sparse PCM windowFrames must be between 1 and 8192");
      options.signal?.throwIfAborted();
      if (options.signal !== undefined) {
        const abort = () => client.#terminate(options.signal?.reason ?? new DOMException("PCM pump Worker aborted", "AbortError"), false);
        options.signal.addEventListener("abort", abort, { once: true });
        client.#detachAbort = () => options.signal?.removeEventListener("abort", abort);
      }
      const sourceIds = new Set<string>();
      for (const source of options.sources) {
        options.signal?.throwIfAborted();
        if (sourceIds.has(source.sourceId)) throw new EngineWebAdapterError("session.declaration_mismatch", "Sparse PCM source IDs must be unique");
        sourceIds.add(source.sourceId);
        validateSparsePumpSource(source);
      }
      const assets = new Map<StemIdentity, SparsePcmDescriptor>();
      const resolved = await Effect.runPromise(readSparseDescriptors(options.lease, options.sources));
      for (const source of options.sources) {
        options.signal?.throwIfAborted();
        const prior = assets.get(source.identity);
        const descriptor = prior ?? resolved.get(source.identity);
        if (descriptor === undefined) throw new EngineWebAdapterError("session.declaration_mismatch", "Sparse PCM resolver omitted a source asset");
        const admitted = admitSparseDescriptor(descriptor, source.identity);
        if (prior !== undefined && !sameSparseShape(prior.index, admitted.index)) {
          throw new EngineWebAdapterError("session.declaration_mismatch", "Sparse PCM aliases disagree about asset shape");
        }
        if (prior === undefined) assets.set(source.identity, admitted);
        validateSparseSourceBinding(source, admitted);
      }
      options.signal?.throwIfAborted();
      const requestId = client.#next();
      const reply = await client.#request({
        type: "initialize-sparse", requestId, sources: options.sources,
        assets: [...assets.values()], windowFrames,
        idleMs: options.idleMs ?? 4, generation: options.generation ?? 1n,
      });
      client.#throwIfTerminated();
      options.signal?.throwIfAborted();
      const expectedScratch = sparseScratchBytes(options.sources, windowFrames);
      if (reply.type !== "initialized" || !reply.bounds ||
          !Number.isSafeInteger(reply.bounds.windowBytes) || reply.bounds.windowBytes < 0 ||
          (options.sources.length > 0 && reply.bounds.windowBytes === 0) ||
          !Number.isSafeInteger(reply.bounds.ringBytes) ||
          reply.bounds.ringBytes !== options.sources.reduce((bytes, source) => bytes + source.ring.byteLength, 0) ||
          !Number.isSafeInteger(reply.bounds.maximumReadScratchBytes) || reply.bounds.maximumReadScratchBytes !== expectedScratch) {
        throw new EngineWebAdapterError("session.open", "Sparse PCM pump Worker returned invalid initialization bounds");
      }
      client.#allocation = Object.freeze({ windowFrames, maximumWindowBytes: reply.bounds.windowBytes, maximumReadScratchBytes: reply.bounds.maximumReadScratchBytes });
      return client;
    } catch (error) {
      client.#terminate(error);
      throw error;
    }
  }

  async seekFrames(frame: number | bigint): Promise<bigint> {
    if (this.#closed || this.#closing) throw new EngineWebAdapterError("session.closed", "PCM pump Worker is closed");
    const reply = await this.#request({ type: "seek", requestId: this.#next(), frame: BigInt(frame) });
    if (reply.type !== "sought") throw new Error("PCM pump Worker returned the wrong seek reply");
    return reply.generation;
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closing = true;
      const operation = this.#closeOnce();
      this.#closePromise = operation;
    }
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#request({ type: "stop", requestId: this.#next() });
    } catch {
      // Teardown is best-effort; termination below is the hard stop.
    } finally {
      this.#terminate(new EngineWebAdapterError("session.closed", "PCM pump Worker closed"));
    }
  }

  #next(): number { return this.#requestId++; }
  #throwIfTerminated(): void {
    if (this.#closed) {
      throw this.#failureReason ?? new EngineWebAdapterError("session.closed", "PCM pump Worker is closed");
    }
  }
  #request(message: PumpWorkerRequest): Promise<PumpWorkerResponse> {
    if (this.#closed) return Promise.reject(this.#failureReason ?? new EngineWebAdapterError("session.closed", "PCM pump Worker is closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new EngineWebAdapterError("stem.read_deadline", "PCM pump Worker request timed out", {
          requestId: message.requestId,
          milliseconds: this.#requestDeadlineMs,
        });
        this.#terminate(error);
      }, this.#requestDeadlineMs);
      this.#pending.set(message.requestId, { resolve, reject, timer });
      try { this.#worker.postMessage(message); }
      catch (error) { this.#terminate(error); }
    });
  }
  #receive(message: PumpWorkerResponse): void {
    if (this.#closed) return;
    if (message.type === "progress") return;
    if (message.type === "pump-error") {
      const error = new Error(message.error.message);
      error.name = message.error.name;
      if (message.error.code !== undefined) Object.assign(error, { code: message.error.code });
      if (message.requestId === undefined) { this.#terminate(error); return; }
      const pending = this.#pending.get(message.requestId);
      if (pending !== undefined) { clearTimeout(pending.timer); pending.reject(error); }
      this.#pending.delete(message.requestId);
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (pending !== undefined) { clearTimeout(pending.timer); this.#pending.delete(message.requestId); pending.resolve(message); }
  }
  #terminate(reason: unknown, unexpected = true): void {
    this.#failureReason ??= reason;
    const authoritative = this.#failureReason;
    if (this.#closed) return;
    const report = unexpected && !this.#closing;
    this.#closed = true;
    this.#closing = true;
    this.#detachAbort?.();
    this.#detachAbort = undefined;
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#worker.removeEventListener("error", this.#onWorkerError);
    this.#worker.removeEventListener("messageerror", this.#onMessageError);
    try { this.#worker.terminate(); } catch { /* pending callers still receive the authoritative cause */ }
    if (report) this.#reportFailure(authoritative);
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(authoritative); }
    this.#pending.clear();
  }
}

const readSparseDescriptors = Effect.fn("PcmPumpWorkerClient.readSparseDescriptors")(function* (
  lease: Pick<{ read(identity: string): Promise<SparsePcmDescriptor> }, "read">,
  sources: readonly SparsePcmPumpSource[],
) {
  const descriptors = new Map<StemIdentity, SparsePcmDescriptor>();
  for (const source of sources) {
    if (descriptors.has(source.identity)) continue;
    const descriptor = yield* Effect.tryPromise({
      try: () => lease.read(source.identity),
      catch: (cause) => cause,
    });
    descriptors.set(source.identity, descriptor);
  }
  return descriptors;
});

function validateSparsePumpSource(source: SparsePcmPumpSource): void {
  if (typeof source.sourceId !== "string" || source.sourceId.length === 0 ||
      !Number.isSafeInteger(source.sampleRateHz) || source.sampleRateHz <= 0 ||
      !Number.isSafeInteger(source.frames) || source.frames <= 0 ||
      (source.channels !== 1 && source.channels !== 2) || (source.bitDepth !== 16 && source.bitDepth !== 24) ||
      !(source.ring instanceof SharedArrayBuffer)) {
    throw new EngineWebAdapterError("session.declaration_mismatch", "Sparse PCM source declaration is invalid");
  }
}

function admitSparseDescriptor(value: SparsePcmDescriptor, identity: string): SparsePcmDescriptor {
  if (value?.kind !== "sparse-pcm" || !(value.data instanceof Blob)) {
    throw new EngineWebAdapterError("session.declaration_mismatch", "Sparse PCM resolver returned an invalid descriptor");
  }
  const index = validateSparsePcmIndex(value.index, value.data);
  if (index.identity !== identity) throw new EngineWebAdapterError("session.declaration_mismatch", "Sparse PCM descriptor identity disagrees with its source");
  return Object.freeze({ kind: "sparse-pcm" as const, data: value.data, index });
}

function validateSparseSourceBinding(source: SparsePcmPumpSource, descriptor: SparsePcmDescriptor): void {
  const index = descriptor.index;
  if (source.sampleRateHz !== index.sampleRateHz || source.channels !== index.channels || source.bitDepth !== index.bitDepth || source.frames !== index.frames) {
    throw new EngineWebAdapterError("session.declaration_mismatch", "Sparse PCM source shape disagrees with its asset");
  }
}

function sameSparseShape(left: SparsePcmIndex, right: SparsePcmIndex): boolean {
  return left.identity === right.identity && left.sampleRateHz === right.sampleRateHz && left.channels === right.channels &&
    left.bitDepth === right.bitDepth && left.frames === right.frames && left.canonicalBytes === right.canonicalBytes && left.activeBytes === right.activeBytes;
}

function sparseScratchBytes(sources: readonly SparsePcmPumpSource[], windowFrames: number): number {
  const values = sources.map((source) => windowFrames * source.channels * (source.bitDepth / 8)).sort((left, right) => right - left).slice(0, 4);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new EngineWebAdapterError("session.open", "Sparse PCM read scratch bound is unsafe");
  return total;
}
