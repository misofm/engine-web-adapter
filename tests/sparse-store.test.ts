import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { createBLAKE3 } from "hash-wasm";

import { EngineWebAdapterError } from "../src/errors.js";
import {
  MemoryStemStorageBackend,
  MemoryStemResolver,
  OpfsStorageBackend,
  VerifiedSparsePcmStore,
  VerifiedStemStore,
  createSparseStemResolver,
  serializeSparseStemIndex,
  validateSparsePcmIndex,
  type SparsePcmExpectation,
} from "../src/stems/index.js";
import { acquireNamedLock } from "../src/stems/lock.js";
import { registerSparseResolver } from "../src/stems/sparse-scheduling.js";
import { sparseSourceProgramForTest } from "../src/stems/sparse-store.js";

const identityHasher = await createBLAKE3(256);

function expectation(bytes: Uint8Array, frames: number, shape: { readonly channels?: 1 | 2; readonly bitDepth?: 16 | 24 } = {}): SparsePcmExpectation {
  const channels = shape.channels ?? 1;
  const bitDepth = shape.bitDepth ?? 16;
  return {
    identity: `blake3:${identityHasher.init().update(bytes).digest("hex")}`,
    sampleRateHz: 48_000,
    channels,
    bitDepth,
    frames,
    canonicalBytes: frames * channels * (bitDepth / 8),
  };
}

function spans(...items: readonly { readonly startFrame: number; readonly bytes: Uint8Array }[]): AsyncIterable<{ readonly startFrame: number; readonly bytes: Uint8Array }> {
  return (async function*() { for (const item of items) yield item; })();
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function emptySparsePackage(expected: SparsePcmExpectation): Uint8Array {
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
  return new Uint8Array([...header, ...encoded]);
}

function responseBody(bytes: Uint8Array | undefined): ArrayBuffer {
  if (bytes === undefined) throw new Error("missing sparse package fixture");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

interface PayloadReadObservation {
  readonly start: number;
  readonly end: number;
  readonly returned: number;
  readonly bytes: Uint8Array;
}
type PayloadReadFault = (bytes: Uint8Array, start: number, end: number, readCount: number) => Uint8Array | Promise<Uint8Array>;

class RecordingPayloadBlob extends Blob {
  constructor(
    source: Blob,
    private readonly observations: PayloadReadObservation[],
    private readonly fault: PayloadReadFault | undefined,
    private readonly requestStart = 0,
    private readonly requestEnd = source.size,
  ) {
    super([source]);
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    return new RecordingPayloadBlob(
      super.slice(start, end, contentType),
      this.observations,
      this.fault,
      start ?? 0,
      end ?? this.size,
    );
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    const source = new Uint8Array(await super.arrayBuffer());
    const bytes = this.fault === undefined
      ? source
      : await this.fault(source, this.requestStart, this.requestEnd, this.observations.length);
    const snapshot = bytes.slice();
    this.observations.push({ start: this.requestStart, end: this.requestEnd, returned: snapshot.byteLength, bytes: snapshot });
    return snapshot.buffer;
  }
}

class RecordingPayloadBackend extends MemoryStemStorageBackend {
  readonly payloadReads: PayloadReadObservation[] = [];
  recording = false;
  fault: PayloadReadFault | undefined;

  override async read(name: string): Promise<Blob> {
    const blob = await super.read(name);
    if (!this.recording || !name.startsWith("sparse-pcm-v1-data-")) return blob;
    return new RecordingPayloadBlob(blob, this.payloadReads, this.fault);
  }
}

interface WarmYieldProbe {
  hold: boolean;
  failPost?: boolean;
  closeThrows?: boolean;
  constructed: number;
  posts: number;
  closes: number;
  listeners: number;
  held: Array<() => void>;
}

class ProbeWarmMessagePort {
  #handler: ((event: MessageEvent<unknown>) => void) | null = null;
  peer!: ProbeWarmMessagePort;

  constructor(private readonly probe: WarmYieldProbe) {}

  get onmessage(): ((event: MessageEvent<unknown>) => void) | null { return this.#handler; }
  set onmessage(handler: ((event: MessageEvent<unknown>) => void) | null) {
    if (this.#handler === null && handler !== null) this.probe.listeners += 1;
    if (this.#handler !== null && handler === null) this.probe.listeners -= 1;
    this.#handler = handler;
  }
  postMessage(_message: unknown): void {
    this.probe.posts += 1;
    if (this.probe.failPost === true) throw new Error("warm task post failed");
    const handler = this.peer.#handler;
    if (handler === null) return;
    const deliver = () => handler({ data: null } as MessageEvent<unknown>);
    if (this.probe.hold) this.probe.held.push(deliver); else queueMicrotask(deliver);
  }
  close(): void {
    this.probe.closes += 1;
    if (this.probe.closeThrows === true) throw new Error("warm task close failed");
  }
}

class ProbeWarmMessageChannel {
  static probe: WarmYieldProbe;
  readonly port1: ProbeWarmMessagePort;
  readonly port2: ProbeWarmMessagePort;

  constructor() {
    const probe = ProbeWarmMessageChannel.probe;
    probe.constructed += 1;
    this.port1 = new ProbeWarmMessagePort(probe);
    this.port2 = new ProbeWarmMessagePort(probe);
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

function warmYieldFixture(): { readonly canonical: Uint8Array; readonly expected: SparsePcmExpectation; readonly spans: readonly { readonly startFrame: number; readonly bytes: Uint8Array }[] } {
  const frameBytes = 2;
  const gapFrames = (64 * 1024) / frameBytes;
  const first = { startFrame: 1, bytes: new Uint8Array([1, 2]) };
  const second = { startFrame: first.startFrame + 1 + gapFrames, bytes: new Uint8Array([3, 4]) };
  const frames = second.startFrame + 1 + gapFrames + 1;
  const canonical = new Uint8Array(frames * frameBytes);
  canonical.set(first.bytes, first.startFrame * frameBytes);
  canonical.set(second.bytes, second.startFrame * frameBytes);
  return { canonical, expected: expectation(canonical, frames), spans: [first, second] };
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function largeWarmFixture(): {
  readonly canonical: Uint8Array;
  readonly expected: SparsePcmExpectation;
  readonly spans: readonly { readonly startFrame: number; readonly bytes: Uint8Array }[];
  readonly intervals: readonly { readonly startFrame: number; readonly frames: number }[];
} {
  const frameBytes = 6;
  const first = { startFrame: 3, frames: 200_001 } as const;
  const second = { startFrame: first.startFrame + first.frames + 7, frames: 100_001 } as const;
  const frames = second.startFrame + second.frames + 5;
  const canonical = new Uint8Array(frames * frameBytes);
  for (const interval of [first, second]) {
    const start = interval.startFrame * frameBytes;
    const end = (interval.startFrame + interval.frames) * frameBytes;
    for (let index = start; index < end; index += 1) canonical[index] = (index * 17 + 13) % 251 + 1;
  }
  const expected = expectation(canonical, frames, { channels: 2, bitDepth: 24 });
  const maximumIngestFrames = Math.floor((128 * 1024) / frameBytes);
  const ingestSpans: { startFrame: number; bytes: Uint8Array }[] = [];
  for (const interval of [first, second]) {
    for (let startFrame = interval.startFrame; startFrame < interval.startFrame + interval.frames;) {
      const spanFrames = Math.min(maximumIngestFrames, interval.startFrame + interval.frames - startFrame);
      ingestSpans.push({ startFrame, bytes: canonical.slice(startFrame * frameBytes, (startFrame + spanFrames) * frameBytes) });
      startFrame += spanFrames;
    }
  }
  return { canonical, expected, spans: ingestSpans, intervals: [first, second] };
}

async function primeLargeWarmStore(backend: RecordingPayloadBackend, instanceId: string): Promise<ReturnType<typeof largeWarmFixture> & { readonly store: VerifiedSparsePcmStore }> {
  const fixture = largeWarmFixture();
  const store = new VerifiedSparsePcmStore({ backend, instanceId });
  await store.installSource(fixture.expected, { resolve: async () => ({ spans: spans(...fixture.spans) }) });
  backend.payloadReads.length = 0;
  backend.recording = true;
  return { ...fixture, store };
}

describe("VerifiedSparsePcmStore", () => {
  it("commits all-silent and all-active canonical sources, then opens warm without resolving", async () => {
    const silentBytes = new Uint8Array(12);
    const silentExpected = expectation(silentBytes, 6);
    const silentBackend = new MemoryStemStorageBackend();
    const silentStore = new VerifiedSparsePcmStore({ backend: silentBackend, instanceId: "silent" });
    let silentResolve = 0;
    const silent = await silentStore.installSource(silentExpected, {
      resolve: async () => { silentResolve += 1; return { spans: spans() }; },
    });
    assert.equal(silent.data.size, 0);
    assert.equal(silent.index.activeBytes, 0);
    await silentStore.installSource(silentExpected, {
      resolve: async () => { throw new Error("warm resolver called"); },
    });
    assert.equal(silentResolve, 1);

    const activeBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const activeExpected = expectation(activeBytes, 4);
    const activeBackend = new MemoryStemStorageBackend();
    const activeStore = new VerifiedSparsePcmStore({ backend: activeBackend, instanceId: "active" });
    const active = await activeStore.installSource(activeExpected, {
      resolve: async () => ({ spans: spans({ startFrame: 0, bytes: activeBytes.slice(0, 4) }, { startFrame: 2, bytes: activeBytes.slice(4) }) }),
    });
    assert.equal(active.data.size, activeExpected.canonicalBytes);
    assert.deepEqual(active.index.intervals, [{ startFrame: 0, frames: 4, byteOffset: 0 }]);
    assert.equal((await activeStore.openSource(activeExpected))?.data.size, 8);
  });

  it("hashes implicit leading/interior/trailing zeros and rejects tampered committed bytes", async () => {
    const canonical = new Uint8Array(20);
    canonical.set([1, 2, 3, 4], 4);
    canonical.set([5, 6, 7, 8], 16);
    const expected = expectation(canonical, 10);
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "gaps" });
    const descriptor = await store.installSource(expected, {
      resolve: async () => ({ spans: spans(
        { startFrame: 2, bytes: canonical.slice(4, 8) },
        { startFrame: 8, bytes: canonical.slice(16, 20) },
      ) }),
    });
    assert.equal(descriptor.data.size, 8);
    assert.deepEqual(descriptor.index.intervals, [
      { startFrame: 2, frames: 2, byteOffset: 0 },
      { startFrame: 8, frames: 2, byteOffset: 4 },
    ]);
    const payload = [...backend.files.keys()].find((name) => name.startsWith("sparse-pcm-v1-data-"));
    assert.ok(payload);
    const changed = backend.files.get(payload)!.slice();
    changed[0] = (changed[0] ?? 0) ^ 1;
    backend.files.set(payload, changed);
    await assert.rejects(store.openSource(expected), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "stem.corrupt");
  });

  it("rejects malformed spans and an upfront index that disagrees before publication", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const expected = expectation(bytes, 2);
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "bounds" });
    await assert.rejects(store.installSource(expected, {
      resolve: async () => ({ spans: spans({ startFrame: 0, bytes: new Uint8Array([1]) }) }),
    }));
    assert.equal((await backend.list()).length, 0);
    const asserted = validateSparsePcmIndex({
      format: "miso_sparse_pcm_v1",
      identity: expected.identity,
      sampleRateHz: expected.sampleRateHz,
      channels: expected.channels,
      bitDepth: expected.bitDepth,
      frames: expected.frames,
      intervals: [{ startFrame: 0, frames: 1, byteOffset: 0 }],
    }, 2);
    await assert.rejects(store.installSource(expected, {
      resolve: async () => ({ index: asserted, spans: spans({ startFrame: 0, bytes }) }),
    }));
    assert.equal((await backend.list()).length, 0);
  });

  it("shares the historical same-backend lock and invokes one cold resolver", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const expected = expectation(bytes, 2);
    const backend = new MemoryStemStorageBackend();
    const first = new VerifiedSparsePcmStore({ backend, instanceId: "one" });
    const second = new VerifiedSparsePcmStore({ backend, instanceId: "two" });
    let resolves = 0;
    const resolve = async () => {
      resolves += 1;
      await new Promise((done) => setTimeout(done, 5));
      return { spans: spans({ startFrame: 0, bytes }) };
    };
    const [left, right] = await Promise.all([
      first.installSource(expected, { resolve }),
      second.installSource(expected, { resolve }),
    ]);
    assert.equal(resolves, 1);
    assert.equal(left.data.size, right.data.size);
    assert.equal((await backend.list()).filter((name) => name.startsWith("sparse-pcm-v1-commit-")).length, 1);
  });

  it("keeps a dense store's index and payload usable beside sparse generations", async () => {
    const denseBytes = new Uint8Array([4, 3, 2, 1]);
    const denseExpected = expectation(denseBytes, 2);
    const backend = new MemoryStemStorageBackend();
    const dense = new VerifiedStemStore({ backend, instanceId: "dense" });
    await (await dense.openSession({
      leaseId: "dense-seed",
      stems: [{ sourceId: "dense", identity: denseExpected.identity, bytes: denseBytes.byteLength }],
      resolver: new MemoryStemResolver({ [denseExpected.identity]: denseBytes }),
    })).close();
    const indexBefore = backend.files.get("index.json")!.slice();
    const sparseBytes = new Uint8Array([9, 8, 7, 6]);
    const sparseExpected = expectation(sparseBytes, 2);
    const sparse = new VerifiedSparsePcmStore({ backend, instanceId: "sparse" });
    await sparse.installSource(sparseExpected, { resolve: async () => ({ spans: spans({ startFrame: 0, bytes: sparseBytes }) }) });
    assert.deepEqual(backend.files.get("index.json"), indexBefore);
    assert.deepEqual(new Uint8Array(await (await dense.read(denseExpected.identity)).arrayBuffer()), denseBytes);
    await sparse.close();
  });

  it("removes owned data and marker when the marker close fails", async () => {
    class MarkerCloseFailureBackend extends MemoryStemStorageBackend {
      override async createWriter(name: string, signal?: AbortSignal) {
        const writer = await super.createWriter(name, signal);
        if (!name.startsWith("sparse-pcm-v1-commit-")) return writer;
        return {
          write: (chunk: Uint8Array | string) => writer.write(chunk),
          close: async () => { await writer.close(); throw new Error("marker close failed"); },
          abort: (reason?: unknown) => writer.abort(reason),
        };
      }
    }
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const backend = new MarkerCloseFailureBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "marker-failure" });
    await assert.rejects(store.installSource(expectation(bytes, 2), { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) }));
    assert.deepEqual(await backend.list(), []);
    await store.close();
  });

  it("removes a file created before a rejected data or marker create", async () => {
    class PartialCreateBackend extends MemoryStemStorageBackend {
      constructor(private readonly phase: "data" | "marker") { super(); }
      override async createWriter(name: string, signal?: AbortSignal) {
        const partial = this.phase === "data" ? name.startsWith("sparse-pcm-v1-data-") : name.startsWith("sparse-pcm-v1-commit-");
        if (partial) {
          this.files.set(name, new Uint8Array([7, 7]));
          throw new Error(`${this.phase} create failed after file creation`);
        }
        return super.createWriter(name, signal);
      }
    }
    const bytes = new Uint8Array([1, 2, 3, 4]);
    for (const phase of ["data", "marker"] as const) {
      const backend = new PartialCreateBackend(phase);
      const store = new VerifiedSparsePcmStore({ backend, instanceId: `partial-${phase}` });
      await assert.rejects(store.installSource(expectation(bytes, 2), { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) }));
      assert.deepEqual(await backend.list(), []);
      await store.close();
    }
  });

  it("does not publish when the cold payload handle has changed size", async () => {
    class WrongSizeReadBackend extends MemoryStemStorageBackend {
      constructor(private readonly delta: "short" | "extra") { super(); }
      override async read(name: string): Promise<Blob> {
        const blob = await super.read(name);
        if (!name.startsWith("sparse-pcm-v1-data-")) return blob;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const changed = this.delta === "short" ? bytes.slice(0, Math.max(0, bytes.byteLength - 1)) : new Uint8Array([...bytes, 99]);
        return new Blob([changed]);
      }
    }
    const bytes = new Uint8Array([1, 2, 3, 4]);
    for (const delta of ["short", "extra"] as const) {
      const backend = new WrongSizeReadBackend(delta);
      const store = new VerifiedSparsePcmStore({ backend, instanceId: `wrong-size-${delta}` });
      await assert.rejects(store.installSource(expectation(bytes, 2), { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) }));
      assert.deepEqual(await backend.list(), []);
      await store.close();
    }
  });

  it("retains owned output when cleanup itself fails", async () => {
    class CleanupFailureBackend extends MemoryStemStorageBackend {
      override async createWriter(name: string, signal?: AbortSignal) {
        const writer = await super.createWriter(name, signal);
        if (!name.startsWith("sparse-pcm-v1-commit-")) return writer;
        return { write: (chunk: Uint8Array | string) => writer.write(chunk), close: async () => { await writer.close(); throw new Error("marker close failed"); }, abort: (reason?: unknown) => writer.abort(reason) };
      }
      override async remove(name: string): Promise<void> {
        if (name.startsWith("sparse-pcm-v1-data-")) throw new Error("data removal failed");
        return super.remove(name);
      }
    }
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const backend = new CleanupFailureBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "cleanup-failure" });
    await assert.rejects(store.installSource(expectation(bytes, 2), { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) }));
    assert.ok((await backend.list()).some((name) => name.startsWith("sparse-pcm-v1-data-")));
    await store.close();
  });

  it("does not finish close until delayed create, write, and close settle physically", async () => {
    class DelayedWriterBackend extends MemoryStemStorageBackend {
      readonly gate = deferred();
      readonly entered = deferred();
      constructor(private readonly phase: "create" | "write" | "close") { super(); }
      override async createWriter(name: string, signal?: AbortSignal) {
        const writer = await super.createWriter(name, signal);
        const target = name.startsWith("sparse-pcm-v1-data-");
        if (!target) return writer;
        if (this.phase === "create") {
          this.entered.resolve();
          await this.gate.promise;
          return writer;
        }
        return {
          write: async (chunk: Uint8Array | string) => { if (this.phase === "write") { this.entered.resolve(); await this.gate.promise; } return writer.write(chunk); },
          close: async () => { if (this.phase === "close") { this.entered.resolve(); await this.gate.promise; } return writer.close(); },
          abort: (reason?: unknown) => writer.abort(reason),
        };
      }
    }
    const bytes = new Uint8Array([1, 2, 3, 4]);
    for (const phase of ["create", "write", "close"] as const) {
      const backend = new DelayedWriterBackend(phase);
      const store = new VerifiedSparsePcmStore({ backend, instanceId: `delayed-${phase}` });
      const installing = store.installSource(expectation(bytes, 2), { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) });
      await backend.entered.promise;
      let closed = false;
      const closing = store.close().then(() => { closed = true; });
      await Promise.resolve();
      assert.equal(closed, false);
      backend.gate.resolve();
      await closing;
      await assert.rejects(installing);
      assert.deepEqual(await backend.list(), []);
    }
  });

  it("uses the Effect clock for pending source progress and aborts before iterator return", async () => {
    const active = new Uint8Array([1, 2]);
    const canonical = new Uint8Array([1, 2, 0, 0]);
    const events: string[] = [];
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "source-timeout", readDeadlineMs: 5 });
    await assert.rejects(store.installSource(expectation(canonical, 2), {
      resolve: async (signal) => ({
        spans: {
          [Symbol.asyncIterator]: () => {
            let count = 0;
            return {
              next: () => {
                count += 1;
                if (count === 1) return Promise.resolve({ done: false as const, value: { startFrame: 0, bytes: active } });
                return new Promise<IteratorResult<{ readonly startFrame: number; readonly bytes: Uint8Array }>>((resolve) => {
                  signal.addEventListener("abort", () => { events.push("abort"); resolve({ done: true, value: undefined }); }, { once: true });
                });
              },
              return: async () => { events.push("return"); return { done: true, value: undefined }; },
            };
          },
        },
      }),
    }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.read_deadline");
    assert.deepEqual(events, ["abort", "return"]);
    assert.deepEqual(await backend.list(), []);
    await store.close();
  });

  it("proves source progress timeout with the injected TestClock layer", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const source: AsyncIterable<{ readonly startFrame: number; readonly bytes: Uint8Array }> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<{ readonly startFrame: number; readonly bytes: Uint8Array }>>((resolve) => {
          controller.signal.addEventListener("abort", () => { events.push("abort"); resolve({ done: true, value: undefined }); }, { once: true });
        }),
        return: async () => { events.push("return"); return { done: true, value: undefined }; },
      }),
    };
    const program = Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(sparseSourceProgramForTest(source, controller, 100));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      return yield* Fiber.await(fiber);
    });
    const exit = await Effect.runPromise(Effect.provide(program, TestClock.layer()));
    assert.equal(Exit.isFailure(exit), true);
    assert.deepEqual(events, ["abort", "return"]);
  });

  it("rejects before writing when the exact sparse generation cannot fit quota", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const backend = new MemoryStemStorageBackend({ quotaBytes: bytes.byteLength });
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "quota" });
    await assert.rejects(store.installSource(expectation(bytes, 2), { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.quota");
    assert.deepEqual(await backend.list(), []);
    await store.close();
  });

  it("uses reported physical usage without double-counting prior active writes", async () => {
    class PhysicalUsageBackend extends MemoryStemStorageBackend {
      private pendingBytes = 0;
      constructor(private readonly quota: number) { super(); }
      override async estimate(): Promise<{ readonly quota?: number; readonly usage?: number }> {
        const estimate = await super.estimate();
        return { quota: this.quota, usage: (estimate.usage ?? 0) + this.pendingBytes };
      }
      override async createWriter(name: string, signal?: AbortSignal) {
        const writer = await super.createWriter(name, signal);
        if (!name.startsWith("sparse-pcm-v1-data-")) return writer;
        return {
          write: async (chunk: Uint8Array | string) => { this.pendingBytes += typeof chunk === "string" ? new TextEncoder().encode(chunk).byteLength : chunk.byteLength; return writer.write(chunk); },
          close: async () => { try { return await writer.close(); } finally { this.pendingBytes = 0; } },
          abort: async (reason?: unknown) => { this.pendingBytes = 0; return writer.abort(reason); },
        };
      }
    }
    const bytes = new Uint8Array(128);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index % 31) + 1;
    const expected = expectation(bytes, 64);
    const pieces = Array.from({ length: 32 }, (_, index) => ({ startFrame: index * 2, bytes: bytes.slice(index * 4, index * 4 + 4) }));
    const baselineBackend = new MemoryStemStorageBackend();
    const baselineStore = new VerifiedSparsePcmStore({ backend: baselineBackend, instanceId: "physical-quota" });
    await baselineStore.installSource(expected, { resolve: async () => ({ spans: spans(...pieces) }) });
    const baselineBytes = [...baselineBackend.files.values()].reduce((sum, file) => sum + file.byteLength, 0);
    await baselineStore.close();
    const backend = new PhysicalUsageBackend(baselineBytes + 32);
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "physical-quota" });
    const descriptor = await store.installSource(expected, { resolve: async () => ({ spans: spans(...pieces) }) });
    assert.equal(descriptor.index.activeBytes, bytes.byteLength);
    await store.close();
  });

  it("refuses every colliding unpublished generation without touching the orphan", async () => {
    class CollisionBackend extends MemoryStemStorageBackend {
      override async exists(name: string): Promise<boolean> {
        if (name.startsWith("sparse-pcm-v1-data-")) return true;
        return super.exists(name);
      }
    }
    const orphanName = "sparse-pcm-v1-data-collision-orphan";
    const orphan = new Uint8Array([99, 98, 97]);
    const backend = new CollisionBackend({ files: { [orphanName]: orphan } });
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "collision" });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await assert.rejects(store.installSource(expectation(bytes, 2), { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.corrupt");
    assert.deepEqual(backend.files.get(orphanName), orphan);
    await store.close();
  });

  it("rejects an unsupported shape before invoking the resolver", async () => {
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "preflight" });
    const bytes = new Uint8Array([1, 2]);
    let resolves = 0;
    await assert.rejects(store.installSource({ ...expectation(bytes, 1), sampleRateHz: 12_345 }, { resolve: async () => { resolves += 1; return { spans: spans({ startFrame: 0, bytes }) }; } }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration");
    assert.equal(resolves, 0);
    assert.deepEqual(await backend.list(), []);
    await store.close();
  });

  it("rejects strict option keys and late getters before opening a writer", async () => {
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "options" });
    const bytes = new Uint8Array([1, 2]);
    let resolves = 0;
    const options: Record<string, unknown> = { resolve: async () => { resolves += 1; return { spans: spans({ startFrame: 0, bytes }) }; }, extra: 1 };
    Object.defineProperty(options, "late", { enumerable: true, get: () => { throw new Error("late getter accessed"); } });
    await assert.rejects(store.installSource(expectation(bytes, 1), options as never), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration");
    assert.equal(resolves, 0);
    assert.deepEqual(await backend.list(), []);
    await store.close();
  });

  it("preserves an existing capability error from the backend boundary", async () => {
    class CapabilityBackend extends MemoryStemStorageBackend {
      override async open(): Promise<void> { throw new EngineWebAdapterError("capability.opfs", "OPFS unavailable"); }
    }
    const store = new VerifiedSparsePcmStore({ backend: new CapabilityBackend(), instanceId: "capability" });
    const bytes = new Uint8Array([1, 2]);
    await assert.rejects(store.installSource(expectation(bytes, 1), { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "capability.opfs");
    await store.close();
  });

  it("cancels a resolver before publication and waits for its physical release", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "cancel" });
    let started!: () => void;
    const resolverStarted = new Promise<void>((resolve) => { started = resolve; });
    let resolverAborted = false;
    const installing = store.installSource(expectation(bytes, 2), {
      resolve: async (signal) => {
        started();
        await new Promise<void>((resolve) => {
          if (signal.aborted) { resolverAborted = true; resolve(); return; }
          signal.addEventListener("abort", () => { resolverAborted = true; resolve(); }, { once: true });
        });
        return { spans: spans() };
      },
    });
    await resolverStarted;
    await store.close();
    await assert.rejects(installing, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
    assert.equal(resolverAborted, true);
    assert.deepEqual(await backend.list(), []);
  });

  it("waits for an active lock before admitting a cancelled successor", async () => {
    const shared = { locks: new Map<string, Promise<void>>() };
    const first = await acquireNamedLock(undefined, shared, "sparse-test", undefined);
    const cancelled = new AbortController();
    const second = acquireNamedLock(undefined, shared, "sparse-test", cancelled.signal);
    cancelled.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(second);
    let thirdReady = false;
    const third = acquireNamedLock(undefined, shared, "sparse-test", undefined).then((lease) => { thirdReady = true; return lease; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(thirdReady, false);
    await first.release();
    const thirdLease = await third;
    assert.equal(thirdReady, true);
    await thirdLease.release();
  });

  it("always returns a source iterator before removing owned output on span or writer failure", async () => {
    const canonical = new Uint8Array([1, 2, 3, 4]);
    for (const mode of ["malformed", "writer"] as const) {
      const events: string[] = [];
      class ObservedBackend extends MemoryStemStorageBackend {
        override async createWriter(name: string, signal?: AbortSignal) {
          const writer = await super.createWriter(name, signal);
          if (mode !== "writer" || !name.startsWith("sparse-pcm-v1-data-")) return writer;
          return {
            write: async () => { events.push("write-failed"); throw new Error("injected write failure"); },
            close: () => writer.close(),
            abort: (reason?: unknown) => writer.abort(reason),
          };
        }
        override async remove(name: string): Promise<void> {
          events.push(events.includes("iterator-return") ? `remove-after-return:${name}` : `remove-before-return:${name}`);
          await super.remove(name);
        }
      }
      const backend = new ObservedBackend();
      const store = new VerifiedSparsePcmStore({ backend, instanceId: `iterator-${mode}` });
      const source = {
        async *[Symbol.asyncIterator]() {
          try {
            yield { startFrame: 0, bytes: mode === "malformed" ? new Uint8Array([1]) : canonical };
          } finally {
            events.push("iterator-return");
          }
        },
      };
      await assert.rejects(store.installSource(expectation(canonical, 2), { resolve: async () => ({ spans: source }) }));
      assert.equal(events.includes("iterator-return"), true, `${mode}: generator finally ran`);
      assert.equal(events.some((event) => event.startsWith("remove-before-return")), false, `${mode}: owned output removal waited for iterator return`);
      await store.close();
    }
  });

  it("closes an already-resolved source when upfront admission fails", async () => {
    const bytes = new Uint8Array([1, 2]);
    const events: string[] = [];
    const source = {
      [Symbol.asyncIterator]() {
        const generator = (async function* () { yield { startFrame: 0, bytes }; })();
        return {
          next: () => generator.next(),
          return: async () => { events.push("iterator-return"); return generator.return(); },
          [Symbol.asyncIterator]() { return this; },
        };
      },
    };
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "admission-return" });
    const badIndex = {
      format: "miso_sparse_pcm_v1" as const,
      identity: expectation(bytes, 1).identity,
      sampleRateHz: 48_000,
      channels: 1 as const,
      bitDepth: 16 as const,
      frames: 1,
      intervals: [{ startFrame: 0, frames: 2, byteOffset: 0 }],
    };
    await assert.rejects(store.installSource(expectation(bytes, 1), { resolve: async () => ({ index: badIndex as never, spans: source }) }));
    assert.deepEqual(events, ["iterator-return"]);
    await store.close();
  });

  it("releases a lock granted in the same turn as caller cancellation", async () => {
    const bytes = new Uint8Array([1, 2]);
    const controller = new AbortController();
    let callbacksFinished = 0;
    const locks = {
      request: async <T>(name: string, _options: { readonly mode: "exclusive"; readonly signal?: AbortSignal }, callback: () => Promise<T>): Promise<T> => {
        const running = callback();
        if (name.includes(":ingest:")) controller.abort(new DOMException("cancelled", "AbortError"));
        try { return await running; }
        finally { callbacksFinished += 1; }
      },
    };
    const store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), locks, instanceId: "grant-cancel" });
    await assert.rejects(store.installSource(expectation(bytes, 1), { signal: controller.signal, resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
    assert.equal(callbacksFinished, 2, "both historical lock callbacks released after the grant/cancel race");
    await store.close();
  });

  it("waits for a pending physical write even when writer abort rejects", async () => {
    const bytes = new Uint8Array([1, 2]);
    const events: string[] = [];
    let resolveWrite!: () => void;
    let notifyAbort!: () => void;
    const writeStarted = new Promise<void>((resolve) => { notifyAbort = resolve; });
    const writeGate = new Promise<void>((resolve) => { resolveWrite = resolve; });
    class AbortRejectBackend extends MemoryStemStorageBackend {
      override async createWriter(name: string, signal?: AbortSignal) {
        const writer = await super.createWriter(name, signal);
        if (!name.startsWith("sparse-pcm-v1-data-")) return writer;
        return {
          write: async (chunk: Uint8Array | string) => {
            events.push("write-start");
            notifyAbort();
            await writeGate;
            events.push("write-settled");
            await writer.write(chunk);
          },
          close: () => writer.close(),
          abort: async () => { events.push("abort-rejected"); throw new Error("injected abort failure"); },
        };
      }
      override async remove(name: string): Promise<void> {
        events.push(`remove:${name}`);
        await super.remove(name);
      }
    }
    const backend = new AbortRejectBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "abort-reject" });
    const installing = store.installSource(expectation(bytes, 1), { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) });
    await writeStarted;
    const closing = store.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events.includes("abort-rejected"), true);
    assert.equal(events.includes("write-settled"), false);
    resolveWrite();
    await closing;
    await assert.rejects(installing);
    assert.ok(events.indexOf("write-settled") >= 0);
    const firstRemove = events.findIndex((event) => event.startsWith("remove:"));
    assert.ok(firstRemove > events.indexOf("write-settled"), events.join(","));
  });

  it("preserves async and sync iterator cleanup failures beside public primary errors", async () => {
    const bytes = new Uint8Array([1, 2]);
    for (const phase of ["span", "write", "early"] as const) {
      for (const cleanupMode of ["async", "sync"] as const) {
        const sentinel = new Error(`RETURN_CLEANUP_${phase}_${cleanupMode}`);
        let returns = 0;
        class CleanupBackend extends MemoryStemStorageBackend {
          override async createWriter(name: string, signal?: AbortSignal) {
            const writer = await super.createWriter(name, signal);
            if (phase !== "write" || !name.startsWith("sparse-pcm-v1-data-")) return writer;
            return {
              write: async () => { throw new Error("WRITE_PRIMARY_FAILURE"); },
              close: () => writer.close(),
              abort: (reason?: unknown) => writer.abort(reason),
            };
          }
        }
        const backend = new CleanupBackend();
        const store = new VerifiedSparsePcmStore({ backend, instanceId: `cleanup-${phase}-${cleanupMode}` });
        const source = {
          [Symbol.asyncIterator]() {
            return {
              next: async () => ({ done: phase === "early", value: phase === "span" ? { startFrame: 0, bytes: new Uint8Array([1]) } : { startFrame: 0, bytes } }),
              return: () => {
                returns += 1;
                if (cleanupMode === "sync") throw sentinel;
                return Promise.reject(sentinel);
              },
              [Symbol.asyncIterator]() { return this; },
            };
          },
        } as AsyncIterable<{ readonly startFrame: number; readonly bytes: Uint8Array }>;
        const expected = expectation(bytes, 1);
        const options = phase === "early"
          ? { resolve: async () => ({ index: { format: "miso_sparse_pcm_v1", identity: expected.identity, sampleRateHz: 48_000, channels: 1, bitDepth: 16, frames: 2, intervals: [], activeBytes: 0, canonicalBytes: 2 } as never, spans: source }) }
          : { resolve: async () => ({ spans: source }) };
        let error: unknown;
        await store.installSource(expected, options).catch((value: unknown) => { error = value; });
        assert.ok(error instanceof EngineWebAdapterError);
        assert.match(inspect(error, { depth: 12 }), new RegExp(sentinel.message));
        assert.equal(returns, 1, `${phase}/${cleanupMode}: iterator.return exactly once`);
        assert.deepEqual(await backend.list(), []);
        await store.close();
      }
    }
  });

  it("does not start a physical write after quota observation aborts the operation", async () => {
    const bytes = new Uint8Array([1, 2]);
    const controller = new AbortController();
    let writes = 0;
    class AbortAtQuotaBackend extends MemoryStemStorageBackend {
      override async estimate(): Promise<{ readonly quota?: number; readonly usage?: number }> {
        controller.abort(new DOMException("quota observation cancelled", "AbortError"));
        return super.estimate();
      }
      override async createWriter(name: string, _signal?: AbortSignal) {
        const writer = await super.createWriter(name);
        if (!name.startsWith("sparse-pcm-v1-data-")) return writer;
        return {
          write: async (chunk: Uint8Array | string) => { writes += 1; return writer.write(chunk); },
          close: () => writer.close(),
          abort: (reason?: unknown) => writer.abort(reason),
        };
      }
    }
    const backend = new AbortAtQuotaBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "quota-abort-before-write", readDeadlineMs: 200 });
    await assert.rejects(
      store.installSource(expectation(bytes, 1), { signal: controller.signal, resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) }),
      (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled",
    );
    assert.equal(writes, 0, "quota cancellation must prevent a new physical write");
    assert.deepEqual(await backend.list(), []);
    await store.close();
  });

  it("settles a synchronous physical-start abort before cleanup", async () => {
    const bytes = new Uint8Array([1, 2]);
    const controller = new AbortController();
    const gate = deferred();
    const writeStarted = deferred();
    const events: string[] = [];
    class AbortDuringWriteBackend extends MemoryStemStorageBackend {
      override async createWriter(name: string, _signal?: AbortSignal) {
        const writer = await super.createWriter(name);
        if (!name.startsWith("sparse-pcm-v1-data-")) return writer;
        return {
          write: async (chunk: Uint8Array | string) => {
            events.push("write-start");
            writeStarted.resolve();
            controller.abort(new DOMException("write startup cancelled", "AbortError"));
            await gate.promise;
            events.push("write-settled");
            return writer.write(chunk);
          },
          close: () => writer.close(),
          abort: async (reason?: unknown) => { events.push("abort"); await writer.abort(reason); },
        };
      }
    }
    const backend = new AbortDuringWriteBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "sync-write-abort", readDeadlineMs: 200 });
    const installing = store.installSource(expectation(bytes, 1), { signal: controller.signal, resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) });
    await writeStarted.promise;
    gate.resolve();
    await assert.rejects(installing, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
    assert.equal(events[0], "write-start");
    assert.ok(events.includes("abort"), "physical abort runs after synchronous cancellation");
    assert.ok(events.indexOf("write-settled") > events.indexOf("abort"), "physical abort precedes write settlement");
    assert.deepEqual(await backend.list(), []);
    await store.close();
  });

  it("keeps metadata deadlines when the OPFS backend owns writer deadlines", async () => {
    const bytes = new Uint8Array([1, 2]);
    const expected = expectation(bytes, 1);
    const index = {
      format: "miso_sparse_pcm_v1" as const,
      identity: expected.identity,
      sampleRateHz: expected.sampleRateHz,
      channels: expected.channels,
      bitDepth: expected.bitDepth,
      frames: expected.frames,
      intervals: [{ startFrame: 0, frames: 1, byteOffset: 0 }],
      activeBytes: bytes.byteLength,
      canonicalBytes: bytes.byteLength,
    };
    for (const stalled of ["exists", "estimate"] as const) {
      const backend = new OpfsStorageBackend({
        storage: { getDirectory: async () => { throw new Error("shadowed open"); } },
        readDeadlineMs: 5,
      });
      backend.open = async () => {};
      backend.exists = stalled === "exists"
        ? async () => new Promise<boolean>(() => {})
        : async () => false;
      backend.estimate = stalled === "estimate"
        ? async () => new Promise<{ readonly quota?: number; readonly usage?: number }>(() => {})
        : async () => ({});
      const store = new VerifiedSparsePcmStore({ backend, instanceId: `metadata-deadline-${stalled}`, readDeadlineMs: 5 });
      const outcome = await new Promise<{ readonly tag: "error" | "timeout"; readonly error?: unknown }>((resolve) => {
        const timer = setTimeout(() => resolve({ tag: "timeout" }), 200);
        void store.installSource(expected, {
          resolve: async () => ({ index, spans: spans({ startFrame: 0, bytes }) }),
        }).then(
          () => { clearTimeout(timer); resolve({ tag: "timeout" }); },
          (error: unknown) => { clearTimeout(timer); resolve({ tag: "error", error }); },
        );
      });
      assert.equal(outcome.tag, "error", `${stalled} metadata operation must be bounded`);
      assert.ok(outcome.error instanceof EngineWebAdapterError);
      assert.equal(outcome.error.code, "stem.read_deadline");
      await store.close();
      backend.close();
    }
  });

  it("maps complete Effect causes once at the public edge", async () => {
    const bytes = new Uint8Array([1, 2]);
    const runCase = async (phase: "undefined" | "getter" | "capability") => {
      const primary = new Error("PRIMARY_GETTER_SENTINEL");
      const cleanup = new Error("RETURN_CLEANUP_SENTINEL");
      class CauseBackend extends MemoryStemStorageBackend {
        override async createWriter(name: string, signal?: AbortSignal) {
          const writer = await super.createWriter(name, signal);
          if (phase !== "capability" || !name.startsWith("sparse-pcm-v1-data-")) return writer;
          return {
            write: async () => { throw new EngineWebAdapterError("capability.opfs", "ORIGINAL_CAPABILITY_SENTINEL"); },
            close: () => writer.close(),
            abort: (reason?: unknown) => writer.abort(reason),
          };
        }
      }
      const backend = new CauseBackend();
      const store = new VerifiedSparsePcmStore({ backend, instanceId: `cause-${phase}` });
      const span: { startFrame: number; bytes: Uint8Array } = { startFrame: 0, bytes: phase === "undefined" ? new Uint8Array([1]) : bytes };
      if (phase === "getter") Object.defineProperty(span, "startFrame", { get: () => { throw primary; }, enumerable: true });
      const source = {
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: false, value: span }),
            return: async () => { throw phase === "undefined" ? undefined : cleanup; },
            [Symbol.asyncIterator]() { return this; },
          };
        },
      } as AsyncIterable<{ readonly startFrame: number; readonly bytes: Uint8Array }>;
      const expected = expectation(bytes, 1);
      let error: unknown;
      await store.installSource(expected, { resolve: async () => ({ spans: source }) }).catch((value: unknown) => { error = value; });
      if (phase === "undefined") {
        assert.ok(error instanceof EngineWebAdapterError);
        const aggregate = (error as Error).cause;
        assert.ok(aggregate instanceof AggregateError);
        assert.equal(aggregate.errors.some((value) => value === undefined), true);
      } else if (phase === "getter") {
        assert.ok(error instanceof EngineWebAdapterError);
        assert.equal(error.code, "stem.corrupt");
        assert.ok(error.cause instanceof AggregateError);
        assert.equal(error.cause.errors.includes(primary), true);
        assert.equal(error.cause.errors.includes(cleanup), true);
      } else {
        assert.ok(error instanceof EngineWebAdapterError);
        assert.equal(error.code, "capability.opfs");
        assert.ok(error.cause instanceof AggregateError);
        assert.equal(error.cause.errors.some((value) => value instanceof EngineWebAdapterError && value.code === "capability.opfs" || value instanceof Error && value.cause instanceof EngineWebAdapterError && value.cause.code === "capability.opfs"), true);
        assert.equal(error.cause.errors.includes(cleanup), true);
      }
      assert.equal((await backend.list()).length, 0);
      await store.close();
    };
    for (const phase of ["undefined", "getter", "capability"] as const) await runCase(phase);
  });

  it("opens a complete detached descriptor map with identity deduplication", async () => {
    const firstBytes = new Uint8Array([1, 2, 3, 4]);
    const secondBytes = new Uint8Array([9, 8, 7, 6]);
    const first = expectation(firstBytes, 2);
    const second = expectation(secondBytes, 2);
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "session-map" });
    const resolved: string[] = [];
    const lease = await store.openSession({
      leaseId: "map",
      sources: [
        { ...first, sourceId: "first" },
        { ...first, sourceId: "first-alias" },
        { ...second, sourceId: "second" },
      ],
      resolve: async (expected) => {
        resolved.push(expected.identity);
        const bytes = expected.identity === first.identity ? firstBytes : secondBytes;
        return { spans: spans({ startFrame: 0, bytes }) };
      },
    });
    assert.deepEqual(lease.sources.map((source) => source.sourceId), ["first", "first-alias", "second"]);
    assert.equal(Object.isFrozen(lease.sources), true);
    assert.equal(Object.isFrozen(lease.sources[0]), true);
    assert.deepEqual(resolved, [first.identity, second.identity]);
    assert.equal((await lease.read(first.identity)).data.size, firstBytes.byteLength);
    await store.close();
    assert.equal((await lease.read(second.identity)).data.size, secondBytes.byteLength);
    await lease.close();
    await assert.rejects(lease.read(first.identity), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.closed");
  });

  it("keeps presence metadata-only and distinguishes missing from warm silent content", async () => {
    const bytes = new Uint8Array(8);
    const expected = expectation(bytes, 4);
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "presence" });
    assert.deepEqual(await store.inspectSourcePresence(expected), { status: "missing" });
    await store.installSource(expected, { resolve: async () => ({ spans: spans() }) });
    assert.deepEqual(await store.inspectSourcePresence(expected), { status: "present", activeBytes: 0 });
    await store.close();
  });

  it("preflights session declarations and charges retained indexes after commit", async () => {
    const bytes = new Uint8Array([1, 2]);
    const expected = expectation(bytes, 1);
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "session-budget" });
    const late = [] as unknown[];
    Object.defineProperty(late, "0", { get: () => { throw new Error("late getter must not run"); }, enumerable: true });
    Object.defineProperty(late, "length", { value: 2 });
    await assert.rejects(store.openSession({ leaseId: "x", sources: late as never[], maximumMetadataBytes: 256 }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration");
    await assert.rejects(store.openSession({
      leaseId: "x",
      sources: [{ ...expected, sourceId: "one" }],
      maximumMetadataBytes: 2 + 256 + 2 * "one".length,
      resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }),
    }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration");
    assert.equal((await backend.list()).some((name) => name.startsWith("sparse-pcm-v1-commit-")), true);
    await store.close();
  });

  it("refuses a cancelled final handoff without exposing an empty-session lease", async () => {
    const controller = new AbortController();
    const store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "handoff" });
    const opening = store.openSession({ leaseId: "handoff", sources: [], signal: controller.signal });
    queueMicrotask(() => controller.abort(new DOMException("handoff cancelled", "AbortError")));
    await assert.rejects(opening, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
    await store.close();
  });

  it("inspects a non-silent source without reading PCM bytes or hashing", async () => {
    let payloadArrayBufferReads = 0;
    let payloadBlobReads = 0;
    class CountingBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        payloadArrayBufferReads += 1;
        return super.arrayBuffer();
      }

      override slice(start?: number, end?: number, contentType?: string): Blob {
        return new CountingBlob([super.slice(start, end, contentType)]);
      }
    }
    class PresenceSpyBackend extends MemoryStemStorageBackend {
      override async read(name: string): Promise<Blob> {
        if (!name.startsWith("sparse-pcm-v1-data-")) return super.read(name);
        const bytes = this.files.get(name);
        if (bytes === undefined) return super.read(name);
        payloadBlobReads += 1;
        return new CountingBlob([bytes.slice()]);
      }
    }
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const expected = expectation(bytes, 2);
    const backend = new PresenceSpyBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "presence-spy" });
    await store.installSource(expected, { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) });
    payloadArrayBufferReads = 0;
    payloadBlobReads = 0;
    assert.deepEqual(await store.inspectSourcePresence(expected), { status: "present", activeBytes: bytes.byteLength });
    assert.equal(payloadBlobReads, 1, "presence may read the payload Blob metadata");
    assert.equal(payloadArrayBufferReads, 0, "presence must not read PCM bytes");
    const payload = [...backend.files.keys()].find((name) => name.startsWith("sparse-pcm-v1-data-"));
    assert.ok(payload);
    const tampered = backend.files.get(payload)!.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    backend.files.set(payload, tampered);
    assert.deepEqual(await store.inspectSourcePresence(expected), { status: "present", activeBytes: bytes.byteLength });
    await assert.rejects(store.openSource(expected), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.corrupt");
    assert.equal(payloadArrayBufferReads > 0, true, "full open must perform canonical PCM verification");
    await store.close();
  });

  it("rejects malformed presence metadata, missing generations, and wrong extents", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const expected = expectation(bytes, 2);
    for (const mode of ["malformed-marker", "missing-generation", "wrong-extent"] as const) {
      const backend = new MemoryStemStorageBackend();
      const store = new VerifiedSparsePcmStore({ backend, instanceId: `presence-${mode}` });
      await store.installSource(expected, { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) });
      const marker = [...backend.files.keys()].find((name) => name.startsWith("sparse-pcm-v1-commit-"));
      const payload = [...backend.files.keys()].find((name) => name.startsWith("sparse-pcm-v1-data-"));
      assert.ok(marker);
      assert.ok(payload);
      if (mode === "malformed-marker") backend.files.set(marker, new Uint8Array([123, 125]));
      if (mode === "missing-generation") backend.files.delete(payload);
      if (mode === "wrong-extent") backend.files.set(payload, backend.files.get(payload)!.slice(0, 2));
      await assert.rejects(store.inspectSourcePresence(expected), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.corrupt");
      await store.close();
    }
  });

  it("rejects duplicate IDs and conflicting aliases before opening storage", async () => {
    class OpenSpyBackend extends MemoryStemStorageBackend {
      opens = 0;
      override async open(): Promise<void> { this.opens += 1; await super.open(); }
    }
    const bytes = new Uint8Array([1, 2]);
    const expected = expectation(bytes, 1);
    const conflicting = { ...expected, frames: 2, canonicalBytes: 4 };
    const backend = new OpenSpyBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "session-admission" });
    const resolve = async () => ({ spans: spans({ startFrame: 0, bytes }) });
    await assert.rejects(store.openSession({ leaseId: "ids", sources: [{ ...expected, sourceId: "same" }, { ...expected, sourceId: "same" }], resolve }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration");
    await assert.rejects(store.openSession({ leaseId: "shape", sources: [{ ...expected, sourceId: "first" }, { ...conflicting, sourceId: "second" }], resolve }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration");
    assert.equal(backend.opens, 0, "admission failures must precede backend access");
    await store.close();
  });

  it("releases each source scope before the next and preserves earlier assets on late failure", async () => {
    const firstBytes = new Uint8Array([1, 2]);
    const secondBytes = new Uint8Array([3, 4]);
    const first = expectation(firstBytes, 1);
    const second = expectation(secondBytes, 1);
    const active = new Set<string>();
    let firstReleasedBeforeSecond = false;
    const locks = {
      request: async <T>(name: string, _options: { readonly mode: "exclusive"; readonly signal?: AbortSignal }, callback: () => Promise<T>): Promise<T> => {
        active.add(name);
        try {
          if (name.endsWith(second.identity.slice(7))) firstReleasedBeforeSecond = ![...active].some((held) => held.endsWith(first.identity.slice(7)));
          return await callback();
        } finally {
          active.delete(name);
        }
      },
    };
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, locks, instanceId: "scope-order" });
    await assert.rejects(store.openSession({
      leaseId: "late-failure",
      sources: [{ ...first, sourceId: "first" }, { ...second, sourceId: "second" }],
      resolve: async (expected) => {
        if (expected.identity === second.identity) throw new Error("late source failed");
        return { spans: spans({ startFrame: 0, bytes: firstBytes }) };
      },
    }));
    assert.equal(firstReleasedBeforeSecond, true);
    assert.deepEqual((await store.openSource(first))?.index.activeBytes, firstBytes.byteLength);
    await store.close();
  });

  it("keeps warm resolver calls at zero, independent leases independent, and reverse orders deadlock-free", async () => {
    const firstBytes = new Uint8Array([1, 2]);
    const secondBytes = new Uint8Array([3, 4]);
    const first = expectation(firstBytes, 1);
    const second = expectation(secondBytes, 1);
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "session-independent" });
    await store.installSource(first, { resolve: async () => ({ spans: spans({ startFrame: 0, bytes: firstBytes }) }) });
    let warmResolves = 0;
    const warm = await store.openSession({ leaseId: "warm", sources: [{ ...first, sourceId: "warm" }], resolve: async () => { warmResolves += 1; throw new Error("warm resolver called"); } });
    assert.equal(warmResolves, 0);
    const independent = await store.openSession({ leaseId: "independent", sources: [{ ...first, sourceId: "independent" }], resolve: async () => ({ spans: spans() }) });
    await warm.close();
    assert.equal((await independent.read(first.identity)).data.size, firstBytes.byteLength);
    await independent.close();

    const resolver = async (expected: SparsePcmExpectation) => ({ spans: spans({ startFrame: 0, bytes: expected.identity === first.identity ? firstBytes : secondBytes }) });
    const [left, right] = await Promise.all([
      store.openSession({ leaseId: "left", sources: [{ ...first, sourceId: "left-first" }, { ...second, sourceId: "left-second" }], resolve: resolver }),
      store.openSession({ leaseId: "right", sources: [{ ...second, sourceId: "right-second" }, { ...first, sourceId: "right-first" }], resolve: resolver }),
    ]);
    assert.equal((await left.read(second.identity)).data.size, secondBytes.byteLength);
    assert.equal((await right.read(first.identity)).data.size, firstBytes.byteLength);
    await left.close();
    await right.close();
    await store.close();
  });

  it("charges one captured boundary snapshot despite accessor substitutions", async () => {
    const bytes = new Uint8Array([1, 2]);
    const expected = expectation(bytes, 1);
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "snapshot-boundary" });
    let leaseIdReads = 0;
    let sourcesReads = 0;
    const declarations = Array.from({ length: 100 }, (_, index) => ({ ...expected, sourceId: `source-${index}` }));
    const lease = await store.openSession({
      get leaseId() { leaseIdReads += 1; return leaseIdReads === 1 ? "x" : "l".repeat(10_000); },
      maximumMetadataBytes: 1_024,
      get sources() { sourcesReads += 1; return sourcesReads === 1 ? [] : declarations; },
      resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }),
    });
    assert.deepEqual(lease.sources, []);
    assert.equal(leaseIdReads, 1);
    assert.equal(sourcesReads, 1);
    await lease.close();
    await store.close();

    const secondBackend = new MemoryStemStorageBackend();
    const secondStore = new VerifiedSparsePcmStore({ backend: secondBackend, instanceId: "snapshot-source" });
    let sourceIdReads = 0;
    const source = { ...expected, sourceId: "x" };
    Object.defineProperty(source, "sourceId", { enumerable: true, get: () => { sourceIdReads += 1; return sourceIdReads === 1 ? "x" : "z".repeat(10_000); } });
    const secondLease = await secondStore.openSession({ leaseId: "x", maximumMetadataBytes: 1_024, sources: [source], resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) });
    assert.equal(secondLease.sources[0]!.sourceId, "x");
    assert.equal(sourceIdReads, 1);
    await secondLease.close();
    await secondStore.close();
  });

  it("rejects an oversized ordinary array before touching a late element getter", async () => {
    let elementReads = 0;
    const sources = new Array(5) as unknown[];
    Object.defineProperty(sources, "0", { enumerable: true, get: () => { elementReads += 1; throw new Error("late element getter accessed"); } });
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "snapshot-array-bound" });
    await assert.rejects(store.openSession({ leaseId: "x", maximumMetadataBytes: 1_024, sources: sources as never[] }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration");
    assert.equal(elementReads, 0);
    await store.close();
  });

  it("reports cumulative cold ingest and warm verification work, including zero gaps", async () => {
    const canonical = new Uint8Array(200_000);
    for (let index = 20_000; index < 40_000; index += 1) canonical[index] = index % 251 + 1;
    for (let index = 160_000; index < 180_000; index += 1) canonical[index] = index % 241 + 1;
    const expected = expectation(canonical, canonical.byteLength / 2);
    const store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "progress" });
    const cold: import("../src/stems/types.js").StemProgress[] = [];
    await store.installSource(expected, {
      resolve: async () => ({ spans: spans(
        { startFrame: 10_000, bytes: canonical.slice(20_000, 40_000) },
        { startFrame: 80_000, bytes: canonical.slice(160_000, 180_000) },
      ) }),
      onProgress: (event) => cold.push(event),
    });
    const coldBytes = cold.filter((event): event is Extract<typeof event, { bytes: number; totalBytes: number }> => "bytes" in event && "totalBytes" in event && event.stage === "ingesting");
    assert.ok(coldBytes.length >= 3, "large logical gaps need more than one ingest advance");
    assert.equal(coldBytes.at(-1)?.bytes, expected.canonicalBytes);
    assert.ok(coldBytes.every((event) => event.identity === expected.identity && event.byteKind === "pcm" && event.totalBytes === expected.canonicalBytes && event.bytes >= 0 && event.bytes <= event.totalBytes));
    assert.equal(cold.filter((event) => event.stage === "source-ready").length, 1);

    const warm: import("../src/stems/types.js").StemProgress[] = [];
    await store.installSource(expected, {
      resolve: async () => { throw new Error("warm sparse install must not resolve"); },
      onProgress: (event) => warm.push(event),
    });
    const warmBytes = warm.filter((event): event is Extract<typeof event, { bytes: number; totalBytes: number }> => "bytes" in event && "totalBytes" in event && event.stage === "verifying");
    assert.ok(warmBytes.length >= 3, "large logical gaps need more than one verification advance");
    assert.equal(warmBytes.at(-1)?.bytes, expected.canonicalBytes);
    assert.equal(warm.some((event) => event.stage === "ingesting"), false);
    assert.equal(warm.filter((event) => event.stage === "source-ready").length, 1);
    const timings = warm.filter((event) => event.verificationTiming !== undefined);
    assert.equal(timings.length, 1);
    const timing = timings[0]!.verificationTiming!;
    assert.equal(timing.readCalls, 2);
    assert.equal(timing.readBytes, 40_000);
    assert.equal(timing.hashedBytes, canonical.byteLength);
    for (const ms of [timing.elapsedMs, timing.metadataMs, timing.readWaitMs, timing.hashMs]) assert.ok(Number.isFinite(ms) && ms >= 0);
    assert.ok(timing.elapsedMs >= timing.metadataMs + timing.readWaitMs + timing.hashMs);
    assert.equal(cold.some((event) => event.verificationTiming !== undefined), false);
    const observedDespiteThrow = await store.openSource(expected, { onProgress: () => { throw new Error("observer failure"); } });
    assert.equal(observedDespiteThrow?.data.size, 40_000);
    await store.close();
  });

  it("reuses one warm task channel across zero gaps and falls back without the capability", async () => {
    const previous = globalThis.MessageChannel;
    const probe: WarmYieldProbe = { hold: false, constructed: 0, posts: 0, closes: 0, listeners: 0, held: [] };
    ProbeWarmMessageChannel.probe = probe;
    globalThis.MessageChannel = ProbeWarmMessageChannel as unknown as typeof globalThis.MessageChannel;
    try {
      const activeBytes = new Uint8Array([1, 2]);
      const activeExpected = expectation(activeBytes, 1);
      const activeStore = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "warm-task-active" });
      await activeStore.installSource(activeExpected, { resolve: async () => ({ spans: spans({ startFrame: 0, bytes: activeBytes }) }) });
      assert.equal((await activeStore.openSource(activeExpected))?.data.size, 2);
      assert.equal(probe.constructed, 0, "all-active warm verification has no zero checkpoint");
      await activeStore.close();

      const fixture = warmYieldFixture();
      const backend = new MemoryStemStorageBackend();
      const store = new VerifiedSparsePcmStore({ backend, instanceId: "warm-task-probe" });
      await store.installSource(fixture.expected, { resolve: async () => ({ spans: spans(...fixture.spans) }) });
      const descriptor = await store.openSource(fixture.expected, { onProgress: () => undefined });
      assert.equal(descriptor?.data.size, 4);
      assert.equal(probe.constructed, 1);
      assert.equal(probe.posts, 4, "leading, interior, and trailing gaps retain 64 KiB cadence");
      assert.equal(probe.listeners, 0);
      assert.equal(probe.closes, 2);
      await store.close();

      const fallbackProbe: WarmYieldProbe = { hold: false, constructed: 0, posts: 0, closes: 0, listeners: 0, held: [] };
      ProbeWarmMessageChannel.probe = fallbackProbe;
      globalThis.MessageChannel = undefined as unknown as typeof globalThis.MessageChannel;
      const fallbackFixture = warmYieldFixture();
      const fallbackStore = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "warm-task-fallback" });
      await fallbackStore.installSource(fallbackFixture.expected, { resolve: async () => ({ spans: spans(...fallbackFixture.spans) }) });
      assert.equal((await fallbackStore.openSource(fallbackFixture.expected))?.data.size, 4);
      assert.equal(fallbackProbe.constructed, 0);
      await fallbackStore.close();
    } finally {
      globalThis.MessageChannel = previous;
    }
  });

  it("cancels a held warm task, releases both ports, ignores stale delivery, and retries", async () => {
    const previous = globalThis.MessageChannel;
    const probe: WarmYieldProbe = { hold: true, constructed: 0, posts: 0, closes: 0, listeners: 0, held: [] };
    ProbeWarmMessageChannel.probe = probe;
    globalThis.MessageChannel = ProbeWarmMessageChannel as unknown as typeof globalThis.MessageChannel;
    try {
      const fixture = warmYieldFixture();
      const store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "warm-task-abort" });
      await store.installSource(fixture.expected, { resolve: async () => ({ spans: spans(...fixture.spans) }) });
      const controller = new AbortController();
      const opening = store.openSource(fixture.expected, { signal: controller.signal });
      for (let count = 0; count < 100 && probe.posts === 0; count += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(probe.posts, 1);
      controller.abort(new DOMException("warm task cancelled", "AbortError"));
      await assert.rejects(opening, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
      assert.equal(probe.listeners, 0);
      assert.equal(probe.closes, 2);
      for (const deliver of probe.held.splice(0)) deliver();

      probe.hold = false;
      assert.equal((await store.openSource(fixture.expected))?.data.size, 4);
      assert.equal(probe.constructed, 2);
      assert.equal(probe.posts, 5);
      assert.equal(probe.closes, 4);
      assert.equal(probe.listeners, 0);

      probe.hold = true;
      const closingOpen = store.openSource(fixture.expected);
      for (let count = 0; count < 100 && probe.posts < 6; count += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(probe.posts, 6);
      const closingStore = store.close();
      await assert.rejects(closingOpen, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
      await closingStore;
      assert.equal(probe.closes, 6);
      assert.equal(probe.listeners, 0);
    } finally {
      globalThis.MessageChannel = previous;
    }
  });

  it("types warm task construction and post failures, and surfaces close faults after both attempts", async () => {
    const previous = globalThis.MessageChannel;
    const fixture = warmYieldFixture();
    const probe: WarmYieldProbe = { hold: false, constructed: 0, posts: 0, closes: 0, listeners: 0, held: [] };
    try {
      class ThrowingWarmMessageChannel {
        constructor() { probe.constructed += 1; throw new Error("warm task construction failed"); }
      }
      globalThis.MessageChannel = ThrowingWarmMessageChannel as unknown as typeof globalThis.MessageChannel;
      const constructionStore = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "warm-task-construction" });
      await constructionStore.installSource(fixture.expected, { resolve: async () => ({ spans: spans(...fixture.spans) }) });
      await assert.rejects(constructionStore.openSource(fixture.expected), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration");
      assert.equal(probe.constructed, 1);
      await constructionStore.close();

      const postProbe: WarmYieldProbe = { hold: false, failPost: true, constructed: 0, posts: 0, closes: 0, listeners: 0, held: [] };
      ProbeWarmMessageChannel.probe = postProbe;
      globalThis.MessageChannel = ProbeWarmMessageChannel as unknown as typeof globalThis.MessageChannel;
      const postStore = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "warm-task-post" });
      await postStore.installSource(fixture.expected, { resolve: async () => ({ spans: spans(...fixture.spans) }) });
      const postEvents: import("../src/stems/types.js").StemProgress[] = [];
      await assert.rejects(postStore.openSource(fixture.expected, { onProgress: (event) => postEvents.push(event) }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration");
      assert.equal(postProbe.constructed, 1);
      assert.equal(postProbe.posts, 1);
      assert.equal(postProbe.closes, 2);
      assert.equal(postProbe.listeners, 0);
      assert.equal(postEvents.some((event) => event.stage === "source-ready"), false);
      await postStore.close();

      const closeProbe: WarmYieldProbe = { hold: false, closeThrows: true, constructed: 0, posts: 0, closes: 0, listeners: 0, held: [] };
      ProbeWarmMessageChannel.probe = closeProbe;
      const closeStore = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "warm-task-close" });
      globalThis.MessageChannel = ProbeWarmMessageChannel as unknown as typeof globalThis.MessageChannel;
      await closeStore.installSource(fixture.expected, { resolve: async () => ({ spans: spans(...fixture.spans) }) });
      const closeEvents: import("../src/stems/types.js").StemProgress[] = [];
      await assert.rejects(closeStore.openSource(fixture.expected, { onProgress: (event) => closeEvents.push(event) }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.corrupt");
      assert.equal(closeProbe.constructed, 1);
      assert.equal(closeProbe.posts, 4);
      assert.equal(closeProbe.closes, 2, "a fault in port1 close cannot skip port2 close");
      assert.equal(closeProbe.listeners, 0);
      assert.equal(closeEvents.some((event) => event.stage === "source-ready"), false);
      await closeStore.close();
    } finally {
      globalThis.MessageChannel = previous;
    }
  });

  it("reads warm payloads in 512 KiB windows without crossing sparse intervals", async () => {
    const backend = new RecordingPayloadBackend();
    const { store, canonical, expected, intervals } = await primeLargeWarmStore(backend, "warm-window-size");
    const events: import("../src/stems/types.js").StemProgress[] = [];
    let resolverCalls = 0;
    const descriptor = await store.installSource(expected, {
      resolve: async () => { resolverCalls += 1; throw new Error("warm sparse install must not resolve"); },
      onProgress: (event) => events.push(event),
    });
    const frameBytes = 6;
    const activeBytes = concatBytes(intervals.map((interval) => canonical.slice(
      interval.startFrame * frameBytes,
      (interval.startFrame + interval.frames) * frameBytes,
    )));
    const firstBytes = intervals[0]!.frames * frameBytes;
    const warmReadBytes = 512 * 1024;
    const expectedReads = [
      [0, warmReadBytes],
      [warmReadBytes, warmReadBytes * 2],
      [warmReadBytes * 2, firstBytes],
      [firstBytes, firstBytes + warmReadBytes],
      [firstBytes + warmReadBytes, activeBytes.byteLength],
    ];
    assert.equal(resolverCalls, 0);
    assert.equal(descriptor.data.size, activeBytes.byteLength);
    assert.deepEqual(backend.payloadReads.map((read) => [read.start, read.end]), expectedReads);
    assert.ok(backend.payloadReads.every((read) => read.end - read.start <= warmReadBytes));
    assert.deepEqual(concatBytes(backend.payloadReads.map((read) => read.bytes)), activeBytes);
    assert.equal(backend.payloadReads.reduce((total, read) => total + read.returned, 0), activeBytes.byteLength);
    const timing = events.find((event) => event.verificationTiming !== undefined)?.verificationTiming;
    assert.ok(timing);
    assert.equal(timing.readCalls, backend.payloadReads.length);
    assert.equal(timing.readBytes, activeBytes.byteLength);
    assert.equal(timing.hashedBytes, canonical.byteLength);
    const verification = events.filter((event): event is Extract<typeof event, { bytes: number; totalBytes: number }> => "bytes" in event && "totalBytes" in event && event.stage === "verifying");
    assert.equal(verification.at(-1)?.bytes, canonical.byteLength);
    assert.equal(events.filter((event) => event.stage === "source-ready").length, 1);
    await store.close();
  });

  it("rejects short warm payload reads without readiness or verification timing", async () => {
    const warmReadBytes = 512 * 1024;
    for (const faultKind of ["full", "tail"] as const) {
      const backend = new RecordingPayloadBackend();
      const { store, expected } = await primeLargeWarmStore(backend, `warm-short-${faultKind}`);
      backend.fault = (bytes, start, end) => {
        const requested = end - start;
        const target = faultKind === "full" ? requested === warmReadBytes : requested < warmReadBytes;
        return target ? bytes.slice(0, bytes.byteLength - 1) : bytes;
      };
      const events: import("../src/stems/types.js").StemProgress[] = [];
      let returnedDescriptor: unknown;
      const opening = store.openSource(expected, {
        onProgress: (event) => events.push(event),
      }).then((descriptor) => {
        returnedDescriptor = descriptor;
        throw new Error("short warm payload read unexpectedly succeeded");
      });
      await assert.rejects(opening, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.corrupt");
      const target = backend.payloadReads.find((read) => faultKind === "full" ? read.end - read.start === warmReadBytes && read.returned < warmReadBytes : read.end - read.start < warmReadBytes);
      assert.ok(target);
      assert.equal(target.returned, target.end - target.start - 1);
      assert.equal(returnedDescriptor, undefined);
      assert.equal(events.some((event) => event.stage === "source-ready"), false);
      assert.equal(events.some((event) => event.stage === "ready"), false);
      assert.equal(events.some((event) => event.verificationTiming !== undefined), false);
      await store.close();
    }
  });

  it("refuses tampered warm bytes and stops after cancellation of a deferred read", async () => {
    const tamperedBackend = new RecordingPayloadBackend();
    const tampered = await primeLargeWarmStore(tamperedBackend, "warm-tampered");
    tamperedBackend.fault = (bytes, _start, _end, readCount) => {
      if (readCount > 0) bytes[0] = (bytes[0] ?? 0) ^ 1;
      return bytes;
    };
    const tamperedEvents: import("../src/stems/types.js").StemProgress[] = [];
    await assert.rejects(tampered.store.openSource(tampered.expected, {
      onProgress: (event) => tamperedEvents.push(event),
    }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.corrupt");
    assert.ok(tamperedBackend.payloadReads.length >= 2);
    assert.equal(tamperedEvents.some((event) => event.stage === "source-ready"), false);
    assert.equal(tamperedEvents.some((event) => event.verificationTiming !== undefined), false);
    await tampered.store.close();

    const cancelledBackend = new RecordingPayloadBackend();
    const cancelled = await primeLargeWarmStore(cancelledBackend, "warm-cancelled-read");
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    cancelledBackend.fault = async (bytes, start, end, readCount) => {
      if (readCount === 0 && start === 0 && end === 512 * 1024) {
        entered.resolve();
        await release.promise;
      }
      return bytes;
    };
    const cancelledEvents: import("../src/stems/types.js").StemProgress[] = [];
    const opening = cancelled.store.openSource(cancelled.expected, {
      signal: controller.signal,
      onProgress: (event) => cancelledEvents.push(event),
    });
    await entered.promise;
    controller.abort(new DOMException("warm read cancelled", "AbortError"));
    release.resolve();
    await assert.rejects(opening, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
    assert.equal(cancelledBackend.payloadReads.length, 1);
    assert.equal(cancelledEvents.some((event) => event.stage === "source-ready"), false);
    assert.equal(cancelledEvents.some((event) => event.verificationTiming !== undefined), false);
    await cancelled.store.close();
  });

  it("keeps ingest spans bounded at 128 KiB while allowing larger warm reads", async () => {
    const bytes = new Uint8Array(128 * 1024 + 4);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 19 + 7) % 251 + 1;
    const expected = expectation(bytes, bytes.byteLength / 6, { channels: 2, bitDepth: 24 });
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "ingest-span-bound" });
    await assert.rejects(store.installSource(expected, {
      resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }),
    }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration");
    assert.deepEqual(await backend.list(), []);
    await store.close();
  });

  it("rejects direct warm open when the final verification callback cancels", async () => {
    const bytes = new Uint8Array([1, 2]);
    const expected = expectation(bytes, 1);
    const store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "warm-final-direct" });
    await store.installSource(expected, { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) });
    const controller = new AbortController();
    const events: import("../src/stems/types.js").StemProgress[] = [];
    await assert.rejects(store.openSource(expected, {
      signal: controller.signal,
      onProgress: (event) => {
        events.push(event);
        if (event.stage === "verifying" && event.bytes === event.totalBytes) controller.abort("final byte");
      },
    }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
    assert.ok(events.some((event) => event.stage === "verifying" && event.bytes === event.totalBytes));
    assert.equal(events.some((event) => event.stage === "source-ready"), false);
    await store.close();
  });

  it("rejects warm sessions before publishing aliases after final verification cancellation", async () => {
    const bytes = new Uint8Array([1, 2]);
    const expected = expectation(bytes, 1);
    const store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "warm-final-session" });
    await store.installSource(expected, { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) });
    const controller = new AbortController();
    const events: import("../src/stems/types.js").StemProgress[] = [];
    await assert.rejects(store.openSession({
      leaseId: "warm-final-session",
      sources: [{ ...expected, sourceId: "left" }, { ...expected, sourceId: "right" }],
      signal: controller.signal,
      onProgress: (event) => {
        events.push(event);
        if (event.stage === "verifying" && event.bytes === event.totalBytes) controller.abort("final byte");
      },
    }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
    assert.ok(events.some((event) => event.stage === "verifying" && event.bytes === event.totalBytes));
    assert.equal(events.some((event) => event.stage === "source-ready"), false);
    assert.equal(events.some((event) => event.stage === "ready"), false);
    await store.close();
  });

  it("forwards resolver progress context and emits one ready proof per alias", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const expected = expectation(bytes, 2);
    const store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "progress-alias" });
    const events: import("../src/stems/types.js").StemProgress[] = [];
    let contextSeen = false;
    const lease = await store.openSession({
      leaseId: "progress-alias",
      sources: [{ ...expected, sourceId: "left" }, { ...expected, sourceId: "right" }],
      resolve: async (_source, _signal, context) => {
        contextSeen = typeof context?.onProgress === "function";
        context?.onProgress?.({ stage: "probing", identity: expected.identity, bytes: 0, totalBytes: expected.canonicalBytes, byteKind: "flac" });
        return { spans: spans({ startFrame: 0, bytes }) };
      },
      onProgress: (event) => events.push(event),
    });
    assert.equal(contextSeen, true);
    const readySources = events.filter((event): event is Extract<typeof event, { stage: "source-ready" }> => event.stage === "source-ready");
    assert.deepEqual(readySources.map((event) => event.sourceId), ["left", "right"]);
    assert.deepEqual(events.filter((event) => event.stage === "ready").map((event) => [event.sourcesReady, event.sourcesTotal]), [[2, 2]]);
    assert.ok(events.find((event) => event.stage === "probing" && event.identity === expected.identity));
    await lease.close();
    await store.close();
  });

  it("waits for native epoch release before aggregate readiness", async () => {
    const expected = expectation(new Uint8Array(2), 1);
    const events: import("../src/stems/types.js").StemProgress[] = [];
    const lifecycle: string[] = [];
    const resolver = async () => ({ spans: spans() });
    registerSparseResolver(resolver, {
      concurrency: 1,
      pool: {
        canRetain: true,
        retain: () => ({
          release: async () => {
            lifecycle.push("physical-release");
            throw new Error("physical termination failed");
          },
        }),
      },
    });
    const store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "release-before-ready" });
    await assert.rejects(store.openSession({
      leaseId: "release-before-ready",
      sources: [{ ...expected, sourceId: "source" }],
      resolve: resolver,
      onProgress: (event) => events.push(event),
    }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.corrupt");
    const sourceReady = events.findIndex((event) => event.stage === "source-ready");
    const physicalRelease = lifecycle.indexOf("physical-release");
    assert.ok(sourceReady >= 0, "a committed source remains observable");
    assert.equal(events.some((event) => event.stage === "ready"), false, "aggregate readiness waits for physical release");
    assert.ok(physicalRelease >= 0, "the retained epoch was physically released");
    await store.close();
  });

  it("uses native sparse scheduling for bounded parallel sources while wrappers stay sequential", async () => {
    const first = expectation(new Uint8Array(4), 2);
    const second = expectation(new Uint8Array(6), 3);
    const packages = new Map([
      ["first", emptySparsePackage(first)],
      ["second", emptySparsePackage(second)],
    ]);
    let active = 0;
    let peak = 0;
    const resolver = createSparseStemResolver({
      locate: (identity) => `https://fixture.invalid/${identity === first.identity ? "first" : "second"}`,
      fetch: async (input) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        const key = new URL(String(input)).pathname.slice(1);
        active -= 1;
        return new Response(responseBody(packages.get(key)), { status: 200 });
      },
      createWorker: () => { throw new Error("silent sources must not create workers"); },
      hardwareConcurrency: 3,
    });
    const parallelStore = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "native-parallel" });
    const parallelLease = await parallelStore.openSession({
      leaseId: "native-parallel",
      sources: [{ ...first, sourceId: "first" }, { ...second, sourceId: "second" }],
      resolve: resolver,
    });
    assert.equal(peak, 2, "the registered native resolver uses its bounded processing width");
    await parallelLease.close();
    await parallelStore.close();

    active = 0;
    peak = 0;
    const wrapped = (expected: SparsePcmExpectation, signal: AbortSignal, context?: import("../src/stems/types.js").SparseStemResolverContext) => resolver(expected, signal, context);
    const sequentialStore = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "wrapped-sequential" });
    const sequentialLease = await sequentialStore.openSession({
      leaseId: "wrapped-sequential",
      sources: [{ ...first, sourceId: "first" }, { ...second, sourceId: "second" }],
      resolve: wrapped,
    });
    assert.equal(peak, 1, "wrapping the native function does not claim private scheduling metadata");
    await sequentialLease.close();
    await sequentialStore.close();
  });

  it("charges concurrent native descriptors atomically and preserves earlier verified commits", async () => {
    const first = expectation(new Uint8Array(4), 2);
    const second = expectation(new Uint8Array(6), 3);
    const packages = new Map([
      [first.identity, emptySparsePackage(first)],
      [second.identity, emptySparsePackage(second)],
    ]);
    const events: import("../src/stems/types.js").StemProgress[] = [];
    const resolver = createSparseStemResolver({
      locate: (identity) => `https://fixture.invalid/${identity.slice(7)}`,
      fetch: async (input) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        const identity = new URL(String(input)).pathname.slice(1);
        return new Response(responseBody(packages.get(`blake3:${identity}`)), { status: 200 });
      },
      createWorker: () => { throw new Error("silent sources must not create workers"); },
      hardwareConcurrency: 3,
    });
    const sourceIds = ["first", "second"] as const;
    const declarationBytes = 2 * "metadata".length + sourceIds.reduce((sum, sourceId) => sum + 256 + 2 * sourceId.length, 0);
    const store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "metadata-race" });
    await assert.rejects(store.openSession({
      leaseId: "metadata",
      sources: [{ ...first, sourceId: sourceIds[0] }, { ...second, sourceId: sourceIds[1] }],
      maximumMetadataBytes: declarationBytes + 512,
      resolve: resolver,
      onProgress: (event) => events.push(event),
    }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration");
    assert.equal(events.some((event) => event.stage === "ready"), false);
    assert.ok(events.filter((event) => event.stage === "source-ready").length <= 1);
    assert.ok((await store.inspectSourcePresence(first)).status === "present" || (await store.inspectSourcePresence(second)).status === "present");
    await store.close();
  });

  it("interrupts an active native sparse sibling after the first source fails", async () => {
    const failing = expectation(new Uint8Array(4), 2);
    const slow = expectation(new Uint8Array(6), 3);
    const slowBody = emptySparsePackage(slow);
    let slowStarted = false;
    let slowCancelled = 0;
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const resolver = createSparseStemResolver({
      locate: (identity) => `https://fixture.invalid/${identity === failing.identity ? "failing" : "slow"}`,
      fetch: async (input) => {
        if (new URL(String(input)).pathname.slice(1) === "failing") return new Response(null, { status: 500 });
        slowStarted = true;
        releaseStarted();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(slowBody); },
          cancel() { slowCancelled += 1; },
        }), { status: 200 });
      },
      createWorker: () => { throw new Error("silent sources must not create workers"); },
      hardwareConcurrency: 3,
    });
    const store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "sibling-failure" });
    const opening = store.openSession({
      leaseId: "sibling-failure",
      sources: [{ ...failing, sourceId: "failing" }, { ...slow, sourceId: "slow" }],
      resolve: resolver,
    });
    let timer!: ReturnType<typeof setTimeout>;
    const sawSlow = await Promise.race([
      started.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 1_000); }),
    ]);
    clearTimeout(timer);
    assert.equal(sawSlow, true, "native bounded scheduling must admit the sibling before failure cleanup");
    await assert.rejects(opening, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.delivery.http");
    assert.equal(slowStarted, true);
    assert.ok(slowCancelled >= 1, "the sibling response body was physically cancelled");
    await store.close();
  });
});
