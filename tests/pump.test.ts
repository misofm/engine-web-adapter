import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  CanonicalPcmPump,
  MSB1_CONTROL,
  MSB1_CONTROL_BYTES,
  Msb1RingReader,
  createMsb1Ring,
} from "../src/stems/index.js";
import type { EngineSourceSink, PumpWorkerRequest, StemIdentity } from "../src/stems/index.js";

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

test("seek drops stale slots, emits quantum slots and retries ordinary backpressure", async () => {
  const bytes = pcm16([0, 1000, 2000, 3000, 4000, 5000]);
  const shared = ring("seekable", 1, 4, 2);
  const reader = new Msb1RingReader(shared);
  const pump = new CanonicalPcmPump({
    lease: { read: async () => new Blob([bytes]) },
    sources: [{ sourceId: "seekable", identity: IDENTITY, channels: 1, bitDepth: 16, frames: 6, ring: shared }],
    windowFrames: 4,
  });
  await pump.pumpUntilBlocked();
  assert.equal(await pump.seekFrames(1), 2n);

  const accepted: Array<{ start: bigint; frames: number; values: number[]; end: boolean }> = [];
  let backpressureOnce = true;
  const sink: EngineSourceSink = {
    async seekSource(request) { assert.equal(request.generation, 2n); assert.equal(request.sourceFrame, 1n); return { result: 0 }; },
    async submitSource(request) {
      if (backpressureOnce) { backpressureOnce = false; return { result: 6 }; }
      accepted.push({
        start: request.startFrame, frames: request.frames,
        values: [...request.planes[0]!], end: request.endOfRegion,
      });
      return { result: 0 };
    },
  };
  await reader.drain(sink);
  assert.equal(reader.counters.stale, 2);
  await pump.pumpUntilBlocked();
  await reader.drain(sink);
  assert.equal(reader.counters.refused, 0, "backpressure is flow control, not an Engine refusal");
  assert.equal(reader.counters.occupancy, 2, "backpressured slot remains queued");
  await reader.drain(sink);
  assert.deepEqual(accepted.map(({ start, frames, end }) => ({ start, frames, end })), [
    { start: 1n, frames: 4, end: false },
    { start: 5n, frames: 1, end: true },
  ]);
  assert.equal(accepted[0]!.values.length, 4);
  assert.deepEqual(accepted[1]!.values.slice(1), [0, 0, 0], "legal tail is zero padded to one quantum");
  assert.equal(reader.counters.refused, 0);
  pump.close(); reader.detach();
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
