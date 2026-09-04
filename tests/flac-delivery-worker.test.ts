import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ADAPTER_ASSETS, createFlacWorker } from "../src/assets.js";
import { EngineWebAdapterError } from "../src/errors.js";
import { FlacWorkerMailbox } from "../src/stems/flac-worker-mailbox.js";
import {
  FlacWorkerPool,
  createFlacStemResolver,
  readExactFlacRange,
  runFlacIngest,
  type FlacWorkerLike,
  type FlacWorkerRequest,
  type FlacWorkerResponse,
} from "../src/stems/index.js";

const IDENTITY = `sha256:${"b".repeat(64)}` as const;

function responseClient(
  respond: (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]) => Response,
): HttpClient.HttpClient {
  return HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, respond(request))));
}

function exactResponse(bytes: Uint8Array, start: number, end: number, total = bytes.byteLength): Response {
  return new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(end - start + 1),
      ETag: '"stable"',
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Effect HttpClient delivery preserves caller headers and overwrites exact Range", async () => {
  const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const seen: Array<Readonly<Record<string, string>>> = [];
  const client = responseClient((request) => {
    seen.push(request.headers);
    return exactResponse(source, 1, 3);
  });
  const attempts: number[] = [];
  const result = await readExactFlacRange({
    identity: IDENTITY,
    phase: "metadata",
    start: 1,
    end: 3,
    signal: new AbortController().signal,
    state: {},
    maximumAttempts: 1,
    httpClient: client,
    locate(_identity, attempt) {
      attempts.push(attempt.attempt);
      return new Request("https://caller.invalid/object", {
        headers: { Authorization: "Bearer caller", Range: "bytes=wrong" },
      });
    },
  });
  assert.deepEqual([...result.bytes], [2, 3, 4]);
  assert.deepEqual(attempts, [1]);
  assert.equal(seen[0]!.authorization, "Bearer caller");
  assert.equal(seen[0]!.range, "bytes=1-3");
});

test("delivery address failures retain stable range-attempt diagnostics", async () => {
  for (const locate of [
    () => "not an absolute URL",
    () => new Request("https://caller.invalid/stem", { method: "POST" }),
    () => { throw new Error("address lookup failed"); },
  ]) {
    await assert.rejects(
      readExactFlacRange({
        identity: IDENTITY,
        phase: "metadata",
        start: 17,
        end: 31,
        signal: new AbortController().signal,
        state: {},
        maximumAttempts: 1,
        locate,
      }),
      (error: unknown) => {
        assert.ok(error instanceof EngineWebAdapterError);
        assert.equal(error.code, "stem.delivery.address");
        assert.equal(error.details.identity, IDENTITY);
        assert.equal(error.details.phase, "metadata");
        assert.deepEqual(error.details.range, [17, 31]);
        assert.equal(error.details.attempt, 1);
        assert.equal(error.details.retryable, false);
        return true;
      },
    );
  }
});

test("default FetchHttpClient preserves caller Request credentials and mode", async () => {
  const originalFetch = globalThis.fetch;
  let observed: RequestInit | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    observed = init;
    return exactResponse(new Uint8Array([4, 5]), 0, 1);
  }) as typeof fetch;
  try {
    const result = await readExactFlacRange({
      identity: IDENTITY,
      phase: "probe",
      start: 0,
      end: 1,
      signal: new AbortController().signal,
      state: {},
      maximumAttempts: 1,
      locate: () => new Request("https://caller.invalid/private-stem", {
        credentials: "include",
        mode: "cors",
      }),
    });
    assert.deepEqual([...result.bytes], [4, 5]);
    assert.equal(observed?.credentials, "include");
    assert.equal(observed?.mode, "cors");
    assert.equal(new Headers(observed?.headers).get("Range"), "bytes=0-1");
    assert.ok(observed?.signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delivery retries only transient failures and re-runs locate per physical attempt", async () => {
  let responses = 0;
  const client = responseClient(() => {
    responses += 1;
    return responses === 1 ? new Response("busy", { status: 503 }) : exactResponse(new Uint8Array([7, 8]), 0, 1);
  });
  const locates: number[] = [];
  const result = await readExactFlacRange({
    identity: IDENTITY, phase: "probe", start: 0, end: 1,
    signal: new AbortController().signal, state: {}, maximumAttempts: 2, httpClient: client,
    locate(_identity, attempt) { locates.push(attempt.attempt); return "https://caller.invalid/stem"; },
  });
  assert.deepEqual([...result.bytes], [7, 8]);
  assert.deepEqual(locates, [1, 2]);
});

test("delivery types transient exhaustion, no-progress stall, and cancellation", async () => {
  let exhaustedLocates = 0;
  await assert.rejects(
    readExactFlacRange({
      identity: IDENTITY, phase: "audio", start: 4, end: 7,
      signal: new AbortController().signal, state: {}, maximumAttempts: 2, readDeadlineMs: 20,
      httpClient: responseClient(() => new Response("busy", { status: 503 })),
      locate() { exhaustedLocates += 1; return "https://caller.invalid/stem"; },
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.delivery.retry_exhausted",
  );
  assert.equal(exhaustedLocates, 2);

  let stalledLocates = 0;
  await assert.rejects(
    readExactFlacRange({
      identity: IDENTITY, phase: "probe", start: 0, end: 1,
      signal: new AbortController().signal, state: {}, maximumAttempts: 2, readDeadlineMs: 5,
      httpClient: responseClient(() => new Response(new ReadableStream({ start() { /* intentionally idle */ } }), {
        status: 206,
        headers: { "Content-Range": "bytes 0-1/2", "Content-Length": "2" },
      })),
      locate() { stalledLocates += 1; return "https://caller.invalid/stem"; },
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.delivery.retry_exhausted",
  );
  assert.equal(stalledLocates, 2);

  const cancelled = new AbortController();
  cancelled.abort("caller");
  await assert.rejects(
    readExactFlacRange({
      identity: IDENTITY, phase: "probe", start: 0, end: 1,
      signal: cancelled.signal, state: {}, maximumAttempts: 1,
      httpClient: responseClient(() => exactResponse(new Uint8Array([1, 2]), 0, 1)),
      locate: () => "https://caller.invalid/stem",
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled",
  );
});

test("delivery defaults to four total physical attempts", async () => {
  let locates = 0;
  await assert.rejects(
    readExactFlacRange({
      identity: IDENTITY, phase: "audio", start: 0, end: 1,
      signal: new AbortController().signal, state: {}, readDeadlineMs: 20,
      httpClient: responseClient(() => new Response("busy", { status: 503 })),
      locate() { locates += 1; return "https://caller.invalid/stem"; },
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.delivery.retry_exhausted",
  );
  assert.equal(locates, 4);
});

test("delivery rejects hidden/malformed/moving headers, encoding, and short bodies without retry", async () => {
  const cases: Response[] = [
    new Response(new Uint8Array([1, 2]), { status: 206, headers: { "Content-Length": "2" } }),
    new Response(new Uint8Array([1, 2]), { status: 206, headers: { "Content-Range": "nope", "Content-Length": "2" } }),
    new Response(new Uint8Array([1, 2]), { status: 206, headers: {
      "Content-Range": "bytes 0-1/2", "Content-Length": "2", "Content-Encoding": "gzip",
    } }),
    new Response(new Uint8Array([1]), { status: 206, headers: { "Content-Range": "bytes 0-1/2", "Content-Length": "2" } }),
    new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "Content-Range": "bytes 0-1/2", "Content-Length": "2" } }),
  ];
  for (const response of cases) {
    let locates = 0;
    await assert.rejects(
      readExactFlacRange({
        identity: IDENTITY, phase: "probe", start: 0, end: 1,
        signal: new AbortController().signal, state: {}, maximumAttempts: 3,
        httpClient: responseClient(() => response),
        locate() { locates += 1; return "https://caller.invalid/stem"; },
      }),
      (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.delivery.range",
    );
    assert.equal(locates, 1);
  }

  const state = { totalBytes: 3, etag: '"old"' };
  await assert.rejects(
    readExactFlacRange({
      identity: IDENTITY, phase: "audio", start: 0, end: 1,
      signal: new AbortController().signal, state, maximumAttempts: 1,
      httpClient: responseClient(() => new Response(new Uint8Array([1, 2]), { status: 206, headers: {
        "Content-Range": "bytes 0-1/4", "Content-Length": "2", ETag: '"new"',
      } })),
      locate: () => "https://caller.invalid/stem",
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.delivery.range",
  );
});

class FakeWorker implements FlacWorkerLike {
  readonly posted: FlacWorkerRequest[] = [];
  readonly ranges: number[] = [];
  terminated = false;
  postsAfterTermination = 0;
  #received = 0;
  #listeners = new Map<string, Set<(event: any) => void>>();
  postMessage(message: FlacWorkerRequest): void {
    if (this.terminated) { this.postsAfterTermination += 1; return; }
    this.posted.push(message);
    if (message.type === "start") queueMicrotask(() => this.emit({ type: "input-credit", requestId: message.requestId, maximumBytes: 4, phase: "probe", phaseBytesRemaining: 4 }));
    if (message.type === "input") {
      this.#received += message.bytes.byteLength;
      if (this.#received < message.totalFlacBytes) {
        const phase = this.#received < 8 ? "metadata" : "audio";
        queueMicrotask(() => this.emit({ type: "input-credit", requestId: message.requestId, maximumBytes: 4, phase, phaseBytesRemaining: phase === "audio" ? 0 : 4 }));
      } else {
        queueMicrotask(() => this.emit({ type: "input-credit", requestId: message.requestId, maximumBytes: 4, phase: "audio", phaseBytesRemaining: 0 }));
      }
    }
    if (message.type === "finish") queueMicrotask(() => {
      const pcm = new Uint8Array([9, 8, 7, 6]).buffer;
      this.emit({ type: "pcm", requestId: message.requestId, bytes: pcm, frames: 1, totalPcmBytes: 4 });
      this.emit({ type: "complete", requestId: message.requestId, pcmBytes: 4, frames: 1 });
    });
  }
  terminate(): void { this.terminated = true; }
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set(); listeners.add(listener); this.#listeners.set(type, listeners);
  }
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }
  emit(message: FlacWorkerResponse): void {
    for (const listener of this.#listeners.get("message") ?? []) listener({ data: message });
  }
  fail(error: Error): void {
    const event = { message: error.message, error };
    for (const listener of this.#listeners.get("error") ?? []) listener(event);
  }
}

test("resolver follows Worker credit with exact nonoverlapping ranges and disposes the one-stem Worker", async () => {
  const source = new Uint8Array(10);
  const ranges: string[] = [];
  const worker = new FakeWorker();
  const resolver = createFlacStemResolver({
    createWorker: () => worker,
    hardwareConcurrency: 2,
    maximumAttempts: 1,
    locate: () => "https://caller.invalid/stem",
    httpClient: responseClient((request) => {
      const range = request.headers.range!;
      ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range)!;
      return exactResponse(source, Number(match[1]), Number(match[2]));
    }),
  });
  const resolved = await resolver.resolve(IDENTITY);
  const reader = resolved.stream.getReader();
  const first = await reader.read();
  const end = await reader.read();
  assert.deepEqual([...first.value!], [9, 8, 7, 6]);
  assert.equal(end.done, true);
  assert.deepEqual(ranges, ["bytes=0-3", "bytes=4-7", "bytes=8-9"]);
  assert.equal(worker.terminated, true);
  assert.ok(worker.posted.some((message) => message.type === "output-credit"));
});

test("mid-body retry resumes at Worker credit without duplicated accepted bytes", async () => {
  const source = new Uint8Array(10);
  const ranges: string[] = [];
  let first = true;
  const worker = new FakeWorker();
  const resolver = createFlacStemResolver({
    createWorker: () => worker,
    hardwareConcurrency: 2,
    maximumAttempts: 2,
    readDeadlineMs: 5,
    locate: () => "https://caller.invalid/stem",
    httpClient: responseClient((request) => {
      const range = request.headers.range!;
      ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/u.exec(range)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (first) {
        first = false;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(source.slice(start, start + 2)); },
        }), {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${end}/${source.byteLength}`,
            "Content-Length": String(end - start + 1),
            ETag: '"stable"',
          },
        });
      }
      return exactResponse(source, start, end);
    }),
  });
  const reader = (await resolver.resolve(IDENTITY)).stream.getReader();
  assert.deepEqual([...(await reader.read()).value!], [9, 8, 7, 6]);
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(ranges, ["bytes=0-3", "bytes=0-3", "bytes=4-7", "bytes=8-9"]);
  const accepted = worker.posted.filter((message): message is Extract<FlacWorkerRequest, { type: "input" }> =>
    message.type === "input");
  assert.deepEqual(accepted.map((message) => message.bytes.byteLength), [4, 4, 2]);
});

test("Worker pool removes queued cancellation and terminates before active rejection", async () => {
  const workers: FakeWorker[] = [];
  const pool = new FlacWorkerPool({
    hardwareConcurrency: 2,
    createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
  });
  let release!: () => void;
  const first = pool.run({ work: (worker) => new Promise<void>((resolve) => { release = resolve; assert.equal(worker, workers[0]); }) });
  const abort = new AbortController();
  const queued = pool.run({ signal: abort.signal, work: async () => assert.fail("cancelled queue item ran") });
  abort.abort("queued");
  await assert.rejects(queued);
  assert.equal(workers.length, 1);
  release();
  await first;
  assert.equal(workers[0]!.terminated, true);
});

test("active resolver cancellation terminates its physical Worker before stream rejection", async () => {
  class IdleWorker extends FakeWorker {
    override postMessage(message: FlacWorkerRequest): void { this.posted.push(message); }
  }
  const worker = new IdleWorker();
  const abort = new AbortController();
  const resolver = createFlacStemResolver({
    createWorker: () => worker,
    hardwareConcurrency: 2,
    locate: () => "https://caller.invalid/unused",
    httpClient: responseClient(() => assert.fail("idle Worker must not request HTTP")),
  });
  const resolved = await resolver.resolve(IDENTITY, { signal: abort.signal });
  const reading = resolved.stream.getReader().read();
  abort.abort("session close");
  await assert.rejects(
    reading,
    (error: unknown) => {
      assert.equal(worker.terminated, true);
      return error instanceof EngineWebAdapterError && error.code === "stem.cancelled";
    },
  );
  assert.ok(worker.posted.some((message) => message.type === "cancel"));
});

test("metadata locator cancellation aborts before Worker termination and rejection", async () => {
  class MetadataWorker extends FakeWorker {
    override postMessage(message: FlacWorkerRequest): void {
      if (this.terminated) { this.postsAfterTermination += 1; return; }
      this.posted.push(message);
      if (message.type === "start") queueMicrotask(() => this.emit({
        type: "input-credit", requestId: message.requestId, maximumBytes: 4,
        phase: "metadata", phaseBytesRemaining: 4,
      }));
    }
  }
  const worker = new MetadataWorker();
  const abort = new AbortController();
  const locateStarted = deferred<void>();
  let locatorAborted = false;
  const resolver = createFlacStemResolver({
    createWorker: () => worker,
    hardwareConcurrency: 2,
    locate: (_identity, attempt) => {
      locateStarted.resolve();
      attempt.signal.addEventListener("abort", () => { locatorAborted = true; }, { once: true });
      return new Promise<string>(() => undefined);
    },
  });
  const reading = (await resolver.resolve(IDENTITY, { signal: abort.signal })).stream.getReader().read();
  await locateStarted.promise;
  abort.abort("metadata cancellation");
  await assert.rejects(reading, (error: unknown) => {
    assert.equal(worker.terminated, true);
    return error instanceof EngineWebAdapterError && error.code === "stem.cancelled";
  });
  assert.equal(locatorAborted, true);
  assert.equal(worker.postsAfterTermination, 0);
});

test("Worker terminal failure aborts active range input and no continuation posts after termination", async () => {
  const worker = new FakeWorker();
  const requestStarted = deferred<void>();
  let deliveryAborted = false;
  const client = responseClient(() => new Response(new ReadableStream<Uint8Array>({
    start() { requestStarted.resolve(); },
  }), {
    status: 206,
    headers: { "Content-Range": "bytes 0-3/4", "Content-Length": "4", ETag: '"stable"' },
  }));
  const resolver = createFlacStemResolver({
    createWorker: () => worker,
    hardwareConcurrency: 2,
    locate: (_identity, attempt) => {
      attempt.signal.addEventListener("abort", () => { deliveryAborted = true; }, { once: true });
      return "https://caller.invalid/active-range";
    },
    httpClient: client,
  });
  const resolved = await resolver.resolve(IDENTITY);
  const reading = resolved.stream.getReader().read();
  await requestStarted.promise;
  worker.fail(new Error("decoder process failed"));
  await assert.rejects(
    reading,
    (error: unknown) => {
      assert.equal(worker.terminated, true);
      return error instanceof EngineWebAdapterError && error.code === "stem.decode.worker";
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(deliveryAborted, true);
  assert.equal(worker.postsAfterTermination, 0);
});

test("caller abort after decoder output terminates before rejection and leaves late work inert", async () => {
  class OutputWorker extends FakeWorker {
    override postMessage(message: FlacWorkerRequest): void {
      if (this.terminated) { this.postsAfterTermination += 1; return; }
      this.posted.push(message);
      if (message.type === "start") queueMicrotask(() => this.emit({
        type: "pcm", requestId: message.requestId, bytes: new Uint8Array([1, 2]).buffer,
        frames: 1, totalPcmBytes: 4,
      }));
    }
  }
  const worker = new OutputWorker();
  const abort = new AbortController();
  const resolver = createFlacStemResolver({
    createWorker: () => worker,
    hardwareConcurrency: 2,
    locate: () => "https://caller.invalid/unused",
  });
  const resolved = await resolver.resolve(IDENTITY, { signal: abort.signal });
  const reader = resolved.stream.getReader();
  assert.deepEqual([...(await reader.read()).value!], [1, 2]);
  abort.abort("decoder output cancellation");
  await assert.rejects(reader.read(), (error: unknown) => {
    assert.equal(worker.terminated, true);
    return error instanceof EngineWebAdapterError && error.code === "stem.cancelled";
  });
  worker.emit({ type: "complete", requestId: 1, pcmBytes: 4, frames: 1 });
  assert.equal(worker.postsAfterTermination, 0);
});

test("ingest core reports typed Worker WebCodecs capability failure", async () => {
  await assert.rejects(
    runFlacIngest({
      requestId: 1, post: () => undefined, nextInput: async () => null,
      nextOutputCredit: async () => undefined, cancelled: () => false, globals: {} as typeof globalThis,
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "capability.webcodecs_audio",
  );
});

function putU64(bytes: Uint8Array, offset: number, input: bigint): void {
  let value = input;
  for (let index = 7; index >= 0; index -= 1) {
    bytes[offset + index] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function singleFrameFlac(): Uint8Array {
  const bytes = new Uint8Array(4 + 4 + 34 + 4 + 18 + 4);
  bytes.set([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 34]);
  const stream = bytes.subarray(8, 42);
  stream.set([0, 16, 0, 16, 0, 0, 4, 0, 0, 4]);
  putU64(stream, 10, (44_100n << 44n) | (15n << 36n) | 1n);
  stream.fill(1, 18, 34);
  bytes.set([0x83, 0, 0, 18], 42);
  putU64(bytes, 46, 0n);
  putU64(bytes, 54, 0n);
  bytes.set([0, 1], 62);
  bytes.set([0xff, 0xf8, 1, 2], 64);
  return bytes;
}

function threeFrameFlac(): Uint8Array {
  const bytes = new Uint8Array(4 + 4 + 34 + 4 + (18 * 3) + (4 * 3));
  bytes.set([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 34]);
  const stream = bytes.subarray(8, 42);
  stream.set([0, 1, 0, 1, 0, 0, 4, 0, 0, 4]);
  putU64(stream, 10, (44_100n << 44n) | (15n << 36n) | 3n);
  stream.fill(1, 18, 34);
  bytes.set([0x83, 0, 0, 54], 42);
  for (let index = 0; index < 3; index += 1) {
    const point = 46 + (index * 18);
    putU64(bytes, point, BigInt(index));
    putU64(bytes, point + 8, BigInt(index * 4));
    bytes.set([0, 1], point + 16);
    bytes.set([0xff, 0xf8, index, index + 1], 100 + (index * 4));
  }
  return bytes;
}

class InProcessFlacWorker implements FlacWorkerLike {
  terminated = false;
  lateReplies = 0;
  #mailbox: FlacWorkerMailbox | undefined;
  #listeners = new Map<string, Set<(event: any) => void>>();
  constructor(readonly globals: typeof globalThis) {}
  postMessage(message: FlacWorkerRequest): void {
    if (this.terminated) return;
    if (message.type === "start") {
      const mailbox = new FlacWorkerMailbox();
      this.#mailbox = mailbox;
      void runFlacIngest({
        requestId: message.requestId,
        ...(message.expected === undefined ? {} : { expected: message.expected }),
        post: (reply) => this.#emit(reply),
        nextInput: () => mailbox.nextInput(),
        nextOutputCredit: () => mailbox.takeOutputCredit(),
        cancelled: () => mailbox.cancelled,
        cancellation: mailbox.cancellation,
        cancellationReason: () => mailbox.cancellationReason,
        globals: this.globals,
      }).catch((error: unknown) => {
        if (!mailbox.cancelled) this.#emit({
          type: "error", requestId: message.requestId,
          error: error instanceof EngineWebAdapterError
            ? { name: error.name, message: error.message, code: error.code, details: error.details }
            : { name: "Error", message: String(error) },
        });
      });
    } else if (message.type === "input") {
      this.#mailbox?.giveInput({ bytes: new Uint8Array(message.bytes), totalFlacBytes: message.totalFlacBytes });
    } else if (message.type === "finish") this.#mailbox?.giveInput(null);
    else if (message.type === "output-credit") this.#mailbox?.giveOutputCredit();
    else this.#mailbox?.cancel(new DOMException("cancelled", "AbortError"));
  }
  terminate(): void {
    this.terminated = true;
    this.#mailbox?.cancel(new DOMException("terminated", "AbortError"));
  }
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set(); listeners.add(listener); this.#listeners.set(type, listeners);
  }
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }
  #emit(message: FlacWorkerResponse): void {
    if (this.terminated) { this.lateReplies += 1; return; }
    for (const listener of this.#listeners.get("message") ?? []) listener({ data: message });
  }
}

function threeFrameResolver(worker: InProcessFlacWorker) {
  const source = threeFrameFlac();
  return createFlacStemResolver({
    createWorker: () => worker,
    hardwareConcurrency: 2,
    maximumAttempts: 1,
    locate: () => "https://caller.invalid/three-frames",
    httpClient: responseClient((request) => {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range!)!;
      return exactResponse(source, Number(match[1]), Number(match[2]));
    }),
  });
}

test("async decoder error wakes output-credit wait and physically terminates the Worker", async () => {
  class FakeEncodedAudioChunk {}
  let lateAudioCloses = 0;
  class AsyncErrorDecoder {
    static async isConfigSupported(config: AudioDecoderConfig) { return { supported: true, config }; }
    readonly error: (error: DOMException) => void;
    readonly output: (audio: AudioData) => void;
    decodes = 0;
    constructor(init: { readonly error: (error: DOMException) => void; readonly output: (audio: AudioData) => void }) {
      this.error = init.error;
      this.output = init.output;
    }
    configure(): void {}
    decode(): void {
      this.decodes += 1;
      if (this.decodes === 2) setTimeout(() => {
        this.error(new DOMException("asynchronous decoder failure", "EncodingError"));
        queueMicrotask(() => this.output({ close: () => { lateAudioCloses += 1; } } as unknown as AudioData));
      }, 0);
    }
    async flush(): Promise<void> {}
    close(): void {}
  }
  const worker = new InProcessFlacWorker({
    AudioDecoder: AsyncErrorDecoder,
    EncodedAudioChunk: FakeEncodedAudioChunk,
  } as unknown as typeof globalThis);
  const reading = (await threeFrameResolver(worker).resolve(IDENTITY)).stream.getReader().read();
  await assert.rejects(Promise.race([
    reading,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("decoder error deadlocked on credit")), 100)),
  ]), /asynchronous decoder failure/u);
  assert.equal(worker.terminated, true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(lateAudioCloses, 1);
  assert.equal(worker.lateReplies, 0);
});

test("PCM conversion failure wakes output-credit wait and physically terminates the Worker", async () => {
  class FakeEncodedAudioChunk {}
  let audioCloses = 0;
  class InvalidOutputDecoder {
    static async isConfigSupported(config: AudioDecoderConfig) { return { supported: true, config }; }
    readonly output: (audio: AudioData) => void;
    decodes = 0;
    constructor(init: { readonly output: (audio: AudioData) => void }) { this.output = init.output; }
    configure(): void {}
    decode(): void {
      this.decodes += 1;
      if (this.decodes === 2) setTimeout(() => {
        this.output({
          format: "s16", numberOfFrames: 1, numberOfChannels: 1, sampleRate: 48_000,
          allocationSize: () => 2, copyTo: () => undefined, close: () => { audioCloses += 1; },
        } as unknown as AudioData);
        queueMicrotask(() => this.output({ close: () => { audioCloses += 1; } } as unknown as AudioData));
      }, 0);
    }
    async flush(): Promise<void> {}
    close(): void {}
  }
  const worker = new InProcessFlacWorker({
    AudioDecoder: InvalidOutputDecoder,
    EncodedAudioChunk: FakeEncodedAudioChunk,
  } as unknown as typeof globalThis);
  const reading = (await threeFrameResolver(worker).resolve(IDENTITY)).stream.getReader().read();
  await assert.rejects(Promise.race([
    reading,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("PCM failure deadlocked on credit")), 100)),
  ]), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.decode.output");
  assert.equal(worker.terminated, true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(audioCloses, 2);
  assert.equal(worker.lateReplies, 0);
});

test("ingest core submits one FLAC frame per EncodedAudioChunk and consumes output credit", async () => {
  const encoded: Array<Readonly<{ data: BufferSource }>> = [];
  let closed = false;
  class FakeEncodedAudioChunk {
    constructor(init: { readonly data: BufferSource }) { encoded.push(init); }
  }
  class FakeAudioDecoder {
    static async isConfigSupported(config: AudioDecoderConfig) { return { supported: true, config }; }
    readonly output: (audio: AudioData) => void;
    constructor(init: { readonly output: (audio: AudioData) => void }) { this.output = init.output; }
    configure(): void {}
    decode(): void {
      const pcm = new Uint8Array([0x34, 0x12]);
      this.output({
        format: "s16", numberOfFrames: 1, numberOfChannels: 1, sampleRate: 44_100,
        allocationSize: () => 2,
        copyTo: (destination: AllowSharedBufferSource) => {
          const target = ArrayBuffer.isView(destination)
            ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
            : new Uint8Array(destination);
          target.set(pcm);
        },
        close: () => { closed = true; },
      } as unknown as AudioData);
    }
    async flush(): Promise<void> {}
    close(): void {}
  }
  const input = singleFrameFlac();
  const replies: FlacWorkerResponse[] = [];
  let reads = 0;
  let credits = 0;
  await runFlacIngest({
    requestId: 9,
    post: (reply) => replies.push(reply),
    nextInput: async () => reads++ === 0 ? { bytes: input, totalFlacBytes: input.byteLength } : null,
    nextOutputCredit: async () => { credits += 1; },
    cancelled: () => false,
    globals: {
      AudioDecoder: FakeAudioDecoder,
      EncodedAudioChunk: FakeEncodedAudioChunk,
    } as unknown as typeof globalThis,
  });
  assert.equal(encoded.length, 1);
  assert.equal(encoded[0]!.data.byteLength, 4);
  assert.equal(credits, 1);
  assert.equal(closed, true);
  assert.ok(replies.some((reply) => reply.type === "pcm"));
  assert.ok(replies.some((reply) => reply.type === "complete"));
});

test("ingest core closes an unexpected extra AudioData before rejecting it", async () => {
  let closes = 0;
  class ExtraOutputDecoder {
    static async isConfigSupported(config: AudioDecoderConfig) { return { supported: true, config }; }
    readonly output: (audio: AudioData) => void;
    constructor(init: { readonly output: (audio: AudioData) => void }) { this.output = init.output; }
    configure(): void {}
    decode(): void {
      for (let index = 0; index < 2; index += 1) {
        this.output({
          format: "s16", numberOfFrames: 1, numberOfChannels: 1, sampleRate: 44_100,
          allocationSize: () => 2,
          copyTo: (destination: AllowSharedBufferSource) => {
            const target = ArrayBuffer.isView(destination)
              ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
              : new Uint8Array(destination);
            target.set([0, 0]);
          },
          close: () => { closes += 1; },
        } as unknown as AudioData);
      }
    }
    async flush(): Promise<void> {}
    close(): void {}
  }
  class FakeEncodedAudioChunk {}
  const input = singleFrameFlac();
  let reads = 0;
  await assert.rejects(
    runFlacIngest({
      requestId: 10,
      post: () => undefined,
      nextInput: async () => reads++ === 0 ? { bytes: input, totalFlacBytes: input.byteLength } : null,
      nextOutputCredit: async () => undefined,
      cancelled: () => false,
      globals: {
        AudioDecoder: ExtraOutputDecoder,
        EncodedAudioChunk: FakeEncodedAudioChunk,
      } as unknown as typeof globalThis,
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.decode.output",
  );
  assert.equal(closes, 2);
});

test("FLAC Worker package asset has a literal URL and honors override factories", () => {
  const calls: string[] = [];
  const fake = {} as Worker;
  assert.equal(createFlacWorker({
    flacWorkerUrl: "https://caller.invalid/custom-worker.js",
    createWorker(url) { calls.push(String(url)); return fake; },
  }), fake);
  assert.deepEqual(calls, ["https://caller.invalid/custom-worker.js"]);
  assert.match(ADAPTER_ASSETS.flacWorker.href, /engine-web-flac-worker\.js$/u);
});
