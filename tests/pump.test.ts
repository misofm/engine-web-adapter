import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { BUNDLED_ENGINE_ASSETS } from "@misofm/engine/assets";
import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { EngineWebAdapterError } from "../src/errors.js";
import { CanonicalPcmPump, SelfDrivingPcmPump } from "../src/stems/pump.js";
import {
  MSB1_CONTROL,
  MSB1_CONTROL_BYTES,
  MSB1_HEADER_OFFSET,
  MSB1_SLOT_HEADER_BYTES,
  createMsb1Ring,
} from "../src/stems/ring.js";
import { PcmPumpWorkerClient } from "../src/stems/worker-client.js";
import type { StemIdentity } from "../src/stems/types.js";
import type { PumpWorkerRequest, PumpWorkerResponse } from "../src/stems/worker-protocol.js";
import type { PumpWorkerLike } from "../src/stems/worker-client.js";

const IDENTITY = `sha256:${"1".repeat(64)}` as StemIdentity;

function pcm16(samples: readonly number[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(samples.length * 2));
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

function ring(sourceId: string, channels = 1, frameCapacity = 4, capacity = 4) {
  return createMsb1Ring({ sourceId, channels, frameCapacity, capacity });
}

test("pump memory is fixed rings plus explicit per-source windows", async () => {
  const bytes = pcm16(Array.from({ length: 1000 }, (_, index) => index));
  const shared = ring("bounded", 1, 4, 2);
  const blob = new TrackingBlob([bytes]);
  const pump = new CanonicalPcmPump({
    lease: { read: async () => blob },
    sources: [{ sourceId: "bounded", identity: IDENTITY, channels: 1, bitDepth: 16, frames: 1000, ring: shared }],
    windowFrames: 8,
  });
  assert.equal(pump.maximumWindowBytes, 16);
  assert.equal(pump.ringBytes, shared.byteLength);
  const outcome = await pump.pumpUntilBlocked();
  assert.deepEqual(outcome, { chunks: 2, frames: 8, finished: false });
  assert.ok(blob.maximumSliceBytes <= 16, "no read window exceeded the declared memory bound");
  assert.equal(new Int32Array(shared, 0, MSB1_CONTROL_BYTES / 4)[MSB1_CONTROL.WROTE], 2);
  pump.close();
});

test("one pass services multiple sources fairly", async () => {
  const bytes = pcm16(Array.from({ length: 32 }, (_, index) => index));
  const first = ring("first", 1, 4, 4);
  const second = ring("second", 1, 4, 4);
  const pump = new CanonicalPcmPump({
    lease: { read: async () => new Blob([bytes]) },
    sources: [
      { sourceId: "first", identity: IDENTITY, channels: 1, bitDepth: 16, frames: 32, ring: first },
      { sourceId: "second", identity: IDENTITY, channels: 1, bitDepth: 16, frames: 32, ring: second },
    ],
    windowFrames: 8,
  });
  assert.deepEqual(await pump.pumpPass(), { chunks: 2, frames: 8, finished: false });
  assert.equal(counter(first, MSB1_CONTROL.WROTE), 1);
  assert.equal(counter(second, MSB1_CONTROL.WROTE), 1);
  pump.close();
});

test("exported self-driver orders a delayed Blob tick before seek", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const bytes = pcm16(Array.from({ length: 16 }, (_, index) => index));
  const delayedBlob = {
    slice(first: number, last: number) {
      return { async arrayBuffer() { entered.resolve(); await release.promise; return bytes.slice(first, last).buffer; } };
    },
  } as unknown as Blob;
  const shared = ring("self-driver", 1, 4, 4);
  const pump = new CanonicalPcmPump({
    lease: { read: async () => delayedBlob },
    sources: [{ sourceId: "self-driver", identity: IDENTITY, channels: 1, bitDepth: 16, frames: 16, ring: shared }],
    windowFrames: 4,
  });
  const driver = new SelfDrivingPcmPump(pump, 1);
  driver.start();
  await entered.promise;
  const sought = driver.seekFrames(5);
  release.resolve();
  assert.equal(await sought, 2n);
  const headersI64 = new BigInt64Array(shared, MSB1_HEADER_OFFSET, 4 * MSB1_SLOT_HEADER_BYTES / 8);
  assert.equal(headersI64[2], 1n, "delayed old PCM must commit under its old generation");
  assert.equal(headersI64[3], 0n, "the old cursor must not be relabelled as the seek target");
  driver.close();
});

test("seek drops stale slots, emits quantum slots and retries ordinary backpressure", async () => {
  const bytes = pcm16([0, 1000, 2000, 3000, 4000, 5000]);
  const shared = ring("seekable", 1, 4, 2);
  const pump = new CanonicalPcmPump({
    lease: { read: async () => new Blob([bytes]) },
    sources: [{ sourceId: "seekable", identity: IDENTITY, channels: 1, bitDepth: 16, frames: 6, ring: shared }],
    windowFrames: 4,
  });
  await pump.pumpUntilBlocked();
  assert.equal(await pump.seekFrames(1), 2n);

  const accepted: Array<{ start: bigint; frames: number; values: number[]; end: boolean }> = [];
  let backpressureOnce = true;
  // Consume the SDK's actual worklet reader; the adapter has no second ring reader.
  const registrations = new Map<string, new () => any>();
  class AttachBase { readonly port = { onmessage: null as ((event: { data: unknown }) => void) | null }; }
  const sandbox = {
    SharedArrayBuffer, Int32Array, BigInt64Array, Uint8Array, Float32Array, Atomics, TextDecoder,
    AudioWorkletProcessor: AttachBase,
    registerProcessor(name: string, ctor: new () => any) { registrations.set(name, ctor); },
  };
  Object.assign(sandbox, { globalThis: sandbox });
  vm.runInNewContext(await readFile(BUNDLED_ENGINE_ASSETS.pcmFeedWorklet, "utf8"), sandbox);
  class EngineProcessor {
    readonly quantumFrames = 4; readonly maximumSourceChannels = 1;
    readonly memoryBuffer = new ArrayBuffer(65536);
    readonly sourceIdPointer = 0; readonly sourceIdCapacity = 128;
    readonly sourcePcm = new Float32Array(this.memoryBuffer, 1024, 4);
    readonly handle = 1; readonly ready = true; readonly disposed = false; readonly stickyResult = 0;
    readonly exports = {
      memory: { buffer: this.memoryBuffer },
      miso_engine_web_v1_source_seek: (_handle: number, _id: number, generation: bigint, frame: bigint) => {
        assert.equal(generation, 2n); assert.equal(frame, 1n); return 0;
      },
      miso_engine_web_v1_source_submit: (_handle: number, _id: number, _generation: bigint, start: bigint, _channels: number, frames: number, end: number) => {
        if (backpressureOnce) { backpressureOnce = false; return 6; }
        accepted.push({ start, frames, values: [...this.sourcePcm], end: end !== 0 }); return 0;
      },
    };
    process() { return true; }
  }
  sandbox.registerProcessor("miso-engine-v1-audio-worklet", EngineProcessor);
  const engine = new (registrations.get("miso-engine-v1-audio-worklet")!)();
  const attach = new (registrations.get("miso-sab-feed-attach")!)();
  attach.port.onmessage({ data: { op: "attach", rings: [shared] } });
  engine.process([], []);
  assert.equal(counter(shared, MSB1_CONTROL.STALE), 2);
  await pump.pumpUntilBlocked();
  engine.process([], []);
  assert.equal(counter(shared, MSB1_CONTROL.REFUSED), 0, "backpressure is flow control, not an Engine refusal");
  assert.equal(counter(shared, MSB1_CONTROL.WRITE_INDEX) - counter(shared, MSB1_CONTROL.READ_INDEX), 2, "backpressured slot remains queued");
  engine.process([], []);
  assert.deepEqual(accepted.map(({ start, frames, end }) => ({ start, frames, end })), [
    { start: 1n, frames: 4, end: false },
    { start: 5n, frames: 1, end: true },
  ]);
  assert.equal(accepted[0]!.values.length, 4);
  assert.deepEqual(accepted[1]!.values.slice(1), [0, 0, 0], "legal tail is zero padded to one quantum");
  assert.equal(counter(shared, MSB1_CONTROL.REFUSED), 0);
  pump.close(); attach.port.onmessage({ data: { op: "detach" } });
});

test("dedicated Worker keeps driving while the main realm is blocked and stops cleanly", async () => {
  const frames = 512;
  const bytes = pcm16(Array.from({ length: frames }, (_, index) => index));
  const shared = ring("worker", 1, 4, 128);
  const worker = new Worker(new URL("./worker-runner.js", import.meta.url));
  try {
    await onceMessage(worker, (message) => message?.type === "runner-ready");
    const initialize: PumpWorkerRequest = {
      type: "initialize", requestId: 1, windowFrames: 16, generation: 1n, idleMs: 1,
      sources: [{ sourceId: "worker", identity: IDENTITY, channels: 1, bitDepth: 16, frames, ring: shared, blob: new Blob([bytes]) }],
    };
    worker.postMessage(initialize);
    const waitWord = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(waitWord, 0, 0, 150);
    assert.ok(counter(shared, MSB1_CONTROL.WROTE) > 0, "Worker progressed during the main-realm block");
    worker.postMessage({ type: "stop", requestId: 2 } satisfies PumpWorkerRequest);
    await onceMessage(worker, (message) => message?.type === "stopped");
    assert.equal(counter(shared, MSB1_CONTROL.WRITER_STATE), 0);
  } finally {
    await worker.terminate();
  }
});

test("pump Worker client bounds requests and terminates on close/error/messageerror", async () => {
  const shared = ring("client", 1, 4, 2);
  const source = { sourceId: "client", identity: IDENTITY, channels: 1 as const, bitDepth: 16 as const, frames: 4, ring: shared };
  const lease = { read: async () => new Blob([new Uint8Array(8)]) };

  const stalled = new FakePumpWorker();
  await assert.rejects(
    PcmPumpWorkerClient.create({ lease, sources: [source], worker: stalled, requestDeadlineMs: 5 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "stem.read_deadline",
  );
  assert.equal(stalled.terminated, true);

  const closable = new FakePumpWorker(true);
  const client = await PcmPumpWorkerClient.create({ lease, sources: [source], worker: closable, requestDeadlineMs: 5 });
  await client.close();
  assert.equal(closable.terminated, true, "missing stop reply is bounded by deadline then terminated");

  for (const type of ["error", "messageerror"] as const) {
    const failing = new FakePumpWorker();
    const opening = PcmPumpWorkerClient.create({ lease, sources: [source], worker: failing, requestDeadlineMs: 100 });
    failing.emit(type, type === "error" ? { message: "worker died", error: new Error("worker died") } : {});
    await assert.rejects(opening);
    assert.equal(failing.terminated, true);
  }
});

test("timed-out seek fail-closes before rejection and makes delayed work inert", async () => {
  const shared = ring("timeout", 1, 4, 2);
  let applied = 0;
  const worker = new FakePumpWorker(true, (message, self) => {
    if (message.type !== "seek") return;
    setTimeout(() => {
      if (!self.terminated) applied += 1;
      self.forceLate({ type: "sought", requestId: message.requestId, generation: 2n });
    }, 25);
  });
  const client = await PcmPumpWorkerClient.create({
    lease: { read: async () => new Blob([new Uint8Array(8)]) },
    sources: [{ sourceId: "timeout", identity: IDENTITY, channels: 1, bitDepth: 16, frames: 4, ring: shared }],
    worker, requestDeadlineMs: 5,
  });
  let settlements = 0;
  const seeking = client.seekFrames(3).then(
    () => { settlements += 1; throw new Error("timed-out seek resolved"); },
    (error: unknown) => {
      settlements += 1;
      assert.equal(worker.terminated, true, "termination must be visible before public rejection");
      throw error;
    },
  );
  await assert.rejects(seeking, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.read_deadline");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(applied, 0, "terminated Worker cannot apply the rejected seek");
  assert.equal(settlements, 1, "late reply cannot settle the public promise again");
  assert.equal(worker.terminateCount, 1);
});

test("cancellation rejects every pending request once with one authoritative reason", async () => {
  const shared = ring("cancel-client", 1, 4, 2);
  const worker = new FakePumpWorker(true);
  const controller = new AbortController();
  const client = await PcmPumpWorkerClient.create({
    lease: { read: async () => new Blob([new Uint8Array(8)]) },
    sources: [{ sourceId: "cancel-client", identity: IDENTITY, channels: 1, bitDepth: 16, frames: 4, ring: shared }],
    worker, signal: controller.signal, requestDeadlineMs: 100,
  });
  let settlements = 0;
  const first = client.seekFrames(1).catch((error: unknown) => { settlements += 1; assert.equal(worker.terminated, true); throw error; });
  const second = client.seekFrames(2).catch((error: unknown) => { settlements += 1; assert.equal(worker.terminated, true); throw error; });
  const reason = new DOMException("cancelled by caller", "AbortError");
  controller.abort(reason);
  const results = await Promise.allSettled([first, second]);
  assert.equal(worker.terminateCount, 1);
  assert.equal(settlements, 2);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason, reason);
  }
  worker.forceLate({ type: "sought", requestId: 2, generation: 2n });
  worker.forceLate({ type: "sought", requestId: 3, generation: 3n });
  await Promise.resolve();
  assert.equal(settlements, 2, "late replies after cancellation are inert");
});

test("constructor abort after initialized reply cannot return a closed client", async () => {
  const shared = ring("constructor-race", 1, 4, 2);
  const controller = new AbortController();
  const reason = new DOMException("abort after initialized", "AbortError");
  const worker = new FakePumpWorker(false, (message, self) => {
    if (message.type !== "initialize") return;
    queueMicrotask(() => {
      self.emit("message", { data: {
        type: "initialized", requestId: message.requestId,
        bounds: { windowBytes: 8, ringBytes: message.sources[0]!.ring.byteLength },
      } satisfies PumpWorkerResponse });
      controller.abort(reason);
    });
  });
  let escaped = false;
  const opening = PcmPumpWorkerClient.create({
    lease: { read: async () => new Blob([new Uint8Array(8)]) },
    sources: [{ sourceId: "constructor-race", identity: IDENTITY, channels: 1, bitDepth: 16, frames: 4, ring: shared }],
    worker, signal: controller.signal, requestDeadlineMs: 100,
  }).then(
    (client) => { escaped = true; return client; },
    (error: unknown) => { assert.equal(worker.terminated, true); throw error; },
  );
  await assert.rejects(opening, (error: unknown) => error === reason);
  assert.equal(escaped, false, "create must not expose the already terminated client");
  assert.equal(worker.terminateCount, 1);
});

test("successful Worker seek and close remain unchanged", async () => {
  const shared = ring("success-client", 1, 4, 2);
  const worker = new FakePumpWorker(true, (message, self) => {
    if (message.type === "seek") self.reply({ type: "sought", requestId: message.requestId, generation: 7n });
    if (message.type === "stop") self.reply({ type: "stopped", requestId: message.requestId });
  });
  const client = await PcmPumpWorkerClient.create({
    lease: { read: async () => new Blob([new Uint8Array(8)]) },
    sources: [{ sourceId: "success-client", identity: IDENTITY, channels: 1, bitDepth: 16, frames: 4, ring: shared }],
    worker, requestDeadlineMs: 100,
  });
  assert.equal(await client.seekFrames(2), 7n);
  const closing = client.close();
  await assert.rejects(client.seekFrames(3), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.closed");
  await Promise.all([closing, client.close()]);
  assert.equal(worker.terminateCount, 1);
});

function counter(shared: SharedArrayBuffer, word: number): number {
  return Atomics.load(new Int32Array(shared, 0, MSB1_CONTROL_BYTES / 4), word);
}

function onceMessage(worker: Worker, predicate: (message: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("worker message timed out")); }, 2000);
    const onMessage = (message: any) => { if (predicate(message)) { cleanup(); resolve(message); } };
    const onError = (error: Error) => { cleanup(); reject(error); };
    function cleanup() { clearTimeout(timer); worker.off("message", onMessage); worker.off("error", onError); }
    worker.on("message", onMessage); worker.on("error", onError);
  });
}

class TrackingBlob extends Blob {
  maximumSliceBytes = 0;
  override slice(start?: number, end?: number, contentType?: string): Blob {
    this.maximumSliceBytes = Math.max(this.maximumSliceBytes, (end ?? this.size) - (start ?? 0));
    return super.slice(start, end, contentType);
  }
}

class FakePumpWorker implements PumpWorkerLike {
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly historicalMessages = new Set<(event: any) => void>();
  terminated = false;
  terminateCount = 0;
  constructor(
    readonly answerInitialize = false,
    readonly onPost?: (message: PumpWorkerRequest, worker: FakePumpWorker) => void,
  ) {}
  postMessage(message: PumpWorkerRequest): void {
    if (this.answerInitialize && message.type === "initialize") {
      this.reply({ type: "initialized", requestId: message.requestId, bounds: { windowBytes: 8, ringBytes: message.sources[0]!.ring.byteLength } });
      return;
    }
    this.onPost?.(message, this);
  }
  terminate(): void { this.terminated = true; this.terminateCount += 1; }
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners);
    if (type === "message") this.historicalMessages.add(listener);
  }
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: any): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  reply(message: PumpWorkerResponse): void { queueMicrotask(() => this.emit("message", { data: message })); }
  forceLate(message: PumpWorkerResponse): void { for (const listener of this.historicalMessages) listener({ data: message }); }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
