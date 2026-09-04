import type { BootOptions, SessionShape } from "@misofm/engine";

import { createScratchWorker } from "./assets.js";
import type { AdapterAssetOverrides } from "./assets.js";
import { EngineWebAdapterError } from "./errors.js";

export interface ScratchBootRequest {
  readonly type: "scratch"; readonly requestId: number; readonly moduleUrl: string;
  readonly document: Uint8Array; readonly options: BootOptions;
}
export type ScratchBootReply =
  | { readonly type: "worker-ready" }
  | { readonly type: "scratch-result"; readonly requestId: number; readonly ok: true; readonly shape: SessionShape }
  | { readonly type: "scratch-result"; readonly requestId: number; readonly ok: false; readonly error: { readonly name: string; readonly message: string } };

interface Pending {
  readonly resolve: (shape: SessionShape) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** A loaded and acknowledged module Worker, prepared before any stem I/O. */
export class ScratchWorkerClient {
  readonly #worker: Worker;
  readonly #requestDeadlineMs: number;
  #nextRequestId = 1;
  #pending = new Map<number, Pending>();
  #closed = false;

  private constructor(worker: Worker, requestDeadlineMs: number) {
    this.#worker = worker;
    this.#requestDeadlineMs = requestDeadlineMs;
    worker.addEventListener("message", this.#onMessage);
    worker.addEventListener("error", this.#onError);
    worker.addEventListener("messageerror", this.#onMessageError);
  }

  static async create(options: {
    readonly assets?: AdapterAssetOverrides; readonly signal?: AbortSignal; readonly requestDeadlineMs?: number;
  } = {}): Promise<ScratchWorkerClient> {
    options.signal?.throwIfAborted();
    let worker: Worker;
    try { worker = createScratchWorker(options.assets); }
    catch (error) { throw new EngineWebAdapterError("capability.module_worker", "Scratch module Worker could not start", {}, error); }
    const client = new ScratchWorkerClient(worker, options.requestDeadlineMs ?? 5_000);
    try { await client.#awaitReady(options.signal); return client; }
    catch (error) {
      client.close();
      throw error instanceof EngineWebAdapterError
        ? error
        : new EngineWebAdapterError("capability.module_worker", "Scratch module Worker did not load", {}, error);
    }
  }

  boot(options: {
    readonly document: Uint8Array; readonly options: BootOptions; readonly moduleUrl: string | URL; readonly signal?: AbortSignal;
  }): Promise<SessionShape> {
    if (this.#closed) return Promise.reject(new EngineWebAdapterError("session.closed", "Scratch Worker is closed"));
    options.signal?.throwIfAborted();
    const requestId = this.#nextRequestId++;
    return new Promise<SessionShape>((resolve, reject) => {
      const timer = setTimeout(() => this.#take(requestId)?.reject(
        new EngineWebAdapterError("session.open", "Scratch Worker request exceeded its deadline", { milliseconds: this.#requestDeadlineMs }),
      ), this.#requestDeadlineMs);
      const abort = () => this.#take(requestId)?.reject(options.signal?.reason ?? new DOMException("Scratch boot aborted", "AbortError"));
      options.signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(requestId, {
        timer,
        resolve: (shape) => { options.signal?.removeEventListener("abort", abort); resolve(shape); },
        reject: (error) => { options.signal?.removeEventListener("abort", abort); reject(error); },
      });
      try {
        this.#worker.postMessage({
          type: "scratch", requestId, moduleUrl: String(options.moduleUrl), document: options.document, options: options.options,
        } satisfies ScratchBootRequest);
      } catch (error) { this.#take(requestId)?.reject(error); }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new EngineWebAdapterError("session.closed", "Scratch Worker closed");
    for (const requestId of [...this.#pending.keys()]) this.#take(requestId)?.reject(error);
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#worker.removeEventListener("error", this.#onError);
    this.#worker.removeEventListener("messageerror", this.#onMessageError);
    this.#worker.terminate();
  }

  #awaitReady(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(() => reject(new Error("module Worker handshake timed out"))), this.#requestDeadlineMs);
      const abort = () => finish(() => reject(signal?.reason ?? new DOMException("Scratch Worker load aborted", "AbortError")));
      const message = (event: MessageEvent<ScratchBootReply>) => { if (event.data.type === "worker-ready") finish(resolve); };
      const error = (event: ErrorEvent) => finish(() => reject(event.error ?? new Error(event.message)));
      const messageerror = () => finish(() => reject(new Error("Scratch module Worker handshake could not be decoded")));
      const finish = (settle: () => void) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        this.#worker.removeEventListener("message", message); this.#worker.removeEventListener("error", error);
        this.#worker.removeEventListener("messageerror", messageerror); settle();
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#worker.addEventListener("message", message); this.#worker.addEventListener("error", error);
      this.#worker.addEventListener("messageerror", messageerror);
    });
  }

  #onMessage = (event: MessageEvent<ScratchBootReply>) => {
    if (event.data.type !== "scratch-result") return;
    const pending = this.#take(event.data.requestId);
    if (pending === undefined) return;
    if (event.data.ok) pending.resolve(event.data.shape);
    else pending.reject(Object.assign(new Error(event.data.error.message), { name: event.data.error.name }));
  };
  #onError = (event: ErrorEvent) => this.#failAll(event.error ?? new Error(event.message));
  #onMessageError = () => this.#failAll(new Error("Scratch module Worker reply could not be decoded"));
  #take(requestId: number): Pending | undefined {
    const pending = this.#pending.get(requestId);
    if (pending !== undefined) { clearTimeout(pending.timer); this.#pending.delete(requestId); }
    return pending;
  }
  #failAll(error: unknown): void { for (const id of [...this.#pending.keys()]) this.#take(id)?.reject(error); }
}

export async function scratchBootWithWorker(options: {
  readonly document: Uint8Array; readonly options: BootOptions; readonly moduleUrl: string | URL;
  readonly assets?: AdapterAssetOverrides; readonly signal?: AbortSignal;
}): Promise<SessionShape> {
  const client = await ScratchWorkerClient.create({
    ...(options.assets === undefined ? {} : { assets: options.assets }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try { return await client.boot(options); } finally { client.close(); }
}
