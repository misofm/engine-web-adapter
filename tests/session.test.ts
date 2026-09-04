import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserEngine } from "@misofm/engine/browser";

import { EngineWebAdapterError, openEngineWebSession } from "../src/index.js";
import { assertEngineWebCapabilities } from "../src/capabilities.js";
import { MSB1_CONTROL } from "../src/stems/index.js";
import type { EngineAudioContext, EngineWebSessionCommonOptions, EngineWebSessionOptions } from "../src/session-types.js";
import type { StemResolver, StemSessionLease, StemStore } from "../src/stems/index.js";

const IDENTITY = `sha256:${"a".repeat(64)}` as const;
const IDENTITY_Z = `sha256:${"b".repeat(64)}` as const;

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

test("default module Worker handshake fails before store or resolver work", async () => {
  let storeOpened = false;
  let resolverCalled = false;
  const worker = new FailingWorker();
  const store = {
    async open() { storeOpened = true; return this; },
    async openSession() { storeOpened = true; throw new Error("unreachable"); },
  } as StemStore;
  const opening = openEngineWebSession({
    ...baseOptions(), store, capabilityScope: capabilities(),
    resolver: { async resolve() { resolverCalled = true; throw new Error("unreachable"); } },
    assets: { createWorker: () => worker as unknown as Worker },
  });
  queueMicrotask(() => worker.fail(new Error("module load failed")));
  await assert.rejects(opening, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "capability.module_worker");
  assert.equal(storeOpened, false);
  assert.equal(resolverCalled, false);
  assert.equal(worker.terminated, true);
});

test("JavaScript callers must select exactly one stem input path", async () => {
  const base = baseOptions();
  await assert.rejects(
    openEngineWebSession({ ...base, resolver: undefined } as unknown as EngineWebSessionOptions),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.input_path",
  );
  await assert.rejects(
    openEngineWebSession({
      ...base,
      flac: { locate: () => "https://caller.invalid/stem" },
    } as unknown as EngineWebSessionOptions),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.input_path",
  );
});

test("scratch declaration mismatch refuses before store or FLAC locator work", async () => {
  let storeOpened = false;
  let locatorCalls = 0;
  const base = baseOptions();
  const { resolver: _resolver, ...common } = base;
  await assert.rejects(
    openEngineWebSession({
      ...common,
      flac: { locate: () => { locatorCalls += 1; return "https://caller.invalid/stem"; } },
      capabilityScope: capabilities(),
      store: {
        async open() { storeOpened = true; return this; },
        async openSession() { storeOpened = true; throw new Error("unreachable"); },
      },
      scratchBoot: async () => ({
        sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16, backend: "simd128",
        sources: [{ id: "source", channels: 2, frames: 4n }], tracks: [],
      }),
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.declaration_mismatch",
  );
  assert.equal(storeOpened, false);
  assert.equal(locatorCalls, 0);
});

test("every document stem tuple mismatch refuses before store or FLAC delivery", async () => {
  const exact = documentValue([{ id: "source", spec: {
    channels: 1, bitDepth: 16, frames: 4, content: IDENTITY,
  } }]);
  const cases: Array<readonly [string, (document: any) => void]> = [
    ["id", (document) => { document.sources[0].id = "other"; }],
    ["content", (document) => { document.sources[0].content = IDENTITY_Z; }],
    ["channels", (document) => { document.sources[0].channels = 2; }],
    ["frames", (document) => { document.sources[0].frames = "5"; }],
    ["bit_depth", (document) => { document.sources[0].bit_depth = 24; }],
    ["sample_rate_hz", (document) => { document.sample_rate_hz = 44_100; }],
  ];
  for (const [field, mutate] of cases) {
    const document = structuredClone(exact);
    mutate(document);
    let storeOpened = false;
    let locatorCalls = 0;
    const base = baseOptions();
    const { resolver: _resolver, ...common } = base;
    await assert.rejects(
      openEngineWebSession({
        ...common,
        document: JSON.stringify(document),
        flac: { locate: () => { locatorCalls += 1; return "https://caller.invalid/stem"; } },
        capabilityScope: capabilities(),
        store: {
          async open() { storeOpened = true; return this; },
          async openSession() { storeOpened = true; throw new Error("unreachable"); },
        },
        scratchBoot: async () => ({
          sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16, backend: "simd128",
          sources: [{ id: "source", channels: 1, frames: 4n }], tracks: [],
        }),
      }),
      (error: unknown) => error instanceof EngineWebAdapterError &&
        error.code === "session.declaration_mismatch" && error.details.field === field,
      field,
    );
    assert.equal(storeOpened, false, field);
    assert.equal(locatorCalls, 0, field);
  }
});

test("session composes in order and serializes lifecycle with reverse cleanup", async () => {
  const events: string[] = [];
  const context = fakeContext(events);
  const lease: StemSessionLease = {
    leaseId: "lease",
    stems: [
      { sourceId: "source-z", identity: IDENTITY_Z, bytes: 8 },
      { sourceId: "source", identity: IDENTITY, bytes: 8 },
    ],
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
    async sessionMap() { return { tracks: [], sources: [{ id: "source", channels: 1, frames: 4n }, { id: "source-z", channels: 1, frames: 4n }], metersAttached: false }; },
    async command() { return { ok: true, result: 0, code: "ok", reason: 0, reasonName: "none", rejectedIndex: 0, admitted: 0, appliedAtSample: 0n }; },
    async dispose() { events.push("host.dispose"); },
  } as unknown as BrowserEngine["host"];
  let pumpRings: readonly SharedArrayBuffer[] = [];
  const options: EngineWebSessionOptions = {
    ...baseOptions(), store,
    sources: [
      { id: "source-z", spec: { channels: 1, bitDepth: 16, frames: 4, content: IDENTITY_Z } },
      { id: "source", spec: { channels: 1, bitDepth: 16, frames: 4, content: IDENTITY } },
    ],
    document: documentFor([
      { id: "source-z", spec: { channels: 1, bitDepth: 16, frames: 4, content: IDENTITY_Z } },
      { id: "source", spec: { channels: 1, bitDepth: 16, frames: 4, content: IDENTITY } },
    ]),
    capabilityScope: capabilities(),
    createContext: () => context,
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
      assert.deepEqual(sources.map((source) => source.sourceId), ["source", "source-z"]);
      pumpRings = sources.map((source) => source.ring);
      for (const ring of pumpRings) Atomics.store(new Int32Array(ring), MSB1_CONTROL.WROTE, 1);
      return {
        async seekFrames(frame) { events.push(`pump.seek:${frame}`); return 2n; },
        close() { events.push("pump.close"); },
      };
    },
    assets: {
      feedWorkletModuleUrl: "feed-override.js",
      createWorker: () => new ScratchWorker(events) as unknown as Worker,
    },
  };

  const session = await openEngineWebSession(options);
  assert.equal(session.state, "ready");
  assert.ok(events.indexOf("scratch") < events.indexOf("scratch.terminate"));
  assert.ok(events.indexOf("scratch.terminate") < events.indexOf("store.openSession"));
  assert.ok(events.indexOf("store.openSession") < events.indexOf("engine-worklet"));
  assert.equal(events.filter((event) => event === "scratch").length, 1, "document is scratch-compiled once");
  assert.ok(events.indexOf("engine-worklet") < events.indexOf("pump.create"));
  assert.equal(pumpRings.length, 2);
  const playing = session.play();
  assert.equal(events.at(-1), "context.resume", "resume is invoked synchronously before play yields");
  await playing;
  await session.pause();
  await session.play();
  assert.equal(context.state, "running", "pause then play leaves the last-requested running state");
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
  const resumes = events.filter((event) => event === "context.resume").length;
  await assert.rejects(session.play(), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.closed");
  assert.equal(events.filter((event) => event === "context.resume").length, resumes, "play after close cannot resume");

  const hungContext = fakeContext(events, true);
  const hung = await openEngineWebSession({ ...options, createContext: () => hungContext });
  const hungPlay = hung.play();
  await Promise.race([
    hung.close(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("close waited behind hung resume")), 50)),
  ]);
  await assert.rejects(hungPlay, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});

function baseOptions(): EngineWebSessionCommonOptions & { readonly resolver: StemResolver; readonly flac?: never } {
  const sources = [{ id: "source", spec: { channels: 1 as const, bitDepth: 16 as const, frames: 4, content: IDENTITY } }];
  return {
    document: documentFor(sources), leaseId: "lease", sources,
    resolver: { async resolve() { throw new Error("resolver must not run in this test"); } },
  };
}

function documentValue(sources: EngineWebSessionCommonOptions["sources"]) {
  return {
    schema_version: 1,
    session_id: "test",
    revision: "0",
    sample_rate_hz: 48_000,
    quantum_frames: 4,
    sources: sources.map((source) => ({
      id: source.id,
      content: source.spec.content,
      channels: source.spec.channels,
      bit_depth: source.spec.bitDepth,
      frames: String(source.spec.frames),
    })),
  };
}

function documentFor(sources: EngineWebSessionCommonOptions["sources"]): string {
  return JSON.stringify(documentValue(sources));
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

function fakeContext(events: string[], hangResume = false): EngineAudioContext & { modules: string[] } {
  const modules: string[] = [];
  let state = "suspended";
  return {
    sampleRate: 48_000,
    renderQuantumSize: 4,
    get state() { return state; },
    destination: {} as AudioNode,
    modules,
    audioWorklet: { async addModule(url) { modules.push(url); events.push("feed-prelude"); } },
    async resume() {
      events.push("context.resume");
      if (hangResume) await new Promise<void>(() => undefined);
      state = "running";
    },
    async suspend() { events.push("context.suspend"); state = "suspended"; },
    async close() { events.push("context.close"); state = "closed"; },
  };
}

class FailingWorker extends EventTarget {
  terminated = false;
  postMessage() { /* handshake only */ }
  terminate() { this.terminated = true; }
  fail(error: Error) {
    const event = Object.assign(new Event("error"), { error, message: error.message });
    this.dispatchEvent(event);
  }
}

class ScratchWorker extends EventTarget {
  #terminated = false;
  constructor(readonly events: string[]) {
    super();
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { type: "worker-ready" } })));
  }
  postMessage(message: { type?: string; requestId?: number }) {
    if (message.type !== "scratch") return;
    this.events.push("scratch");
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
      type: "scratch-result", requestId: message.requestId, ok: true,
      shape: {
        sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16, backend: "simd128",
        sources: [{ id: "source", channels: 1, frames: 4n }, { id: "source-z", channels: 1, frames: 4n }], tracks: [],
      },
    } })));
  }
  terminate() {
    if (!this.#terminated) { this.#terminated = true; this.events.push("scratch.terminate"); }
  }
}
