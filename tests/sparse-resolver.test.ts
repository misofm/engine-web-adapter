import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import { serializeSparseStemIndex, MemoryStemStorageBackend, VerifiedSparsePcmStore, createSparseStemResolver } from "../src/stems/index.js";
import type { FlacWorkerLike, FlacWorkerRequest, FlacWorkerResponse } from "../src/stems/flac-worker-protocol.js";
import type { SparsePcmExpectation } from "../src/stems/sparse-store.js";

const ZERO_IDENTITY = `sha256:${createHash("sha256").update(new Uint8Array(4096)).digest("hex")}` as const;

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
