import { createHash } from "node:crypto";
import { createIngestDiagnostics } from "../src/index.js";
import { VerifiedStemStore } from "../src/stems/store.js";
import { MemoryStemStorageBackend } from "../src/stems/storage.js";
import { BoundedStemAdmission } from "../src/stems/flac-admission.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { createBLAKE3 } from "hash-wasm";

import { ADAPTER_ASSETS, createFlacWorker } from "../src/assets.js";
import { EngineWebAdapterError } from "../src/errors.js";
import { readExactFlacRange } from "../src/stems/flac-delivery.js";
import { createFlacStemChunkResolver, createFlacStemResolver, createFlacStemResolverWithSource } from "../src/stems/flac-resolver.js";
import { DecoderByteSourceError, type DecoderByteSource, type DecoderByteSourceOptions } from "../src/stems/decoder-byte-source.js";
import { FlacWorkerPool } from "../src/stems/flac-worker-pool.js";
import type {
  FlacWorkerLike,
  FlacWorkerRequest,
  FlacWorkerResponse,
} from "../src/stems/flac-worker-protocol.js";

const IDENTITY = `blake3:${"b".repeat(64)}` as const;
const identityHasher = await createBLAKE3(256);
const identityFor = (bytes: Uint8Array) => `blake3:${identityHasher.init().update(bytes).digest("hex")}` as const;

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

class ScriptedWorker implements FlacWorkerLike {
  readonly posted: FlacWorkerRequest[] = [];
  terminated = false;
  readonly slotState = { value: -1 };
  #listeners = new Map<string, Set<(event: any) => void>>();
  #onInitialize: (worker: ScriptedWorker, requestId: number) => void;
  #slot: Extract<FlacWorkerRequest, { type: "start" }>['inputSlot'] | undefined;

  constructor(onInitialize: (worker: ScriptedWorker, requestId: number) => void) {
    this.#onInitialize = onInitialize;
  }

  postMessage(message: FlacWorkerRequest): void {
    if (this.terminated) return;
    this.posted.push(message);
    if (message.type === "start") {
      this.#slot = message.inputSlot;
      queueMicrotask(() => this.emit({ type: "ready", requestId: message.requestId }));
    } else if (message.type === "initialize") {
      queueMicrotask(() => this.#onInitialize(this, message.requestId));
    }
  }

  terminate(): void {
    this.terminated = true;
    if (this.#slot !== undefined) this.slotState.value = Atomics.load(new Int32Array(this.#slot.control), 0);
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(message: FlacWorkerResponse): void {
    for (const listener of this.#listeners.get("message") ?? []) listener({ data: message });
  }

  fail(error: Error): void {
    for (const listener of this.#listeners.get("error") ?? []) listener({ message: error.message, error });
  }
}

function syntheticStreamInfo() {
  return Object.freeze({
    sampleRateHz: 44_100 as const, channels: 1 as const, bitDepth: 16 as const, totalSamples: 1,
    minimumBlockSamples: 16, maximumBlockSamples: 16, minimumFrameBytes: 0, maximumFrameBytes: 0,
    streamMd5: new Uint8Array(16), decoderDescription: new Uint8Array(42),
  });
}

function syntheticSource(options: {
  readonly prepare?: DecoderByteSource["prepare"];
  readonly read: DecoderByteSource["read"];
  readonly finish: DecoderByteSource["finish"];
}) {
  const info = syntheticStreamInfo();
  return {
    prepare: options.prepare ?? Effect.succeed({ streamInfo: info, expectedFrames: 1, totalPcmBytes: 4 }),
    read: options.read,
    finish: options.finish,
  };
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

test("private input lane consumes one synthetic sequential source with bounded credits", async () => {
  const worker = new FakeWorker();
  const encoded = new Uint8Array([1, 2, 3, 4, 5]);
  const streamInfo = Object.freeze({
    sampleRateHz: 44_100 as const, channels: 1 as const, bitDepth: 16 as const, totalSamples: 1,
    minimumBlockSamples: 16, maximumBlockSamples: 16, minimumFrameBytes: 0, maximumFrameBytes: 0,
    streamMd5: new Uint8Array(16), decoderDescription: new Uint8Array(42),
  });
  let prepares = 0;
  let reads = 0;
  let activeReads = 0;
  let activePeak = 0;
  let releases = 0;
  let finishes = 0;
  const resolver = createFlacStemResolverWithSource({
    createWorker: () => worker,
    hardwareConcurrency: 2,
    locate: () => assert.fail("synthetic source must not invoke the ranged locator"),
  }, () => {
    let offset = 0;
    return {
      prepare: Effect.sync(() => {
        prepares += 1;
        return { streamInfo, expectedFrames: 1, totalPcmBytes: 4 };
      }),
      read: (maximumBytes: number) => Effect.sync(() => {
        activeReads += 1;
        activePeak = Math.max(activePeak, activeReads);
        try {
          reads += 1;
          const length = Math.min(maximumBytes, encoded.byteLength - offset);
          const bytes = encoded.slice(offset, offset + length);
          offset += length;
          return { bytes, end: offset === encoded.byteLength, release: () => { releases += 1; } };
        } finally { activeReads -= 1; }
      }),
      finish: Effect.sync(() => { finishes += 1; }),
    };
  });
  const resolved = await resolver.resolve(IDENTITY);
  const reader = resolved.stream.getReader();
  assert.deepEqual([...((await reader.read()).value ?? [])], [9, 8, 7, 6]);
  assert.equal((await reader.read()).done, true);
  assert.equal(prepares, 1);
  assert.equal(reads, 2);
  assert.equal(activePeak, 1);
  assert.equal(releases, 2);
  assert.equal(finishes, 1);
  assert.deepEqual(worker.acceptedInputBytes, [4, 1]);
});

test("a source adopts a synchronous borrow before cancellation and releases it once", async () => {
  const abort = new AbortController();
  const worker = new ScriptedWorker((physical, requestId) => {
    physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
  });
  let releases = 0;
  let reads = 0;
  const resolver = createFlacStemResolverWithSource({
    createWorker: () => worker, hardwareConcurrency: 2, locate: () => assert.fail("synthetic source must not locate"),
  }, (options: DecoderByteSourceOptions) => {
    const info = syntheticStreamInfo();
    return {
      prepare: Effect.succeed({ streamInfo: info, expectedFrames: 1, totalPcmBytes: 4 }),
      read: () => Effect.sync(() => {
        reads += 1;
        const release = () => { releases += 1; };
        options.borrow!.adopt(release);
        abort.abort("cancel during source handoff");
        return { bytes: new Uint8Array([1]), end: true, release: options.borrow!.release };
      }),
      finish: Effect.sync(() => {}),
    };
  });
  const reading = (await resolver.resolve(IDENTITY, { signal: abort.signal })).stream.getReader().read();
  await assert.rejects(reading, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
  assert.equal(reads, 1);
  assert.equal(releases, 1);
  assert.equal(worker.terminated, true);
});

test("private chunk output borrows the shared queue and returns credit only on release", async () => {
  const expected = {
    sampleRateHz: 44_100, channels: 1 as const, bitDepth: 16 as const,
    frames: 2, canonicalBytes: 4,
  };
  const pcm = new Uint8Array([9, 8, 7, 6]);
  const worker = new ScriptedWorker((physical, requestId) => {
    physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
    queueMicrotask(() => physical.emit({ type: "pcm", requestId, bytes: pcm.slice().buffer, frames: 2, totalPcmBytes: 4 }));
  });
  const resolver = createFlacStemChunkResolver({
    createWorker: () => worker, hardwareConcurrency: 2,
    wholeSourceIdentity: IDENTITY,
    chunk: { expected, pcmSha256: createHash("sha256").update(pcm).digest("hex") },
    sourceFactory: options => {
      assert.equal("range" in options, false);
      return syntheticSource({
      prepare: Effect.succeed({ streamInfo: syntheticStreamInfo(), expectedFrames: 2, totalPcmBytes: 4 }),
      read: () => Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }),
      finish: Effect.sync(() => {}),
      });
    },
  });
  const { output } = await resolver.resolve();
  const reader = output.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.deepEqual([...(first.value?.bytes ?? [])], [...pcm]);
  assert.equal(worker.posted.filter(message => message.type === "output-credit").length, 0);
  first.value!.release();
  const requestId = worker.posted.find((message): message is Extract<FlacWorkerRequest, { type: "start" }> => message.type === "start")!.requestId;
  worker.emit({ type: "complete", requestId, pcmBytes: 4, frames: 2 });
  assert.equal((await reader.read()).done, true);
  assert.equal(worker.posted.filter(message => message.type === "output-credit").length, 1);
  assert.equal(worker.terminated, true);
});

test("private chunk output enforces frame alignment independently of processing", async () => {
  const expected = {
    sampleRateHz: 44_100, channels: 2 as const, bitDepth: 24 as const,
    frames: 1, canonicalBytes: 6,
  };
  const streamInfo = { ...syntheticStreamInfo(), channels: 2 as const, bitDepth: 24 as const };
  const worker = new ScriptedWorker((physical, requestId) => {
    physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
    queueMicrotask(() => physical.emit({ type: "pcm", requestId, bytes: new Uint8Array([1, 2, 3, 4, 5]).buffer, frames: 1, totalPcmBytes: 6 }));
  });
  const resolver = createFlacStemChunkResolver({
    createWorker: () => worker, hardwareConcurrency: 2,
    wholeSourceIdentity: IDENTITY,
    chunk: { expected, pcmSha256: "0".repeat(64) },
    sourceFactory: () => syntheticSource({
      prepare: Effect.succeed({ streamInfo, expectedFrames: 1, totalPcmBytes: 6 }),
      read: () => Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }),
      finish: Effect.sync(() => {}),
    }),
  });
  const reader = (await resolver.resolve()).output.getReader();
  await assert.rejects(reader.read(), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.decode.worker");
  assert.equal(worker.terminated, true);
});

test("private output capacity includes the checked-out block until its release", async () => {
  const expected = {
    sampleRateHz: 44_100, channels: 1 as const, bitDepth: 16 as const,
    frames: 3, canonicalBytes: 6,
  };
  const worker = new ScriptedWorker((physical, requestId) => {
    physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
    queueMicrotask(() => physical.emit({ type: "pcm", requestId, bytes: new Uint8Array([1, 2]).buffer, frames: 1, totalPcmBytes: 6 }));
  });
  const resolver = createFlacStemChunkResolver({
    createWorker: () => worker, hardwareConcurrency: 2,
    wholeSourceIdentity: IDENTITY,
    chunk: { expected, pcmSha256: "0".repeat(64) },
    sourceFactory: () => syntheticSource({
      prepare: Effect.succeed({ streamInfo: syntheticStreamInfo(), expectedFrames: 3, totalPcmBytes: 6 }),
      read: () => Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }),
      finish: Effect.sync(() => {}),
    }),
  });
  const reader = (await resolver.resolve()).output.getReader();
  const first = await reader.read();
  const requestId = worker.posted.find((message): message is Extract<FlacWorkerRequest, { type: "start" }> => message.type === "start")!.requestId;
  worker.emit({ type: "pcm", requestId, bytes: new Uint8Array([3, 4]).buffer, frames: 1, totalPcmBytes: 6 });
  worker.emit({ type: "pcm", requestId, bytes: new Uint8Array([5, 6]).buffer, frames: 1, totalPcmBytes: 6 });
  await assert.rejects(reader.read(), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.decode.worker");
  assert.equal(worker.terminated, true);
  first.value?.release();
  assert.equal(worker.posted.filter(message => message.type === "output-credit").length, 0);
});

test("private output blocks a repeated pull and cancellation suppresses a late release credit", async () => {
  const expected = {
    sampleRateHz: 44_100, channels: 1 as const, bitDepth: 16 as const,
    frames: 2, canonicalBytes: 4,
  };
  const worker = new ScriptedWorker((physical, requestId) => {
    physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
    queueMicrotask(() => physical.emit({ type: "pcm", requestId, bytes: new Uint8Array([1, 2]).buffer, frames: 1, totalPcmBytes: 4 }));
  });
  const resolver = createFlacStemChunkResolver({
    createWorker: () => worker, hardwareConcurrency: 2,
    wholeSourceIdentity: IDENTITY,
    chunk: { expected, pcmSha256: "0".repeat(64) },
    sourceFactory: () => syntheticSource({
      prepare: Effect.succeed({ streamInfo: syntheticStreamInfo(), expectedFrames: 2, totalPcmBytes: 4 }),
      read: () => Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }),
      finish: Effect.sync(() => {}),
    }),
  });
  const reader = (await resolver.resolve()).output.getReader();
  const first = await reader.read();
  const requestId = worker.posted.find((message): message is Extract<FlacWorkerRequest, { type: "start" }> => message.type === "start")!.requestId;
  worker.emit({ type: "pcm", requestId, bytes: new Uint8Array([3, 4]).buffer, frames: 1, totalPcmBytes: 4 });
  const repeated = reader.read();
  let settled = false;
  void repeated.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false);
  await reader.cancel("cancel while first output is borrowed");
  first.value!.release();
  assert.equal(worker.posted.filter(message => message.type === "output-credit").length, 0);
});

test("private completion checks host PCM hash and strict final counts", async () => {
  for (const problem of ["hash", "count"] as const) {
    const expected = {
      sampleRateHz: 44_100, channels: 1 as const, bitDepth: 16 as const,
      frames: 2, canonicalBytes: 4,
    };
    const pcm = new Uint8Array([9, 8, 7, 6]);
    const worker = new ScriptedWorker((physical, requestId) => {
      physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
      queueMicrotask(() => physical.emit({ type: "pcm", requestId, bytes: pcm.slice().buffer, frames: 2, totalPcmBytes: 4 }));
    });
    const resolver = createFlacStemChunkResolver({
      createWorker: () => worker, hardwareConcurrency: 2,
      wholeSourceIdentity: IDENTITY,
      chunk: { expected, pcmSha256: problem === "hash" ? "0".repeat(64) : createHash("sha256").update(pcm).digest("hex") },
      sourceFactory: () => syntheticSource({
        prepare: Effect.succeed({ streamInfo: syntheticStreamInfo(), expectedFrames: 2, totalPcmBytes: 4 }),
        read: () => Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }),
        finish: Effect.sync(() => {}),
      }),
    });
    const reader = (await resolver.resolve()).output.getReader();
    const first = await reader.read();
    first.value!.release();
    const requestId = worker.posted.find((message): message is Extract<FlacWorkerRequest, { type: "start" }> => message.type === "start")!.requestId;
    worker.emit({ type: "complete", requestId, pcmBytes: 4, frames: problem === "count" ? 1 : 2 });
    await assert.rejects(reader.read(), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.corrupt");
    assert.equal(worker.terminated, true);
  }
});

test("private output waits for delayed encoded finish before ending", async () => {
  const finishGate = deferred<void>();
  let finishStarted = false;
  const expected = {
    sampleRateHz: 44_100, channels: 1 as const, bitDepth: 16 as const,
    frames: 2, canonicalBytes: 4,
  };
  const pcm = new Uint8Array([9, 8, 7, 6]);
  const worker = new ScriptedWorker((physical, requestId) => {
    physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
    queueMicrotask(() => physical.emit({ type: "pcm", requestId, bytes: pcm.slice().buffer, frames: 2, totalPcmBytes: 4 }));
  });
  const resolver = createFlacStemChunkResolver({
    createWorker: () => worker, hardwareConcurrency: 2,
    wholeSourceIdentity: IDENTITY,
    chunk: { expected, pcmSha256: createHash("sha256").update(pcm).digest("hex") },
    sourceFactory: () => syntheticSource({
      prepare: Effect.succeed({ streamInfo: syntheticStreamInfo(), expectedFrames: 2, totalPcmBytes: 4 }),
      read: () => Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }),
      finish: Effect.promise(() => { finishStarted = true; return finishGate.promise; }),
    }),
  });
  const reader = (await resolver.resolve()).output.getReader();
  const first = await reader.read();
  const requestId = worker.posted.find((message): message is Extract<FlacWorkerRequest, { type: "start" }> => message.type === "start")!.requestId;
  worker.emit({ type: "complete", requestId, pcmBytes: 4, frames: 2 });
  const ending = reader.read();
  for (let index = 0; index < 100 && !finishStarted; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(finishStarted, true);
  let settled = false;
  void ending.then(() => { settled = true; });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false);
  first.value!.release();
  finishGate.resolve();
  assert.equal((await ending).done, true);
  assert.equal(worker.terminated, true);
});

test("input lane refuses invalid credits and bounded-command overflow before source access", async () => {
  let invalidReads = 0;
  const invalidWorker = new ScriptedWorker((worker, requestId) => {
    worker.emit({ type: "input-credit", requestId, maximumBytes: 0, phase: "audio", phaseBytesRemaining: 0 });
  });
  const invalidResolver = createFlacStemResolverWithSource({
    createWorker: () => invalidWorker, hardwareConcurrency: 2, locate: () => assert.fail("synthetic source must not locate"),
  }, () => syntheticSource({
    read: () => { invalidReads += 1; return Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }); },
    finish: Effect.sync(() => {}),
  }));
  await assert.rejects((await invalidResolver.resolve(IDENTITY)).stream.getReader().read(), (error: unknown) =>
    error instanceof EngineWebAdapterError && error.code === "stem.decode.worker");
  assert.equal(invalidReads, 0);
  assert.equal(invalidWorker.terminated, true);

  const staleAbort = new AbortController();
  let staleReads = 0;
  const staleWorker = new ScriptedWorker((worker, requestId) => {
    worker.emit({ type: "input-credit", requestId: requestId + 1, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
  });
  const staleResolver = createFlacStemResolverWithSource({
    createWorker: () => staleWorker, hardwareConcurrency: 2, locate: () => assert.fail("synthetic source must not locate"),
  }, () => syntheticSource({
    read: () => { staleReads += 1; return Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }); },
    finish: Effect.sync(() => {}),
  }));
  const staleReading = (await staleResolver.resolve(IDENTITY, { signal: staleAbort.signal })).stream.getReader().read();
  await new Promise(resolve => setTimeout(resolve, 0));
  staleAbort.abort("stale credit");
  await assert.rejects(staleReading, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
  assert.equal(staleReads, 0);
  assert.equal(staleWorker.terminated, true);

  const pending = deferred<{ readonly bytes: Uint8Array; readonly end: boolean; readonly release: () => void }>();
  let overflowReads = 0;
  const overflowWorker = new ScriptedWorker((worker, requestId) => {
    for (let index = 0; index < 3; index += 1) {
      worker.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
    }
  });
  const overflowResolver = createFlacStemResolverWithSource({
    createWorker: () => overflowWorker, hardwareConcurrency: 2, locate: () => assert.fail("synthetic source must not locate"),
  }, () => syntheticSource({
    read: () => { overflowReads += 1; return Effect.promise(() => pending.promise); },
    finish: Effect.sync(() => {}),
  }));
  await assert.rejects((await overflowResolver.resolve(IDENTITY)).stream.getReader().read(), (error: unknown) =>
    error instanceof EngineWebAdapterError && error.code === "stem.decode.worker");
  assert.ok(overflowReads <= 1);
  assert.equal(overflowWorker.terminated, true);
  assert.equal(overflowWorker.slotState.value, 3);
});

test("input lane waits for finish and suspends the watchdog during a source read", async () => {
  const finishGate = deferred<void>();
  let finishStarted = false;
  const worker = new ScriptedWorker((physical, requestId) => {
    physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
    queueMicrotask(() => {
      physical.emit({ type: "pcm", requestId, bytes: new Uint8Array([9, 8, 7, 6]).buffer, frames: 1, totalPcmBytes: 4 });
      physical.emit({ type: "complete", requestId, pcmBytes: 4, frames: 1 });
    });
  });
  const resolver = createFlacStemResolverWithSource({
    createWorker: () => worker, hardwareConcurrency: 2, decodeNoProgressMs: 5,
    locate: () => assert.fail("synthetic source must not locate"),
  }, () => syntheticSource({
    read: () => Effect.promise(() => new Promise(resolve => setTimeout(() => resolve({ bytes: new Uint8Array([1]), end: true, release() {} }), 25))),
    finish: Effect.promise(() => { finishStarted = true; return finishGate.promise; }),
  }));
  const reader = (await resolver.resolve(IDENTITY)).stream.getReader();
  const first = await reader.read();
  assert.deepEqual([...(first.value ?? [])], [9, 8, 7, 6]);
  const ending = reader.read();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(finishStarted, false);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(finishStarted, true);
  assert.equal(worker.terminated, false);
  let settled = false;
  void ending.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false);
  finishGate.resolve();
  assert.equal((await ending).done, true);
  assert.equal(worker.terminated, true);

  const finishFailure = new Error("finish sentinel");
  const failingWorker = new ScriptedWorker((physical, requestId) => {
    physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
    queueMicrotask(() => {
      physical.emit({ type: "pcm", requestId, bytes: new Uint8Array([9, 8, 7, 6]).buffer, frames: 1, totalPcmBytes: 4 });
      physical.emit({ type: "complete", requestId, pcmBytes: 4, frames: 1 });
    });
  });
  const failingResolver = createFlacStemResolverWithSource({
    createWorker: () => failingWorker, hardwareConcurrency: 2, decodeNoProgressMs: 100,
    locate: () => assert.fail("synthetic source must not locate"),
  }, () => syntheticSource({
    read: () => Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }),
    finish: Effect.fail(new DecoderByteSourceError({ operation: "finish", message: "finish failed", cause: finishFailure })),
  }));
  const failingReader = (await failingResolver.resolve(IDENTITY)).stream.getReader();
  assert.deepEqual([...(await failingReader.read()).value ?? []], [9, 8, 7, 6]);
  await assert.rejects(failingReader.read(), (error: unknown) => {
    assert.ok(error instanceof EngineWebAdapterError);
    assert.equal(error.code, "stem.decode.worker");
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.includes(finishFailure), true);
    return true;
  });
  assert.equal(failingWorker.terminated, true);
});

test("completion closes new worker production while an accepted finish drains", async () => {
  const finishGate = deferred<void>();
  let finishStarted = false;
  const worker = new ScriptedWorker((physical, requestId) => {
    physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
    queueMicrotask(() => {
      physical.emit({ type: "pcm", requestId, bytes: new Uint8Array([9, 8, 7, 6]).buffer, frames: 1, totalPcmBytes: 4 });
      physical.emit({ type: "complete", requestId, pcmBytes: 4, frames: 1 });
    });
  });
  const resolver = createFlacStemResolverWithSource({
    createWorker: () => worker, hardwareConcurrency: 2, decodeNoProgressMs: 100,
    locate: () => assert.fail("synthetic source must not locate"),
  }, () => syntheticSource({
    read: () => Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }),
    finish: Effect.promise(() => { finishStarted = true; return finishGate.promise; }),
  }));
  const reader = (await resolver.resolve(IDENTITY)).stream.getReader();
  assert.deepEqual([...(await reader.read()).value ?? []], [9, 8, 7, 6]);
  const ending = reader.read();
  for (let index = 0; index < 100 && !finishStarted; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(finishStarted, true);
  worker.emit({ type: "pcm", requestId: worker.posted.find(message => message.type === "start")!.requestId,
    bytes: new Uint8Array([0]).buffer, frames: 1, totalPcmBytes: 5 });
  await assert.rejects(ending, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.decode.worker");
  assert.equal(worker.terminated, true);
  finishGate.resolve();
});

test("completion rejects duplicate completion and readiness while finish drains", async () => {
  for (const duplicate of ["complete", "ready"] as const) {
    const finishGate = deferred<void>();
    let finishStarted = false;
    const worker = new ScriptedWorker((physical, requestId) => {
      physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
      queueMicrotask(() => {
        physical.emit({ type: "pcm", requestId, bytes: new Uint8Array([9, 8, 7, 6]).buffer, frames: 1, totalPcmBytes: 4 });
        physical.emit({ type: "complete", requestId, pcmBytes: 4, frames: 1 });
      });
    });
    const resolver = createFlacStemResolverWithSource({
      createWorker: () => worker, hardwareConcurrency: 2, decodeNoProgressMs: 100,
      locate: () => assert.fail("synthetic source must not locate"),
    }, () => syntheticSource({
      read: () => Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }),
      finish: Effect.promise(() => { finishStarted = true; return finishGate.promise; }),
    }));
    const reader = (await resolver.resolve(IDENTITY)).stream.getReader();
    await reader.read();
    const ending = reader.read();
    for (let index = 0; index < 100 && !finishStarted; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(finishStarted, true);
    const requestId = worker.posted.find(message => message.type === "start")!.requestId;
    if (duplicate === "complete") worker.emit({ type: "complete", requestId, pcmBytes: 4, frames: 1 });
    else worker.emit({ type: "ready", requestId });
    await assert.rejects(ending, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.decode.worker");
    assert.equal(worker.terminated, true);
    finishGate.resolve();
  }
});

test("legacy metadata shape failures keep their public codes through the private source", async () => {
  const metadataOnly = singleFrameFlac().slice(0, 46);
  metadataOnly.set([0x81, 0, 0, 0], 42);
  for (const [label, code, bytes] of [
    ["empty suffix", "stem.flac.invalid", metadataOnly],
    ["unknown total", "stem.flac.shape", (() => {
      const value = singleFrameFlac();
      putU64(value, 18, 0n);
      return value;
    })()],
  ] as const) {
    const worker = new FakeWorker();
    const resolver = createFlacStemResolver({
      createWorker: () => worker, maximumAttempts: 1, locate: () => "https://caller.invalid/stem",
      fetch: responseFetch(request => {
        const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range!)!;
        return exactResponse(bytes, Number(match[1]), Number(match[2]));
      }),
    });
    await assert.rejects((await resolver.resolve(IDENTITY)).stream.getReader().read(), (error: unknown) => {
      assert.ok(error instanceof EngineWebAdapterError, label);
      assert.equal(error.code, code);
      return true;
    });
  }
});

test("private source failures retain operation, message, Cause reasons, and undefined defects", async () => {
  const cases: ReadonlyArray<{
    readonly effect: DecoderByteSource["prepare"];
    readonly message: string;
  }> = [
    { effect: Effect.fail(new DecoderByteSourceError({ operation: "prepare", message: "specific source failure" })), message: "specific source failure" },
    { effect: Effect.fail(new DecoderByteSourceError({ operation: "prepare", message: "explicit undefined", cause: undefined })), message: "explicit undefined" },
    { effect: Effect.die(undefined), message: "FLAC decoder input lane failed" },
  ];
  for (const item of cases) {
    const worker = new ScriptedWorker(() => {});
    const resolver = createFlacStemResolverWithSource({
      createWorker: () => worker, hardwareConcurrency: 2, locate: () => assert.fail("synthetic source must not locate"),
    }, () => ({
      prepare: item.effect,
      read: () => Effect.die("unexpected read"),
      finish: Effect.void,
    }));
    const result = await resolver.resolve(IDENTITY);
    await assert.rejects(result.stream.getReader().read(), (error: unknown) => {
      assert.ok(error instanceof EngineWebAdapterError);
      assert.match(error.message, new RegExp(item.message.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      if (item.message !== "FLAC decoder input lane failed") {
        assert.equal(error.details.operation, "prepare");
      }
      assert.ok(error.cause instanceof AggregateError);
      return true;
    });
  }
});

test("cyclic progress failures still settle the public stream and terminate the Worker", async () => {
  const source = singleFrameFlac();
  const worker = new FakeWorker();
  const cyclic = new AggregateError([], "cyclic progress failure");
  cyclic.errors.push(cyclic);
  const resolver = createFlacStemResolver({
    createWorker: () => worker, maximumAttempts: 1, locate: () => "https://caller.invalid/stem",
    fetch: responseFetch(request => {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range!)!;
      return exactResponse(source, Number(match[1]), Number(match[2]));
    }),
  });
  const result = await resolver.resolve(IDENTITY, {
    onProgress: progress => { if (progress.stage === "probing") throw cyclic; },
  });
  await assert.rejects(result.stream.getReader().read(), (error: unknown) => {
    assert.ok(error instanceof EngineWebAdapterError);
    assert.equal(error.code, "stem.decode.worker");
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors.includes(cyclic), true);
    return true;
  });
  assert.equal(worker.terminated, true);
});

test("input lane cancellation settles pending prepare, read, and finish without late publication", async () => {
  const waitFor = async (predicate: () => boolean) => {
    for (let index = 0; index < 100 && !predicate(); index += 1) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(predicate(), true);
  };

  {
    const abort = new AbortController();
    let prepareStarted = false;
    let initialized = false;
    const worker = new ScriptedWorker(() => {});
    const gate = deferred<{ readonly streamInfo: ReturnType<typeof syntheticStreamInfo>; readonly expectedFrames: number; readonly totalPcmBytes: number }>();
    const resolver = createFlacStemResolverWithSource({
      createWorker: () => worker, hardwareConcurrency: 2, locate: () => assert.fail("synthetic source must not locate"),
    }, () => ({
      prepare: Effect.promise(() => { prepareStarted = true; return gate.promise; }),
      read: () => Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }),
      finish: Effect.sync(() => {}),
    }));
    const resolved = await resolver.resolve(IDENTITY, { signal: abort.signal });
    const reading = resolved.stream.getReader().read();
    await waitFor(() => prepareStarted);
    initialized = worker.posted.some(message => message.type === "initialize");
    abort.abort("cancel prepare");
    await assert.rejects(reading, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
    assert.equal(initialized, false);
    assert.equal(worker.terminated, true);
  }

  {
    const abort = new AbortController();
    let readStarted = false;
    const worker = new ScriptedWorker((physical, requestId) => {
      physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
    });
    const gate = deferred<{ readonly bytes: Uint8Array; readonly end: boolean; readonly release: () => void }>();
    const cleanupFailure = new Error("read cleanup sentinel");
    const resolver = createFlacStemResolverWithSource({
      createWorker: () => worker, hardwareConcurrency: 2, locate: () => assert.fail("synthetic source must not locate"),
    }, () => syntheticSource({
      read: () => Effect.acquireUseRelease(
        Effect.sync(() => { readStarted = true; }),
        () => Effect.promise(() => gate.promise),
        () => Effect.fail(new DecoderByteSourceError({ operation: "read", message: "read cleanup failed", cause: cleanupFailure })),
      ),
      finish: Effect.sync(() => {}),
    }));
    const resolved = await resolver.resolve(IDENTITY, { signal: abort.signal });
    const reading = resolved.stream.getReader().read();
    await waitFor(() => readStarted);
    abort.abort("cancel read");
    await assert.rejects(reading, (error: unknown) => {
      assert.ok(error instanceof EngineWebAdapterError);
      assert.equal(error.code, "stem.cancelled");
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.includes(cleanupFailure), true);
      return true;
    });
    assert.equal(worker.terminated, true);
    assert.equal(worker.slotState.value, 3);
  }

  {
    const abort = new AbortController();
    let finishStarted = false;
    const finishGate = deferred<void>();
    const worker = new ScriptedWorker((physical, requestId) => {
      physical.emit({ type: "input-credit", requestId, maximumBytes: 1, phase: "audio", phaseBytesRemaining: 0 });
      queueMicrotask(() => {
        physical.emit({ type: "pcm", requestId, bytes: new Uint8Array([9, 8, 7, 6]).buffer, frames: 1, totalPcmBytes: 4 });
        physical.emit({ type: "complete", requestId, pcmBytes: 4, frames: 1 });
      });
    });
    const resolver = createFlacStemResolverWithSource({
      createWorker: () => worker, hardwareConcurrency: 2, decodeNoProgressMs: 100,
      locate: () => assert.fail("synthetic source must not locate"),
    }, () => syntheticSource({
      read: () => Effect.succeed({ bytes: new Uint8Array([1]), end: true, release() {} }),
      finish: Effect.promise(() => { finishStarted = true; return finishGate.promise; }),
    }));
    const reader = (await resolver.resolve(IDENTITY, { signal: abort.signal })).stream.getReader();
    assert.deepEqual([...(await reader.read()).value ?? []], [9, 8, 7, 6]);
    const ending = reader.read();
    await waitFor(() => finishStarted);
    abort.abort("cancel finish");
    await assert.rejects(ending, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
    assert.equal(worker.terminated, true);
  }
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
  const identity = identityFor(pcm);
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
    const identity = identityFor(pcm);
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


test("synchronous probe-completion cancellation releases the range before any resolver handoff", async () => {
  const source = singleFrameFlac();
  const worker = new FakeWorker();
  const diagnostics = createIngestDiagnostics();
  const abort = new AbortController();
  const resolver = createFlacStemResolver({
    createWorker: () => worker, locate: () => "https://caller.invalid/stem",
    fetch: responseFetch(request => {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range!)!;
      return exactResponse(source, Number(match[1]), Number(match[2]));
    }),
  });
  const backend = new MemoryStemStorageBackend();
  let ready = false;
  await assert.rejects(new VerifiedStemStore({ backend }).openSession({
    leaseId: "cancel-probe-completion", stems: [{ sourceId: "source", identity: IDENTITY, bytes: 4 }],
    resolver, ingestDiagnostics: diagnostics, signal: abort.signal,
    onProgress: event => {
      if (event.stage === "ready") ready = true;
      if (event.stage === "probing") {
        assert.equal(diagnostics.snapshot().residency!.deliveredBytes, 42);
        abort.abort("cancel in range completion callback");
      }
    },
  }), { code: "stem.cancelled" });
  assert.deepEqual(diagnostics.snapshot().residency, {
    limit: 1, deliveredBytes: 0, deliveredPeakBytes: 42, decodedBytes: 0, decodedPeakBytes: 0,
    containers: 0, containersPeak: 1, active: 0, activePeak: 1,
  });
  assert.equal(ready, false);
  assert.equal(worker.terminated, true);
  assert.equal(worker.posted.some(message => message.type === "initialize"), false);
  assert.equal([...backend.files.keys()].some(name => name.startsWith("staging-") || name.startsWith("blake3-")), false);
});

test("eight processing slots make progress beyond the store deadline while queued behind two downloads", async () => {
  const source = singleFrameFlac();
  putU64(source, 18, (44_100n << 44n) | (1n << 41n) | (15n << 36n) | 1n);
  const pcms = Array.from({ length: 12 }, (_, index) => new Uint8Array([9, 8, 7, index]));
  const stems = pcms.map((pcm, index) => ({ sourceId: String(index), bytes: 4,
    identity: identityFor(pcm) }));
  const lookup = new Map(stems.map((stem, index) => [stem.identity, pcms[index]!]));
  class DistinctWorker extends FakeWorker {
    identity = IDENTITY as string;
    override postMessage(message: FlacWorkerRequest): void {
      if (message.type === "start") this.identity = message.identity;
      super.postMessage(message);
    }
    override emit(message: FlacWorkerResponse): void {
      if (message.type === "pcm") message = { ...message, bytes: lookup.get(this.identity as typeof IDENTITY)!.slice().buffer };
      super.emit(message);
    }
  }
  const admission = new BoundedStemAdmission(8);
  let activeBodies = 0;
  let bodyPeak = 0;
  const resolver = createFlacStemResolver({
    admission, hardwareConcurrency: 32, deviceMemory: 8, memoryBudgetBytes: 16 * 1024 * 1024,
    processing: { maximumWorkers: 8 }, createWorker: () => new DistinctWorker(),
    decodeNoProgressMs: 20, readDeadlineMs: 200, maximumAttempts: 1,
    locate: () => "https://caller.invalid/queued",
    fetch: async (_input, init) => {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(new Headers(init?.headers).get("range")!)!;
      const start = Number(match[1]); const end = Number(match[2]);
      activeBodies += 1; bodyPeak = Math.max(bodyPeak, activeBodies);
      return new Response(new ReadableStream({ start(controller) {
        setTimeout(() => { activeBodies -= 1; controller.enqueue(source.slice(start, end + 1)); controller.close(); }, 30);
      } }), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${source.length}`, "Content-Length": String(end - start + 1) } });
    },
  });
  const diagnostics = createIngestDiagnostics();
  const store = new VerifiedStemStore({ backend: new MemoryStemStorageBackend(), readDeadlineMs: 20 });
  const lease = await store.openSession({ leaseId: "eight", stems: stems.slice(0, 8), resolver, ingestDiagnostics: diagnostics });
  assert.equal(bodyPeak, 2);
  assert.equal(diagnostics.snapshot().processing!.workers.peak, 8);
  assert.equal(diagnostics.snapshot().processing!.downloads.peak, 2);
  assert.ok(diagnostics.snapshot().processing!.downloadQueue.milliseconds > 20);
  for (let index = 0; index < 8; index++) assert.deepEqual(new Uint8Array(await (await lease.read(stems[index]!.identity)).arrayBuffer()), pcms[index]);
  await lease.close();
  assert.equal(diagnostics.snapshot().residency!.decodedBytes, 0);
  assert.equal(diagnostics.snapshot().processing!.downloads.active, 0);
  assert.equal(diagnostics.snapshot().processing!.downloadQueue.active, 0);
  assert.equal(diagnostics.snapshot().processing!.workers.active, 0);
  const mixedDiagnostics = createIngestDiagnostics();
  const mixed = await store.openSession({ leaseId: "mixed", stems: [...stems.slice(0, 4), ...stems.slice(8)], resolver,
    ingestDiagnostics: mixedDiagnostics });
  assert.equal(mixedDiagnostics.snapshot().processing!.workers.count, 4, "only uncached members decode");
  assert.ok(mixedDiagnostics.snapshot().processing!.verification.peak <= 2);
  for (const index of [0, 1, 2, 3, 8, 9, 10, 11]) assert.deepEqual(new Uint8Array(await (await mixed.read(stems[index]!.identity)).arrayBuffer()), pcms[index]);
  await mixed.close();
  assert.equal(mixedDiagnostics.snapshot().processing!.workers.active, 0);
  assert.equal(mixedDiagnostics.snapshot().processing!.verification.active, 0);
});

test("custom Worker digest claims cannot bypass canonical store hashing and completion checks", async () => {
  const source = singleFrameFlac();
  putU64(source, 18, (44_100n << 44n) | (1n << 41n) | (15n << 36n) | 1n);
  const pcm = new Uint8Array([9, 8, 7, 6]);
  const identity = identityFor(pcm);
  for (const problem of ["mutated-output", "early-complete", "wrong-count", "cancel-before-promotion"] as const) {
    class ForgingWorker extends FakeWorker {
      override emit(message: FlacWorkerResponse): void {
        if (message.type === "pcm" && problem === "early-complete") return;
        if (message.type === "pcm" && problem === "mutated-output") new Uint8Array(message.bytes)[0] = 0;
        if (message.type === "complete") message = { ...message, digest: identity.slice(7),
          ...(problem === "wrong-count" ? { pcmBytes: 3 } : {}) };
        super.emit(message);
      }
    }
    const backend = new MemoryStemStorageBackend();
    const abort = new AbortController();
    const resolver = createFlacStemResolver({ hardwareConcurrency: 2, processing: {}, createWorker: () => new ForgingWorker(),
      locate: () => "https://caller.invalid/forged",
      fetch: responseFetch(request => { const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range!)!;
        return exactResponse(source, Number(match[1]), Number(match[2])); }),
    });
    await assert.rejects(new VerifiedStemStore({ backend }).openSession({
      leaseId: problem, stems: [{ sourceId: "source", identity, bytes: 4 }], resolver, signal: abort.signal,
      onProgress: event => { if (problem === "cancel-before-promotion" && event.stage === "ingesting") abort.abort(problem); },
    }), error => error instanceof EngineWebAdapterError && error.code === (problem === "cancel-before-promotion" ? "stem.cancelled" : "stem.corrupt"));
    assert.equal([...backend.files.keys()].some(name => name.startsWith("staging-") || name.startsWith("blake3-")), false);
  }
});

test("resolver snapshots mutable factories and URL assets before lazy Worker construction", async () => {
  const source = singleFrameFlac();
  const worker = new FakeWorker();
  const wasm = new URL("https://caller.invalid/original.wasm");
  const assets = { flacDecoderWasmUrl: wasm, createWorker: () => worker as unknown as Worker };
  const options = { hardwareConcurrency: 2, assets, locate: () => "https://caller.invalid/snapshot",
    fetch: responseFetch(request => { const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range!)!;
      return exactResponse(source, Number(match[1]), Number(match[2])); }),
  };
  const resolver = createFlacStemResolver(options);
  wasm.pathname = "/changed.wasm";
  assets.createWorker = () => assert.fail("changed factory selected");
  const reader = (await resolver.resolve(IDENTITY)).stream.getReader();
  while (!(await reader.read()).done) { /* drain */ }
  const start = worker.posted.find((message): message is Extract<FlacWorkerRequest, { type: "start" }> => message.type === "start")!;
  assert.equal(start.decoderWasmUrl, "https://caller.invalid/original.wasm");
  assert.equal(start.verifyPcm, false);
});
