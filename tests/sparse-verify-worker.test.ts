import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createBLAKE3 } from "hash-wasm";

import { SparseVerifyWorkerPool } from "../src/stems/sparse-verify-worker-pool.js";
import { MemoryStemStorageBackend, VerifiedSparsePcmStore, createSparseStemResolver } from "../src/stems/index.js";
import {
  SPARSE_VERIFY_PROTOCOL_VERSION,
  sparseVerifyExpectedCounts,
  packSparseVerifyIntervals,
  sparseVerifyWorkerResponse,
  sparseVerifyWorkerStart,
} from "../src/stems/sparse-verify-worker-protocol.js";

interface ListenerWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void;
}

const previousWorker = (globalThis as unknown as { Worker?: unknown }).Worker;
const previousMessageChannel = (globalThis as unknown as { MessageChannel?: unknown }).MessageChannel;
const previousSelf = (globalThis as unknown as { self?: unknown }).self;

afterEach(() => {
  (globalThis as unknown as { Worker?: unknown }).Worker = previousWorker;
  (globalThis as unknown as { MessageChannel?: unknown }).MessageChannel = previousMessageChannel;
  (globalThis as unknown as { self?: unknown }).self = previousSelf;
});

describe("Sparse verification Worker transport", () => {
  it("bounds packed metadata and validates ordered scalar wire fields", () => {
    const index = {
      format: "miso_sparse_pcm_v1",
      identity: ("blake3:" + "a".repeat(64)) as `blake3:${string}`,
      sampleRateHz: 48_000,
      channels: 1 as const,
      bitDepth: 16 as const,
      frames: 5,
      intervals: [{ startFrame: 1, frames: 2, byteOffset: 0 }],
      activeBytes: 4,
      canonicalBytes: 10,
    } as const;
    const intervals = packSparseVerifyIntervals(index);
    assert.ok(intervals);
    const decoded = sparseVerifyWorkerStart({
      type: "start", version: SPARSE_VERIFY_PROTOCOL_VERSION, jobId: 1, generation: 1,
      identity: index.identity, frames: index.frames, channels: index.channels, bitDepth: index.bitDepth,
      frameBytes: 2, canonicalBytes: index.canonicalBytes, activeBytes: index.activeBytes,
      intervalCount: index.intervals.length, intervals, data: new Blob([new Uint8Array(4)]), readDeadlineMs: 100,
    });
    assert.equal(decoded.intervals.length, 3);
    assert.throws(() => sparseVerifyWorkerStart({
      type: "start", version: SPARSE_VERIFY_PROTOCOL_VERSION, jobId: 1, generation: 1,
      identity: index.identity, frames: index.frames, channels: index.channels, bitDepth: index.bitDepth,
      frameBytes: 2, canonicalBytes: index.canonicalBytes, activeBytes: index.activeBytes,
      intervalCount: 1, intervals: new Float64Array([1, 2, 1]).buffer, data: new Blob([new Uint8Array(4)]), readDeadlineMs: 100,
    }));
    const ceilingIntervals = Array.from({ length: 10_922 }, (_, index) => ({ startFrame: index, frames: 1, byteOffset: index * 2 }));
    const ceilingIndex = { ...index, frames: 10_922, intervals: ceilingIntervals, activeBytes: 10_922 * 2, canonicalBytes: 10_922 * 2 };
    assert.equal(packSparseVerifyIntervals(ceilingIndex)?.byteLength, 256 * 1024 - 16);
    const overCeiling = { ...ceilingIndex, frames: 10_923, intervals: [...ceilingIntervals, { startFrame: 10_922, frames: 1, byteOffset: 10_922 * 2 }], activeBytes: 10_923 * 2, canonicalBytes: 10_923 * 2 };
    assert.equal(packSparseVerifyIntervals(overCeiling), undefined);
  });

  it("reuses one slot, acknowledges progress, and rejects an active abort after termination", async () => {
    const workers: FakeVerifyWorker[] = [];
    (globalThis as unknown as { Worker: new () => ListenerWorker }).Worker = class extends FakeVerifyWorker {
      constructor() { super(); workers.push(this); }
    };
    const pool = new SparseVerifyWorkerPool({ width: 1 });
    const index = {
      format: "miso_sparse_pcm_v1" as const,
      identity: "blake3:" + "b".repeat(64) as `blake3:${string}`,
      sampleRateHz: 48_000,
      channels: 1 as const,
      bitDepth: 16 as const,
      frames: 4,
      intervals: [{ startFrame: 0, frames: 2, byteOffset: 0 }],
      activeBytes: 4,
      canonicalBytes: 8,
    };
    const run = (signal: AbortSignal) => pool.run({
      identity: index.identity, frames: index.frames, channels: index.channels, bitDepth: index.bitDepth,
      canonicalBytes: index.canonicalBytes, index, data: new Blob([new Uint8Array(4)]), readDeadlineMs: 500,
      signal,
    });
    const first = await run(new AbortController().signal);
    assert.equal(first.readBytes, 4);
    assert.equal(workers.length, 1);
    assert.equal(workers[0]!.acks, 1);
    const second = await run(new AbortController().signal);
    assert.equal(second.generation, 2);
    assert.equal(workers.length, 1);

    const controller = new AbortController();
    const pending = pool.run({
      identity: index.identity, frames: index.frames, channels: index.channels, bitDepth: index.bitDepth,
      canonicalBytes: index.canonicalBytes, index, data: new Blob([new Uint8Array(4)]), readDeadlineMs: 500,
      signal: controller.signal,
    });
    workers[0]!.hold = true;
    controller.abort();
    await assert.rejects(pending, /cancelled/u);
    assert.equal(workers[0]!.terminated, true);
    await pool.close();
  });

  it("cancels a held acknowledgement, ignores stale job and generation events, and retries fresh", async () => {
    const workers: RetryVerifyWorker[] = [];
    (globalThis as unknown as { Worker: new () => ListenerWorker }).Worker = class extends RetryVerifyWorker {
      constructor() {
        super(workers.length === 0);
        workers.push(this);
      }
    };
    const pool = new SparseVerifyWorkerPool({ width: 1 });
    const index = smallIndex();
    const controller = new AbortController();
    const first = pool.run(runOptions(index, controller.signal));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort(new DOMException("held progress cancelled", "AbortError"));
    await assert.rejects(first, /cancelled/u);
    assert.equal(workers.length, 1);
    workers[0]!.emitForTest({ data: completeMessage(index.identity, 1, 1) });

    const second = pool.run(runOptions(index, new AbortController().signal));
    workers[1]?.emitForTest({ data: completeMessage(index.identity, 1, 1) });
    workers[1]?.emitForTest({ data: completeMessage(index.identity, 2, 99) });
    const result = await second;
    assert.equal(result.generation, 1, "a fresh Worker retries at its own first generation");
    assert.equal(result.readCalls, 1);
    assert.equal(workers.length, 2);
    await pool.close();
  });

  it("runs the canonical worker loop for active, silent, mixed, and tail bytes with exact independent counts", async () => {
    const frames = 65_543;
    const frameBytes = 2;
    const intervals = [
      { startFrame: 1, frames: 1, byteOffset: 0 },
      { startFrame: 65_539, frames: 2, byteOffset: 2 },
    ];
    const payload = new Uint8Array([11, 12, 21, 22, 23, 24]);
    const canonical = new Uint8Array(frames * frameBytes);
    canonical.set(payload.subarray(0, 2), frameBytes);
    canonical.set(payload.subarray(2), 65_539 * frameBytes);
    const hasher = await createBLAKE3(256);
    const identity = `blake3:${hasher.init().update(canonical).digest("hex")}` as `blake3:${string}`;
    const index = { format: "miso_sparse_pcm_v1" as const, identity, sampleRateHz: 48_000, channels: 1 as const, bitDepth: 16 as const, frames, intervals, activeBytes: payload.byteLength, canonicalBytes: canonical.byteLength };
    // Keep the oracle independent of the production helper: this fixture has
    // one 2-byte active read, one 4-byte active read, and five zero updates:
    // one leading 2-byte update, three updates for the 131074-byte middle
    // gap, and one trailing 4-byte update.
    const expectedCounts = { readCalls: 2, zeroUpdates: 5, hashUpdates: 7 };
    const packed = packSparseVerifyIntervals(index);
    assert.ok(packed);
    const messages: any[] = [];
    const workerScope: any = {
      onmessage: null,
      postMessage(message: any) {
        messages.push(message);
        if (message.type === "progress") workerScope.onmessage({ data: { type: "ack", version: SPARSE_VERIFY_PROTOCOL_VERSION, jobId: message.jobId, generation: message.generation, bytes: message.bytes } });
      },
      close() {},
    };
    (globalThis as unknown as { self?: unknown }).self = workerScope;
    await import(`../src/internal/engine-web-sparse-verify-worker.js?worker-loop-${Date.now()}`);
    workerScope.onmessage({ data: {
      type: "start", version: SPARSE_VERIFY_PROTOCOL_VERSION, jobId: 1, generation: 1, identity,
      frames, channels: 1, bitDepth: 16, frameBytes, canonicalBytes: canonical.byteLength,
      activeBytes: payload.byteLength, intervalCount: intervals.length, intervals: packed,
      data: new Blob([payload]), readDeadlineMs: 1_000,
    } });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: () => void): void => {
        if (settled) return;
        settled = true;
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        clearTimeout(deadline);
        result();
      };
      const deadline = setTimeout(() => finish(() => reject(new Error("worker loop fixture timed out"))), 2_000);
      const poll = (): void => {
        if (settled) return;
        const failure = messages.find((message) => message.type === "failure");
        if (failure !== undefined) {
          const error = new Error(`worker loop fixture failed: ${failure.kind}: ${failure.message}`);
          finish(() => reject(error));
          return;
        }
        if (messages.some((message) => message.type === "complete")) {
          finish(resolve);
          return;
        }
        pollTimer = setTimeout(poll, 1);
      };
      poll();
    });
    const complete = messages.find((message) => message.type === "complete");
    assert.equal(complete.identity, identity);
    assert.equal(complete.digest, identity.slice(7));
    assert.equal(complete.readCalls, expectedCounts.readCalls);
    assert.equal(complete.zeroUpdates, expectedCounts.zeroUpdates);
    assert.equal(complete.hashUpdates, expectedCounts.hashUpdates);
    assert.equal(complete.readBytes, payload.byteLength);
    assert.equal(complete.hashedBytes, canonical.byteLength);
    assert.equal(complete.progressBytes, canonical.byteLength);
    assert.equal(messages.filter((message) => message.type === "progress").length >= 1, true);
  });

  it("hashes an empty silent source and a >512 KiB active interval with independent slices and tails", async () => {
    const silentFrames = 131_073;
    const silentCanonical = new Uint8Array(silentFrames * 2);
    const silentIdentity = await canonicalIdentity(silentCanonical);
    const silent = await runActualWorkerLoop({
      identity: silentIdentity,
      frames: silentFrames,
      frameBytes: 2,
      canonicalBytes: silentCanonical.byteLength,
      activeBytes: 0,
      intervals: [],
      data: new Blob(),
      readDeadlineMs: 250,
    });
    assert.equal(silent.complete?.digest, silentIdentity.slice(7));
    assert.deepEqual(
      { readCalls: silent.complete?.readCalls, zeroUpdates: silent.complete?.zeroUpdates, hashUpdates: silent.complete?.hashUpdates },
      { readCalls: 0, zeroUpdates: 5, hashUpdates: 5 },
    );
    assert.equal(silent.complete?.hashedBytes, silentCanonical.byteLength);

    const frameBytes = 2;
    const active = { startFrame: 3, frames: 262_149, byteOffset: 0 } as const;
    const frames = active.startFrame + active.frames + 5;
    const payload = new Uint8Array(active.frames * frameBytes);
    for (let index = 0; index < payload.byteLength; index += 1) payload[index] = (index * 31 + 17) % 251 + 1;
    const canonical = new Uint8Array(frames * frameBytes);
    canonical.set(payload, active.startFrame * frameBytes);
    const identity = await canonicalIdentity(canonical);
    const slices: Array<readonly [number, number]> = [];
    const reads: ReadBufferObservations = { buffers: [], lengths: [], beforeReadDetached: [] };
    const result = await runActualWorkerLoop({
      identity,
      frames,
      frameBytes,
      canonicalBytes: canonical.byteLength,
      activeBytes: payload.byteLength,
      intervals: [active],
      data: new RecordingSliceBlob([payload], slices, reads),
      readDeadlineMs: 250,
    });
    assert.equal(result.complete?.digest, identity.slice(7));
    assert.deepEqual(slices, [[0, 512 * 1024], [512 * 1024, payload.byteLength]]);
    assert.deepEqual(reads.lengths, [512 * 1024, payload.byteLength - 512 * 1024]);
    assert.deepEqual(reads.beforeReadDetached, [true, true]);
    assert.equal(reads.buffers.every((buffer) => isDetached(buffer)), true, "every consumed read buffer is detached at completion");
    assert.deepEqual(
      { readCalls: result.complete?.readCalls, zeroUpdates: result.complete?.zeroUpdates, hashUpdates: result.complete?.hashUpdates },
      { readCalls: 2, zeroUpdates: 2, hashUpdates: 4 },
    );
    assert.equal(result.complete?.readBytes, payload.byteLength);
    assert.equal(result.complete?.hashedBytes, canonical.byteLength);
    assert.equal(result.maxUnacknowledgedProgress, 1);
  });

  it("detaches short reads and preserves the primary consumption error when disposal also fails", async () => {
    const payload = new Uint8Array([8, 7, 6, 5]);
    const identity = await canonicalIdentity(payload);
    const shortBuffers: ArrayBuffer[] = [];
    const short = await runActualWorkerLoop({
      identity,
      frames: 2,
      frameBytes: 2,
      canonicalBytes: payload.byteLength,
      activeBytes: payload.byteLength,
      intervals: [{ startFrame: 0, frames: 2, byteOffset: 0 }],
      data: new FaultReadBlob([payload], "short", shortBuffers),
      readDeadlineMs: 250,
    });
    assert.equal(short.failure?.kind, "corrupt");
    assert.equal(shortBuffers.length, 1, "short-read consumption reached the Blob read");
    assert.equal(shortBuffers.every((buffer) => isDetached(buffer)), true);

    const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "transfer");
    assert.ok(descriptor);
    let transferCalls = 0;
    const nativeTransfer = descriptor.value as (this: ArrayBuffer, newByteLength?: number) => ArrayBuffer;
    try {
      Object.defineProperty(ArrayBuffer.prototype, "transfer", {
        value(this: ArrayBuffer, newByteLength?: number) {
          transferCalls += 1;
          if (transferCalls > 1) throw new Error("fixture disposal failed");
          return Reflect.apply(nativeTransfer, this, [newByteLength]);
        },
      });
      const primary = await runActualWorkerLoop({
        identity,
        frames: 2,
        frameBytes: 2,
        canonicalBytes: payload.byteLength,
        activeBytes: payload.byteLength,
        intervals: [{ startFrame: 0, frames: 2, byteOffset: 0 }],
        data: new FaultReadBlob([payload], "short"),
        readDeadlineMs: 250,
      });
      assert.equal(primary.failure?.kind, "corrupt", "short-read corruption remains primary over disposal failure");
      assert.ok(transferCalls >= 2);
    } finally {
      Object.defineProperty(ArrayBuffer.prototype, "transfer", descriptor);
    }
  });

  it("reports disposal-only failures as I/O and refuses worker-realm capability after dispatch", async () => {
    const payload = new Uint8Array([8, 7, 6, 5]);
    const identity = await canonicalIdentity(payload);
    const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "transfer");
    assert.ok(descriptor);
    const nativeTransfer = descriptor.value as (this: ArrayBuffer, newByteLength?: number) => ArrayBuffer;
    let transferCalls = 0;
    try {
      Object.defineProperty(ArrayBuffer.prototype, "transfer", {
        value(this: ArrayBuffer, newByteLength?: number) {
          transferCalls += 1;
          if (transferCalls > 1) throw new Error("fixture disposal failed");
          return Reflect.apply(nativeTransfer, this, [newByteLength]);
        },
      });
      const disposalFailure = await runActualWorkerLoop({
        identity,
        frames: 2,
        frameBytes: 2,
        canonicalBytes: payload.byteLength,
        activeBytes: payload.byteLength,
        intervals: [{ startFrame: 0, frames: 2, byteOffset: 0 }],
        data: new Blob([payload]),
        readDeadlineMs: 250,
      });
      assert.equal(disposalFailure.failure?.kind, "io");
      assert.equal(disposalFailure.complete, undefined);
    } finally {
      Object.defineProperty(ArrayBuffer.prototype, "transfer", descriptor);
    }

    const transferDescriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "transfer");
    assert.ok(transferDescriptor);
    const slices: Array<readonly [number, number]> = [];
    try {
      Object.defineProperty(ArrayBuffer.prototype, "transfer", { ...transferDescriptor, value: undefined });
      const result = await runActualWorkerLoop({
        identity,
        frames: 2,
        frameBytes: 2,
        canonicalBytes: payload.byteLength,
        activeBytes: payload.byteLength,
        intervals: [{ startFrame: 0, frames: 2, byteOffset: 0 }],
        data: new RecordingSliceBlob([payload], slices),
        readDeadlineMs: 250,
      });
      assert.equal(result.failure?.kind, "boundary", "worker-realm capability failure is typed at the worker boundary");
      assert.equal(result.complete, undefined);
      assert.deepEqual(slices, [], "worker-realm capability failure does not dispatch a payload read or local retry");
    } finally {
      Object.defineProperty(ArrayBuffer.prototype, "transfer", transferDescriptor);
    }

    const lateBuffers: ArrayBuffer[] = [];
    const late = await runActualWorkerLoop({
      identity,
      frames: 2,
      frameBytes: 2,
      canonicalBytes: payload.byteLength,
      activeBytes: payload.byteLength,
      intervals: [{ startFrame: 0, frames: 2, byteOffset: 0 }],
      data: new DelayedReadBlob([payload], 30, lateBuffers),
      readDeadlineMs: 5,
    });
    assert.equal(late.failure?.kind, "deadline");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(late.complete, undefined);
    assert.equal(lateBuffers.length, 1);
    assert.equal(lateBuffers.every((buffer) => isDetached(buffer)), true, "late settled reads are disposed without hashing");
  });

  it("uses local fallback when main-realm transfer capability is absent without constructing a Worker", async () => {
    const previousWorker = (globalThis as unknown as { Worker?: unknown }).Worker;
    const workers: FakeVerifyWorker[] = [];
    (globalThis as unknown as { Worker: new () => ListenerWorker }).Worker = class extends FakeVerifyWorker {
      constructor() { super(); workers.push(this); }
    };
    const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "transfer");
    assert.ok(descriptor);
    let pool: SparseVerifyWorkerPool | undefined;
    let store: VerifiedSparsePcmStore | undefined;
    let lease: { close: () => Promise<void>; read: (identity: any) => Promise<{ index: any }> } | undefined;
    try {
      Object.defineProperty(ArrayBuffer.prototype, "transfer", { ...descriptor, value: undefined });
      pool = new SparseVerifyWorkerPool({ width: 1 });
      assert.equal(pool.canRun(smallIndex()), false);
      await assert.rejects(pool.run(runOptions(smallIndex(), new AbortController().signal)), (error: unknown) => error instanceof Error && "kind" in error && error.kind === "boundary");
      assert.equal(workers.length, 0);
      const index = smallIndex();
      const active = new Uint8Array([1, 2, 3, 4]);
      const canonical = new Uint8Array(index.canonicalBytes);
      canonical.set(active);
      const expected = { identity: await canonicalIdentity(canonical), sampleRateHz: 48_000, channels: 1 as const, bitDepth: 16 as const, frames: index.frames, canonicalBytes: index.canonicalBytes };
      store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "missing-transfer-fallback" });
      await store.installSource(expected, { resolve: async () => ({ spans: (async function*() { yield { startFrame: 0, bytes: active }; })() }) });
      const events: any[] = [];
      lease = await store.openSession({
        leaseId: "missing-transfer-fallback",
        sources: [{ ...expected, sourceId: "source" }],
        resolve: createSparseStemResolver({ locate: () => "https://fixture.invalid/missing-transfer-fallback", hardwareConcurrency: 2, maximumWorkers: 1, memoryBudgetBytes: 12 * 1024 * 1024 }),
        onProgress: (event) => events.push(event),
      });
      assert.equal(events.some((event) => event.verificationTiming !== undefined), true);
      assert.equal(events.filter((event) => event.stage === "ready").length, 1);
      assert.deepEqual((await lease.read(expected.identity)).index, {
        ...index,
        identity: expected.identity,
        intervals: [{ startFrame: 0, frames: 2, byteOffset: 0 }],
        activeBytes: 4,
      });
    } finally {
      await lease?.close().catch(() => undefined);
      await store?.close().catch(() => undefined);
      await pool?.close().catch(() => undefined);
      Object.defineProperty(ArrayBuffer.prototype, "transfer", descriptor);
      (globalThis as unknown as { Worker?: unknown }).Worker = previousWorker;
    }
  });

  it("maps actual worker short, I/O, and deadline reads to typed worker failures", async () => {
    const payload = new Uint8Array([8, 7, 6, 5]);
    const canonical = new Uint8Array(payload);
    const identity = await canonicalIdentity(canonical);
    const cases = [
      { mode: "short" as const, kind: "corrupt" as const },
      { mode: "io" as const, kind: "io" as const },
      { mode: "deadline" as const, kind: "deadline" as const },
    ];
    for (const item of cases) {
      const result = await runActualWorkerLoop({
        identity,
        frames: 2,
        frameBytes: 2,
        canonicalBytes: canonical.byteLength,
        activeBytes: canonical.byteLength,
        intervals: [{ startFrame: 0, frames: 2, byteOffset: 0 }],
        data: new FaultReadBlob([payload], item.mode),
        readDeadlineMs: item.mode === "deadline" ? 15 : 250,
      });
      assert.equal(result.failure?.kind, item.kind, item.mode);
    }
  });

  it("coalesces held progress, cancels the actual loop, and leaves no terminal delivery", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const frames = 100_003;
    const canonical = new Uint8Array(frames * 2);
    canonical.set(payload);
    const identity = await canonicalIdentity(canonical);
    const held = await runActualWorkerLoop({
      identity,
      frames,
      frameBytes: 2,
      canonicalBytes: canonical.byteLength,
      activeBytes: payload.byteLength,
      intervals: [{ startFrame: 0, frames: 2, byteOffset: 0 }],
      data: new Blob([payload]),
      readDeadlineMs: 250,
      holdAcknowledgement: true,
    });
    assert.equal(held.messages.filter((message) => message.type === "progress").length, 1);
    assert.equal(held.maxUnacknowledgedProgress, 1);
    assert.deepEqual(
      { readCalls: held.complete?.readCalls, zeroUpdates: held.complete?.zeroUpdates, hashUpdates: held.complete?.hashUpdates },
      { readCalls: 1, zeroUpdates: 4, hashUpdates: 5 },
    );
    const messages: any[] = [];
    let scope!: ActualWorkerScope;
    const result = await runActualWorkerLoop({
      identity,
      frames,
      frameBytes: 2,
      canonicalBytes: canonical.byteLength,
      activeBytes: payload.byteLength,
      intervals: [{ startFrame: 0, frames: 2, byteOffset: 0 }],
      data: new Blob([payload]),
      readDeadlineMs: 250,
      holdAcknowledgement: true,
      onScope: (value) => { scope = value; },
      onMessage: (message) => messages.push(message),
      cancelAfterFirstProgress: true,
    });
    assert.equal(result.complete, undefined);
    assert.equal(result.failure, undefined);
    assert.equal(messages.filter((message) => message.type === "progress").length, 1);
    assert.equal(result.maxUnacknowledgedProgress, 1);
    assert.ok(scope);
  });

  it("closes on failed termination without replacing a width-one slot or reusing its reservation", async () => {
    const workers: ThrowingTerminateWorker[] = [];
    (globalThis as unknown as { Worker: new () => ListenerWorker }).Worker = class extends ThrowingTerminateWorker {
      constructor() { super(); workers.push(this); }
    };
    const pool = new SparseVerifyWorkerPool({ width: 1 });
    const index = smallIndex();
    const firstController = new AbortController();
    const first = pool.run(runOptions(index, firstController.signal)).catch((error: unknown) => error);
    const queued = pool.run(runOptions(index, new AbortController().signal)).catch((error: unknown) => error);
    firstController.abort();
    const firstError = await first;
    const queuedError = await queued;
    assert.equal(firstError instanceof Error && "kind" in firstError && firstError.kind, "io");
    assert.equal(queuedError instanceof Error && "kind" in queuedError && queuedError.kind, "cancelled");
    assert.equal(workers.length, 1);
    await assert.rejects(pool.close());
    await assert.rejects(pool.run(runOptions(index, new AbortController().signal)));
  });

  it("classifies malformed and mismatched completion accounting as corruption while ignoring stale generations", async () => {
    assert.throws(() => sparseVerifyWorkerResponse({ type: "complete", version: SPARSE_VERIFY_PROTOCOL_VERSION, jobId: 1, generation: 1 }), /completion identity/u);
    const workers: ScriptedWorker[] = [];
    (globalThis as unknown as { Worker: new () => ListenerWorker }).Worker = class extends ScriptedWorker {
      constructor() { super(); workers.push(this); }
    };
    const index = smallIndex();
    const pool = new SparseVerifyWorkerPool({ width: 1 });
    const result = await pool.run(runOptions(index, new AbortController().signal)).catch((error: unknown) => error);
    assert.equal(result instanceof Error && "kind" in result && result.kind, "corrupt");
    assert.equal(workers.length, 1);
    await pool.close();
  });

  it("fails closed on injected job and generation exhaustion", async () => {
    const workers: FakeVerifyWorker[] = [];
    (globalThis as unknown as { Worker: new () => ListenerWorker }).Worker = class extends FakeVerifyWorker {
      constructor() { super(); workers.push(this); }
    };
    const index = smallIndex();
    const jobPool = new SparseVerifyWorkerPool({ width: 1 });
    jobPool.setCountersForTest({ nextJobId: Number.MAX_SAFE_INTEGER + 1 });
    await assert.rejects(jobPool.run(runOptions(index, new AbortController().signal)));
    await assert.rejects(jobPool.close());

    const generationPool = new SparseVerifyWorkerPool({ width: 1 });
    const first = await generationPool.run(runOptions(index, new AbortController().signal));
    assert.equal(first.readCalls, 1);
    generationPool.setCountersForTest({ nextGeneration: Number.MAX_SAFE_INTEGER });
    await assert.rejects(generationPool.run(runOptions(index, new AbortController().signal)));
    await assert.rejects(generationPool.close());
  });
});

function smallIndex() {
  return {
    format: "miso_sparse_pcm_v1" as const,
    identity: `blake3:${"b".repeat(64)}` as `blake3:${string}`,
    sampleRateHz: 48_000,
    channels: 1 as const,
    bitDepth: 16 as const,
    frames: 4,
    intervals: [{ startFrame: 0, frames: 2, byteOffset: 0 }],
    activeBytes: 4,
    canonicalBytes: 8,
  };
}

function runOptions(index: ReturnType<typeof smallIndex>, signal: AbortSignal) {
  return {
    identity: index.identity, frames: index.frames, channels: index.channels, bitDepth: index.bitDepth,
    canonicalBytes: index.canonicalBytes, index, data: new Blob([new Uint8Array(4)]), readDeadlineMs: 500, signal,
  };
}

function completeMessage(identity: `blake3:${string}`, jobId: number, generation: number): Record<string, unknown> {
  return {
    type: "complete", version: SPARSE_VERIFY_PROTOCOL_VERSION, jobId, generation,
    identity, digest: "0".repeat(64), progressBytes: 8, canonicalBytes: 8,
    readCalls: 1, readBytes: 4, hashedBytes: 8, hashUpdates: 2, zeroUpdates: 1,
    elapsedMs: 1, readWaitMs: 1, hashMs: 1,
  };
}

type ActualWorkerFailure = { readonly type: "failure"; readonly kind: string; readonly message: string };
type ActualWorkerScope = { onmessage: ((event: MessageEvent<unknown>) => void) | null };

interface ActualWorkerLoopOptions {
  readonly identity: `blake3:${string}`;
  readonly frames: number;
  readonly frameBytes: number;
  readonly canonicalBytes: number;
  readonly activeBytes: number;
  readonly intervals: readonly { readonly startFrame: number; readonly frames: number; readonly byteOffset: number }[];
  readonly data: Blob;
  readonly readDeadlineMs: number;
  readonly holdAcknowledgement?: boolean;
  readonly cancelAfterFirstProgress?: boolean;
  readonly onScope?: (scope: ActualWorkerScope) => void;
  readonly onMessage?: (message: any) => void;
}

interface ActualWorkerLoopResult {
  readonly complete: any | undefined;
  readonly failure: ActualWorkerFailure | undefined;
  readonly messages: readonly any[];
  readonly maxUnacknowledgedProgress: number;
}

async function runActualWorkerLoop(options: ActualWorkerLoopOptions): Promise<ActualWorkerLoopResult> {
  const packed = packSparseVerifyIntervals({
    format: "miso_sparse_pcm_v1",
    identity: options.identity,
    sampleRateHz: 48_000,
    channels: options.frameBytes === 2 ? 1 : 2,
    bitDepth: options.frameBytes === 2 ? 16 : 24,
    frames: options.frames,
    intervals: options.intervals,
    activeBytes: options.activeBytes,
    canonicalBytes: options.canonicalBytes,
  });
  assert.ok(packed);
  const messages: any[] = [];
  let pendingProgress = 0;
  let maxUnacknowledgedProgress = 0;
  let firstProgress = true;
  const workerScope: any = {
    onmessage: null,
    postMessage(message: any) {
      messages.push(message);
      options.onMessage?.(message);
      if (message.type !== "progress") return;
      pendingProgress += 1;
      maxUnacknowledgedProgress = Math.max(maxUnacknowledgedProgress, pendingProgress);
      if (options.cancelAfterFirstProgress && firstProgress) {
        firstProgress = false;
        queueMicrotask(() => workerScope.onmessage?.({ data: {
          type: "cancel", version: SPARSE_VERIFY_PROTOCOL_VERSION,
          jobId: message.jobId, generation: message.generation,
        } }));
        return;
      }
      if (options.holdAcknowledgement) return;
      queueMicrotask(() => {
        pendingProgress = Math.max(0, pendingProgress - 1);
        workerScope.onmessage?.({ data: {
          type: "ack", version: SPARSE_VERIFY_PROTOCOL_VERSION,
          jobId: message.jobId, generation: message.generation, bytes: message.bytes,
        } });
      });
    },
    close() {},
  };
  const scope = workerScope as ActualWorkerScope;
  options.onScope?.(scope);
  (globalThis as unknown as { self?: unknown }).self = workerScope;
  await import(`../src/internal/engine-web-sparse-verify-worker.js?actual-loop-${Date.now()}-${Math.random()}`);
  workerScope.onmessage({ data: {
    type: "start", version: SPARSE_VERIFY_PROTOCOL_VERSION, jobId: 1, generation: 1,
    identity: options.identity, frames: options.frames, channels: options.frameBytes === 2 ? 1 : 2,
    bitDepth: options.frameBytes === 2 ? 16 : 24, frameBytes: options.frameBytes,
    canonicalBytes: options.canonicalBytes, activeBytes: options.activeBytes,
    intervalCount: options.intervals.length, intervals: packed, data: options.data,
    readDeadlineMs: options.readDeadlineMs,
  } });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => finish(() => reject(new Error("actual worker loop fixture timed out"))), 1_000);
    const finish = (result: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      result();
    };
    const poll = (): void => {
      if (settled) return;
      if (messages.some((message) => message.type === "complete" || message.type === "failure")) {
        finish(resolve);
        return;
      }
      pollTimer = setTimeout(poll, 1);
    };
    poll();
  }).catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.includes("actual worker loop fixture timed out")) throw error;
  });
  return {
    complete: messages.find((message) => message.type === "complete"),
    failure: messages.find((message): message is ActualWorkerFailure => message.type === "failure"),
    messages,
    maxUnacknowledgedProgress,
  };
}

async function canonicalIdentity(bytes: Uint8Array): Promise<`blake3:${string}`> {
  const hasher = await createBLAKE3(256);
  return `blake3:${hasher.init().update(bytes).digest("hex")}`;
}

interface ReadBufferObservations {
  readonly buffers: ArrayBuffer[];
  readonly lengths: number[];
  readonly beforeReadDetached: boolean[];
}

class RecordingSliceBlob extends Blob {
  constructor(
    parts: BlobPart[],
    private readonly slices: Array<readonly [number, number]>,
    private readonly observations: ReadBufferObservations = { buffers: [], lengths: [], beforeReadDetached: [] },
  ) { super(parts); }
  override slice(start?: number, end?: number, contentType?: string): Blob {
    const actualStart = start ?? 0;
    const actualEnd = end ?? this.size;
    this.slices.push([actualStart, actualEnd]);
    return new RecordingSliceBlob([super.slice(start, end, contentType)], this.slices, this.observations);
  }
  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.observations.beforeReadDetached.push(this.observations.buffers.every((buffer) => isDetached(buffer)));
    const value = await super.arrayBuffer();
    this.observations.lengths.push(value.byteLength);
    this.observations.buffers.push(value);
    return value;
  }
}

function isDetached(buffer: ArrayBuffer): boolean {
  try { new Uint8Array(buffer); return false; }
  catch { return true; }
}

class FaultReadBlob extends Blob {
  constructor(parts: BlobPart[], private readonly mode: "short" | "io" | "deadline", private readonly buffers: ArrayBuffer[] = []) { super(parts); }
  override slice(start?: number, end?: number, contentType?: string): Blob {
    return new FaultReadBlob([super.slice(start, end, contentType)], this.mode, this.buffers);
  }
  override async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.mode === "io") throw new Error("fixture read I/O failure");
    if (this.mode === "deadline") await new Promise<never>(() => undefined);
    const bytes = new Uint8Array(await super.arrayBuffer());
    const value = this.mode === "short" ? bytes.slice(0, Math.max(0, bytes.byteLength - 1)).buffer : bytes.buffer;
    this.buffers.push(value);
    return value;
  }
}

class DelayedReadBlob extends Blob {
  constructor(
    parts: BlobPart[],
    private readonly delayMs: number,
    private readonly buffers: ArrayBuffer[],
  ) { super(parts); }
  override slice(start?: number, end?: number, contentType?: string): Blob {
    return new DelayedReadBlob([super.slice(start, end, contentType)], this.delayMs, this.buffers);
  }
  override async arrayBuffer(): Promise<ArrayBuffer> {
    const value = await super.arrayBuffer();
    return new Promise<ArrayBuffer>((resolve) => setTimeout(() => { this.buffers.push(value); resolve(value); }, this.delayMs));
  }
}

class FakeVerifyWorker implements ListenerWorker {
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  acks = 0;
  hold = false;
  terminated = false;
  identity = "blake3:" + "0".repeat(64);
  postMessage(message: any): void {
    if (message.type === "ack") {
      this.acks += 1;
      if (this.hold) return;
      queueMicrotask(() => this.emit({ data: {
        type: "complete", version: SPARSE_VERIFY_PROTOCOL_VERSION, jobId: message.jobId, generation: message.generation,
        identity: this.identity, digest: "0".repeat(64), progressBytes: 8, canonicalBytes: 8, readCalls: 1, readBytes: 4, hashedBytes: 8,
        hashUpdates: 2, zeroUpdates: 1,
        elapsedMs: 1, readWaitMs: 1, hashMs: 1,
      } }));
      return;
    }
    if (message.type !== "start") return;
    this.identity = message.identity;
    queueMicrotask(() => {
      this.emit({ data: { type: "progress", version: SPARSE_VERIFY_PROTOCOL_VERSION, jobId: message.jobId, generation: message.generation, bytes: 8 } });
    });
  }
  terminate(): void { this.terminated = true; }
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener); this.listeners.set(type, set);
  }
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void { this.listeners.get(type)?.delete(listener); }
  private emit(event: any): void { for (const listener of this.listeners.get("message") ?? []) listener(event); }
  emitForTest(event: any): void { this.emit(event); }
}

class RetryVerifyWorker extends FakeVerifyWorker {
  constructor(private readonly holdFirst: boolean) { super(); }
  override postMessage(message: any): void {
    if (message.type === "start" && this.holdFirst) {
      this.hold = true;
      this.identity = message.identity;
      queueMicrotask(() => this.emitForTest({ data: {
        type: "progress", version: SPARSE_VERIFY_PROTOCOL_VERSION,
        jobId: message.jobId, generation: message.generation, bytes: 8,
      } }));
      return;
    }
    super.postMessage(message);
  }
}

class ThrowingTerminateWorker extends FakeVerifyWorker {
  override terminate(): void { throw new Error("cannot terminate"); }
}

class ScriptedWorker extends FakeVerifyWorker {
  override postMessage(message: any): void {
    if (message.type !== "start") return super.postMessage(message);
    this.identity = message.identity;
    queueMicrotask(() => this.emitForTest({ data: { type: "complete", version: SPARSE_VERIFY_PROTOCOL_VERSION, jobId: message.jobId + 1, generation: message.generation, identity: this.identity, digest: "0".repeat(64), progressBytes: 8, canonicalBytes: 8, readCalls: 99, readBytes: 4, hashedBytes: 8, hashUpdates: 100, zeroUpdates: 1, elapsedMs: 1, readWaitMs: 1, hashMs: 1 } }));
    queueMicrotask(() => this.emitForTest({ data: { type: "complete", version: SPARSE_VERIFY_PROTOCOL_VERSION, jobId: message.jobId, generation: message.generation, identity: this.identity, digest: "0".repeat(64), progressBytes: 8, canonicalBytes: 8, readCalls: 99, readBytes: 4, hashedBytes: 8, hashUpdates: 100, zeroUpdates: 1, elapsedMs: 1, readWaitMs: 1, hashMs: 1 } }));
  }
  override emitForTest(event: any): void { (this as unknown as { emit: (event: any) => void }).emit(event); }
}
