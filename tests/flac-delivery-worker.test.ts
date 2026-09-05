import { createHash } from "node:crypto";
import { createIngestDiagnostics } from "../src/index.js";
import { VerifiedStemStore } from "../src/stems/store.js";
import { MemoryStemStorageBackend } from "../src/stems/storage.js";
import { BoundedStemAdmission } from "../src/stems/flac-admission.js";
import assert from "node:assert/strict";
import test from "node:test";

import { ADAPTER_ASSETS, createFlacWorker } from "../src/assets.js";
import { EngineWebAdapterError } from "../src/errors.js";
import { readExactFlacRange } from "../src/stems/flac-delivery.js";
import { createFlacStemResolver } from "../src/stems/flac-resolver.js";
import { FlacWorkerPool } from "../src/stems/flac-worker-pool.js";
import type {
  FlacWorkerLike,
  FlacWorkerRequest,
  FlacWorkerResponse,
} from "../src/stems/flac-worker-protocol.js";

const IDENTITY = `sha256:${"b".repeat(64)}` as const;

/** A `fetch` stub shaped like the normalized request the package actually sends. */
function responseFetch(
  respond: (request: { readonly url: string; readonly headers: Readonly<Record<string, string>> }) => Response,
): typeof globalThis.fetch {
  return (async (input: unknown, init?: RequestInit) => respond({
    url: String(input),
    headers: (init?.headers ?? {}) as Readonly<Record<string, string>>,
  })) as typeof globalThis.fetch;
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

test("delivery preserves caller headers and overwrites exact Range", async () => {
  const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const seen: Array<Readonly<Record<string, string>>> = [];
  const client = responseFetch((request) => {
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
    fetch: client,
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

test("HTTP response and body chunks report decoder-watchdog activity", async () => {
  let activity = 0;
  const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
  const result = await readExactFlacRange({
    identity: IDENTITY, phase: "audio", start: 0, end: 2,
    signal: new AbortController().signal, state: {}, maximumAttempts: 1,
    locate: () => "https://caller.invalid/stem",
    onActivity: () => { activity += 1; },
    fetch: responseFetch(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close(); else controller.enqueue(chunk);
      },
    }), { status: 206, headers: {
      "Content-Range": "bytes 0-2/4", "Content-Length": "3", ETag: '"stable"',
    } })),
  });
  assert.deepEqual([...result.bytes], [1, 2, 3]);
  assert.equal(activity, 4);
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
  const client = responseFetch(() => {
    responses += 1;
    return responses === 1 ? new Response("busy", { status: 503 }) : exactResponse(new Uint8Array([7, 8]), 0, 1);
  });
  const locates: number[] = [];
  const result = await readExactFlacRange({
    identity: IDENTITY, phase: "probe", start: 0, end: 1,
    signal: new AbortController().signal, state: {}, maximumAttempts: 2, fetch: client,
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
      fetch: responseFetch(() => new Response("busy", { status: 503 })),
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
      fetch: responseFetch(() => new Response(new ReadableStream({ start() { /* intentionally idle */ } }), {
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
      fetch: responseFetch(() => exactResponse(new Uint8Array([1, 2]), 0, 1)),
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
      fetch: responseFetch(() => new Response("busy", { status: 503 })),
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
        fetch: responseFetch(() => response),
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
      fetch: responseFetch(() => new Response(new Uint8Array([1, 2]), { status: 206, headers: {
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
  readonly acceptedInputBytes: number[] = [];
  terminated = false;
  postsAfterTermination = 0;
  #slot: Extract<FlacWorkerRequest, { type: "start" }>["inputSlot"] | undefined;
  #listeners = new Map<string, Set<(event: any) => void>>();
  postMessage(message: FlacWorkerRequest): void {
    if (this.terminated) { this.postsAfterTermination += 1; return; }
    this.posted.push(message);
    if (message.type === "start") {
      this.#slot = message.inputSlot;
      queueMicrotask(() => this.emit({ type: "ready", requestId: message.requestId }));
    }
    if (message.type === "initialize") {
      queueMicrotask(() => this.emit({ type: "input-credit", requestId: message.requestId, maximumBytes: 4, phase: "audio", phaseBytesRemaining: 0 }));
      this.#pollSlot(message.requestId);
    }
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
  #pollSlot(requestId: number): void {
    if (this.terminated || this.#slot === undefined) return;
    const control = new Int32Array(this.#slot.control);
    if (Atomics.load(control, 0) !== 1) { setTimeout(() => this.#pollSlot(requestId), 0); return; }
    const length = Atomics.load(control, 1);
    const final = Atomics.load(control, 3) === 1;
    this.acceptedInputBytes.push(length);
    Atomics.store(control, 0, 0);
    if (!final) {
      this.emit({ type: "input-credit", requestId, maximumBytes: 4, phase: "audio", phaseBytesRemaining: 0 });
      this.#pollSlot(requestId);
      return;
    }
    const pcm = new Uint8Array([9, 8, 7, 6]).buffer;
    this.emit({ type: "pcm", requestId, bytes: pcm, frames: 1, totalPcmBytes: 4 });
    this.emit({ type: "complete", requestId, pcmBytes: 4, frames: 1 });
  }
}

test("resolver follows Worker credit with exact nonoverlapping ranges and disposes the one-stem Worker", async () => {
  const source = singleFrameFlac();
  const ranges: string[] = [];
  const worker = new FakeWorker();
  const resolver = createFlacStemResolver({
    createWorker: () => worker,
    assets: { flacDecoderWasmUrl: "https://caller.invalid/decoder.wasm" },
    hardwareConcurrency: 2,
    maximumAttempts: 1,
    locate: () => "https://caller.invalid/stem",
    fetch: responseFetch((request) => {
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
  assert.deepEqual(ranges, ["bytes=0-41", "bytes=42-45", "bytes=64-67"]);
  assert.equal(worker.terminated, true);
  assert.ok(worker.posted.some((message) => message.type === "output-credit"));
  const start = worker.posted.find((message): message is Extract<FlacWorkerRequest, { type: "start" }> =>
    message.type === "start")!;
  assert.equal(start.decoderWasmUrl, "https://caller.invalid/decoder.wasm");
  assert.equal(start.inputSlot.bytes.byteLength, 256 * 1024);
});

test("mid-body retry resumes at Worker credit without duplicated accepted bytes", async () => {
  const source = singleFrameFlac();
  const ranges: string[] = [];
  let first = true;
  const worker = new FakeWorker();
  const resolver = createFlacStemResolver({
    createWorker: () => worker,
    hardwareConcurrency: 2,
    maximumAttempts: 2,
    readDeadlineMs: 5,
    locate: () => "https://caller.invalid/stem",
    fetch: responseFetch((request) => {
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
  const pcm = new Uint8Array([9, 8, 7, 6]);
  const identity = `sha256:${createHash("sha256").update(pcm).digest("hex")}` as const;
  const diagnostics = createIngestDiagnostics();
  const lease = await new VerifiedStemStore({ backend: new MemoryStemStorageBackend() }).openSession({
    leaseId: "retry", stems: [{ sourceId: "source", identity, bytes: pcm.length }],
    resolver, admission: new BoundedStemAdmission(1), ingestDiagnostics: diagnostics,
  });
  assert.deepEqual(new Uint8Array(await (await lease.read(identity)).arrayBuffer()), pcm);
  assert.deepEqual(diagnostics.snapshot().residency, {
    limit: 1, deliveredBytes: 0, deliveredPeakBytes: 42, decodedBytes: 0, decodedPeakBytes: 4,
    containers: 0, containersPeak: 1, active: 0, activePeak: 1,
  });
  await lease.close();
  assert.deepEqual(ranges, ["bytes=0-41", "bytes=0-41", "bytes=42-45", "bytes=64-67"]);
  assert.deepEqual(worker.acceptedInputBytes, [4]);
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
    fetch: responseFetch(() => assert.fail("idle Worker must not request HTTP")),
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

for (const phase of ["decoder-load", "frame"] as const) {
  test(`${phase} no-progress watchdog terminates before typed rejection`, async () => {
    class StalledWorker extends FakeWorker {
      override postMessage(message: FlacWorkerRequest): void {
        if (this.terminated) return;
        this.posted.push(message);
        if (phase === "frame" && message.type === "start") {
          queueMicrotask(() => this.emit({ type: "ready", requestId: message.requestId }));
        }
      }
    }
    const worker = new StalledWorker();
    const source = singleFrameFlac();
    const resolver = createFlacStemResolver({
      createWorker: () => worker,
      hardwareConcurrency: 2,
      decodeNoProgressMs: 10,
      maximumAttempts: 1,
      locate: () => "https://caller.invalid/stem",
      fetch: responseFetch((request) => {
        const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range!)!;
        return exactResponse(source, Number(match[1]), Number(match[2]));
      }),
    });
    const reading = (await resolver.resolve(IDENTITY)).stream.getReader().read();
    await assert.rejects(reading, (error: unknown) => {
      assert.equal(worker.terminated, true);
      return error instanceof EngineWebAdapterError && error.code === "stem.decode.stall" && error.details.phase === phase;
    });
  });
}

test("zero-high-water stream returns credit only after consuming one of exactly two buffered PCM blocks", async () => {
  class TwoCreditWorker extends FakeWorker {
    emittedThird = false;
    override postMessage(message: FlacWorkerRequest): void {
      if (this.terminated) return;
      this.posted.push(message);
      if (message.type === "start") queueMicrotask(() => this.emit({ type: "ready", requestId: message.requestId }));
      if (message.type === "initialize") queueMicrotask(() => {
        this.emit({ type: "pcm", requestId: message.requestId, bytes: new Uint8Array([1]).buffer, frames: 1, totalPcmBytes: 3 });
        this.emit({ type: "pcm", requestId: message.requestId, bytes: new Uint8Array([2]).buffer, frames: 1, totalPcmBytes: 3 });
      });
      if (message.type === "output-credit" && !this.emittedThird) {
        this.emittedThird = true;
        queueMicrotask(() => {
        this.emit({ type: "pcm", requestId: message.requestId, bytes: new Uint8Array([3]).buffer, frames: 1, totalPcmBytes: 3 });
        this.emit({ type: "complete", requestId: message.requestId, pcmBytes: 3, frames: 3 });
        });
      }
    }
  }
  const worker = new TwoCreditWorker();
  const source = singleFrameFlac();
  const resolver = createFlacStemResolver({
    createWorker: () => worker, hardwareConcurrency: 2, decodeNoProgressMs: 1_000,
    locate: () => "https://caller.invalid/stem",
    fetch: responseFetch((request) => {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range!)!;
      return exactResponse(source, Number(match[1]), Number(match[2]));
    }),
  });
  const reader = (await resolver.resolve(IDENTITY)).stream.getReader();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(worker.posted.filter((message) => message.type === "output-credit").length, 0);
  assert.deepEqual([...(await reader.read()).value!], [1]);
  assert.equal(worker.posted.filter((message) => message.type === "output-credit").length, 1);
  assert.deepEqual([...(await reader.read()).value!], [2]);
  assert.deepEqual([...(await reader.read()).value!], [3]);
  assert.equal((await reader.read()).done, true);

  for (const outcome of ["success", "cancel", "write-failure"] as const) {
    const physical = new TwoCreditWorker();
    const diagnostics = createIngestDiagnostics();
    const admission = new BoundedStemAdmission(1);
    const pcm = new Uint8Array([1, 2, 3]);
    const identity = `sha256:${createHash("sha256").update(pcm).digest("hex")}` as const;
    const packageResolver = createFlacStemResolver({
      admission, createWorker: () => physical, locate: () => "https://caller.invalid/stem",
      fetch: responseFetch(request => {
        const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range!)!;
        return exactResponse(source, Number(match[1]), Number(match[2]));
      }),
    });
    const backend = new MemoryStemStorageBackend();
    const createWriter = backend.createWriter.bind(backend);
    const writing = deferred<void>();
    const settleWrite = deferred<void>();
    const failure = new Error("store write rejected");
    let writes = 0;
    backend.createWriter = async name => {
      const writer = await createWriter(name);
      if (!name.startsWith("staging-")) return writer;
      return { ...writer, async write(bytes) {
        if (writes++ === 0) {
          writing.resolve();
          await settleWrite.promise;
          if (outcome === "write-failure") throw failure;
        }
        await writer.write(bytes);
      } };
    };
    const abort = new AbortController();
    let ready = false;
    const opening = new VerifiedStemStore({ backend }).openSession({
      leaseId: outcome, stems: [{ sourceId: "source", identity, bytes: 3 }],
      resolver: packageResolver, admission, ingestDiagnostics: diagnostics, signal: abort.signal,
      onProgress: event => { if (event.stage === "ready") ready = true; },
    });
    const refused = outcome === "success" ? undefined : assert.rejects(opening, error =>
      outcome === "cancel" ? error instanceof EngineWebAdapterError && error.code === "stem.cancelled" : error === failure);
    await writing.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(physical.terminated, true, "physical decode ends before the trailing store write");
    assert.equal(admission.stats.active, 0);
    assert.deepEqual(diagnostics.snapshot().residency, {
      limit: 1, deliveredBytes: 0, deliveredPeakBytes: 42, decodedBytes: 3, decodedPeakBytes: 3,
      containers: 0, containersPeak: 1, active: 1, activePeak: 1,
    }, "two queued backing buffers plus the handed-off buffer remain owned during the write");
    const retained = diagnostics.snapshot();
    if (outcome === "cancel") abort.abort("cancel queued and handed-off PCM");
    settleWrite.resolve();
    if (outcome === "success") {
      const lease = await opening;
      assert.deepEqual(new Uint8Array(await (await lease.read(identity)).arrayBuffer()), pcm);
      await lease.close();
    } else await refused;
    assert.equal(ready, outcome === "success");
    assert.equal(diagnostics.snapshot().residency!.decodedBytes, 0);
    assert.equal(diagnostics.snapshot().residency!.active, 0);
    assert.equal(diagnostics.snapshot().residency!.decodedPeakBytes, 3);
    assert.equal(retained.residency!.decodedBytes, 3, "snapshots are independent values");
  }

});

test("metadata locator cancellation aborts before Worker termination and rejection", async () => {
  class MetadataWorker extends FakeWorker {
    override postMessage(message: FlacWorkerRequest): void {
      if (this.terminated) { this.postsAfterTermination += 1; return; }
      this.posted.push(message);
      if (message.type === "start") queueMicrotask(() => this.emit({ type: "ready", requestId: message.requestId }));
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
  const client = responseFetch(() => new Response(new ReadableStream<Uint8Array>({
    start() { requestStarted.resolve(); },
  }), {
    status: 206,
    headers: { "Content-Range": "bytes 0-41/100", "Content-Length": "42", ETag: '"stable"' },
  }));
  const resolver = createFlacStemResolver({
    createWorker: () => worker,
    hardwareConcurrency: 2,
    locate: (_identity, attempt) => {
      attempt.signal.addEventListener("abort", () => { deliveryAborted = true; }, { once: true });
      return "https://caller.invalid/active-range";
    },
    fetch: client,
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

for (const code of ["stem.decode.flac", "stem.decode.output"] as const) {
  test(`${code} Worker failure terminates before stream rejection`, async () => {
    class FailingWorker extends FakeWorker {
      override postMessage(message: FlacWorkerRequest): void {
        if (this.terminated) { this.postsAfterTermination += 1; return; }
        this.posted.push(message);
        if (message.type === "start") queueMicrotask(() => this.emit({ type: "ready", requestId: message.requestId }));
        if (message.type === "initialize") queueMicrotask(() => this.emit({
          type: "error", requestId: message.requestId,
          error: { name: "EngineWebAdapterError", message: "decoder failed closed", code, details: { retryable: false } },
        }));
      }
    }
    const worker = new FailingWorker();
    const source = singleFrameFlac();
    const resolver = createFlacStemResolver({
      createWorker: () => worker, hardwareConcurrency: 2, maximumAttempts: 1,
      locate: () => "https://caller.invalid/failing",
      fetch: responseFetch((request) => {
        const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range!)!;
        return exactResponse(source, Number(match[1]), Number(match[2]));
      }),
    });
    await assert.rejects((await resolver.resolve(IDENTITY)).stream.getReader().read(), (error: unknown) => {
      assert.equal(worker.terminated, true);
      return error instanceof EngineWebAdapterError && error.code === code;
    });
  });
}

test("FLAC Worker package asset has a literal URL and honors override factories", () => {
  const calls: string[] = [];
  const fake = {} as Worker;
  assert.equal(createFlacWorker({
    flacWorkerUrl: "https://caller.invalid/custom-worker.js",
    createWorker(url) { calls.push(String(url)); return fake; },
  }), fake);
  assert.deepEqual(calls, ["https://caller.invalid/custom-worker.js"]);
  assert.match(ADAPTER_ASSETS.flacWorker.href, /engine-web-flac-worker\.js$/u);
  assert.match(ADAPTER_ASSETS.flacDecoderWasm.href, /engine-web-flac-decoder\.wasm$/u);
});
