import { Cause, Effect, Exit, Fiber } from "effect";

import { createIncrementalBlake3, type IncrementalBlake3 } from "../stems/blake3.js";
import { verifiedSparseVerifyArrayBufferTransfer, type SparseVerifyArrayBufferTransfer } from "../stems/sparse-verify-buffer.js";
import {
  SPARSE_VERIFY_READ_BYTES,
  SPARSE_VERIFY_PROTOCOL_VERSION,
  SPARSE_VERIFY_ZERO_BYTES,
  sparseVerifyWorkerControl,
  sparseVerifyWorkerStart,
  type SparseVerifyComplete,
  type SparseVerifyFailureKind,
  type SparseVerifyStart,
  type SparseVerifyWorkerRequest,
  type SparseVerifyWorkerResponse,
} from "../stems/sparse-verify-worker-protocol.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<SparseVerifyWorkerRequest>) => void) | null;
  postMessage(message: SparseVerifyWorkerResponse): void;
  close?: () => void;
}

interface JobState {
  request: SparseVerifyStart;
  intervals: Float64Array;
  readonly transfer: SparseVerifyArrayBufferTransfer;
  readonly controller: AbortController;
  fiber: Fiber.Fiber<SparseVerifyComplete, WorkerVerificationError> | undefined;
  latestProgress: number;
  sentProgress: number;
  awaitingAck: boolean;
  cleared: boolean;
}

interface Counters {
  readCalls: number;
  readBytes: number;
  hashedBytes: number;
  hashUpdates: number;
  zeroUpdates: number;
  readWaitMs: number;
  hashMs: number;
}

class WorkerVerificationError extends Error {
  readonly kind: SparseVerifyFailureKind;

  constructor(kind: SparseVerifyFailureKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkerVerificationError";
    this.kind = kind;
  }
}

const scope = ((globalThis as unknown as { readonly self?: WorkerScope }).self ?? globalThis) as unknown as WorkerScope;
let active: JobState | undefined;

scope.onmessage = (event) => {
  const value = event.data as unknown;
  if (isStart(value)) {
    start(value);
    return;
  }
  try {
    const control = sparseVerifyWorkerControl(value);
    const job = active;
    if (job === undefined || control.jobId !== job.request.jobId || control.generation !== job.request.generation) return;
    if (control.type === "cancel") {
      job.controller.abort();
      const fiber = job.fiber;
      if (fiber !== undefined) void Effect.runPromise(Fiber.interrupt(fiber));
      return;
    }
    if (!job.awaitingAck || control.bytes !== job.sentProgress) throw new WorkerVerificationError("corrupt", "Sparse verification progress acknowledgement is stale");
    job.awaitingAck = false;
    if (job.latestProgress > job.sentProgress) postProgress(job);
  } catch (cause) {
    const job = active;
    if (job !== undefined) {
      job.controller.abort();
      if (job.fiber !== undefined) void Effect.runPromise(Fiber.interrupt(job.fiber));
      fail(job, cause);
    }
  }
};

function isStart(value: unknown): value is SparseVerifyStart {
  return typeof value === "object" && value !== null && (value as { readonly type?: unknown }).type === "start";
}

function start(value: SparseVerifyStart): void {
  let decoded: ReturnType<typeof sparseVerifyWorkerStart>;
  try {
    decoded = sparseVerifyWorkerStart(value);
  } catch (cause) {
    postFailure(value, "corrupt", message(cause));
    return;
  }
  if (active !== undefined) {
    postFailure(value, "corrupt", "Sparse verification worker received overlapping jobs");
    return;
  }
  const transfer = verifiedSparseVerifyArrayBufferTransfer();
  if (transfer === undefined) {
    postFailure(value, "boundary", "Sparse verification ArrayBuffer transfer capability is unavailable");
    return;
  }
  const job: JobState = {
    request: decoded.request,
    intervals: decoded.intervals,
    transfer,
    controller: new AbortController(),
    fiber: undefined,
    latestProgress: 0,
    sentProgress: 0,
    awaitingAck: false,
    cleared: false,
  };
  active = job;
  const execution = Effect.onExit(verify(job), (exit) => Effect.sync(() => finish(job, exit)));
  job.fiber = Effect.runFork(execution);
}

function verify(job: JobState): Effect.Effect<SparseVerifyComplete, WorkerVerificationError> {
  return Effect.gen(function*() {
    const request = job.request;
    const started = now();
    const hash = yield* Effect.tryPromise({
      try: () => createIncrementalBlake3(),
      catch: (cause) => new WorkerVerificationError("io", "Sparse verification BLAKE3 initialization failed", cause),
    });
    const counters: Counters = {
      readCalls: 0, readBytes: 0, hashedBytes: 0, hashUpdates: 0, zeroUpdates: 0,
      readWaitMs: 0, hashMs: 0,
    };
    let payloadCursor = 0;
    let frameCursor = 0;
    for (let index = 0; index < request.intervalCount; index += 1) {
      const offset = index * 3;
      const startFrame = job.intervals[offset]!;
      const frames = job.intervals[offset + 1]!;
      const byteOffset = job.intervals[offset + 2]!;
      yield* hashZeros(job, hash, (startFrame - frameCursor) * request.frameBytes, frameCursor * request.frameBytes, counters);
      const intervalBytes = frames * request.frameBytes;
      for (let localOffset = 0; localOffset < intervalBytes; localOffset += SPARSE_VERIFY_READ_BYTES) {
        checkCancelled(job);
        const end = Math.min(localOffset + SPARSE_VERIFY_READ_BYTES, intervalBytes);
        const before = now();
        const readLength = yield* readAndConsume(job, request.data, byteOffset + localOffset, byteOffset + end, before, hash, counters);
        counters.readCalls = addCount(counters.readCalls, 1);
        counters.readBytes = addCount(counters.readBytes, readLength);
        payloadCursor = addCount(payloadCursor, readLength);
        if (payloadCursor > request.activeBytes) throw new WorkerVerificationError("corrupt", "Sparse verification payload cursor exceeded its bound");
      }
      frameCursor = addCount(startFrame, frames);
    }
    yield* hashZeros(job, hash, (request.frames - frameCursor) * request.frameBytes, frameCursor * request.frameBytes, counters);
    checkCancelled(job);
    const beforeDigest = now();
    const digest = yield* Effect.try({
      try: () => hash.digest("hex"),
      catch: (cause) => new WorkerVerificationError("corrupt", "Sparse verification digest failed", cause),
    });
    counters.hashMs += Math.max(0, now() - beforeDigest);
    if (payloadCursor !== request.data.size || counters.readBytes !== request.activeBytes || counters.hashedBytes !== request.canonicalBytes) {
      throw new WorkerVerificationError("corrupt", "Sparse verification byte counts are inconsistent");
    }
    return {
      type: "complete",
      version: SPARSE_VERIFY_PROTOCOL_VERSION,
      jobId: request.jobId,
      generation: request.generation,
      identity: request.identity,
      digest,
      progressBytes: request.canonicalBytes,
      canonicalBytes: counters.hashedBytes,
      readCalls: counters.readCalls,
      readBytes: counters.readBytes,
      hashedBytes: counters.hashedBytes,
      hashUpdates: counters.hashUpdates,
      zeroUpdates: counters.zeroUpdates,
      elapsedMs: Math.max(0, now() - started),
      readWaitMs: counters.readWaitMs,
      hashMs: counters.hashMs,
    } satisfies SparseVerifyComplete;
  });
}

function hashZeros(
  job: JobState,
  hash: IncrementalBlake3,
  bytes: number,
  baseBytes: number,
  counters: Counters,
): Effect.Effect<void, WorkerVerificationError> {
  return Effect.gen(function*() {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(baseBytes) || baseBytes < 0 || !Number.isSafeInteger(baseBytes + bytes)) {
      return yield* Effect.fail(new WorkerVerificationError("corrupt", "Sparse verification zero gap arithmetic is unsafe"));
    }
    const zero = new Uint8Array(SPARSE_VERIFY_ZERO_BYTES);
    for (let offset = 0; offset < bytes; offset += zero.byteLength) {
      checkCancelled(job);
      const take = Math.min(zero.byteLength, bytes - offset);
      yield* hashUpdate(job, hash, zero.subarray(0, take), counters);
      counters.zeroUpdates = addCount(counters.zeroUpdates, 1);
      yield* taskYield();
    }
  });
}

function hashUpdateSync(job: JobState, hash: IncrementalBlake3, bytes: Uint8Array, counters: Counters): void {
  const started = now();
  try { hash.update(bytes); }
  catch (cause) { throw new WorkerVerificationError("io", "Sparse verification hash update failed", cause); }
  counters.hashMs += Math.max(0, now() - started);
  try {
    counters.hashedBytes = addCount(counters.hashedBytes, bytes.byteLength);
    counters.hashUpdates = addCount(counters.hashUpdates, 1);
    emitProgress(job, counters.hashedBytes);
  } catch (cause) {
    if (cause instanceof WorkerVerificationError) throw cause;
    throw new WorkerVerificationError("io", "Sparse verification hash update failed", cause);
  }
}

function hashUpdate(job: JobState, hash: IncrementalBlake3, bytes: Uint8Array, counters: Counters): Effect.Effect<void, WorkerVerificationError> {
  return Effect.try({
    try: () => hashUpdateSync(job, hash, bytes, counters),
    catch: (cause) => cause instanceof WorkerVerificationError ? cause : new WorkerVerificationError("io", "Sparse verification hash update failed", cause),
  });
}

function readAndConsume(
  job: JobState,
  blob: Blob,
  start: number,
  end: number,
  beforeRead: number,
  hash: IncrementalBlake3,
  counters: Counters,
): Effect.Effect<number, WorkerVerificationError> {
  return Effect.callback<number, WorkerVerificationError>((resume, effectSignal) => {
    let pending: Promise<ArrayBuffer>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = (): void => {
      effectSignal.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const finish = (result: Effect.Effect<number, WorkerVerificationError>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(result);
    };
    const onAbort = (): void => finish(Effect.fail(new WorkerVerificationError("cancelled", "Sparse verification payload read was cancelled")));
    const disposeLate = (value: ArrayBuffer): void => {
      try { void job.transfer(value, 0); } catch { /* the original deadline/cancelled result remains primary */ }
    };
    const onValue = (value: ArrayBuffer): void => {
      if (settled || effectSignal.aborted) {
        disposeLate(value);
        return;
      }
      counters.readWaitMs += Math.max(0, now() - beforeRead);
      let result: Effect.Effect<number, WorkerVerificationError>;
      try {
        result = Effect.succeed(consumeBuffer(job, value, end - start, hash, counters));
      } catch (cause) {
        result = Effect.fail(cause instanceof WorkerVerificationError
          ? cause
          : new WorkerVerificationError("io", "Sparse verification payload consumption failed", cause));
      }
      finish(result);
    };
    if (effectSignal.aborted) {
      onAbort();
      return Effect.void;
    }
    try {
      pending = Promise.resolve(blob.slice(start, end).arrayBuffer());
    } catch (cause) {
      finish(Effect.fail(new WorkerVerificationError("io", "Sparse verification payload read failed", cause)));
      return Effect.void;
    }
    pending.catch(() => undefined);
    effectSignal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(Effect.fail(new WorkerVerificationError("deadline", "Sparse verification payload read exceeded its deadline"))), job.request.readDeadlineMs);
    pending.then(
      onValue,
      (cause) => { if (!effectSignal.aborted) finish(Effect.fail(new WorkerVerificationError("io", "Sparse verification payload read failed", cause))); },
    );
    return Effect.sync(() => {
      settled = true;
      cleanup();
    });
  });
}

function consumeBuffer(job: JobState, buffer: ArrayBuffer, expectedLength: number, hash: IncrementalBlake3, counters: Counters): number {
  let owned: ArrayBuffer | undefined = buffer;
  let view: Uint8Array | undefined;
  let readLength = 0;
  let primary: WorkerVerificationError | undefined;
  try {
    readLength = owned.byteLength;
    if (readLength !== expectedLength) throw new WorkerVerificationError("corrupt", "Sparse verification payload read was short");
    checkCancelled(job);
    view = new Uint8Array(owned);
    hashUpdateSync(job, hash, view, counters);
  } catch (cause) {
    primary = cause instanceof WorkerVerificationError
      ? cause
      : new WorkerVerificationError("io", "Sparse verification payload consumption failed", cause);
  } finally {
    if (owned !== undefined) {
      try { void job.transfer(owned, 0); }
      catch (cause) {
        if (primary === undefined) primary = new WorkerVerificationError("io", "Sparse verification payload disposal failed", cause);
      }
    }
    view = undefined;
    owned = undefined;
  }
  if (primary !== undefined) throw primary;
  return readLength;
}

function taskYield(): Effect.Effect<void, WorkerVerificationError> {
  return Effect.callback<void, WorkerVerificationError>((resume, effectSignal) => {
    if (effectSignal.aborted) {
      resume(Effect.fail(new WorkerVerificationError("cancelled", "Sparse verification task yield was cancelled")));
      return Effect.void;
    }
    const Constructor = (globalThis as unknown as { readonly MessageChannel?: typeof MessageChannel }).MessageChannel;
    if (typeof Constructor !== "function") {
      resume(Effect.fail(new WorkerVerificationError("boundary", "Sparse verification MessageChannel is unavailable")));
      return Effect.void;
    }
    let channel: MessageChannel;
    try { channel = new Constructor(); }
    catch (cause) {
      resume(Effect.fail(new WorkerVerificationError("boundary", "Sparse verification MessageChannel could not be constructed", cause)));
      return Effect.void;
    }
    let settled = false;
    const close = (): void => {
      try { channel.port1.onmessage = null; } catch { /* best effort during interruption */ }
      try { channel.port1.close(); } catch { /* best effort during interruption */ }
      try { channel.port2.close(); } catch { /* best effort during interruption */ }
    };
    const finish = (result: Effect.Effect<void, WorkerVerificationError>): void => {
      if (settled) return;
      settled = true;
      effectSignal.removeEventListener("abort", onAbort);
      close();
      resume(result);
    };
    const onAbort = (): void => finish(Effect.fail(new WorkerVerificationError("cancelled", "Sparse verification task yield was cancelled")));
    channel.port1.onmessage = () => finish(Effect.succeed(undefined));
    effectSignal.addEventListener("abort", onAbort, { once: true });
    try { channel.port2.postMessage(null); }
    catch (cause) { finish(Effect.fail(new WorkerVerificationError("io", "Sparse verification MessageChannel post failed", cause))); }
    return Effect.sync(close);
  });
}

function checkCancelled(job: JobState): void {
  if (job.controller.signal.aborted) throw new WorkerVerificationError("cancelled", "Sparse verification was cancelled");
}

function emitProgress(job: JobState, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > job.request.canonicalBytes || bytes < job.latestProgress) {
    throw new WorkerVerificationError("corrupt", "Sparse verification progress is invalid");
  }
  job.latestProgress = bytes;
  if (!job.awaitingAck && bytes > job.sentProgress) postProgress(job);
}

function postProgress(job: JobState): void {
  const bytes = job.latestProgress;
  if (bytes <= job.sentProgress) return;
  // Publish the transport state before calling into the host. Test doubles
  // and unusual Worker shims may deliver the acknowledgement synchronously.
  job.sentProgress = bytes;
  job.awaitingAck = true;
  try {
    scope.postMessage({
      type: "progress",
      version: SPARSE_VERIFY_PROTOCOL_VERSION,
      jobId: job.request.jobId,
      generation: job.request.generation,
      bytes,
    });
  } catch (cause) {
    throw new WorkerVerificationError("io", "Sparse verification progress could not be posted", cause);
  }
}

function finish(job: JobState, exit: Exit.Exit<SparseVerifyComplete, WorkerVerificationError>): void {
  if (job.cleared) return;
  if (Exit.isSuccess(exit)) {
    const complete = exit.value;
    clear(job);
    try { scope.postMessage(complete); }
    catch {
      // The reusable worker cannot report a completion after its port fails.
      scope.close?.();
    }
    return;
  }
  if (job.controller.signal.aborted || Cause.hasInterruptsOnly(exit.cause)) {
    clear(job);
    return;
  }
  fail(job, Cause.squash(exit.cause));
}

function fail(job: JobState, cause: unknown): void {
  if (job.cleared) return;
  const request = job.request;
  postFailure(request, cause instanceof WorkerVerificationError ? cause.kind : "io", message(cause));
  clear(job);
}

function postFailure(request: Partial<SparseVerifyStart>, kind: SparseVerifyFailureKind, text: string): void {
  if (typeof request.jobId !== "number" || typeof request.generation !== "number") return;
  try {
    scope.postMessage({
      type: "failure",
      version: SPARSE_VERIFY_PROTOCOL_VERSION,
      jobId: request.jobId,
      generation: request.generation,
      kind,
      message: text,
    });
  } catch {
    scope.close?.();
  }
}

function clear(job: JobState): void {
  if (job.cleared) return;
  job.cleared = true;
  job.controller.abort();
  job.latestProgress = 0;
  job.sentProgress = 0;
  job.awaitingAck = false;
  job.intervals = undefined as never;
  job.request = undefined as never;
  job.fiber = undefined;
  if (active === job) active = undefined;
}

function addCount(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right < 0 || !Number.isSafeInteger(left + right)) {
    throw new WorkerVerificationError("corrupt", "Sparse verification scalar count exceeded its safe bound");
  }
  return left + right;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function now(): number { return typeof performance === "undefined" ? Date.now() : performance.now(); }
