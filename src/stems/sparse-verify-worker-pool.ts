import { Effect } from "effect";

import { createSparseVerifyWorker } from "./sparse-verify-worker-asset.js";
import { verifiedSparseVerifyArrayBufferTransfer, type SparseVerifyArrayBufferTransfer } from "./sparse-verify-buffer.js";
import {
  SPARSE_VERIFY_PROTOCOL_VERSION,
  SPARSE_VERIFY_MAX_INTERVALS,
  packSparseVerifyIntervals,
  sparseVerifyExpectedCounts,
  sparseVerifyWorkerResponse,
  type SparseVerifyComplete,
  type SparseVerifyFailureKind,
  type SparseVerifyStart,
  type SparseVerifyWorkerResponse,
} from "./sparse-verify-worker-protocol.js";
import type { SparsePcmIndex } from "./sparse-pcm.js";
import type { StemIdentity } from "./types.js";

export class SparseVerifyWorkerError extends Error {
  readonly kind: SparseVerifyFailureKind;

  constructor(kind: SparseVerifyFailureKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SparseVerifyWorkerError";
    this.kind = kind;
  }
}

export interface SparseVerifyWorkerRunOptions {
  readonly identity: StemIdentity;
  readonly frames: number;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly canonicalBytes: number;
  readonly index: SparsePcmIndex;
  readonly data: Blob;
  readonly readDeadlineMs: number;
  readonly signal: AbortSignal;
  readonly onProgress?: (bytes: number) => void;
}

export interface SparseVerifyWorkerPoolOptions {
  readonly width: number;
}

export type SparseVerifyWorkerResult = SparseVerifyComplete;
type Settlement = (effect: Effect.Effect<SparseVerifyWorkerResult, SparseVerifyWorkerError>) => void;

interface PendingJob {
  readonly options: SparseVerifyWorkerRunOptions;
  readonly jobId: number;
  readonly settle: Settlement;
  queued: boolean;
  settled: boolean;
  slot: WorkerSlot | undefined;
}

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void;
}

interface WorkerSlot {
  readonly worker: WorkerLike;
  generation: number;
  busy: boolean;
  terminating: boolean;
  terminated: boolean;
  terminationFailure: unknown;
  finishing: boolean;
  finishPromise: Promise<SparseVerifyWorkerError | undefined> | undefined;
  pending: PendingJob | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  onMessage: ((event: any) => void) | undefined;
  onError: ((event: any) => void) | undefined;
  onMessageError: ((event: any) => void) | undefined;
  lastProgress: number;
}

/** A preparation-owned FIFO of reusable verification Workers. */
export class SparseVerifyWorkerPool {
  readonly #width: number;
  readonly #bufferTransfer: SparseVerifyArrayBufferTransfer | undefined;
  readonly #slots = new Set<WorkerSlot>();
  readonly #queue: PendingJob[] = [];
  #nextJobId = 1;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  readonly #terminationFailures: unknown[] = [];

  constructor(options: SparseVerifyWorkerPoolOptions) {
    if (!Number.isSafeInteger(options.width) || options.width < 1) throw new RangeError("warm verification width must be a positive safe integer");
    this.#width = options.width;
    this.#bufferTransfer = verifiedSparseVerifyArrayBufferTransfer();
  }

  get width(): number { return this.#width; }

  /** Internal lifecycle test seam; omitted from the public stems barrel. */
  setCountersForTest(values: { readonly nextJobId?: number; readonly nextGeneration?: number }): void {
    if (values.nextJobId !== undefined) this.#nextJobId = values.nextJobId;
    if (values.nextGeneration !== undefined) {
      for (const slot of this.#slots) slot.generation = values.nextGeneration;
    }
  }

  /** Capability and metadata preflight. A false result keeps baseline verification. */
  canRun(index: SparsePcmIndex): boolean {
    return !this.#closed && hasWorkerCapabilities(this.#bufferTransfer) && index.intervals.length <= SPARSE_VERIFY_MAX_INTERVALS;
  }

  /** Promise facade for tests and the private store bridge. */
  run(options: SparseVerifyWorkerRunOptions): Promise<SparseVerifyWorkerResult> {
    return Effect.runPromise(this.runEffect(options));
  }

  /** Effect-owned callback bridge. Interruption awaits job invalidation and cleanup. */
  runEffect(options: SparseVerifyWorkerRunOptions): Effect.Effect<SparseVerifyWorkerResult, SparseVerifyWorkerError> {
    return Effect.callback<SparseVerifyWorkerResult, SparseVerifyWorkerError>((resume, effectSignal) => {
      if (!this.canRun(options.index)) {
        resume(Effect.fail(new SparseVerifyWorkerError("boundary", "Sparse verification Worker capability or metadata bound is unavailable")));
        return Effect.void;
      }
      if (options.signal.aborted) {
        resume(Effect.fail(new SparseVerifyWorkerError("cancelled", "Sparse verification was cancelled", options.signal.reason)));
        return Effect.void;
      }
      const jobOrError = this.enqueue(options, resume);
      if (jobOrError instanceof SparseVerifyWorkerError) {
        resume(Effect.fail(jobOrError));
        return Effect.void;
      }
      const job = jobOrError;
      const onAbort = (): void => {
        void this.abortJob(job, options.signal.reason).then((failure) => {
          if (failure !== undefined) resume(Effect.fail(failure));
        });
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
      return Effect.promise(async () => {
        options.signal.removeEventListener("abort", onAbort);
        if (job.settled) return;
        const failure = await this.abortJob(job, new DOMException("Sparse verification Effect interrupted", "AbortError"));
        if (failure !== undefined) throw failure;
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.closeOnce();
    return this.#closePromise;
  }

  private enqueue(options: SparseVerifyWorkerRunOptions, settle: Settlement): PendingJob | SparseVerifyWorkerError {
    if (this.#closed) return new SparseVerifyWorkerError("boundary", "Sparse verification Worker pool is closed");
    if (this.#nextJobId > Number.MAX_SAFE_INTEGER) {
      const failure = new SparseVerifyWorkerError("boundary", "Sparse verification Worker job identifiers are exhausted");
      this.failClosed(failure);
      void this.close().catch(() => undefined);
      return failure;
    }
    const job: PendingJob = {
      options,
      jobId: this.#nextJobId,
      settle,
      queued: true,
      settled: false,
      slot: undefined,
    };
    this.#nextJobId += 1;
    this.#queue.push(job);
    this.dispatch();
    return job;
  }

  private async closeOnce(): Promise<void> {
    for (const job of this.#queue.splice(0)) {
      job.queued = false;
      this.settleJob(job, Effect.fail(new SparseVerifyWorkerError("cancelled", "Sparse verification preparation closed")));
    }
    const failures: unknown[] = [];
    for (const slot of [...this.#slots]) {
      const job = slot.pending;
      const terminationFailure = await this.terminateSlot(slot);
      if (terminationFailure !== undefined) failures.push(terminationFailure);
      slot.pending = undefined;
      slot.busy = false;
      slot.finishing = false;
      if (job !== undefined) {
        job.slot = undefined;
        this.settleJob(job, Effect.fail(new SparseVerifyWorkerError("cancelled", "Sparse verification preparation closed")));
      }
    }
    failures.push(...this.#terminationFailures.filter((failure, index, all) => all.indexOf(failure) === index));
    if (failures.length > 0) throw failures.length === 1 ? failures[0] : new AggregateError(failures, "Sparse verification Worker cleanup failed");
  }

  private dispatch(): void {
    while (!this.#closed && this.#queue.length > 0) {
      const slot = [...this.#slots].find((candidate) => !candidate.busy && !candidate.terminating && !candidate.terminated) ?? this.newSlot();
      if (slot === undefined) return;
      const job = this.#queue.shift()!;
      job.queued = false;
      this.start(slot, job);
    }
  }

  private newSlot(): WorkerSlot | undefined {
    if (this.#slots.size >= this.#width) return undefined;
    let worker: WorkerLike;
    try { worker = createSparseVerifyWorker() as unknown as WorkerLike; }
    catch (cause) {
      const job = this.#queue.shift();
      if (job !== undefined) {
        job.queued = false;
        this.settleJob(job, Effect.fail(new SparseVerifyWorkerError("io", "Sparse verification Worker could not be constructed", cause)));
      }
      return undefined;
    }
    const slot: WorkerSlot = {
      worker,
      generation: 0,
      busy: false,
      terminating: false,
      terminated: false,
      terminationFailure: undefined,
      finishing: false,
      finishPromise: undefined,
      pending: undefined,
      timer: undefined,
      onMessage: undefined,
      onError: undefined,
      onMessageError: undefined,
      lastProgress: 0,
    };
    this.#slots.add(slot);
    return slot;
  }

  private start(slot: WorkerSlot, job: PendingJob): void {
    if (slot.generation >= Number.MAX_SAFE_INTEGER) {
      this.settleJob(job, Effect.fail(new SparseVerifyWorkerError("boundary", "Sparse verification Worker generations are exhausted")));
      this.failClosed(new SparseVerifyWorkerError("boundary", "Sparse verification Worker generations are exhausted"));
      void this.close().catch(() => undefined);
      return;
    }
    const generation = slot.generation + 1;
    slot.generation = generation;
    slot.busy = true;
    slot.pending = job;
    slot.lastProgress = 0;
    job.slot = slot;
    const onMessage = (event: any): void => this.message(slot, generation, event);
    const onError = (event: any): void => this.failSlot(slot, generation, new SparseVerifyWorkerError("io", "Sparse verification Worker failed", event?.error ?? event?.message));
    const onMessageError = (event: any): void => this.failSlot(slot, generation, new SparseVerifyWorkerError("io", "Sparse verification Worker message could not be decoded", event));
    slot.onMessage = onMessage;
    slot.onError = onError;
    slot.onMessageError = onMessageError;
    slot.worker.addEventListener("message", onMessage);
    slot.worker.addEventListener("error", onError);
    slot.worker.addEventListener("messageerror", onMessageError);
    this.resetWatchdog(slot, generation, job.options.readDeadlineMs);
    const intervals = packSparseVerifyIntervals(job.options.index);
    if (intervals === undefined) {
      this.failSlot(slot, generation, new SparseVerifyWorkerError("boundary", "Sparse verification interval metadata exceeds its bound"));
      return;
    }
    const request: SparseVerifyStart = {
      type: "start",
      version: SPARSE_VERIFY_PROTOCOL_VERSION,
      jobId: job.jobId,
      generation,
      identity: job.options.identity,
      frames: job.options.frames,
      channels: job.options.channels,
      bitDepth: job.options.bitDepth,
      frameBytes: job.options.channels * (job.options.bitDepth / 8),
      canonicalBytes: job.options.canonicalBytes,
      activeBytes: job.options.index.activeBytes,
      intervalCount: job.options.index.intervals.length,
      intervals,
      data: job.options.data,
      readDeadlineMs: job.options.readDeadlineMs,
    };
    try { slot.worker.postMessage(request, [intervals]); }
    catch (cause) { this.failSlot(slot, generation, new SparseVerifyWorkerError("io", "Sparse verification Worker request could not be posted", cause)); }
  }

  private message(slot: WorkerSlot, generation: number, event: any): void {
    const job = slot.pending;
    if (job === undefined || slot.generation !== generation || slot.terminated || slot.finishing) return;
    let response: SparseVerifyWorkerResponse;
    try { response = sparseVerifyWorkerResponse(event?.data); }
    catch (cause) {
      this.failSlot(slot, generation, new SparseVerifyWorkerError("corrupt", "Sparse verification Worker response was malformed", cause));
      return;
    }
    if (response.jobId !== job.jobId || response.generation !== generation) return;
    if (response.type === "progress") {
      if (response.bytes <= slot.lastProgress || response.bytes > job.options.canonicalBytes) {
        this.failSlot(slot, generation, new SparseVerifyWorkerError("corrupt", "Sparse verification Worker progress was not monotonic"));
        return;
      }
      slot.lastProgress = response.bytes;
      this.resetWatchdog(slot, generation, job.options.readDeadlineMs);
      try { job.options.onProgress?.(response.bytes); } catch { /* progress is observational */ }
      if (job.options.signal.aborted) {
        void this.abortJob(job, job.options.signal.reason);
        return;
      }
      try {
        slot.worker.postMessage({ type: "ack", version: SPARSE_VERIFY_PROTOCOL_VERSION, jobId: job.jobId, generation, bytes: response.bytes });
      } catch (cause) {
        this.failSlot(slot, generation, new SparseVerifyWorkerError("io", "Sparse verification Worker acknowledgement could not be posted", cause));
      }
      return;
    }
    if (response.type === "failure") {
      this.failSlot(slot, generation, new SparseVerifyWorkerError(response.kind, response.message));
      return;
    }
    let expectedCounts: ReturnType<typeof sparseVerifyExpectedCounts>;
    try { expectedCounts = sparseVerifyExpectedCounts(job.options.index, job.options.frames, job.options.channels * (job.options.bitDepth / 8)); }
    catch (cause) {
      this.failSlot(slot, generation, new SparseVerifyWorkerError("corrupt", "Sparse verification count expectation was invalid", cause));
      return;
    }
    if (response.identity !== job.options.identity || response.progressBytes !== job.options.canonicalBytes || response.canonicalBytes !== job.options.canonicalBytes ||
      response.readBytes !== job.options.index.activeBytes || response.hashedBytes !== job.options.canonicalBytes ||
      response.readCalls !== expectedCounts.readCalls || response.hashUpdates !== expectedCounts.hashUpdates || response.zeroUpdates !== expectedCounts.zeroUpdates) {
      this.failSlot(slot, generation, new SparseVerifyWorkerError("corrupt", "Sparse verification Worker counts or identity disagreed with the admitted descriptor"));
      return;
    }
    this.resetWatchdog(slot, generation, job.options.readDeadlineMs);
    this.complete(slot, generation, response);
  }

  private complete(slot: WorkerSlot, generation: number, result: SparseVerifyWorkerResult): void {
    const job = slot.pending;
    if (job === undefined || slot.generation !== generation) return;
    this.detach(slot);
    slot.pending = undefined;
    slot.busy = false;
    job.slot = undefined;
    this.settleJob(job, Effect.succeed(result));
    this.dispatch();
  }

  private async abortJob(job: PendingJob, reason: unknown): Promise<SparseVerifyWorkerError | undefined> {
    if (job.settled) return undefined;
    if (job.queued) {
      const index = this.#queue.indexOf(job);
      if (index >= 0) this.#queue.splice(index, 1);
      job.queued = false;
      this.settleJob(job, Effect.fail(new SparseVerifyWorkerError("cancelled", "Sparse verification was cancelled", reason)));
      return undefined;
    }
    const slot = job.slot;
    if (slot === undefined) return undefined;
    return this.finishSlot(slot, new SparseVerifyWorkerError("cancelled", "Sparse verification was cancelled", reason), true);
  }

  private failSlot(slot: WorkerSlot, generation: number, cause: SparseVerifyWorkerError): void {
    if (slot.generation !== generation || slot.terminated || slot.finishing) return;
    void this.finishSlot(slot, cause, true);
  }

  private async finishSlot(slot: WorkerSlot, cause: SparseVerifyWorkerError, terminate: boolean): Promise<SparseVerifyWorkerError | undefined> {
    if (slot.finishing) return slot.finishPromise;
    slot.finishing = true;
    const promise = this.finishSlotOnce(slot, cause, terminate);
    slot.finishPromise = promise;
    return promise;
  }

  private async finishSlotOnce(slot: WorkerSlot, cause: SparseVerifyWorkerError, terminate: boolean): Promise<SparseVerifyWorkerError | undefined> {
    const job = slot.pending;
    this.detach(slot);
    slot.pending = undefined;
    slot.busy = false;
    if (job !== undefined) job.slot = undefined;
    let terminationFailure: unknown;
    if (terminate) terminationFailure = await this.terminateSlot(slot);
    if (terminationFailure !== undefined) this.failClosed(new SparseVerifyWorkerError("io", "Sparse verification Worker termination failed", terminationFailure));
    if (job !== undefined) this.settleJob(job, Effect.fail(terminationFailure === undefined ? cause : new SparseVerifyWorkerError("io", "Sparse verification Worker termination failed", new AggregateError([cause, terminationFailure]))));
    slot.finishing = false;
    if (terminationFailure === undefined) this.dispatch();
    else void this.close().catch(() => undefined);
    return terminationFailure === undefined ? undefined : new SparseVerifyWorkerError("io", "Sparse verification Worker termination failed", terminationFailure);
  }

  private async terminateSlot(slot: WorkerSlot): Promise<unknown> {
    if (slot.terminated) return undefined;
    if (slot.terminating) return slot.terminationFailure;
    slot.terminating = true;
    this.detach(slot);
    try {
      slot.worker.terminate();
      slot.terminated = true;
      this.#slots.delete(slot);
      return undefined;
    } catch (cause) {
      slot.terminating = false;
      slot.terminationFailure = cause;
      if (!this.#terminationFailures.includes(cause)) this.#terminationFailures.push(cause);
      this.#closed = true;
      return cause;
    }
  }

  private settleJob(job: PendingJob, effect: Effect.Effect<SparseVerifyWorkerResult, SparseVerifyWorkerError>): void {
    if (job.settled) return;
    job.settled = true;
    job.settle(effect);
  }

  private failClosed(cause: unknown): void {
    this.#closed = true;
    if (!this.#terminationFailures.includes(cause)) this.#terminationFailures.push(cause);
  }

  private detach(slot: WorkerSlot): void {
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = undefined;
    if (slot.onMessage !== undefined) slot.worker.removeEventListener("message", slot.onMessage);
    if (slot.onError !== undefined) slot.worker.removeEventListener("error", slot.onError);
    if (slot.onMessageError !== undefined) slot.worker.removeEventListener("messageerror", slot.onMessageError);
    slot.onMessage = undefined;
    slot.onError = undefined;
    slot.onMessageError = undefined;
  }

  private resetWatchdog(slot: WorkerSlot, generation: number, deadlineMs: number): void {
    if (slot.timer !== undefined) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      if (slot.generation !== generation || slot.pending === undefined || slot.terminated || slot.finishing) return;
      this.failSlot(slot, generation, new SparseVerifyWorkerError("deadline", "Sparse verification Worker made no progress before its deadline"));
    }, deadlineMs);
  }
}

function hasWorkerCapabilities(bufferTransfer: SparseVerifyArrayBufferTransfer | undefined): boolean {
  const globals = globalThis as unknown as { readonly Worker?: unknown; readonly MessageChannel?: unknown; readonly WebAssembly?: unknown };
  return bufferTransfer !== undefined && typeof globals.Worker === "function" && typeof globals.MessageChannel === "function" && globals.WebAssembly !== undefined;
}
