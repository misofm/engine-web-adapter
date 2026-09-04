import { createOpfsWorker } from "../assets.js";
import type { AdapterAssetOverrides } from "../assets.js";
import { EngineWebAdapterError } from "../errors.js";
import type { EngineWebAdapterErrorCode } from "../errors.js";
import { OPFS_WRITE_METHOD, OPFS_WRITE_REMEDY } from "./opfs-worker-protocol.js";
import type { OpfsWorkerLike, OpfsWorkerRequest, OpfsWorkerResponse } from "./opfs-worker-protocol.js";
import type { StemStorageWriter } from "./storage.js";

interface Pending {
  resolve(): void;
  reject(reason: unknown): void;
}

/**
 * Owns the single OPFS write Worker.
 *
 * The Worker is created on the first open writer and terminated when the last
 * one settles, so an idle store holds no OPFS thread. Reads never come here.
 */
export class OpfsWriteWorkerClient {
  readonly #createWorker: () => OpfsWorkerLike;
  readonly #pending = new Map<number, Pending>();
  #worker: OpfsWorkerLike | undefined;
  #ready: Promise<void> | undefined;
  #detach: (() => void) | undefined;
  #openWriters = 0;
  #writeSupport: boolean | undefined;
  #requestId = 1;
  #writerId = 1;
  #generation = 1;

  constructor(options: { readonly assets?: AdapterAssetOverrides; readonly createWorker?: () => OpfsWorkerLike } = {}) {
    this.#createWorker = options.createWorker
      ?? (() => createOpfsWorker(options.assets) as unknown as OpfsWorkerLike);
  }

  get workersActive(): number { return this.#worker === undefined ? 0 : 1; }

  /**
   * Refuse before any write when the Worker scope has no usable OPFS write
   * method. This is the authoritative probe: `createSyncAccessHandle()` is
   * `[Exposed=DedicatedWorker]`, so the synchronous main-thread capability gate
   * cannot see it.
   */
  async assertWriteSupport(): Promise<void> {
    if (this.#supported()) return;
    await this.#acquire();
    const generation = this.#generation;
    try {
      if (!this.#supported()) {
        throw new EngineWebAdapterError("capability.opfs", "Origin-private file storage cannot be written", {
          missing: OPFS_WRITE_METHOD,
          remedy: OPFS_WRITE_REMEDY,
        });
      }
    } finally {
      this.#release(generation);
    }
  }

  async createWriter(folderName: string, name: string): Promise<StemStorageWriter> {
    const writerId = this.#writerId++;
    await this.#acquire();
    const generation = this.#generation;
    try {
      await this.#request({ type: "write-open", requestId: this.#next(), writerId, folderName, name }, generation);
    } catch (error) {
      this.#release(generation);
      throw error;
    }
    let settled = false;
    const finish = async (message: OpfsWorkerRequest): Promise<void> => {
      if (settled) return;
      settled = true;
      try { await this.#request(message, generation); }
      finally { this.#release(generation); }
    };
    return {
      write: async (chunk) => {
        if (settled) throw new EngineWebAdapterError("session.closed", "OPFS writer is closed");
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        await this.#request({ type: "write", requestId: this.#next(), writerId, chunk: bytes }, generation);
      },
      close: () => finish({ type: "write-close", requestId: this.#next(), writerId }),
      abort: async () => {
        try { await finish({ type: "write-abort", requestId: this.#next(), writerId }); }
        catch { /* aborting is best effort; the store removes the staging file */ }
      },
    };
  }

  /** Drop the Worker even if writers are outstanding. Idempotent. */
  close(): void {
    this.#fail(new EngineWebAdapterError("session.closed", "OPFS write Worker closed"));
  }

  async #acquire(): Promise<void> {
    if (this.#worker === undefined) {
      let worker: OpfsWorkerLike;
      try { worker = this.#createWorker(); }
      catch (error) {
        throw new EngineWebAdapterError("capability.module_worker", "OPFS write Worker could not start", {}, error);
      }
      this.#worker = worker;
      const onMessage = (event: MessageEvent<OpfsWorkerResponse>) => this.#receive(event.data);
      const onError = (event: ErrorEvent) => this.#fail(event.error ?? new Error(event.message));
      const onMessageError = () => this.#fail(
        new EngineWebAdapterError("capability.opfs", "OPFS write Worker message could not be cloned"),
      );
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onMessageError);
      this.#detach = () => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("messageerror", onMessageError);
      };
      this.#ready = this.#awaitReady(worker);
    }
    this.#openWriters += 1;
    try {
      await this.#ready;
    } catch (error) {
      // A Worker that failed its handshake must not poison later attempts.
      this.#openWriters -= 1;
      if (this.#openWriters <= 0) { this.#openWriters = 0; this.#teardown(); }
      throw error;
    }
  }

  #awaitReady(worker: OpfsWorkerLike): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settle = (action: () => void) => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        action();
      };
      const onMessage = (event: MessageEvent<OpfsWorkerResponse>) => {
        if (event.data.type !== "worker-ready") return;
        this.#writeSupport = event.data.writeSupport;
        settle(resolve);
      };
      const onError = (event: ErrorEvent) => settle(() => reject(new EngineWebAdapterError(
        "capability.module_worker", "OPFS write Worker did not load", {}, event.error ?? new Error(event.message),
      )));
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
    });
  }

  #release(generation: number): void {
    if (generation !== this.#generation) return;
    this.#openWriters -= 1;
    if (this.#openWriters > 0) return;
    this.#openWriters = 0;
    this.#teardown();
  }

  #teardown(): void {
    const worker = this.#worker;
    this.#detach?.();
    this.#detach = undefined;
    this.#worker = undefined;
    this.#ready = undefined;
    // A Worker scope's write support does not change between instances.
    this.#generation += 1;
    try { worker?.terminate(); } catch { /* a terminated Worker cannot be re-terminated */ }
  }

  #fail(reason: unknown): void {
    if (this.#worker === undefined && this.#pending.size === 0) return;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#openWriters = 0;
    this.#teardown();
    for (const entry of pending) entry.reject(reason);
  }

  #supported(): boolean { return this.#writeSupport === true; }

  #next(): number { return this.#requestId++; }

  #request(message: OpfsWorkerRequest, generation: number): Promise<void> {
    if (generation !== this.#generation || this.#worker === undefined) {
      return Promise.reject(new EngineWebAdapterError("session.closed", "OPFS write Worker is closed"));
    }
    const worker = this.#worker;
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(message.requestId, { resolve, reject });
      try { worker.postMessage(message); }
      catch (error) {
        this.#pending.delete(message.requestId);
        this.#fail(error);
        reject(error);
      }
    });
  }

  #receive(message: OpfsWorkerResponse): void {
    if (message.type === "worker-ready") return;
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) return;
    this.#pending.delete(message.requestId);
    if (message.type === "opfs-ok") { pending.resolve(); return; }
    pending.reject(reviveWorkerError(message.error));
  }
}

function reviveWorkerError(error: Extract<OpfsWorkerResponse, { type: "opfs-error" }>["error"]): unknown {
  if (error.code !== undefined) {
    return new EngineWebAdapterError(error.code as EngineWebAdapterErrorCode, error.message, error.details ?? {});
  }
  const revived = new Error(error.message);
  revived.name = error.name;
  return revived;
}
