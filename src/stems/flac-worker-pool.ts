import { ADAPTER_ASSETS, createFlacWorker, type AdapterAssetOverrides } from "../assets.js";
import { EngineWebAdapterError } from "../errors.js";
import { BoundedStemAdmission, flacPipelineWidths, type FlacProcessingOptions, type StemAdmissionLease } from "./flac-admission.js";
import { loadNativeFlacDecoderModule } from "./native-flac-decoder.js";
import type { StemProgress } from "./types.js";
import type { FlacWorkerLike, FlacWorkerResponse } from "./flac-worker-protocol.js";

export interface FlacWorkerPoolOptions {
  readonly admission?: BoundedStemAdmission;
  readonly processing?: FlacProcessingOptions;
  readonly assets?: AdapterAssetOverrides;
  readonly createWorker?: () => FlacWorkerLike;
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
  readonly memoryBudgetBytes?: number;
  readonly maximumWorkers?: number;
}

export interface FlacWorkerRunContext {
  /** Immutable decoder code. Each job still instantiates a fresh decoder/memory. */
  readonly decoderModule?: WebAssembly.Module;
}

export interface FlacWorkerPoolLease {
  /** Idempotent. Resolves only after the retained epoch has physically drained. */
  readonly release: () => Promise<void>;
}

export interface FlacWorkerRunOptions<T> {
  readonly signal?: AbortSignal;
  readonly requestId?: number;
  readonly onProgress?: (progress: StemProgress) => void;
  readonly work: (worker: FlacWorkerLike, context?: FlacWorkerRunContext) => Promise<T>;
  /** Bound only the shared native decoder module wait for this job. */
  readonly moduleLoadTimeoutMs?: number;
  /** Creates the typed failure reported when the module wait reaches its bound. */
  readonly onModuleLoadTimeout?: () => unknown;
  /** Called when this job relinquishes its runnable/job reservation. */
  readonly onReleased?: () => void;
  /** Called only after the physical Worker is terminated. */
  readonly onTerminated?: () => void;
  /** Keep the physical reservation until residual output has been released. */
  readonly waitForRelease?: () => Promise<void>;
}

interface ModuleLease {
  readonly module: WebAssembly.Module;
  readonly release: () => void;
}

interface PendingJob<T> {
  readonly options: FlacWorkerRunOptions<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly abort: () => void;
}

interface WorkerSlot {
  readonly worker: FlacWorkerLike;
  readonly reservation: StemAdmissionLease;
  readonly decoderModule?: WebAssembly.Module;
  busy: boolean;
  terminated: boolean;
}

interface PendingModuleLoad {
  readonly controller: AbortController;
  owners: number;
  promise: Promise<WebAssembly.Module>;
}

/** One lazy, single-flight module per native resolver asset configuration. */
class NativeDecoderModuleLoader {
  readonly #url: string;
  #module: WebAssembly.Module | undefined;
  #pending: PendingModuleLoad | undefined;

  constructor(url: string) { this.#url = url; }

  acquire(signal?: AbortSignal): Promise<ModuleLease> {
    if (signal?.aborted) return Promise.reject(cancelled(signal.reason));
    const cached = this.#module;
    if (cached !== undefined) return Promise.resolve({ module: cached, release: noop });
    let pending = this.#pending;
    if (pending === undefined) {
      const controller = new AbortController();
      pending = { controller, owners: 0, promise: Promise.resolve(undefined as unknown as WebAssembly.Module) };
      pending.promise = loadNativeFlacDecoderModule({ url: this.#url, signal: controller.signal }).then((module) => {
        if (pending!.owners < 1 || this.#pending !== pending) {
          if (this.#pending === pending) this.#pending = undefined;
          throw cancelled(controller.signal.reason);
        }
        this.#module = module;
        this.#pending = undefined;
        return module;
      }, (error) => {
        if (this.#pending === pending) this.#pending = undefined;
        throw error;
      });
      this.#pending = pending;
    }
    pending.owners += 1;
    let released = false;
    const onAbort = signal === undefined ? undefined : () => release();
    const release = () => {
      if (released) return;
      released = true;
      if (onAbort !== undefined) signal!.removeEventListener("abort", onAbort);
      pending!.owners = Math.max(0, pending!.owners - 1);
      if (pending!.owners === 0 && this.#pending === pending) {
        pending!.controller.abort(new DOMException("FLAC decoder asset has no active consumers", "AbortError"));
      }
    };
    if (onAbort !== undefined) signal!.addEventListener("abort", onAbort, { once: true });
    return pending.promise.then((module) => {
      if (released || signal?.aborted) {
        release();
        throw cancelled(signal?.reason);
      }
      return {
        module,
        release: () => {
          release();
        },
      };
    }, (error) => {
      release();
      throw error;
    });
  }
}

const noop = (): void => undefined;

function cancelled(reason: unknown): EngineWebAdapterError {
  return new EngineWebAdapterError("stem.cancelled", "FLAC Worker pool acquisition was cancelled", {}, reason);
}

function invoke(callback: (() => void) | undefined): void {
  try { callback?.(); } catch { /* lifecycle callbacks cannot replace the operation result */ }
}

/**
 * Bounded FLAC Worker ownership. Without an epoch lease it retains the old
 * one-job behavior; a privately admitted retained epoch can reuse healthy
 * realms and the immutable decoder module.
 */
export class FlacWorkerPool {
  readonly #admission: BoundedStemAdmission;
  readonly #createWorker: () => FlacWorkerLike;
  readonly #limit: number;
  readonly #reuseEligible: boolean;
  readonly #moduleLoader: NativeDecoderModuleLoader | undefined;
  readonly #workers = new Set<WorkerSlot>();
  readonly #pending: PendingJob<unknown>[] = [];
  readonly #constructionAborts = new Set<AbortController>();
  #constructing = 0;
  #activeJobs = 0;
  #retentions = 0;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #closeResolve: (() => void) | undefined;

  constructor(options: FlacWorkerPoolOptions = {}) {
    this.#admission = options.admission ?? new BoundedStemAdmission(flacPipelineWidths(options).processing);
    this.#limit = this.#admission.limit;
    this.#createWorker = options.createWorker ?? (() => createFlacWorker(options.assets) as unknown as FlacWorkerLike);
    // A caller-owned admission is shared with another resource owner. Keeping
    // idle physical reservations there could starve that owner, so it remains
    // conservative one-job lifetime. A custom factory may opt into reuse by
    // returning the reset acknowledgement; workers without that handshake
    // continue to terminate after one job.
    this.#reuseEligible = options.admission === undefined;
    if (this.#reuseEligible && options.createWorker === undefined && options.assets?.createWorker === undefined) {
      this.#moduleLoader = new NativeDecoderModuleLoader(String(options.assets?.flacDecoderWasmUrl ?? ADAPTER_ASSETS.flacDecoderWasm));
    }
  }

  get stats(): Readonly<{ active: number; queued: number; limit: number }> {
    if (!this.#reuseEligible || this.#retentions === 0) return this.#admission.stats;
    return { active: this.#activeJobs, queued: this.#pending.length, limit: this.#limit };
  }

  /** True when this pool may retain private physical reservations. */
  get canRetain(): boolean { return this.#reuseEligible; }

  retain(): FlacWorkerPoolLease {
    if (!this.#reuseEligible) return { release: () => Promise.resolve() };
    // A resolver can serve multiple preparations over its lifetime. Once the
    // prior epoch has physically drained, start a new epoch while preserving
    // the immutable module cache. A retain racing an in-flight close cannot
    // resurrect a worker and therefore remains a conservative no-op.
    if (this.#closing) {
      if (this.#workers.size !== 0 || this.#constructing !== 0 || this.#activeJobs !== 0 || this.#pending.length !== 0) {
        return { release: () => Promise.resolve() };
      }
      this.#closing = false;
      this.#closePromise = undefined;
      this.#closeResolve = undefined;
    }
    this.#retentions += 1;
    let released = false;
    let releasePromise: Promise<void> | undefined;
    return {
      release: () => {
        if (released) return releasePromise ?? Promise.resolve();
        released = true;
        this.#retentions = Math.max(0, this.#retentions - 1);
        releasePromise = this.#retentions === 0 ? this.#beginClose() : Promise.resolve();
        return releasePromise;
      },
    };
  }

  run<T>(options: FlacWorkerRunOptions<T>): Promise<T> {
    if (this.#closing) return Promise.reject(cancelled(options.signal?.reason));
    if (this.#reuseEligible && this.#retentions > 0) return this.#enqueue(options);
    return this.#runOneShot(options);
  }

  async #runOneShot<T>(options: FlacWorkerRunOptions<T>): Promise<T> {
    if (this.#admission.stats.active >= this.#admission.limit) {
      options.onProgress?.({
        stage: "queued",
        workersActive: this.#admission.stats.active,
        workersQueued: this.#admission.stats.queued + 1,
        workerLimit: this.#admission.limit,
      });
    }
    const reservation = await this.#admission.acquire(options.signal);
    let worker: FlacWorkerLike | undefined;
    let failed = false;
    try {
      options.signal?.throwIfAborted();
      worker = this.#createWorker();
      const value = await options.work(worker);
      if (options.waitForRelease !== undefined) await options.waitForRelease();
      return value;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (worker !== undefined) {
        try {
          try { worker.terminate(); }
          finally {
            invoke(options.onReleased);
            invoke(options.onTerminated);
          }
        } finally { reservation.release(); }
      } else if (failed) invoke(options.onReleased);
      if (worker === undefined) reservation.release();
    }
  }

  #enqueue<T>(options: FlacWorkerRunOptions<T>): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(cancelled(options.signal.reason));
    if (this.#pending.length > 0 || this.#activeJobs + this.#constructing >= this.#limit) {
      options.onProgress?.({
        stage: "queued",
        workersActive: this.#activeJobs,
        workersQueued: this.#pending.length + 1,
        workerLimit: this.#limit,
      });
    }
    return new Promise<T>((resolve, reject) => {
      let pending!: PendingJob<T>;
      const abort = () => {
        const index = this.#pending.indexOf(pending as PendingJob<unknown>);
        if (index < 0) return;
        this.#pending.splice(index, 1);
        reject(cancelled(options.signal?.reason));
        this.#drain();
        this.#maybeFinishClose();
      };
      pending = { options, resolve, reject, abort };
      this.#pending.push(pending as PendingJob<unknown>);
      options.signal?.addEventListener("abort", abort, { once: true });
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#closing) return;
    for (;;) {
      const pending = this.#pending[0];
      if (pending === undefined) return;
      if (pending.options.signal?.aborted) {
        this.#pending.shift();
        pending.options.signal.removeEventListener("abort", pending.abort);
        pending.reject(cancelled(pending.options.signal.reason));
        continue;
      }
      const idle = [...this.#workers].find((slot) => !slot.busy && !slot.terminated);
      if (idle !== undefined) {
        this.#pending.shift();
        pending.options.signal?.removeEventListener("abort", pending.abort);
        idle.busy = true;
        this.#activeJobs += 1;
        void this.#execute(idle, pending);
        continue;
      }
      if (this.#workers.size + this.#constructing >= this.#limit) return;
      this.#pending.shift();
      pending.options.signal?.removeEventListener("abort", pending.abort);
      this.#constructing += 1;
      void this.#constructNew(pending);
    }
  }

  async #constructNew(pending: PendingJob<unknown>): Promise<void> {
    let moduleLease: ModuleLease | undefined;
    let reservation: StemAdmissionLease | undefined;
    let slot: WorkerSlot | undefined;
    const moduleController = new AbortController();
    this.#constructionAborts.add(moduleController);
    const forwardAbort = () => moduleController.abort(pending.options.signal?.reason);
    if (pending.options.signal?.aborted) forwardAbort();
    else pending.options.signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      moduleLease = await this.#acquireModule(moduleController, pending.options);
      pending.options.signal?.throwIfAborted();
      // The construction controller is aborted both by the caller and by the
      // final epoch release. Passing it to admission prevents close from
      // waiting forever behind another owner of a shared token.
      reservation = await this.#admission.acquire(moduleController.signal);
      pending.options.signal?.throwIfAborted();
      if (this.#closing) throw cancelled(pending.options.signal?.reason);
      const worker = this.#createWorker();
      slot = {
        worker,
        reservation,
        ...(moduleLease === undefined ? {} : { decoderModule: moduleLease.module }),
        busy: true,
        terminated: false,
      };
      this.#workers.add(slot);
      this.#activeJobs += 1;
      await this.#execute(slot, pending);
      reservation = undefined;
    } catch (error) {
      // A factory or an unexpected execution failure can happen after the
      // slot has been published. Evict it before admitting the next queued
      // job; normal #execute failures already mark it terminated.
      if (slot !== undefined && !slot.terminated) this.#finishTerminated(slot, pending.options);
      pending.reject(error);
    } finally {
      pending.options.signal?.removeEventListener("abort", forwardAbort);
      this.#constructionAborts.delete(moduleController);
      moduleLease?.release();
      if (reservation !== undefined) reservation.release();
      this.#constructing -= 1;
      this.#drain();
      this.#maybeFinishClose();
    }
  }

  #acquireModule(controller: AbortController, options: FlacWorkerRunOptions<unknown>): Promise<ModuleLease | undefined> {
    const acquisition = this.#moduleLoader?.acquire(controller.signal);
    if (acquisition === undefined || options.moduleLoadTimeoutMs === undefined) return acquisition ?? Promise.resolve(undefined);
    const timeoutMs = options.moduleLoadTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new RangeError("moduleLoadTimeoutMs must be positive"));
    }
    return new Promise<ModuleLease>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        let timeout: unknown;
        try {
          timeout = options.onModuleLoadTimeout?.() ?? new EngineWebAdapterError(
            "stem.decode.stall", `FLAC decoder made no progress for ${timeoutMs}ms`,
            { phase: "decoder-load", milliseconds: timeoutMs, retryable: false },
          );
        } catch (error) {
          timeout = error;
        }
        // Releasing this waiter's lease aborts the shared load only when no
        // other construction still owns it. The promise rejection below is
        // intentionally the typed timeout, even if the loader observes the
        // abort first and reports cancellation.
        controller.abort(timeout);
        reject(timeout);
      }, timeoutMs);
      void acquisition.then((lease) => {
        if (settled) {
          lease.release();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(lease);
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async #execute(slot: WorkerSlot, pending: PendingJob<unknown>): Promise<void> {
    const options = pending.options;
    let resetAcknowledged = false;
    const requestId = options.requestId;
    const onMessage = (event: MessageEvent<FlacWorkerResponse>) => {
      const message = event.data;
      if (requestId !== undefined && message.type === "complete" && message.requestId === requestId && message.reset === true) {
        resetAcknowledged = true;
      }
    };
    try { slot.worker.addEventListener("message", onMessage); }
    catch (error) {
      this.#finishTerminated(slot, options);
      pending.reject(error);
      this.#activeJobs -= 1;
      this.#drain();
      this.#maybeFinishClose();
      return;
    }
    try {
      const context = slot.decoderModule === undefined ? undefined : { decoderModule: slot.decoderModule };
      const value = await options.work(slot.worker, context);
      if (options.waitForRelease !== undefined) await options.waitForRelease();
      const reusable = this.#reuseEligible && !this.#closing && this.#retentions > 0 &&
        !(options.signal?.aborted ?? false) && requestId !== undefined && resetAcknowledged;
      if (reusable) {
        slot.busy = false;
        invoke(options.onReleased);
        pending.resolve(value);
      } else {
        this.#finishTerminated(slot, options);
        pending.resolve(value);
      }
    } catch (error) {
      this.#finishTerminated(slot, options);
      pending.reject(error);
    } finally {
      try { slot.worker.removeEventListener("message", onMessage); }
      catch { /* a poisoned realm is already being evicted or was terminated */ }
      this.#activeJobs -= 1;
      this.#drain();
      this.#maybeFinishClose();
    }
  }

  #finishTerminated(slot: WorkerSlot, options: FlacWorkerRunOptions<unknown>): void {
    if (!slot.terminated) {
      slot.terminated = true;
      this.#workers.delete(slot);
      try { slot.worker.terminate(); }
      finally {
        slot.reservation.release();
        invoke(options.onReleased);
        invoke(options.onTerminated);
      }
    } else {
      invoke(options.onReleased);
    }
  }

  #beginClose(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = new Promise<void>((resolve) => { this.#closeResolve = resolve; });
    const reason = cancelled(new DOMException("FLAC Worker pool epoch closed", "AbortError"));
    for (const controller of this.#constructionAborts) controller.abort(reason);
    while (this.#pending.length > 0) {
      const pending = this.#pending.shift()!;
      pending.options.signal?.removeEventListener("abort", pending.abort);
      pending.reject(reason);
    }
    for (const slot of [...this.#workers]) {
      if (!slot.busy) this.#finishTerminated(slot, { work: async () => undefined });
    }
    this.#maybeFinishClose();
    return this.#closePromise;
  }

  #maybeFinishClose(): void {
    if (!this.#closing || this.#workers.size !== 0 || this.#constructing !== 0 || this.#activeJobs !== 0 || this.#pending.length !== 0) return;
    const resolve = this.#closeResolve;
    this.#closeResolve = undefined;
    if (resolve === undefined) return;
    // Worker.terminate() is synchronous at the adapter boundary. Yield once
    // so message/error tasks from a just-terminated realm cannot re-enter.
    queueMicrotask(resolve);
  }
}
