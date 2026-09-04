import { createPumpWorker } from "../assets.js";
import type { AdapterAssetOverrides } from "../assets.js";
import { EngineWebAdapterError } from "../errors.js";
import type { PcmPumpSource } from "./pump.js";
import type { PumpWorkerRequest, PumpWorkerResponse } from "./worker-protocol.js";
import type { StemSessionLease } from "./types.js";

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
  readonly #onWorkerError = (event: ErrorEvent) => this.#terminate(event.error ?? new Error(event.message));
  readonly #onMessageError = () => this.#terminate(new EngineWebAdapterError("session.open", "PCM pump Worker message could not be cloned"));
  readonly #requestDeadlineMs: number;
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
      options.signal?.throwIfAborted();
      const requestId = client.#next();
      await client.#request({
        type: "initialize",
        requestId,
        sources: options.sources.map((source) => ({ ...source, blob: blobs.get(source.identity)! })),
        windowFrames: options.windowFrames ?? 4096,
        idleMs: options.idleMs ?? 4,
        generation: options.generation ?? 1n,
      });
      // A Worker may resolve initialize and the constructor signal may abort
      // later in that same task, before this async continuation runs.
      client.#throwIfTerminated();
      options.signal?.throwIfAborted();
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
      const operation = this.#closeOnce();
      this.#closing = true;
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
      if (message.requestId === undefined) { this.#terminate(error); return; }
      const pending = this.#pending.get(message.requestId);
      if (pending !== undefined) { clearTimeout(pending.timer); pending.reject(error); }
      this.#pending.delete(message.requestId);
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (pending !== undefined) { clearTimeout(pending.timer); this.#pending.delete(message.requestId); pending.resolve(message); }
  }
  #terminate(reason: unknown): void {
    this.#failureReason ??= reason;
    const authoritative = this.#failureReason;
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = true;
    this.#detachAbort?.();
    this.#detachAbort = undefined;
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#worker.removeEventListener("error", this.#onWorkerError);
    this.#worker.removeEventListener("messageerror", this.#onMessageError);
    try { this.#worker.terminate(); } catch { /* pending callers still receive the authoritative cause */ }
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(authoritative); }
    this.#pending.clear();
  }
}
