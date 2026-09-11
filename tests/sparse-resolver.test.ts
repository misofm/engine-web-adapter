import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import { serializeSparseStemIndex, MemoryStemStorageBackend, VerifiedSparsePcmStore, createSparseStemResolver } from "../src/stems/index.js";
import type { FlacWorkerLike, FlacWorkerRequest, FlacWorkerResponse } from "../src/stems/flac-worker-protocol.js";
import type { SparsePcmExpectation } from "../src/stems/sparse-store.js";

const ZERO_IDENTITY = `sha256:${createHash("sha256").update(new Uint8Array(4096)).digest("hex")}` as const;

function responseBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function responseWithByobTerminal(
  result: ReadableStreamReadResult<Uint8Array>,
): Response {
  const response = new Response(null, { status: 200 });
  let reads = 0;
  const body = {
    locked: false,
    getReader(options?: { readonly mode?: "byob" }) {
      if (options?.mode !== "byob") throw new TypeError("BYOB reader required");
      return {
        async read(_view: Uint8Array) { reads += 1; return reads === 1 ? result : { done: true, value: new Uint8Array() }; },
        async cancel() {},
        releaseLock() {},
      };
    },
  };
  Object.defineProperty(response, "body", { value: body });
  return response;
}

class DecodeWorker implements FlacWorkerLike {
  readonly posted: FlacWorkerRequest[] = [];
  terminated = false;
  #slot: Extract<FlacWorkerRequest, { type: "start" }>['inputSlot'] | undefined;
  #listeners = new Set<(event: { readonly data: FlacWorkerResponse }) => void>();

  postMessage(message: FlacWorkerRequest): void {
    if (this.terminated) return;
    this.posted.push(message);
    if (message.type === "start") {
      this.#slot = message.inputSlot;
      setTimeout(() => this.emit({ type: "ready", requestId: message.requestId }), 0);
    } else if (message.type === "initialize") {
      setTimeout(() => this.emit({ type: "input-credit", requestId: message.requestId, maximumBytes: 256 * 1024, phase: "audio", phaseBytesRemaining: 0 }), 0);
      setTimeout(() => this.poll(message.requestId, message.expectedFrames, message.totalPcmBytes), 0);
    }
  }

  terminate(): void { this.terminated = true; }
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    if (type === "message") this.#listeners.add(listener);
  }
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    if (type === "message") this.#listeners.delete(listener);
  }
  emit(message: FlacWorkerResponse): void { for (const listener of this.#listeners) listener({ data: message }); }
  private poll(requestId: number, frames: number, pcmBytes: number): void {
    if (this.terminated || this.#slot === undefined) return;
    const control = new Int32Array(this.#slot.control);
    if (Atomics.load(control, 0) !== 1) {
      setTimeout(() => this.poll(requestId, frames, pcmBytes), 0);
      return;
    }
    const final = Atomics.load(control, 3) === 1;
    Atomics.store(control, 0, 0);
    if (!final) {
      setTimeout(() => this.emit({ type: "input-credit", requestId, maximumBytes: 256 * 1024, phase: "audio", phaseBytesRemaining: 0 }), 0);
      setTimeout(() => this.poll(requestId, frames, pcmBytes), 0);
      return;
    }
    this.emit({ type: "pcm", requestId, bytes: new ArrayBuffer(pcmBytes), frames, totalPcmBytes: pcmBytes });
    this.emit({ type: "complete", requestId, pcmBytes, frames });
  }
}

function packageBody(flac: Uint8Array): { readonly body: Uint8Array; readonly expected: SparsePcmExpectation } {
  const expected = {
    identity: ZERO_IDENTITY,
    sampleRateHz: 48_000,
    channels: 1 as const,
    bitDepth: 16 as const,
    frames: 2_048,
    canonicalBytes: 4_096,
  };
  const manifest = {
    format: "miso_sparse_stem_v1" as const,
    identity: expected.identity,
    sampleRateHz: expected.sampleRateHz,
    channels: expected.channels,
    bitDepth: expected.bitDepth,
    frames: expected.frames,
    intervals: [{ startFrame: 0, frames: expected.frames, packedFrameOffset: 0 }],
    chunks: [{
      offset: 0,
      bytes: flac.byteLength,
      frames: expected.frames,
      packedStartFrame: 0,
      flacSha256: createHash("sha256").update(flac).digest("hex"),
      pcmSha256: createHash("sha256").update(new Uint8Array(expected.canonicalBytes)).digest("hex"),
    }],
  };
  const encoded = serializeSparseStemIndex(manifest);
  const header = new Uint8Array(16);
  header.set(new TextEncoder().encode("MISOSTM1"));
  new DataView(header.buffer).setUint32(8, encoded.byteLength, true);
  return { body: new Uint8Array([...header, ...encoded, ...flac]), expected };
}

function emptySilentPackage(): { readonly body: Uint8Array; readonly expected: SparsePcmExpectation } {
  const expected = {
    identity: ZERO_IDENTITY,
    sampleRateHz: 48_000,
    channels: 1 as const,
    bitDepth: 16 as const,
    frames: 2_048,
    canonicalBytes: 4_096,
  };
  const encoded = serializeSparseStemIndex({
    format: "miso_sparse_stem_v1" as const,
    identity: expected.identity,
    sampleRateHz: expected.sampleRateHz,
    channels: expected.channels,
    bitDepth: expected.bitDepth,
    frames: expected.frames,
    intervals: [],
    chunks: [],
  });
  const header = new Uint8Array(16);
  header.set(new TextEncoder().encode("MISOSTM1"));
  new DataView(header.buffer).setUint32(8, encoded.byteLength, true);
  return { body: new Uint8Array([...header, ...encoded]), expected };
}

async function expectFullResponseFailure(
  packed: { readonly body: Uint8Array; readonly expected: SparsePcmExpectation },
  response: () => Response,
  code: string,
  createWorker: () => FlacWorkerLike = () => { throw new Error("malformed all-silent source must not create a decoder worker"); },
): Promise<void> {
  let fetches = 0;
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/indexed",
    fetch: async () => { fetches += 1; return response(); },
    createWorker,
  });
  const resolved = await resolver(packed.expected, new AbortController().signal);
  const iterator = resolved.spans[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), (error: unknown) => error instanceof Error && "code" in error &&
    (error as { readonly code?: unknown }).code === code);
  assert.equal(fetches, 1);
}

test("full-response admission rejects malformed sections, headers, status and trailing bytes", async () => {
  const packed = emptySilentPackage();
  const manifestBytes = new DataView(packed.body.buffer, packed.body.byteOffset, packed.body.byteLength).getUint32(8, true);
  const cases: readonly { readonly response: () => Response; readonly code: string }[] = [
    { response: () => new Response(responseBytes(packed.body.slice(0, 8)), { status: 200 }), code: "stem.delivery.range" },
    { response: () => new Response(responseBytes(packed.body.slice(0, 16 + Math.floor(manifestBytes / 2))), { status: 200 }), code: "stem.delivery.range" },
    { response: () => new Response(responseBytes(packed.body), { status: 200, headers: { "Content-Length": "1" } }), code: "stem.delivery.http" },
    { response: () => new Response(responseBytes(packed.body), { status: 200, headers: { "Content-Length": "invalid" } }), code: "stem.delivery.http" },
    { response: () => new Response(responseBytes(packed.body), { status: 206 }), code: "stem.delivery.http" },
    { response: () => new Response(responseBytes(packed.body), { status: 200, headers: { "Content-Encoding": "gzip" } }), code: "stem.delivery.http" },
    { response: () => new Response(responseBytes(new Uint8Array([...packed.body, 0])), { status: 200 }), code: "stem.delivery.range" },
  ];
  for (const item of cases) await expectFullResponseFailure(packed, item.response, item.code);
});

test("finite FLAC metadata truncation refuses before the private chunk completes", async () => {
  const flac = new Uint8Array(readFileSync("tests/fixtures/native-silence.flac"));
  const packed = packageBody(flac);
  const manifestBytes = new DataView(packed.body.buffer, packed.body.byteOffset, packed.body.byteLength).getUint32(8, true);
  const metadataOnly = packed.body.slice(0, 16 + manifestBytes + 42);
  await expectFullResponseFailure(packed, () => new Response(metadataOnly, { status: 200 }), "stem.delivery.range", () => new DecodeWorker());
});

test("finite encoded extent and host digest remain mandatory after PCM output", async () => {
  const flac = new Uint8Array(readFileSync("tests/fixtures/native-silence.flac"));
  const packed = packageBody(flac);
  const mutated = packed.body.slice();
  mutated[mutated.length - 1]! ^= 1;
  let fetches = 0;
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/indexed",
    fetch: async () => { fetches += 1; return new Response(responseBytes(mutated), { status: 200 }); },
    createWorker: () => new DecodeWorker(),
  });
  const resolved = await resolver(packed.expected, new AbortController().signal);
  const iterator = resolved.spans[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  await assert.rejects(iterator.next(), (error: unknown) => error instanceof Error && "code" in error &&
    (error as { readonly code?: unknown }).code === "stem.decode.worker");
  assert.equal(fetches, 1);
});

test("a missing Content-Length and a default reader with a large backing remain valid", async () => {
  const packed = emptySilentPackage();
  let fetches = 0;
  const backing = new Uint8Array(2 * 1024 * 1024);
  backing.set(packed.body);
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/indexed",
    fetch: async () => {
      fetches += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(backing.buffer, 0, packed.body.byteLength));
          controller.close();
        },
      }), { status: 200 });
    },
    createWorker: () => { throw new Error("all-silent source must not create a decoder worker"); },
  });
  const resolved = await resolver(packed.expected, new AbortController().signal);
  const result = await resolved.spans[Symbol.asyncIterator]().next();
  assert.equal(result.done, true);
  assert.equal(fetches, 1);
});

test("a later BYOB read failure is terminal and never retries with a default reader", async () => {
  const packed = emptySilentPackage();
  let pulls = 0;
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/indexed",
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      type: "bytes",
      pull(controller) {
        pulls += 1;
        controller.error(new Error("BYOB read sentinel"));
      },
    }), { status: 200 }),
    createWorker: () => { throw new Error("failed source must not create a decoder worker"); },
  });
  const resolved = await resolver(packed.expected, new AbortController().signal);
  await assert.rejects(resolved.spans[Symbol.asyncIterator]().next(), (error: unknown) => error instanceof Error && "code" in error &&
    (error as { readonly code?: unknown }).code === "stem.delivery.http");
  assert.equal(pulls, 1);
});

test("BYOB terminal nonempty views are consumed, while undefined termination refuses", async () => {
  const packed = emptySilentPackage();
  const nonemptyResolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/indexed",
    fetch: async () => responseWithByobTerminal({ done: true, value: new Uint8Array(packed.body) }),
    createWorker: () => { throw new Error("all-silent source must not create a decoder worker"); },
  });
  const resolved = await nonemptyResolver(packed.expected, new AbortController().signal);
  assert.equal((await resolved.spans[Symbol.asyncIterator]().next()).done, true);

  const undefinedResolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/indexed",
    fetch: async () => responseWithByobTerminal({ done: true, value: undefined }),
    createWorker: () => { throw new Error("undefined BYOB termination must not create a decoder worker"); },
  });
  const undefinedResolved = await undefinedResolver(packed.expected, new AbortController().signal);
  await assert.rejects(undefinedResolved.spans[Symbol.asyncIterator]().next(), (error: unknown) => error instanceof Error && "code" in error &&
    (error as { readonly code?: unknown }).code === "stem.delivery.range");
});

test("a real byte response can install an all-silent sparse source without a decoder worker", async () => {
  const packed = emptySilentPackage();
  const backend = new MemoryStemStorageBackend();
  const store = new VerifiedSparsePcmStore({ backend, instanceId: "sparse-byte-eof" });
  let requests = 0;
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/silent",
    fetch: async () => {
      requests += 1;
      return new Response(packed.body.buffer as ArrayBuffer, { status: 200, headers: { "Content-Length": String(packed.body.byteLength) } });
    },
    createWorker: () => { throw new Error("all-silent source must not create a decoder worker"); },
  });
  const result = await store.installSource(packed.expected, { resolve: signal => resolver(packed.expected, signal) });
  assert.equal(requests, 1);
  assert.equal(result.data.size, 0);
  assert.equal(result.index.activeBytes, 0);
  assert.equal(result.index.canonicalBytes, packed.expected.canonicalBytes);
  await store.close();
});

test("sparse full GET installs an actual FLAC payload cold and resolves warm without transport or workers", async () => {
  const flac = new Uint8Array(readFileSync("tests/fixtures/native-silence.flac"));
  const packed = packageBody(flac);
  const backend = new MemoryStemStorageBackend();
  const store = new VerifiedSparsePcmStore({ backend, instanceId: "sparse-full-get" });
  let fetches = 0;
  let workers = 0;
  let locates = 0;
  const resolver = createSparseStemResolver({
    locate(identity, { signal }) {
      locates += 1;
      assert.equal(identity, packed.expected.identity);
      assert.equal(signal.aborted, false);
      return new Request("https://caller.invalid/full-stem", {
        headers: { Authorization: "Bearer caller", Range: "bytes=wrong", "If-Range": "wrong" },
      });
    },
    fetch: async (_input, init) => {
      fetches += 1;
      assert.equal(new Headers(init?.headers).get("Range"), null);
      assert.equal(new Headers(init?.headers).get("If-Range"), null);
      const pieces = [packed.body.slice(0, 7), packed.body.slice(7, 53), packed.body.slice(53)];
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const piece = pieces.shift();
          if (piece === undefined) controller.close(); else controller.enqueue(piece);
        },
      }), { status: 200, headers: { "Content-Length": String(packed.body.byteLength) } });
    },
    createWorker: () => { workers += 1; return new DecodeWorker(); },
    hardwareConcurrency: 2,
  });
  const cold = await store.installSource(packed.expected, { resolve: signal => resolver(packed.expected, signal) });
  assert.equal(cold.data.size, packed.expected.canonicalBytes);
  assert.equal(cold.index.activeBytes, packed.expected.canonicalBytes);
  assert.equal(fetches, 1);
  assert.equal(locates, 1);
  assert.equal(workers, 1);

  let warmResolverCalls = 0;
  const warm = await store.installSource(packed.expected, {
    resolve: async () => { warmResolverCalls += 1; throw new Error("warm sparse resolver must not run"); },
  });
  assert.equal(warmResolverCalls, 0);
  assert.equal(warm.data.size, packed.expected.canonicalBytes);
  assert.equal(fetches, 1);
  assert.equal(locates, 1);
  assert.equal(workers, 1);
  await store.close();
});

test("a locator Request abort composes with the resolver signal during the one full response", async () => {
  const flac = new Uint8Array(readFileSync("tests/fixtures/native-silence.flac"));
  const packed = packageBody(flac);
  const requestAbort = new AbortController();
  let fetchSignal: AbortSignal | undefined;
  let workers = 0;
  const resolver = createSparseStemResolver({
    locate: () => new Request("https://caller.invalid/full-stem", { signal: requestAbort.signal }),
    fetch: async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      let cancelled = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              if (!cancelled) { controller.enqueue(packed.body); controller.close(); }
              resolve();
            }, 100);
          });
        },
        cancel() { cancelled = true; },
      }), { status: 200 });
    },
    createWorker: () => { workers += 1; return new DecodeWorker(); },
    hardwareConcurrency: 2,
  });
  const resolved = await resolver(packed.expected, new AbortController().signal);
  const next = resolved.spans[Symbol.asyncIterator]().next();
  setTimeout(() => requestAbort.abort(new Error("caller stopped")), 5);
  await assert.rejects(next, (error: unknown) => error instanceof Error && "code" in error && (error as { readonly code?: unknown }).code === "stem.cancelled");
  assert.equal(workers, 0);
  assert.equal(fetchSignal?.aborted, true);
});
