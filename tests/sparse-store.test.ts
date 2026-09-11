import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { EngineWebAdapterError } from "../src/errors.js";
import {
  MemoryStemStorageBackend,
  MemoryStemResolver,
  VerifiedSparsePcmStore,
  VerifiedStemStore,
  validateSparsePcmIndex,
  type SparsePcmExpectation,
} from "../src/stems/index.js";
import { acquireNamedLock } from "../src/stems/lock.js";
import { sparseSourceProgramForTest } from "../src/stems/sparse-store.js";

function expectation(bytes: Uint8Array, frames: number, shape: { readonly channels?: 1 | 2; readonly bitDepth?: 16 | 24 } = {}): SparsePcmExpectation {
  const channels = shape.channels ?? 1;
  const bitDepth = shape.bitDepth ?? 16;
  return {
    identity: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
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
});
