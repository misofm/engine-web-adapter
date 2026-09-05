import { BrowserBootError } from "@misofm/engine/browser";
import { scratchBootWithWorker } from "../src/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserEngine } from "@misofm/engine/browser";
import { EngineWebAdapterError, openEngineWebSession } from "../src/index.js";
import { assertEngineWebCapabilities } from "../src/capabilities.js";
import { MSB1_CONTROL } from "../src/stems/ring.js";
import type { EngineAudioContext, EngineWebSessionCommonOptions, EngineWebSessionOptions } from "../src/session-types.js";
import type { FlacWorkerRequest, FlacWorkerResponse } from "../src/stems/flac-worker-protocol.js";
import type { DeclaredStemSource, StemResolver, StemSessionLease, StemStore } from "../src/stems/types.js";

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
    ["FileSystemFileHandle", "capability.opfs"],
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

test("OPFS refusals name what is missing and carry a remedy", () => {
  // Safari 17/18 shape: OPFS handles present, createWritable absent. It must
  // pass, because the store no longer uses createWritable.
  assert.doesNotThrow(() => assertEngineWebCapabilities({
    ...capabilities(), FileSystemFileHandle: class { getFile() {} },
  }));
  for (const [scope, missing] of [
    [{ ...capabilities(), navigator: { locks: { request() {} } } }, "navigator.storage.getDirectory"],
    [{ ...capabilities(), FileSystemFileHandle: undefined }, "FileSystemFileHandle"],
  ] as const) {
    assert.throws(
      () => assertEngineWebCapabilities(scope),
      (error: unknown) => error instanceof EngineWebAdapterError
        && error.code === "capability.opfs"
        && error.details["missing"] === missing
        && typeof error.details["remedy"] === "string"
        && (error.details["remedy"] as string).includes("15.2"),
    );
  }
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

test("session snapshots document and source declarations before deferred scratch work", async () => {
  const originalSources = [{
    id: "source",
    spec: { channels: 1 as const, bitDepth: 16 as const, frames: 4, content: IDENTITY },
  }];
  const document = new TextEncoder().encode(documentFor(originalSources));
  const snapshot = new Uint8Array(document);
  const scratchStarted = deferred<void>();
  const releaseScratch = deferred<void>();
  let scratchDocument: Uint8Array | undefined;
  let hostDocument: Uint8Array | undefined;
  let storeStem: unknown;
  const events: string[] = [];
  const context = fakeContext(events);
  const host = {
    node: { connect() {}, disconnect() {} },
    async sessionMap() { return { tracks: [], sources: [{ id: "source", channels: 1, frames: 4n }], metersAttached: false }; },
    async command() { return { ok: true, result: 0, code: "ok", reason: 0, reasonName: "none", rejectedIndex: 0, admitted: 0, appliedAtSample: 0n }; },
    async dispose() {},
  } as unknown as BrowserEngine["host"];
  const lease: StemSessionLease = {
    leaseId: "snapshot", stems: [{ sourceId: "source", identity: IDENTITY, bytes: 8 }],
    async read() { return new Blob([new Uint8Array(8)]); }, async close() {},
  };
  const opening = openEngineWebSession({
    document,
    leaseId: "snapshot",
    sources: originalSources as readonly DeclaredStemSource[],
    resolver: { async resolve() { throw new Error("warm fixture must not resolve"); } },
    capabilityScope: capabilities(),
    store: {
      async open() { return this; },
      async openSession(request) { storeStem = request.stems[0]; return lease; },
    },
    scratchBoot: async (request) => {
      scratchDocument = request.document;
      scratchStarted.resolve();
      await releaseScratch.promise;
      return {
        sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16, backend: "simd128",
        sources: [{ id: "source", channels: 1, frames: 4n }], tracks: [],
      };
    },
    createContext: () => context,
    createHost: async (request) => { hostDocument = request.document; return host; },
    createAttachNode: () => ({
      port: { postMessage(message: unknown) {
        const value = message as { op: string; rings?: SharedArrayBuffer[] };
        if (value.op === "attach") for (const ring of value.rings ?? []) Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1);
      } },
      disconnect() {},
    }),
    createPump: async ({ sources }) => {
      for (const source of sources) Atomics.store(new Int32Array(source.ring), MSB1_CONTROL.WROTE, 1);
      return { async seekFrames() { return 0n; }, close() {} };
    },
    createOutput: () => ({ connect() {}, disconnect() {} }) as unknown as AudioNode,
  });
  await scratchStarted.promise;
  document.fill(0x78);
  const mutable = originalSources[0]! as any;
  mutable.id = "mutated";
  mutable.spec.channels = 2;
  mutable.spec.bitDepth = "32f";
  mutable.spec.frames = 99;
  mutable.spec.content = IDENTITY_Z;
  releaseScratch.resolve();
  const session = await opening;
  assert.deepEqual(scratchDocument, snapshot, "scratch sees owned document snapshot A");
  assert.deepEqual(hostDocument, snapshot, "createEngine host sees the same document snapshot A");
  assert.deepEqual(storeStem, { sourceId: "source", identity: IDENTITY, bytes: 8 });
  assert.deepEqual(session.shape.sources, [{ id: "source", channels: 1, frames: 4n }]);
  await session.close();
});

test("high-level FLAC path honors common Worker assets with nested FLAC precedence", async () => {
  for (const nested of [false, true]) {
    const urls: string[] = [];
    const workers: ErrorOnStartWorker[] = [];
    const base = baseOptions();
    const { resolver: _resolver, ...common } = base;
    await assert.rejects(openEngineWebSession({
      ...common,
      capabilityScope: capabilities(),
      assets: {
        flacWorkerUrl: "https://caller.invalid/common-flac-worker.js",
        createWorker(url) {
          urls.push(String(url));
          const worker = new ErrorOnStartWorker();
          workers.push(worker);
          return worker as unknown as Worker;
        },
      },
      flac: {
        locate: () => "https://caller.invalid/stem.flac",
        ...(nested ? { assets: { flacWorkerUrl: "https://caller.invalid/nested-flac-worker.js" } } : {}),
      },
      scratchBoot: async () => ({
        sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16, backend: "simd128",
        sources: [{ id: "source", channels: 1, frames: 4n }], tracks: [],
      }),
      store: {
        async open() { return this; },
        async openSession(request) {
          const reader = (await request.resolver.resolve(IDENTITY)).stream.getReader();
          await reader.read();
          throw new Error("unreachable");
        },
      },
    }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.decode.worker");
    assert.deepEqual(urls, [nested
      ? "https://caller.invalid/nested-flac-worker.js"
      : "https://caller.invalid/common-flac-worker.js"]);
    assert.equal(workers[0]?.terminated, true);
  }
});

test("session FLAC expectations reject wrong STREAMINFO before any audio-byte range", async () => {
  const cases = [
    { field: "sample rate", sampleRateHz: 44_100, channels: 1, bitDepth: 16, frames: 4 },
    { field: "channels", sampleRateHz: 48_000, channels: 2, bitDepth: 16, frames: 4 },
    { field: "bit depth", sampleRateHz: 48_000, channels: 1, bitDepth: 24, frames: 4 },
    { field: "frames", sampleRateHz: 48_000, channels: 1, bitDepth: 16, frames: 5 },
  ] as const;
  for (const mismatch of cases) {
    const fixture = nativeFlacFixture(mismatch);
    const requested: Array<readonly [number, number]> = [];
    const client: typeof globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Readonly<Record<string, string>>;
      const match = /^bytes=(\d+)-(\d+)$/u.exec(headers.range!)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      requested.push([start, end]);
      return new Response(fixture.bytes.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${fixture.bytes.byteLength}`,
          "Content-Length": String(end - start + 1),
          ETag: '"shape-fixture"',
        },
      });
    }) as typeof globalThis.fetch;
    const worker = new ValidationWorker();
    const base = baseOptions();
    const { resolver: _resolver, ...common } = base;
    await assert.rejects(openEngineWebSession({
      ...common,
      capabilityScope: capabilities(),
      scratchBoot: async () => ({
        sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16, backend: "simd128",
        sources: [{ id: "source", channels: 1, frames: 4n }], tracks: [],
      }),
      flac: {
        locate: () => "https://caller.invalid/shape.flac",
        fetch: client,
        createWorker: () => worker,
        maximumAttempts: 1,
      },
      store: {
        async open() { return this; },
        async openSession(request) {
          await (await request.resolver.resolve(IDENTITY)).stream.getReader().read();
          throw new Error("unreachable");
        },
      },
    }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.flac.shape", mismatch.field);
    assert.ok(requested.length > 0, `${mismatch.field}: metadata was requested`);
    assert.ok(requested.every(([start, end]) => start < fixture.audioStart && end < fixture.audioStart),
      `${mismatch.field}: no range touched audio bytes`);
    assert.equal(worker.terminated, true);
  }
});

function baseOptions(): EngineWebSessionCommonOptions & { readonly resolver: StemResolver; readonly flac?: never } {
  const sources = [{ id: "source", spec: { channels: 1 as const, bitDepth: 16 as const, frames: 4, content: IDENTITY } }];
  return {
    document: documentFor(sources), leaseId: "lease", sources,
    resolver: { async resolve() { throw new Error("resolver must not run in this test"); } },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function putU64(bytes: Uint8Array, offset: number, input: bigint): void {
  let value = input;
  for (let index = 7; index >= 0; index -= 1) {
    bytes[offset + index] = Number(value & 0xffn);
    value >>= 8n;
  }
}

function nativeFlacFixture(shape: { readonly sampleRateHz: number; readonly channels: number; readonly bitDepth: number; readonly frames: number }) {
  const seekBytes = shape.frames * 18;
  const audioStart = 46 + seekBytes;
  const bytes = new Uint8Array(audioStart + (shape.frames * 4));
  bytes.set([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 34]);
  const stream = bytes.subarray(8, 42);
  stream.set([0, 1, 0, 1, 0, 0, 4, 0, 0, 4]);
  const packed = (BigInt(shape.sampleRateHz) << 44n) |
    (BigInt(shape.channels - 1) << 41n) |
    (BigInt(shape.bitDepth - 1) << 36n) |
    BigInt(shape.frames);
  putU64(stream, 10, packed);
  stream.fill(1, 18, 34);
  bytes.set([0x83, (seekBytes >>> 16) & 0xff, (seekBytes >>> 8) & 0xff, seekBytes & 0xff], 42);
  for (let index = 0; index < shape.frames; index += 1) {
    const point = 46 + (index * 18);
    putU64(bytes, point, BigInt(index));
    putU64(bytes, point + 8, BigInt(index * 4));
    bytes.set([0, 1], point + 16);
    bytes.set([0xff, 0xf8, index, 0], audioStart + (index * 4));
  }
  return { bytes, audioStart };
}

function documentValue(sources: readonly DeclaredStemSource[]) {
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

function documentFor(sources: readonly DeclaredStemSource[]): string {
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
    FileSystemFileHandle: class { getFile() {} },
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

class ErrorOnStartWorker extends EventTarget {
  terminated = false;
  postMessage(message: { type?: string; requestId?: number }) {
    if (message.type !== "start") return;
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
      type: "error", requestId: message.requestId,
      error: { name: "Error", message: "intentional FLAC worker stop" },
    } })));
  }
  terminate() { this.terminated = true; }
}

class ValidationWorker extends EventTarget {
  terminated = false;
  postMessage(message: FlacWorkerRequest) {
    if (this.terminated) return;
    if (message.type === "start") {
      queueMicrotask(() => this.#reply({ type: "ready", requestId: message.requestId }));
    }
  }
  terminate() {
    this.terminated = true;
  }
  #reply(reply: FlacWorkerResponse) {
    if (!this.terminated) this.dispatchEvent(new MessageEvent("message", { data: reply }));
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

test("delegated scratch deadlines use typed adapter translation and terminate", async () => {
  for (const ready of [false, true]) {
    const worker = new FailingWorker();
    const pending = scratchBootWithWorker({ document: new Uint8Array(), options: {}, moduleUrl: "chosen-wasm",
      requestDeadlineMs: 5, assets: { createWorker: () => worker as unknown as Worker } });
    if (ready) worker.dispatchEvent(new MessageEvent("message", { data: { type: "worker-ready" } }));
    await assert.rejects(pending, (error: unknown) => error instanceof EngineWebAdapterError
      && error.code === "session.open" && error.cause instanceof BrowserBootError
      && error.cause.operation === "scratch-deadline");
    assert.equal(worker.terminated, true);
  }
});

test("delegated scratch retains caller Worker URL, Wasm URL and abort reason", async () => {
  const worker = new FailingWorker(); const controller = new AbortController();
  const workerUrl = new URL("https://caller.invalid/scratch.js");
  let received: unknown;
  worker.postMessage = (request?: unknown) => { received = request; };
  const opening = scratchBootWithWorker({ document: new Uint8Array([7]), options: {}, moduleUrl: "chosen-wasm",
    signal: controller.signal, assets: { scratchWorkerUrl: workerUrl, createWorker(url, options) {
      assert.equal(url, workerUrl); assert.deepEqual(options, { type: "module" }); return worker as unknown as Worker;
    } } });
  worker.dispatchEvent(new MessageEvent("message", { data: { type: "worker-ready" } }));
  assert.equal((received as { moduleUrl: string }).moduleUrl, "chosen-wasm");
  const reason = new Error("caller stopped"); controller.abort(reason);
  await assert.rejects(opening, (error: unknown) => error === reason);
  assert.equal(worker.terminated, true);
});

test("SDK host defaults wait for verified lease, forward URLs and install the SDK feed first", async () => {
  const events: string[] = []; const context = fakeContext(events); const verified = deferred<StemSessionLease>();
  let contexts = 0; let scratches = 0;
  const hostModuleUrl = `data:text/javascript,${encodeURIComponent(`
    export async function createMisoAudioWorkletHost(request) {
      if (request.context.modules.at(-1) !== "chosen-feed" || request.context.state !== "suspended"
        || request.simd128ModuleUrl !== "chosen-wasm" || request.workletModuleUrl !== "chosen-worklet"
        || request.options.consoleCommandQueueRecords !== 0n) throw new Error("wrong forwarded host request");
      return { node: { connect() {}, disconnect() {} }, async dispose() { request.context.modules.push("disposed"); } };
    }
  `)}`;
  const opening = openEngineWebSession({
    ...baseOptions(), capabilityScope: capabilities(), console: false,
    store: { async open() { return this; }, async openSession() { events.push("store"); return verified.promise; } },
    scratchBoot: async () => { scratches++; return { sampleRateHz: 48000, quantumFrames: 4, sourceRingFrames: 16,
      backend: "simd128", sources: [{ id: "source", channels: 1, frames: 4n }], tracks: [] }; },
    createContext: () => { contexts++; events.push("context"); return context; },
    createAttachNode: () => ({ port: { postMessage(message) {
      const request = message as { op: string; rings?: SharedArrayBuffer[] };
      for (const ring of request.rings ?? []) Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1);
    } }, disconnect() {} }),
    createPump: async ({ sources }) => {
      for (const source of sources) Atomics.store(new Int32Array(source.ring), MSB1_CONTROL.WROTE, 1);
      return { async seekFrames() { return 2n; }, close() {} };
    },
    assets: { engineHostModuleUrl: hostModuleUrl, engineWasmUrl: "chosen-wasm", engineWorkletModuleUrl: "chosen-worklet", feedWorkletModuleUrl: "chosen-feed" },
  });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(events, ["store"]); assert.equal(contexts, 0);
  verified.resolve({ leaseId: "verified", stems: [{ sourceId: "source", identity: IDENTITY, bytes: 8 }],
    async read() { return new Blob(); }, async close() { events.push("lease.close"); } });
  const session = await opening;
  assert.equal(scratches, 1); assert.equal(contexts, 1); assert.equal(session.state, "ready");
  await session.close(); await session.close();
  assert.deepEqual(context.modules, ["chosen-feed", "disposed"]);
  assert.ok(events.indexOf("context.close") < events.indexOf("lease.close"));
});

test("source observation maps compiled sources and reports owned buffers without consuming audio", async (t) => {
  const { Msb1RingObserver, Msb1RingWriter } = await import("@misofm/engine/browser");
  const declarations: DeclaredStemSource[] = [
    { id: "z", spec: { channels: 1, bitDepth: 16, frames: 4, content: IDENTITY } },
    { id: "a", spec: { channels: 2, bitDepth: 24, frames: 4, content: IDENTITY_Z } },
    { id: "m", spec: { channels: 1, bitDepth: 16, frames: 4, content: IDENTITY } },
  ];
  const ordered = [declarations[1]!, declarations[2]!, declarations[0]!];
  for (const allocation of [undefined, { windowFrames: 17, maximumWindowBytes: 170 }]) {
    const rings: SharedArrayBuffer[] = [];
    const events: string[] = [];
    const session = await openEngineWebSession({
      ...baseOptions(), sources: declarations, document: documentFor(declarations), console: false,
      capabilityScope: capabilities(), createContext: () => fakeContext(events),
      scratchBoot: async () => ({ sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16,
        backend: "simd128", tracks: [], sources: ordered.map((source) => ({ id: source.id, channels: source.spec.channels, frames: 4n })) }),
      store: { async open() { return this; }, async openSession() {
        return { leaseId: "lease", stems: [], async read() { throw new Error("custom pump owns reads"); }, async close() {} };
      } },
      createHost: async () => ({ node: { connect() {}, disconnect() {} }, memoryBytes: 123456, async dispose() {} }) as unknown as BrowserEngine["host"],
      createAttachNode: () => ({ port: { postMessage() {} }, disconnect() {} }),
      createPump: async ({ sources }) => {
        assert.deepEqual(sources.map((source) => source.sourceId), ["a", "m", "z"]);
        for (const [index, source] of sources.entries()) {
          rings.push(source.ring);
          const writer = new Msb1RingWriter(source.ring);
          writer.engage(1n);
          for (let chunk = 0; chunk < 2; chunk++) {
            const planes = writer.reserve(3)!;
            for (const [channel, plane] of planes.entries()) plane.set([index * 10 + channel + chunk, 2, 3]);
            writer.commit({ generation: 1n, startFrame: BigInt(chunk * 3), frames: 3, endOfRegion: chunk === 1 });
          }
        }
        return { ...(allocation === undefined ? {} : { allocation }), async seekFrames() { return 2n; }, close() {} };
      },
    });
    assert.equal(session.state, "ready");
    const before = rings.map((ring) => Buffer.from(new Uint8Array(ring)));
    const first = session.observeSource("a"), second = session.observeSource("a"), mono = session.observeSource("z");
    assert.equal(first.channels, 2); assert.equal(mono.channels, 1); assert.equal(first.sampleRateHz, 48_000);
    let borrowed: Float32Array | undefined;
    assert.equal(first.pull((chunk) => { borrowed = chunk.planes[0]; assert.equal(chunk.startFrame, 0n); assert.deepEqual([...chunk.planes[1]!], [1, 2, 3, 0]); }, 1), 1);
    assert.equal(first.pull((chunk) => { assert.equal(chunk.planes[0], borrowed); assert.equal(chunk.startFrame, 3n); assert.equal(chunk.frames, 3); }, 1), 1);
    assert.equal(second.pull((chunk) => assert.equal(chunk.startFrame, 0n), 1), 1);
    assert.equal(mono.pull((chunk) => assert.equal(chunk.planes[0]![0], 20), 1), 1);
    assert.throws(() => first.pull(() => {}, 33), RangeError);
    assert.throws(() => session.observeSource("missing"), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.not_found" && error.details.sourceId === "missing");
    const snapshot = session.feedDiagnostics();
    assert.deepEqual(snapshot.sources, rings.map((ring, index) => {
      const sdk = new Msb1RingObserver(ring); const counters = sdk.counters(); sdk.close();
      return { sourceId: ordered[index]!.id, ...counters };
    }));
    assert.deepEqual(snapshot.allocation, { sources: 3, ringBytes: rings.reduce((bytes, ring) => bytes + ring.byteLength, 0),
      engineMemoryBytes: 123456, observationBytes: (4 + 2 + 2 + 1) * 4 * 4, pump: allocation ?? null });
    const constructor = t.mock.method(globalThis, "Float32Array", new Proxy(Float32Array, { construct() { throw new Error("counter snapshot constructed an observer"); } }));
    try { assert.deepEqual(session.feedDiagnostics(), snapshot); assert.deepEqual(session.feedDiagnostics(), snapshot); }
    finally { constructor.mock.restore(); }
    first.close(); first.close();
    assert.equal(first.pull(() => assert.fail("closed source observer")), 0);
    assert.equal(session.feedDiagnostics().allocation.observationBytes, (4 + 2 + 1) * 4 * 4);
    for (const [index, ring] of rings.entries()) assert.deepEqual(Buffer.from(new Uint8Array(ring)), before[index]);
    const originalClose = Msb1RingObserver.prototype.close;
    const closed = new Set<object>();
    const closeHook = t.mock.method(Msb1RingObserver.prototype, "close", function (this: InstanceType<typeof Msb1RingObserver>) { closed.add(this); originalClose.call(this); });
    try { await session.close(); await session.close(); }
    finally { closeHook.mock.restore(); }
    assert.equal(closed.size, 5, "three counter observers and two remaining source observers are released");
    assert.equal(second.pull(() => assert.fail("session-closed observation")), 0);
    assert.equal(mono.pull(() => assert.fail("session-closed observation")), 0);
    for (const call of [() => session.observeSource("a"), () => session.feedDiagnostics()]) {
      assert.throws(call, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.closed");
    }
  }
});
