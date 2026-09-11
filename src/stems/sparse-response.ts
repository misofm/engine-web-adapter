import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { EngineWebAdapterError } from "../errors.js";
import type { StemIdentity } from "./types.js";
import type { BoundedStemAdmission, StemAdmissionLease } from "./flac-admission.js";

export const SPARSE_RESPONSE_MAX_INPUT_BYTES = 256 * 1024;

export interface SparseResponseOptions {
  readonly identity: StemIdentity;
  readonly locate: (identity: StemIdentity, options: { readonly signal: AbortSignal }) => string | URL | Request | Promise<string | URL | Request>;
  readonly fetch?: typeof globalThis.fetch;
  readonly readDeadlineMs: number;
  readonly admission: BoundedStemAdmission;
  readonly signal: AbortSignal;
  /** The owner of `signal` can abort the complete resolver operation. */
  readonly abortOperation?: (reason: unknown) => void;
}

export interface SparseResponseCursor {
  readonly position: number;
  readonly contentLength: number | undefined;
  readonly readExact: (length: number) => Effect.Effect<Uint8Array, EngineWebAdapterError>;
  /** Publish the body borrow before the successful effect value is yielded. */
  readonly readChunk: (length: number, adopt?: (release: () => void) => void) => Effect.Effect<Readonly<{ bytes: Uint8Array; end: boolean; release: () => void }>, EngineWebAdapterError>;
  readonly assertContentLength: (expected: number) => Effect.Effect<void, EngineWebAdapterError>;
  readonly assertEof: Effect.Effect<void, EngineWebAdapterError>;
}

interface NormalizedRequest {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly fetchInit: RequestInit;
  readonly dispose: () => void;
}

function failure(code: EngineWebAdapterError["code"], message: string, details: Readonly<Record<string, unknown>> = {}, cause?: unknown): EngineWebAdapterError {
  return new EngineWebAdapterError(code, message, details, cause);
}

function requestPolicy(location: string | URL | Request, operationController: AbortController, abortOperation: ((reason: unknown) => void) | undefined, identity: StemIdentity): NormalizedRequest {
  let base: Request;
  try { base = location instanceof Request ? location : new Request(location); }
  catch (cause) { throw failure("stem.delivery.address", "Sparse locator returned an invalid delivery address", { identity }, cause); }
  if (base.method !== "GET" || base.body !== null) throw failure("stem.delivery.address", "Sparse locator must return a bodyless GET Request", { identity });
  const headers = new Headers(base.headers);
  headers.delete("range");
  headers.delete("if-range");
  const requestController = new AbortController();
  const onOperationAbort = () => requestController.abort(operationController.signal.reason);
  const onLocationAbort = () => {
    requestController.abort(base.signal.reason);
    operationController.abort(base.signal.reason);
    abortOperation?.(base.signal.reason);
  };
  operationController.signal.addEventListener("abort", onOperationAbort, { once: true });
  base.signal.addEventListener("abort", onLocationAbort, { once: true });
  if (operationController.signal.aborted) onOperationAbort();
  if (base.signal.aborted) onLocationAbort();
  try {
    return {
      request: HttpClientRequest.fromWeb(new Request(base, { headers, signal: requestController.signal })),
      fetchInit: {
        credentials: base.credentials,
        mode: base.mode,
        cache: base.cache,
        redirect: base.redirect,
        integrity: base.integrity,
        referrer: base.referrer,
        referrerPolicy: base.referrerPolicy,
        keepalive: base.keepalive,
      },
      dispose: () => {
        operationController.signal.removeEventListener("abort", onOperationAbort);
        base.signal.removeEventListener("abort", onLocationAbort);
      },
    };
  } catch (cause) {
    operationController.signal.removeEventListener("abort", onOperationAbort);
    base.signal.removeEventListener("abort", onLocationAbort);
    throw failure("stem.delivery.address", "Sparse full-response Request could not be constructed", { identity }, cause);
  }
}

function preserveEffectFailure(identity: StemIdentity, operation: string, cause: unknown): EngineWebAdapterError {
  if (cause instanceof EngineWebAdapterError) return cause;
  return failure("stem.delivery.http", `Sparse full response ${operation} failed`, { identity, operation }, cause);
}

function abortEffect(signal: AbortSignal, identity: StemIdentity): Effect.Effect<never, EngineWebAdapterError> {
  return Effect.callback<never, EngineWebAdapterError>((resume, effectSignal) => {
    const abort = () => resume(Effect.fail(failure("stem.cancelled", "Sparse full response was cancelled", { identity }, signal.reason)));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", abort);
      effectSignal.removeEventListener("abort", abort);
    });
  });
}

function parseContentLength(value: string | undefined, identity: StemIdentity): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw failure("stem.delivery.http", "Sparse full response has malformed Content-Length", { identity, contentLength: value });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw failure("stem.delivery.http", "Sparse full response Content-Length is outside its safe bound", { identity, contentLength: value });
  return parsed;
}

/** Acquire one real response and own its actual body reader in the current Scope. */
export function openSparseResponse(options: SparseResponseOptions): Effect.Effect<SparseResponseCursor, EngineWebAdapterError, HttpClient.HttpClient | import("effect").Scope.Scope> {
  return Effect.gen(function*() {
    if (options.signal.aborted) return yield* Effect.fail(failure("stem.cancelled", "Sparse full response was cancelled before acquisition", { identity: options.identity }, options.signal.reason));
    const lease = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => options.admission.acquire(options.signal), catch: cause => preserveEffectFailure(options.identity, "download admission", cause) }),
      (held: StemAdmissionLease) => Effect.sync(() => held.release()),
      { interruptible: true },
    );
    const requestController = new AbortController();
    const onAbort = () => requestController.abort(options.signal.reason);
    options.signal.addEventListener("abort", onAbort, { once: true });
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      options.signal.removeEventListener("abort", onAbort);
      requestController.abort(new DOMException("Sparse full response scope closed", "AbortError"));
    }));
    const location = yield* Effect.tryPromise({
      try: () => Promise.resolve(options.locate(options.identity, { signal: requestController.signal })),
      catch: cause => preserveEffectFailure(options.identity, "locator", cause),
    }).pipe(Effect.timeoutOrElse({ duration: options.readDeadlineMs, orElse: () => Effect.fail(failure("stem.delivery.address", "Sparse locator exceeded its deadline", { identity: options.identity })) }));
    const normalized = yield* Effect.try({ try: () => requestPolicy(location, requestController, options.abortOperation, options.identity), catch: cause => preserveEffectFailure(options.identity, "request normalization", cause) });
    yield* Effect.addFinalizer(() => Effect.sync(normalized.dispose));
    const http = yield* HttpClient.HttpClient;
    let physicalResponse: Response | undefined;
    const physicalFetch: typeof globalThis.fetch = (input, init) => Promise.resolve((options.fetch ?? globalThis.fetch)(input, init)).then(response => {
      physicalResponse = response;
      return response;
    });
    const response = yield* HttpClient.withScope(http).execute(normalized.request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, normalized.fetchInit),
      Effect.provideService(FetchHttpClient.Fetch, physicalFetch),
      Effect.timeoutOrElse({ duration: options.readDeadlineMs, orElse: () => Effect.fail(failure("stem.delivery.stall", "Sparse full response headers exceeded their deadline", { identity: options.identity })) }),
      Effect.mapError((cause) => preserveEffectFailure(options.identity, "response", cause)),
    );
    if (response.status !== 200) return yield* Effect.fail(failure("stem.delivery.http", `Sparse full response returned HTTP ${response.status}`, { identity: options.identity, status: response.status }));
    const encoding = response.headers["content-encoding"];
    if (encoding !== undefined && encoding !== "" && encoding.toLowerCase() !== "identity") return yield* Effect.fail(failure("stem.delivery.http", "Sparse full response has an unsupported Content-Encoding", { identity: options.identity, contentEncoding: encoding }));
    const contentLength = parseContentLength(response.headers["content-length"], options.identity);
    const body = physicalResponse?.body;
    if (body === null || body === undefined) return yield* Effect.fail(failure("stem.delivery.http", "Sparse full response has no body", { identity: options.identity }));
    let byob = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader;
    try {
      reader = body.getReader({ mode: "byob" });
      byob = true;
    } catch (cause) {
      if (!(cause instanceof TypeError) || body.locked) return yield* Effect.fail(failure("stem.delivery.http", "Sparse response body reader could not be acquired", { identity: options.identity }, cause));
      reader = body.getReader();
    }
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    let carry: Uint8Array | undefined;
    let carryOffset = 0;
    let position = 0;
    let eof = false;
    let scratchLive = false;
    let byobBuffer: Uint8Array<ArrayBuffer> | undefined;
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      const failures: unknown[] = [];
      const inFlight = pending;
      // Abort the physical request before waiting for a read which may still
      // be waiting on transport. Start reader cancellation first, then await
      // both obligations so neither cleanup cause is discarded.
      requestController.abort(new DOMException("Sparse response reader closed", "AbortError"));
      const cancellation = Promise.resolve().then(() => reader.cancel());
      const settled = await Promise.allSettled(inFlight === undefined ? [cancellation] : [cancellation, inFlight]);
      for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
      try { reader.releaseLock(); } catch (cause) { failures.push(cause); }
      if (failures.length > 0) throw new AggregateError(failures, "Sparse full response cleanup failed");
    }));
    const nextBody = Effect.gen(function*() {
      if (carry !== undefined && carryOffset < carry.byteLength) return { done: false as const, value: carry };
      carry = undefined;
      carryOffset = 0;
      if (eof) return { done: true as const, value: new Uint8Array() };
      const readPromise = byob
        ? (reader as ReadableStreamBYOBReader).read(byobBuffer ?? new Uint8Array(new ArrayBuffer(SPARSE_RESPONSE_MAX_INPUT_BYTES)))
        : (reader as ReadableStreamDefaultReader<Uint8Array>).read();
      byobBuffer = undefined;
      pending = readPromise;
      void readPromise.then(
        () => { if (pending === readPromise) pending = undefined; },
        () => { if (pending === readPromise) pending = undefined; },
      );
      const read = Effect.tryPromise({ try: () => readPromise, catch: cause => cause }).pipe(
        Effect.timeoutOrElse({ duration: options.readDeadlineMs, orElse: () => Effect.fail(failure("stem.delivery.stall", "Sparse full response body made no progress", { identity: options.identity })) }),
        Effect.raceFirst(abortEffect(options.signal, options.identity)),
      );
      const exit = yield* Effect.exit(read);
      if (Exit.isFailure(exit)) return yield* Effect.fail(preserveEffectFailure(options.identity, "body read", Cause.squash(exit.cause)));
      const value = exit.value.value;
      if (exit.value.done && (options.signal.aborted || requestController.signal.aborted)) {
        return yield* Effect.fail(failure("stem.cancelled", "Sparse full response was cancelled", { identity: options.identity }, options.signal.reason ?? requestController.signal.reason));
      }
      if (value === undefined) {
        if (!exit.value.done || byob) return yield* Effect.fail(failure("stem.delivery.range", "Sparse response ended without a terminal body view", { identity: options.identity }));
        eof = true;
        return { done: true as const, value: new Uint8Array() };
      }
      if (!(value instanceof Uint8Array) || (byob && (value.byteLength > SPARSE_RESPONSE_MAX_INPUT_BYTES || value.buffer.byteLength > SPARSE_RESPONSE_MAX_INPUT_BYTES))) {
        return yield* Effect.fail(failure("stem.delivery.range", "Sparse BYOB response body view exceeds its bounded input", { identity: options.identity, limit: SPARSE_RESPONSE_MAX_INPUT_BYTES }));
      }
      if (byob && value.buffer instanceof ArrayBuffer) byobBuffer = new Uint8Array(value.buffer);
      if (exit.value.done) {
        eof = true;
        if (value.byteLength === 0) return { done: true as const, value };
      } else if (value.byteLength < 1) {
        return yield* Effect.fail(failure("stem.delivery.range", "Sparse full response returned an empty nonterminal body view", { identity: options.identity }));
      }
      carry = value;
      return { done: false as const, value };
    });
    const readExact = (length: number): Effect.Effect<Uint8Array, EngineWebAdapterError> => Effect.gen(function*() {
      if (!Number.isSafeInteger(length) || length < 0) return yield* Effect.fail(failure("stem.delivery.range", "Sparse full-response read length is invalid", { identity: options.identity, length }));
      const output = new Uint8Array(length);
      let written = 0;
      while (written < length) {
        const chunk = yield* nextBody;
        if (chunk.done) return yield* Effect.fail(failure("stem.delivery.range", "Sparse full response ended before the admitted section", { identity: options.identity, expectedBytes: length, receivedBytes: written }));
        const available = chunk.value.byteLength - carryOffset;
        const count = Math.min(available, length - written);
        output.set(chunk.value.subarray(carryOffset, carryOffset + count), written);
        written += count;
        carryOffset += count;
        position += count;
        if (carryOffset === chunk.value.byteLength) { carry = undefined; carryOffset = 0; }
      }
      return output;
    });
    const readChunk = (length: number, adopt?: (release: () => void) => void): Effect.Effect<Readonly<{ bytes: Uint8Array; end: boolean; release: () => void }>, EngineWebAdapterError> => Effect.gen(function*() {
      if (!Number.isSafeInteger(length) || length < 1 || length > SPARSE_RESPONSE_MAX_INPUT_BYTES) return yield* Effect.fail(failure("stem.delivery.range", "Sparse finite chunk read is outside its bounded input", { identity: options.identity, length }));
      if (scratchLive) return yield* Effect.fail(failure("stem.delivery.range", "Sparse finite decoder scratch is still borrowed", { identity: options.identity }));
      const bytes = yield* readExact(length);
      scratchLive = true;
      let released = false;
      const release = () => { if (!released) { released = true; scratchLive = false; } };
      adopt?.(release);
      return { bytes, end: false, release };
    });
    const assertContentLength = (expected: number): Effect.Effect<void, EngineWebAdapterError> => Effect.gen(function*() {
      if (contentLength !== undefined && contentLength !== expected) return yield* Effect.fail(failure("stem.delivery.http", "Sparse full response Content-Length disagrees with its admitted manifest", { identity: options.identity, contentLength, expectedLength: expected }));
    });
    const assertEof = Effect.gen(function*() {
      const chunk = yield* nextBody;
      if (!chunk.done) return yield* Effect.fail(failure("stem.delivery.range", "Sparse full response contains bytes after its admitted payload", { identity: options.identity, offset: position }));
    });
    return { get position() { return position; }, contentLength, readExact, readChunk, assertContentLength, assertEof };
  });
}
