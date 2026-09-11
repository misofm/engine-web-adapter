import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { EngineWebAdapterError } from "../src/errors.js";
import { validateSparsePcmIndex, type SparsePcmIndex } from "../src/stems/sparse-pcm.js";
import { CanonicalPcmPump } from "../src/stems/pump.js";
import {
  MSB1_CONTROL,
  MSB1_CONTROL_BYTES,
  MSB1_HEADER_OFFSET,
  MSB1_SLOT_HEADER_BYTES,
  createMsb1Ring,
} from "../src/stems/ring.js";
import { PcmPumpWorkerClient, type PumpWorkerLike } from "../src/stems/worker-client.js";
import type { SparsePcmDescriptor } from "../src/stems/sparse-store.js";
import type { StemIdentity } from "../src/stems/types.js";
import type { PumpWorkerRequest, PumpWorkerResponse } from "../src/stems/worker-protocol.js";

const IDENTITY = `sha256:${"2".repeat(64)}` as StemIdentity;

interface Interval { readonly startFrame: number; readonly frames: number }

function packedDescriptor(options: {
  readonly identity?: StemIdentity;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frames: number;
  readonly intervals: readonly Interval[];
  readonly samples: readonly (readonly number[])[];
  readonly data?: Blob;
}): SparsePcmDescriptor {
  const frameBytes = options.channels * (options.bitDepth / 8);
  const bytes = new Uint8Array(options.intervals.reduce((total, interval) => total + interval.frames * frameBytes, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const interval of options.intervals) {
    for (let frame = interval.startFrame; frame < interval.startFrame + interval.frames; frame += 1) {
      const values = options.samples[frame] ?? [];
      for (let channel = 0; channel < options.channels; channel += 1) {
        const sample = values[channel] ?? 0;
        if (options.bitDepth === 16) view.setInt16(offset, sample, true);
        else {
          view.setUint8(offset, sample & 0xff);
          view.setUint8(offset + 1, (sample >> 8) & 0xff);
          view.setUint8(offset + 2, (sample >> 16) & 0xff);
        }
        offset += options.bitDepth / 8;
      }
    }
  }
  const data = options.data ?? new Blob([bytes]);
  const index = validateSparsePcmIndex({
    format: "miso_sparse_pcm_v1",
    identity: options.identity ?? IDENTITY,
    sampleRateHz: 48_000,
    channels: options.channels,
    bitDepth: options.bitDepth,
    frames: options.frames,
    intervals: options.intervals.map((interval, index) => ({
      startFrame: interval.startFrame,
      frames: interval.frames,
      byteOffset: options.intervals.slice(0, index).reduce((total, prior) => total + prior.frames * frameBytes, 0),
    })),
  }, data);
  return { kind: "sparse-pcm", data, index };
}

function source(
  sourceId: string,
  descriptor: SparsePcmDescriptor,
  ring: SharedArrayBuffer = createMsb1Ring({ sourceId, channels: descriptor.index.channels, frameCapacity: 2, capacity: 16 }),
) {
  return {
    sourceId,
    identity: descriptor.index.identity,
    sampleRateHz: descriptor.index.sampleRateHz,
    channels: descriptor.index.channels,
    bitDepth: descriptor.index.bitDepth,
    frames: descriptor.index.frames,
    ring,
  } as const;
}

function ringChunks(shared: SharedArrayBuffer): Array<{ start: bigint; frames: number; values: number[][]; generation: bigint; end: boolean }> {
  const control = new Int32Array(shared, 0, MSB1_CONTROL_BYTES / 4);
  const capacity = control[MSB1_CONTROL.CAPACITY]!;
  const channels = control[MSB1_CONTROL.CHANNELS]!;
  const frameCapacity = control[MSB1_CONTROL.FRAME_CAPACITY]!;
  const pcmOffset = control[MSB1_CONTROL.PCM_OFFSET]!;
  const headers = new Int32Array(shared, MSB1_HEADER_OFFSET, capacity * MSB1_SLOT_HEADER_BYTES / 4);
  const headers64 = new BigInt64Array(shared, MSB1_HEADER_OFFSET, capacity * MSB1_SLOT_HEADER_BYTES / 8);
  const wrote = Atomics.load(control, MSB1_CONTROL.WROTE);
  return Array.from({ length: wrote }, (_, sequence) => {
    const slot = sequence & (capacity - 1);
    const values = Array.from({ length: channels }, (_, channel) =>
      [...new Float32Array(shared, pcmOffset + (slot * channels + channel) * frameCapacity * 4, frameCapacity)]);
    return {
      start: headers64[slot * 4 + 3]!,
      frames: headers[slot * 8 + 2]!,
      generation: headers64[slot * 4 + 2]!,
      end: (headers[slot * 8 + 3]! & 1) !== 0,
      values,
    };
  });
}

function flatSamples(chunks: ReturnType<typeof ringChunks>, channels: 1 | 2): number[][] {
  const values: number[][] = [];
  for (const chunk of chunks) for (let frame = 0; frame < chunk.frames; frame += 1) {
    values.push(Array.from({ length: channels }, (_, channel) => chunk.values[channel]![frame]!));
  }
  return values;
}

class TrackingBlob extends Blob {
  slices = 0;
  override slice(start?: number, end?: number, contentType?: string): Blob {
    this.slices += 1;
    return super.slice(start, end, contentType);
  }
}

test("sparse pump matches the dense oracle across gaps, stereo 24-bit data and a partial tail", async () => {
  const samples = Array.from({ length: 12 }, (_, frame) => [frame < 3 ? (frame + 1) * 1000 : frame >= 7 && frame < 10 ? -frame * 1000 : 0]);
  const descriptor = packedDescriptor({ channels: 1, bitDepth: 16, frames: 12, intervals: [{ startFrame: 0, frames: 3 }, { startFrame: 7, frames: 3 }], samples });
  const ring = createMsb1Ring({ sourceId: "mono-gap", channels: 1, frameCapacity: 2, capacity: 16 });
  const pump = CanonicalPcmPump.createSparse({ assets: [descriptor], sources: [source("mono-gap", descriptor, ring)], windowFrames: 8 });
  const outcome = await pump.pumpUntilBlocked();
  assert.deepEqual(outcome, { chunks: 6, frames: 12, finished: true });
  assert.deepEqual(flatSamples(ringChunks(ring), 1), samples.map(([value]) => [value! / 32_768]));
  assert.equal(ringChunks(ring).at(-1)?.end, true);
  pump.close();

  const stereoSamples = [[0, 0], [0x123456, -0x123456], [0x234567, -0x234567], [0, 0], [0, 0], [-1, 1]];
  const stereo = packedDescriptor({ channels: 2, bitDepth: 24, frames: 6, intervals: [{ startFrame: 1, frames: 2 }, { startFrame: 5, frames: 1 }], samples: stereoSamples });
  const stereoRing = createMsb1Ring({ sourceId: "stereo-24", channels: 2, frameCapacity: 2, capacity: 8 });
  const stereoPump = CanonicalPcmPump.createSparse({ assets: [stereo], sources: [source("stereo-24", stereo, stereoRing)], windowFrames: 4 });
  await stereoPump.pumpUntilBlocked();
  assert.deepEqual(flatSamples(ringChunks(stereoRing), 2), stereoSamples.map(([left, right]) => [left! / 8_388_608, right! / 8_388_608]));
  stereoPump.close();
});

test("all-silent sparse windows allocate no active Blob read and preserve conservative scratch bounds", async () => {
  const data = new TrackingBlob([]);
  const descriptor = packedDescriptor({ channels: 1, bitDepth: 16, frames: 8, intervals: [], samples: [], data });
  const ring = createMsb1Ring({ sourceId: "silent", channels: 1, frameCapacity: 2, capacity: 8 });
  const pump = CanonicalPcmPump.createSparse({ assets: [descriptor], sources: [source("silent", descriptor, ring)], windowFrames: 4 });
  assert.equal(pump.maximumReadScratchBytes, 8);
  await pump.pumpUntilBlocked();
  assert.equal(data.slices, 0);
  assert.deepEqual(flatSamples(ringChunks(ring), 1), Array.from({ length: 8 }, () => [0]));
  pump.close();
});

test("pure gaps avoid I/O while an intersecting window performs one bounded packed read", async () => {
  const samples = Array.from({ length: 16 }, (_, frame) => [frame + 1]);
  const data = new TrackingBlob([pcm16(samples.slice(12).map(([value]) => value!))]);
  const descriptor = packedDescriptor({ channels: 1, bitDepth: 16, frames: 16, intervals: [{ startFrame: 12, frames: 4 }], samples, data });
  const ring = createMsb1Ring({ sourceId: "gaps", channels: 1, frameCapacity: 2, capacity: 16 });
  const pump = CanonicalPcmPump.createSparse({ assets: [descriptor], sources: [source("gaps", descriptor, ring)], windowFrames: 8 });
  await pump.pumpUntilBlocked();
  assert.equal(data.slices, 1);
  assert.deepEqual(flatSamples(ringChunks(ring), 1), samples.map((_, frame) => [frame < 12 ? 0 : (samples[frame]![0]! / 32_768)]));
  pump.close();
});

test("sparse aliases retain independent rings while acquiring one descriptor", async () => {
  const descriptor = packedDescriptor({ channels: 1, bitDepth: 16, frames: 4, intervals: [{ startFrame: 0, frames: 4 }], samples: [[1], [2], [3], [4]] });
  const firstRing = createMsb1Ring({ sourceId: "alias-a", channels: 1, frameCapacity: 2, capacity: 4 });
  const secondRing = createMsb1Ring({ sourceId: "alias-b", channels: 1, frameCapacity: 2, capacity: 4 });
  const pump = CanonicalPcmPump.createSparse({ assets: [descriptor], sources: [source("alias-a", descriptor, firstRing), source("alias-b", descriptor, secondRing)], windowFrames: 4 });
  await pump.pumpUntilBlocked();
  assert.deepEqual(flatSamples(ringChunks(firstRing), 1), [[1 / 32_768], [2 / 32_768], [3 / 32_768], [4 / 32_768]]);
  assert.deepEqual(flatSamples(ringChunks(secondRing), 1), [[1 / 32_768], [2 / 32_768], [3 / 32_768], [4 / 32_768]]);
  pump.close();
});

test("sparse admission rejects unsafe windows, malformed clone metadata and shape mismatches before engagement", () => {
  const descriptor = packedDescriptor({ channels: 1, bitDepth: 16, frames: 4, intervals: [{ startFrame: 0, frames: 4 }], samples: [[1], [2], [3], [4]] });
  const ring = createMsb1Ring({ sourceId: "invalid", channels: 1, frameCapacity: 2, capacity: 4 });
  assert.throws(() => CanonicalPcmPump.createSparse({ assets: [descriptor], sources: [source("invalid", descriptor, ring)], windowFrames: 8193 }), RangeError);
  assert.throws(() => CanonicalPcmPump.createSparse({ assets: [{ kind: "sparse-pcm", data: new Blob([new Uint8Array(8)]), index: { ...descriptor.index, activeBytes: 7 } }], sources: [source("invalid", descriptor, ring)] }), EngineWebAdapterError);
  assert.throws(() => CanonicalPcmPump.createSparse({ assets: [descriptor], sources: [{ ...source("invalid", descriptor, ring), channels: 2 }] }), EngineWebAdapterError);
});

test("sparse Worker client deduplicates identity reads and requires the reported scratch bound", async () => {
  const descriptor = packedDescriptor({ channels: 1, bitDepth: 16, frames: 4, intervals: [{ startFrame: 0, frames: 4 }], samples: [[1], [2], [3], [4]] });
  const firstRing = createMsb1Ring({ sourceId: "client-a", channels: 1, frameCapacity: 2, capacity: 4 });
  const secondRing = createMsb1Ring({ sourceId: "client-b", channels: 1, frameCapacity: 2, capacity: 4 });
  let reads = 0;
  const worker = new SparseFakeWorker();
  const client = await PcmPumpWorkerClient.createSparse({
    lease: { read: async () => { reads += 1; return descriptor; } },
    sources: [source("client-a", descriptor, firstRing), source("client-b", descriptor, secondRing)],
    worker,
    windowFrames: 4,
  });
  assert.equal(reads, 1);
  const initialize = worker.messages.find((message) => message.type === "initialize-sparse");
  assert.equal(initialize?.assets.length, 1);
  assert.equal(initialize?.sources.length, 2);
  assert.deepEqual(client.allocation, { windowFrames: 4, maximumWindowBytes: 32, maximumReadScratchBytes: 16 });
  await client.close();

  const badWorker = new SparseFakeWorker(false);
  await assert.rejects(PcmPumpWorkerClient.createSparse({
    lease: { read: async () => descriptor }, sources: [source("client-a", descriptor, firstRing)], worker: badWorker,
  }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.open");
  assert.equal(badWorker.terminated, true);

  const invalidOptionsWorker = new SparseFakeWorker();
  await assert.rejects(PcmPumpWorkerClient.createSparse({
    lease: { read: async () => descriptor }, sources: [source("client-a", descriptor, firstRing)], worker: invalidOptionsWorker, windowFrames: 8193,
  }), RangeError);
  assert.equal(invalidOptionsWorker.terminated, false, "invalid sparse options must be rejected before worker ownership begins");

  const stalled = new SparseFakeWorker(true, false);
  await assert.rejects(PcmPumpWorkerClient.createSparse({
    lease: { read: async () => descriptor }, sources: [source("client-a", descriptor, firstRing)], worker: stalled, requestDeadlineMs: 5,
  }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.read_deadline");
  assert.equal(stalled.terminated, true);
});

test("sparse pending windows retain generation ownership across seek and stop", async () => {
  const descriptor = packedDescriptor({ channels: 1, bitDepth: 16, frames: 8, intervals: [{ startFrame: 0, frames: 8 }], samples: Array.from({ length: 8 }, (_, frame) => [frame + 1]) });
  const entered = deferred<void>();
  const release = deferred<void>();
  let stalled = true;
  const delayed = new TrackingBlob([new Uint8Array(16)]);
  const originalSlice = delayed.slice.bind(delayed);
  delayed.slice = ((start?: number, end?: number, contentType?: string) => {
    const base = originalSlice(start, end, contentType);
    if (!stalled) return base;
    stalled = false;
    return { async arrayBuffer() { entered.resolve(); await release.promise; return base.arrayBuffer(); } } as Blob;
  }) as typeof delayed.slice;
  const ring = createMsb1Ring({ sourceId: "seek-stalled", channels: 1, frameCapacity: 2, capacity: 8 });
  const delayedDescriptor = { ...descriptor, data: delayed };
  const pump = CanonicalPcmPump.createSparse({ assets: [delayedDescriptor], sources: [source("seek-stalled", delayedDescriptor, ring)], windowFrames: 4 });
  const pending = pump.pumpPass(false);
  await entered.promise;
  assert.equal(await pump.seekFrames(3), 2n);
  release.resolve();
  await pending;
  assert.equal(new Int32Array(ring, 0, MSB1_CONTROL_BYTES / 4)[MSB1_CONTROL.WROTE], 0);
  await pump.pumpUntilBlocked();
  assert.ok(new Int32Array(ring, 0, MSB1_CONTROL_BYTES / 4)[MSB1_CONTROL.WROTE]! > 0);
  pump.close();

  const stopEntered = deferred<void>();
  const stopRelease = deferred<void>();
  const stopBlob = new TrackingBlob([new Uint8Array(16)]);
  const stopBase = stopBlob.slice.bind(stopBlob);
  stopBlob.slice = ((start?: number, end?: number, contentType?: string) => ({
    async arrayBuffer() { stopEntered.resolve(); await stopRelease.promise; return stopBase(start, end, contentType).arrayBuffer(); },
  })) as typeof stopBlob.slice;
  const stopRing = createMsb1Ring({ sourceId: "stop-stalled", channels: 1, frameCapacity: 2, capacity: 8 });
  const stopDescriptor = { ...descriptor, data: stopBlob };
  const stopping = CanonicalPcmPump.createSparse({ assets: [stopDescriptor], sources: [source("stop-stalled", stopDescriptor, stopRing)], windowFrames: 4 });
  const stopped = stopping.pumpPass(false);
  await stopEntered.promise;
  stopping.close();
  stopRelease.resolve();
  await stopped;
  assert.equal(new Int32Array(stopRing, 0, MSB1_CONTROL_BYTES / 4)[MSB1_CONTROL.WROTE], 0);
});

test("sparse Worker boundary admits a structured-cloned index and drives a ring", async () => {
  const descriptor = packedDescriptor({ channels: 1, bitDepth: 16, frames: 8, intervals: [{ startFrame: 2, frames: 2 }, { startFrame: 6, frames: 2 }], samples: Array.from({ length: 8 }, (_, frame) => [frame + 1]) });
  const ring = createMsb1Ring({ sourceId: "real-sparse-worker", channels: 1, frameCapacity: 2, capacity: 8 });
  const worker = new Worker(new URL("./worker-runner.js", import.meta.url));
  try {
    await onceMessage(worker, (message) => message?.type === "runner-ready");
    worker.postMessage({
      type: "initialize-sparse", requestId: 1, windowFrames: 4, generation: 1n, idleMs: 1,
      sources: [source("real-sparse-worker", descriptor, ring)], assets: [descriptor],
    } satisfies PumpWorkerRequest);
    const initialized = await onceMessage(worker, (message) => message?.type === "initialized");
    assert.equal(initialized.bounds.maximumReadScratchBytes, 8);
    for (let attempt = 0; attempt < 50 && Atomics.load(new Int32Array(ring, 0, MSB1_CONTROL_BYTES / 4), MSB1_CONTROL.WROTE) === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(Atomics.load(new Int32Array(ring, 0, MSB1_CONTROL_BYTES / 4), MSB1_CONTROL.WROTE) > 0);
    worker.postMessage({ type: "stop", requestId: 2 } satisfies PumpWorkerRequest);
    await onceMessage(worker, (message) => message?.type === "stopped");
  } finally { await worker.terminate(); }
});

function pcm16(samples: readonly number[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(samples.length * 2));
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

function onceMessage(worker: Worker, predicate: (message: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("pump worker message timed out")); }, 2_000);
    const onMessage = (message: any) => { if (predicate(message)) { cleanup(); resolve(message); } };
    const onError = (error: Error) => { cleanup(); reject(error); };
    function cleanup() { clearTimeout(timer); worker.off("message", onMessage); worker.off("error", onError); }
    worker.on("message", onMessage); worker.on("error", onError);
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class SparseFakeWorker implements PumpWorkerLike {
  readonly messages: PumpWorkerRequest[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  terminated = false;
  constructor(readonly validScratch = true, readonly replyInitialize = true) {}
  postMessage(message: PumpWorkerRequest): void {
    this.messages.push(message);
    if (this.replyInitialize && message.type === "initialize-sparse") queueMicrotask(() => this.emit("message", { data: {
      type: "initialized", requestId: message.requestId,
      bounds: { windowBytes: 32, ringBytes: message.sources.reduce((sum, item) => sum + item.ring.byteLength, 0), maximumReadScratchBytes: this.validScratch ? 16 : 0 },
    } satisfies PumpWorkerResponse }));
    if (message.type === "stop") queueMicrotask(() => this.emit("message", { data: { type: "stopped", requestId: message.requestId } satisfies PumpWorkerResponse }));
  }
  terminate(): void { this.terminated = true; }
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    const values = this.listeners.get(type) ?? new Set(); values.add(listener); this.listeners.set(type, values);
  }
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void { this.listeners.get(type)?.delete(listener); }
  private emit(type: string, event: any): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
}
