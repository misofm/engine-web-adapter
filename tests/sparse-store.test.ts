import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { EngineWebAdapterError } from "../src/errors.js";
import {
  MemoryStemStorageBackend,
  MemoryStemResolver,
  OpfsStorageBackend,
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
});
