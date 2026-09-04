import { createPumpWorker } from "../assets.js";
import type { AdapterAssetOverrides } from "../assets.js";
import { EngineWebAdapterError } from "../errors.js";
import type { PcmPumpSource } from "./pump.js";
import type { PumpWorkerRequest, PumpWorkerResponse } from "./worker-protocol.js";
import type { StemSessionLease } from "./types.js";

export interface PumpWorkerLike {
  postMessage(message: PumpWorkerRequest): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: MessageEvent<PumpWorkerResponse>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<PumpWorkerResponse>) => void): void;
}

export class PcmPumpWorkerClient {
  readonly #worker: PumpWorkerLike;
  readonly #pending = new Map<number, { resolve(value: PumpWorkerResponse): void; reject(reason: unknown): void }>();
  readonly #onMessage = (event: MessageEvent<PumpWorkerResponse>) => this.#receive(event.data);
  #detachAbort: (() => void) | undefined;
  #requestId = 1;
  #closed = false;

  private constructor(worker: PumpWorkerLike) {
    this.#worker = worker;
    worker.addEventListener("message", this.#onMessage);
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
  }): Promise<PcmPumpWorkerClient> {
    const worker = options.worker ?? createPumpWorker(options.assets) as unknown as PumpWorkerLike;
    const client = new PcmPumpWorkerClient(worker);
    try {
      options.signal?.throwIfAborted();
      if (options.signal !== undefined) {
        const abort = () => client.#terminate(options.signal?.reason ?? new DOMException("PCM pump Worker aborted", "AbortError"));
        options.signal.addEventListener("abort", abort, { once: true });
        client.#detachAbort = () => options.signal?.removeEventListener("abort", abort);
      }
      const blobs = new Map<string, Blob>();
      for (const source of options.sources) {
        options.signal?.throwIfAborted();
        blobs.set(source.identity, blobs.get(source.identity) ?? await options.lease.read(source.identity));
      }
      const requestId = client.#next();
      await client.#request({
        type: "initialize",
        requestId,
        sources: options.sources.map((source) => ({ ...source, blob: blobs.get(source.identity)! })),
        windowFrames: options.windowFrames ?? 4096,
        idleMs: options.idleMs ?? 4,
        generation: options.generation ?? 1n,
      });
      return client;
    } catch (error) {
      client.#terminate(error);
      throw error;
    }
  }

  async seekFrames(frame: number | bigint): Promise<bigint> {
    if (this.#closed) throw new EngineWebAdapterError("session.closed", "PCM pump Worker is closed");
    const reply = await this.#request({ type: "seek", requestId: this.#next(), frame: BigInt(frame) });
    if (reply.type !== "sought") throw new Error("PCM pump Worker returned the wrong seek reply");
    return reply.generation;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#request({ type: "stop", requestId: this.#next() });
    } finally {
      this.#terminate(new EngineWebAdapterError("session.closed", "PCM pump Worker closed"));
    }
  }

  #next(): number { return this.#requestId++; }
  #request(message: PumpWorkerRequest): Promise<PumpWorkerResponse> {
    return new Promise((resolve, reject) => {
      this.#pending.set(message.requestId, { resolve, reject });
      this.#worker.postMessage(message);
    });
  }
  #receive(message: PumpWorkerResponse): void {
    if (message.type === "progress") return;
    if (message.type === "pump-error") {
      const error = new Error(message.error.message);
      error.name = message.error.name;
      if (message.requestId === undefined) { this.#terminate(error); return; }
      this.#pending.get(message.requestId)?.reject(error);
      this.#pending.delete(message.requestId);
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (pending !== undefined) { this.#pending.delete(message.requestId); pending.resolve(message); }
  }
  #terminate(reason: unknown): void {
    this.#closed = true;
    this.#detachAbort?.();
    this.#detachAbort = undefined;
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#worker.terminate();
    for (const pending of this.#pending.values()) pending.reject(reason);
    this.#pending.clear();
  }
}
