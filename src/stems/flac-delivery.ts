import { Effect, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";

import { EngineWebAdapterError } from "../errors.js";
import type { BoundedStemAdmission } from "./flac-admission.js";
import { beginIngestStage, type IngestDiagnostics } from "./ingest-diagnostics.js";
import type { StemIdentity, StemProgress } from "./types.js";

export interface FlacRangeAttempt {
  readonly identity: StemIdentity;
  readonly phase: "probe" | "metadata" | "audio";
  readonly start: number;
  readonly end: number;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export type FlacLocator = (
  identity: StemIdentity,
  rangeAttempt: FlacRangeAttempt,
) => string | URL | Request | Promise<string | URL | Request>;

export interface FlacHttpOptions {
  readonly locate: FlacLocator;
  /**
   * The transport every physical range attempt runs through.
   *
   * Defaults to the platform `fetch`. An override receives the normalized GET
   * URL and headers plus the adapter's own `Range`, signal and any caller
   * `Request` policy `locate` returned; everything beyond that request model is
   * the override's own.
   */
  readonly fetch?: typeof globalThis.fetch;
  readonly readDeadlineMs?: number;
  readonly maximumAttempts?: number;
}

interface DeliveryState {
  totalBytes?: number;
  etag?: string;
}

interface FlacRangeReadOptions extends FlacHttpOptions {
  readonly identity: StemIdentity;
  readonly phase: "probe" | "metadata" | "audio";
  readonly start: number;
  readonly end: number;
  readonly signal: AbortSignal;
  readonly state: DeliveryState;
  readonly onProgress?: (progress: StemProgress) => void;
  readonly onActivity?: () => void;
  readonly retainRange?: (bytes: number) => () => void;
  readonly downloadAdmission?: BoundedStemAdmission;
  readonly diagnostics?: IngestDiagnostics;
  readonly onProduced?: (release: () => void) => void;
}

function failure(
  code: "stem.delivery.address" | "stem.delivery.http" | "stem.delivery.range" | "stem.delivery.retry_exhausted" | "stem.delivery.stall",
  message: string,
  details: Readonly<Record<string, unknown>>,
  cause?: unknown,
): EngineWebAdapterError {
  return new EngineWebAdapterError(code, message, details, cause);
}

function retryable(error: unknown): boolean {
  return HttpClientError.isHttpClientError(error) ||
    (error instanceof EngineWebAdapterError && error.details.retryable === true);
}

function requestFor(
  location: string | URL | Request,
  rangeHeader: string,
  signal: AbortSignal,
  details: Readonly<Record<string, unknown>>,
): Readonly<{
  request: HttpClientRequest.HttpClientRequest;
  fetchInit: RequestInit;
}> {
  let base: Request;
  try { base = location instanceof Request ? location : new Request(location); }
  catch (error) {
    throw failure("stem.delivery.address", "FLAC locator returned an invalid delivery address", details, error);
  }
  if (base.method !== "GET" || base.body !== null) {
    throw failure("stem.delivery.address", "FLAC locator must return a bodyless GET Request", details);
  }
  const headers = new Headers(base.headers);
  headers.set("Range", rangeHeader);
  const fetchInit: RequestInit = {
    credentials: base.credentials,
    mode: base.mode,
    cache: base.cache,
    redirect: base.redirect,
    integrity: base.integrity,
    referrer: base.referrer,
    referrerPolicy: base.referrerPolicy,
    keepalive: base.keepalive,
  };
  try {
    return {
      request: HttpClientRequest.fromWeb(new Request(base, { headers, signal })),
      fetchInit,
    };
  }
  catch (error) { throw failure("stem.delivery.address", "FLAC delivery Request could not be constructed", details, error); }
}

/** Execute one credit-sized exact range through Effect HttpClient, including physical retries. */
export function readExactFlacRangeEffect(options: FlacRangeReadOptions): Effect.Effect<Readonly<{ bytes: Uint8Array; totalBytes: number; release: () => void }>, EngineWebAdapterError> {
  const maximumAttempts = options.maximumAttempts ?? 4;
  const deadlineMs = options.readDeadlineMs ?? 30_000;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) throw new RangeError("maximumAttempts must be positive");
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new RangeError("readDeadlineMs must be positive");
  if (!Number.isSafeInteger(options.start) || !Number.isSafeInteger(options.end) || options.start < 0 || options.end < options.start) {
    return Effect.fail(failure("stem.delivery.range", "Requested FLAC range is invalid", {
      identity: options.identity,
      phase: options.phase,
      range: [options.start, options.end],
      attempt: 0,
      retryable: false,
    }));
  }
  const expectedBytes = options.end - options.start + 1;
  const range = `bytes=${options.start}-${options.end}`;

  const physicalAttempt = (attempt: number) => {
    let release = () => {};
    let produced = false;
    let cleanupFailure: EngineWebAdapterError | undefined;
    return Effect.scoped(Effect.gen(function* () {
    if (options.downloadAdmission !== undefined) {
      yield* Effect.acquireRelease(Effect.tryPromise({
        try: async () => {
          const finishQueue = options.downloadAdmission!.stats.active >= options.downloadAdmission!.limit
            ? beginIngestStage(options.diagnostics, "downloadQueue") : () => {};
          try { return await options.downloadAdmission!.acquire(options.signal); }
          finally { finishQueue(); }
        },
        catch: error => error,
      }), lease => Effect.sync(() => lease.release()));
    }
    const finishDownload = beginIngestStage(options.diagnostics, "downloads");
    yield* Effect.addFinalizer(() => Effect.sync(finishDownload));
    let physicalResponse: Response | undefined;
    let transportSettlement: Promise<void> | undefined;
    let finalized = false;
    const quarantine = (cause?: unknown) => {
      cleanupFailure ??= failure("stem.delivery.stall", "FLAC physical request cleanup did not settle safely", {
        identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt,
        retryable: false, cleanup: true,
      }, cause);
      options.downloadAdmission?.close(cleanupFailure);
    };
    const boundedCleanup = async (operation: Promise<unknown>): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        operation.catch(quarantine),
        new Promise<void>(resolve => {
          timer = setTimeout(() => { quarantine(); resolve(); }, deadlineMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    };
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      // HttpClient's scope aborts its request before this finalizer. Wait for
      // the actual fetch promise, not only the interrupted Effect continuation.
      if (transportSettlement !== undefined) await boundedCleanup(transportSettlement);
      if (physicalResponse?.body !== null && physicalResponse?.body !== undefined && !physicalResponse.body.locked) {
        await boundedCleanup(physicalResponse.body.cancel());
      }
      finalized = true;
    }));
    const physicalFetch: typeof globalThis.fetch = (input, init) => {
      const flight = Promise.resolve().then(() => (options.fetch ?? globalThis.fetch)(input, init)).then(response => {
        physicalResponse = response;
        // A misbehaving transport may deliver headers after bounded teardown.
        // Its admission is quarantined; dispose late bytes without reviving it.
        if (finalized) void boundedCleanup(response.body?.cancel() ?? Promise.resolve());
        return response;
      });
      transportSettlement = flight.then(() => undefined, () => undefined);
      return flight;
    };
    const location = yield* Effect.tryPromise({
      try: () => Promise.resolve(options.locate(options.identity, {
        identity: options.identity,
        phase: options.phase,
        start: options.start,
        end: options.end,
        attempt,
        signal: options.signal,
      })),
      catch: (error) => failure("stem.delivery.address", "FLAC locator failed", {
        identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt, retryable: false,
      }, error),
    }).pipe(Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.fail(failure(
      "stem.delivery.address", "FLAC locator exceeded its deadline", {
        identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt, retryable: false,
      },
    )) }));
    const normalized = yield* Effect.try({
      try: () => requestFor(location, range, options.signal, {
        identity: options.identity,
        phase: options.phase,
        range: [options.start, options.end],
        attempt,
        retryable: false,
      }),
      catch: (error) => error,
    });
    const service = yield* HttpClient.HttpClient;
    const client = HttpClient.withScope(service);
    const stalled = () => failure("stem.delivery.stall", `FLAC range made no progress for ${deadlineMs}ms`, {
      identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt, retryable: true,
    });
    const response = yield* client.execute(normalized.request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, normalized.fetchInit),
      Effect.provideService(FetchHttpClient.Fetch, physicalFetch),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.fail(stalled()) }),
    );
    options.onActivity?.();
    if (response.status !== 206) {
      const transient = response.status >= 500 && response.status <= 599;
      return yield* Effect.fail(failure("stem.delivery.http", `FLAC range returned HTTP ${response.status}`, {
        identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt,
        status: response.status, retryable: transient,
      }));
    }
    if ((response.headers["content-encoding"] ?? "") !== "") {
      return yield* Effect.fail(failure("stem.delivery.range", "FLAC range must not carry Content-Encoding", {
        identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt,
        status: response.status, retryable: false,
      }));
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers["content-range"] ?? "");
    const actualStart = Number(match?.[1]);
    const actualEnd = Number(match?.[2]);
    const totalBytes = Number(match?.[3]);
    const contentLength = Number(response.headers["content-length"]);
    if (
      match === null || !Number.isSafeInteger(totalBytes) || totalBytes <= actualEnd ||
      actualStart !== options.start || actualEnd !== options.end || contentLength !== expectedBytes ||
      (options.state.totalBytes !== undefined && options.state.totalBytes !== totalBytes)
    ) {
      return yield* Effect.fail(failure("stem.delivery.range", "FLAC response has malformed or moving exact-range headers", {
        identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt,
        status: response.status, retryable: false,
      }));
    }
    const etag = response.headers.etag;
    if (options.state.etag !== undefined && etag !== options.state.etag) {
      return yield* Effect.fail(failure("stem.delivery.range", "FLAC ETag changed or disappeared during delivery", {
        identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt,
        status: response.status, retryable: false,
      }));
    }
    if (etag !== undefined) options.state.etag = etag;
    options.state.totalBytes = totalBytes;

    const bytes = new Uint8Array(expectedBytes);
    release = options.retainRange?.(bytes.byteLength) ?? (() => {});
    let received = 0;
    if (physicalResponse?.body === null || physicalResponse?.body === undefined) {
      return yield* Effect.fail(failure("stem.delivery.range", "FLAC response has no body", {
        identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt, retryable: false,
      }));
    }
    yield* Stream.fromReadableStream({
      evaluate: () => physicalResponse!.body!,
      onError: error => failure("stem.delivery.http", "FLAC response body failed", {
        identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt, retryable: true,
      }, error),
      // Our enclosing attempt owns bounded cancellation before its permit release.
      releaseLockOnEnd: true,
    }).pipe(
      Stream.timeoutOrElse({ duration: deadlineMs, orElse: () => Stream.fail(stalled()) }),
      Stream.runForEach((chunk) => Effect.try({
        try: () => {
          if (received + chunk.byteLength > expectedBytes) {
            throw failure("stem.delivery.range", "FLAC response body exceeds its exact range", {
              identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt,
              status: response.status, retryable: false, expectedBytes, receivedBytes: received + chunk.byteLength,
            });
          }
          bytes.set(chunk, received);
          received += chunk.byteLength;
          options.onActivity?.();
        },
        catch: (error) => error,
      })),
    );
    if (received !== expectedBytes) {
      return yield* Effect.fail(failure("stem.delivery.range", "FLAC response body length is not exact", {
        identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt,
        status: response.status, retryable: false, expectedBytes, receivedBytes: received,
      }));
    }
    // Transfer a release handle before invoking callbacks. A callback may
    // synchronously abort the enclosing input lane before its caller receives
    // the range result.
    options.onProduced?.(release);
    produced = true;
    options.onProgress?.({
      stage: options.phase === "probe" ? "probing" : "fetching",
      identity: options.identity,
      bytes: options.end + 1,
      totalBytes,
      byteKind: "flac",
      attempt,
    });
    // The Effect has produced a result, but its outer scope can still fail or
    // be interrupted before the resolver receives that result.
    return { bytes, totalBytes, release };
    }).pipe(Effect.ensuring(Effect.sync(() => { if (!produced) release(); })))).pipe(
      Effect.catch(error => Effect.fail(cleanupFailure ?? error)),
    );
  };

  const attempt = (number: number): Effect.Effect<Readonly<{ bytes: Uint8Array; totalBytes: number; release: () => void }>, unknown, HttpClient.HttpClient | import("effect").Scope.Scope> =>
    physicalAttempt(number).pipe(Effect.catch((error) => {
      if (retryable(error) && number < maximumAttempts) {
        return Effect.sleep(Math.min(100, 5 * 2 ** (number - 1))).pipe(Effect.andThen(attempt(number + 1)));
      }
      if (retryable(error) && number >= maximumAttempts) {
        return Effect.fail(failure("stem.delivery.retry_exhausted", "FLAC delivery exhausted transient retry attempts", {
          identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt: number,
          retryable: false,
        }, error));
      }
      return Effect.fail(error);
    }));

  const operation = Effect.scoped(attempt(1));
  // A caller override replaces only the platform `fetch` reference; the client
  // itself, and every bound it enforces, stays the package's.
  const transported = options.fetch === undefined
    ? operation
    : operation.pipe(Effect.provideService(FetchHttpClient.Fetch, options.fetch));
  const provided = transported.pipe(Effect.provide(FetchHttpClient.layer));
  return provided.pipe(Effect.mapError((error) => error instanceof EngineWebAdapterError
    ? error
    : failure("stem.delivery.http", "FLAC range operation failed", {
      identity: options.identity, phase: options.phase, range: [options.start, options.end], attempt: 0, retryable: false,
    }, error)));
}

export function readExactFlacRange(options: FlacRangeReadOptions): Promise<Readonly<{ bytes: Uint8Array; totalBytes: number; release: () => void }>> {
  let unhandedRelease: (() => void) | undefined;
  let effect: Effect.Effect<Readonly<{ bytes: Uint8Array; totalBytes: number; release: () => void }>, EngineWebAdapterError>;
  try { effect = readExactFlacRangeEffect({ ...options, onProduced: release => { unhandedRelease = release; } }); }
  catch (error) { return Promise.reject(error); }
  return Effect.runPromise(effect, { signal: options.signal }).then((result) => {
    // Only this successful Promise handoff transfers ownership to the resolver.
    unhandedRelease = undefined;
    return result;
  }, (error: unknown) => {
    unhandedRelease?.();
    unhandedRelease = undefined;
    if (options.signal.aborted) {
      throw new EngineWebAdapterError("stem.cancelled", "FLAC delivery was cancelled", {
        identity: options.identity,
        phase: options.phase,
        range: [options.start, options.end],
      }, options.signal.reason);
    }
    throw error;
  });
}
