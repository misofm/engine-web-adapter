import { attachEngineFeed, prepareEngineFeed } from "../src/feed.js";
import { EngineWebAdapterError } from "../src/errors.js";
import { PcmFeedError } from "@misofm/engine/browser";
import { BUNDLED_ENGINE_ASSETS } from "@misofm/engine/assets";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { MSB1_CONTROL, Msb1RingWriter, createMsb1Ring } from "../src/stems/ring.js";

test("shipped prelude wraps Engine process and submits MSB1 through the synchronous Wasm ABI", async () => {
  const registrations = new Map<string, new () => any>();
  class AudioWorkletProcessorFake {
    readonly port = { onmessage: null as ((event: { data: unknown }) => void) | null };
  }
  const sandbox = {
    SharedArrayBuffer, Int32Array, BigInt64Array, Uint8Array, Float32Array, Atomics,
    TextDecoder,
    AudioWorkletProcessor: AudioWorkletProcessorFake,
    registerProcessor(name: string, constructor: new () => any) { registrations.set(name, constructor); },
  };
  Object.assign(sandbox, { globalThis: sandbox });
  const source = await readFile(BUNDLED_ENGINE_ASSETS.pcmFeedWorklet, "utf8");
  vm.runInNewContext(source, sandbox);

  const submissions: Array<{ generation: bigint; start: bigint; frames: number }> = [];
  const seekResults: number[] = [];
  class EngineProcessor {
    readonly quantumFrames = 4;
    readonly maximumSourceChannels = 1;
    readonly memoryBuffer = new ArrayBuffer(65_536);
    readonly sourceIdPointer = 0;
    readonly sourceIdCapacity = 128;
    readonly sourcePcm = new Float32Array(this.memoryBuffer, 1024, 4);
    readonly handle = 1;
    readonly ready = true;
    readonly disposed = false;
    readonly stickyResult = 0;
    readonly exports = {
      memory: { buffer: this.memoryBuffer },
      miso_engine_web_v1_source_seek: () => seekResults.shift() ?? 0,
      miso_engine_web_v1_source_submit: (_handle: number, _id: number, generation: bigint, start: bigint, _channels: number, frames: number) => {
        submissions.push({ generation, start, frames }); return 0;
      },
    };
    process() { return true; }
  }
  sandbox.registerProcessor("miso-engine-v1-audio-worklet", EngineProcessor);
  const Wrapped = registrations.get("miso-engine-v1-audio-worklet")!;
  const Attach = registrations.get("miso-sab-feed-attach")!;
  const engine = new Wrapped() as any;
  const attach = new Attach() as InstanceType<typeof AudioWorkletProcessorFake>;
  const ring = createMsb1Ring({ sourceId: "source", channels: 1, frameCapacity: 4, capacity: 2 });
  attach.port.onmessage?.({ data: { op: "attach", rings: [ring] } });
  const writer = new Msb1RingWriter(ring);
  writer.engage(1n);
  const planes = writer.reserve(4)!;
  planes[0]!.set([0, 0.25, -0.25, 1]);
  writer.commit({ generation: 1n, startFrame: 0n, frames: 4, endOfRegion: true });
  engine.process([], []);
  assert.deepEqual(submissions, [{ generation: 1n, start: 0n, frames: 4 }]);

  writer.seek(2n, 3n);
  seekResults.push(6, 0);
  engine.process([], []);
  const control = new Int32Array(ring);
  assert.equal(control[MSB1_CONTROL.SEEKS_APPLIED], 0);
  assert.equal(control[MSB1_CONTROL.REFUSED], 0, "seek backpressure is not a refusal");
  engine.process([], []);
  assert.equal(control[MSB1_CONTROL.SEEKS_APPLIED], 1, "unseen seek retries next process");
});

test("worklet drain contains no first-use typed-array or tail subview allocation", async () => {
  const source = await readFile(BUNDLED_ENGINE_ASSETS.pcmFeedWorklet, "utf8");
  const drain = source.slice(source.indexOf("drainSharedRing(ring)"), source.indexOf("/** The rings' way in"));
  assert.equal(/new Uint8Array\s*\(/u.test(drain), false);
  assert.equal(/\.subarray\s*\(/u.test(drain), false);
});

test("SDK feed errors translate by operation and retain their typed cause", async () => {
  await assert.rejects(prepareEngineFeed({ audioWorklet: { async addModule() { throw new Error("load"); } } }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "capability.audio_worklet"
      && error.cause instanceof PcmFeedError && error.cause.operation === "moduleLoad");
  const options = { context: {} as BaseAudioContext, sources: [{ sourceId: "a", channels: 1 as const }], quantumFrames: 4 };
  assert.throws(() => attachEngineFeed({ ...options, createNode: () => { throw new Error("node"); } }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.open"
      && error.cause instanceof PcmFeedError && error.cause.operation === "nodeCreate");
  let disconnected = 0;
  assert.throws(() => attachEngineFeed({ ...options, createNode: () => ({ port: { postMessage() { throw new Error("post"); } }, disconnect() { disconnected++; } }) }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.open"
      && error.cause instanceof PcmFeedError && error.cause.operation === "attachPost");
  assert.equal(disconnected, 1);
  const feed = attachEngineFeed({ ...options, createNode: () => ({ port: { postMessage() {} }, disconnect() { disconnected++; } }) });
  await assert.rejects(feed.ready({ timeoutMs: 0, now: () => 0 }), (error: unknown) => error instanceof EngineWebAdapterError
    && error.code === "session.open" && error.cause instanceof PcmFeedError && error.cause.operation === "readyTimeout");
  await assert.rejects(feed.ready(), (error: unknown) => error instanceof EngineWebAdapterError
    && error.code === "session.closed" && error.cause instanceof PcmFeedError && error.cause.operation === "closed");
  feed.close(); assert.equal(disconnected, 2);
});
