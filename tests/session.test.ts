import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserEngine } from "@misofm/engine/browser";

import { EngineWebAdapterError, openEngineWebSession } from "../src/index.js";
import { assertEngineWebCapabilities } from "../src/capabilities.js";
import { MSB1_CONTROL } from "../src/stems/index.js";
import type { EngineAudioContext, EngineWebSessionOptions } from "../src/session-types.js";
import type { StemSessionLease, StemStore } from "../src/stems/index.js";

const IDENTITY = `sha256:${"a".repeat(64)}` as const;

test("capabilities refuse before store or resolver work", async () => {
  let opened = false;
  const store = { async open() { opened = true; return this; }, async openSession() { throw new Error("unreachable"); } } as StemStore;
  await assert.rejects(
    openEngineWebSession({
      ...baseOptions(), store,
      capabilityScope: { crossOriginIsolated: false },
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "capability.cross_origin_isolation",
  );
  assert.equal(opened, false);
});

test("every required browser capability has a stable typed refusal", () => {
  const cases: Array<[keyof ReturnType<typeof capabilities>, string]> = [
    ["crossOriginIsolated", "capability.cross_origin_isolation"],
    ["SharedArrayBuffer", "capability.shared_array_buffer"],
    ["Worker", "capability.module_worker"],
    ["AudioContext", "capability.audio_worklet"],
    ["AudioWorkletNode", "capability.audio_worklet"],
    ["navigator", "capability.opfs"],
    ["WebAssembly", "capability.simd128"],
  ];
  for (const [missing, code] of cases) {
    const scope = { ...capabilities(), [missing]: undefined };
    assert.throws(
      () => assertEngineWebCapabilities(scope),
      (error: unknown) => error instanceof EngineWebAdapterError && error.code === code,
    );
  }
  const noLocks = { ...capabilities(), navigator: { storage: { getDirectory() {} } } };
  assert.throws(
    () => assertEngineWebCapabilities(noLocks),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "capability.web_locks",
  );
});

test("session composes in order and serializes lifecycle with reverse cleanup", async () => {
  const events: string[] = [];
  const context = fakeContext(events);
  const lease: StemSessionLease = {
    leaseId: "lease",
    stems: [{ sourceId: "source", identity: IDENTITY, bytes: 8 }],
    async read() { return new Blob([new Uint8Array(8)]); },
    async close() { events.push("lease.close"); },
  };
  const store: StemStore = {
    async open() { return this; },
    async openSession() { events.push("store.openSession"); return lease; },
  };
  const node = {
    connect() { events.push("output.connect"); },
    disconnect() { events.push("output.disconnect"); },
  } as unknown as AudioWorkletNode;
  const host = {
    node,
    async sessionMap() { return { tracks: [], sources: [{ id: "source", channels: 1, frames: 4n }], metersAttached: false }; },
    async command() { return { ok: true, result: 0, code: "ok", reason: 0, reasonName: "none", rejectedIndex: 0, admitted: 0, appliedAtSample: 0n }; },
    async dispose() { events.push("host.dispose"); },
  } as unknown as BrowserEngine["host"];
  let pumpRings: readonly SharedArrayBuffer[] = [];
  const options: EngineWebSessionOptions = {
    ...baseOptions(), store,
    capabilityScope: capabilities(),
    createContext: () => context,
    scratchBoot: async () => {
      events.push("scratch");
      return { sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16, backend: "simd128", sources: [{ id: "source", channels: 1, frames: 4n }], tracks: [] };
    },
    createHost: async ({ context: engineContext }) => {
      assert.deepEqual((engineContext as unknown as typeof context).modules, ["feed-override.js"]);
      events.push("engine-worklet");
      return host;
    },
    createAttachNode: (_context, _name) => ({
      port: { postMessage(message: unknown) {
        const value = message as { op: string; rings?: SharedArrayBuffer[] };
        if (value.op === "attach") for (const ring of value.rings ?? []) Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1);
        else events.push("feed.detach");
      } },
      disconnect() { events.push("feed.disconnect"); },
    }),
    createPump: async ({ sources }) => {
      events.push("pump.create");
      pumpRings = sources.map((source) => source.ring);
      for (const ring of pumpRings) Atomics.store(new Int32Array(ring), MSB1_CONTROL.WROTE, 1);
      return {
        async seekFrames(frame) { events.push(`pump.seek:${frame}`); return 2n; },
        close() { events.push("pump.close"); },
      };
    },
    assets: { feedWorkletModuleUrl: "feed-override.js" },
  };

  const session = await openEngineWebSession(options);
  assert.equal(session.state, "ready");
  assert.ok(events.indexOf("store.openSession") < events.indexOf("scratch"));
  assert.ok(events.indexOf("scratch") < events.indexOf("engine-worklet"));
  assert.ok(events.indexOf("engine-worklet") < events.indexOf("pump.create"));
  assert.equal(pumpRings.length, 1);
  const playing = session.play();
  assert.equal(events.at(-1), "context.resume", "resume is invoked synchronously before play yields");
  await playing;
  await session.seekFrames(2);
  await session.pause();
  assert.equal(session.state, "paused");
  await session.close();
  await session.close();
  assert.equal(session.state, "closed");
  assert.deepEqual(events.slice(-8), [
    "context.suspend", "output.disconnect", "pump.close", "feed.detach",
    "feed.disconnect", "host.dispose", "context.close", "lease.close",
  ]);
  assert.equal(events.filter((event) => event === "lease.close").length, 1);
});

function baseOptions(): EngineWebSessionOptions {
  return {
    document: "{}", leaseId: "lease",
    sources: [{ id: "source", spec: { channels: 1, bitDepth: 16, frames: 4, content: IDENTITY } }],
    resolver: { async resolve() { throw new Error("resolver must not run in this test"); } },
  };
}

function capabilities(): NonNullable<EngineWebSessionOptions["capabilityScope"]> {
  return {
    crossOriginIsolated: true,
    SharedArrayBuffer,
    Worker: class {} as unknown as typeof Worker,
    AudioContext: class {} as unknown as typeof AudioContext,
    AudioWorkletNode: class {} as unknown as typeof AudioWorkletNode,
    WebAssembly: { validate: () => true },
    navigator: { storage: { getDirectory() {} }, locks: { request() {} } },
  };
}

function fakeContext(events: string[]): EngineAudioContext & { modules: string[] } {
  const modules: string[] = [];
  return {
    sampleRate: 48_000,
    renderQuantumSize: 4,
    state: "suspended",
    destination: {} as AudioNode,
    modules,
    audioWorklet: { async addModule(url) { modules.push(url); events.push("feed-prelude"); } },
    async resume() { events.push("context.resume"); },
    async suspend() { events.push("context.suspend"); },
    async close() { events.push("context.close"); },
  };
}
