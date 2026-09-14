import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createIngestDiagnostics } from "../src/index.js";
import { BoundedStemAdmission } from "../src/stems/flac-admission.js";
import { VerifiedStemStore } from "../src/stems/store.js";
import { MemoryStemStorageBackend } from "../src/stems/storage.js";
import { createSparseStemResolver, OpfsStorageBackend, serializeSparseStemIndex, VerifiedSparsePcmStore } from "../src/stems/index.js";
import { BrowserBootError, Msb1RingWriter, PcmFeedError, PcmRunwayError } from "@misofm/engine/browser";
import { scratchBootWithWorker, prepareBrowserSessionWithWorker } from "../src/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createBLAKE3 } from "hash-wasm";

import type { BrowserEngine } from "@misofm/engine/browser";
import { EngineWebAdapterError, openEngineWebSession, openSparseEngineWebSession } from "../src/index.js";
import { assertEngineWebCapabilities } from "../src/capabilities.js";
import { MSB1_CONTROL } from "../src/stems/ring.js";
import type { EngineAudioContext, EnginePump, EngineWebSessionCommonOptions, EngineWebSessionOptions } from "../src/session-types.js";
import type { FlacWorkerRequest, FlacWorkerResponse } from "../src/stems/flac-worker-protocol.js";
import type { DeclaredStemSource, StemProgress, StemResolver, StemSessionLease, StemStore } from "../src/stems/types.js";
import type { SparsePcmExpectation, SparsePcmSessionLease, SparsePcmSessionOptions } from "../src/stems/sparse-store.js";
import type { SparsePcmPumpSource } from "../src/stems/pump.js";
import type { OpfsWorkerLike, OpfsWorkerRequest, OpfsWorkerResponse } from "../src/stems/opfs-worker-protocol.js";

const identityHasher = await createBLAKE3(256);
const identityFor = (bytes: Uint8Array) => `blake3:${identityHasher.init().update(bytes).digest("hex")}` as const;

const IDENTITY = `blake3:${"a".repeat(64)}` as const;
const IDENTITY_Z = `blake3:${"b".repeat(64)}` as const;

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
  const verified = deferred<void>();
  const storeStarted = deferred<void>();
  let scratchWorker: ScratchWorker | undefined;
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
    async openSession() {
      events.push("store.openSession"); storeStarted.resolve();
      await verified.promise;
      return lease;
    },
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
    createHost: async ({ context: engineContext, preparedModule }) => {
      assert.equal(preparedModule, scratchWorker!.module, "the locally received module survives verified ingestion");
      assert.deepEqual((engineContext as unknown as typeof context).modules, ["feed-override.js"]);
      events.push("engine-worklet");
      return host;
    },
    createAttachNode: (_context, _name) => {
      const port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage(message: unknown) {
        const value = message as { op: string; rings?: SharedArrayBuffer[] };
        if (value.op === "attach") for (const ring of value.rings ?? []) Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1);
        else if (value.op === "prepare-seek") port.onmessage?.({ data: { ...value, op: "seek-prepared", kind: "confirmed" } } as MessageEvent);
        else events.push("feed.detach");
      } };
      return { port, disconnect() { events.push("feed.disconnect"); } };
    },
    createPump: async ({ sources }) => {
      events.push("pump.create");
      assert.deepEqual(sources.map((source) => source.sourceId), ["source", "source-z"]);
      pumpRings = sources.map((source) => source.ring);
      for (const ring of pumpRings) fillRing(ring, 4);
      return {
        async seekFrames(frame) {
          events.push(`pump.seek:${frame}`);
          for (const ring of pumpRings) {
            const writer = new Msb1RingWriter(ring);
            writer.seek(2n, BigInt(frame));
            const control = new Int32Array(ring);
            Atomics.store(control, MSB1_CONTROL.READ_INDEX, Atomics.load(control, MSB1_CONTROL.WRITE_INDEX));
            writer.reserve(2);
            writer.commit({ generation: 2n, startFrame: BigInt(frame), frames: 2, endOfRegion: true });
          }
          return 2n;
        },
        close() { events.push("pump.close"); },
      };
    },
    assets: {
      feedWorkletModuleUrl: "feed-override.js",
      createWorker: () => (scratchWorker = new ScratchWorker(events)) as unknown as Worker,
    },
  };

  const opening = openEngineWebSession(options);
  await storeStarted.promise;
  assert.deepEqual(events, ["scratch", "scratch.terminate", "store.openSession"]);
  assert.equal(context.modules.length, 0, "no live worklet starts before canonical verification finishes");
  verified.resolve();
  const session = await opening;
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

test("sparse session prepares complete authoritative sources through the shared controller", async () => {
  const events: string[] = [];
  const context = fakeContext(events);
  const sources: DeclaredStemSource[] = [
    { id: "source-z", spec: { channels: 2, bitDepth: 24, frames: 8, content: IDENTITY_Z } },
    { id: "source-a", spec: { channels: 1, bitDepth: 16, frames: 8, content: IDENTITY } },
    { id: "source-alias", spec: { channels: 1, bitDepth: 16, frames: 8, content: IDENTITY } },
  ];
  const compiled = [sources[1]!, sources[2]!, sources[0]!];
  let request: SparsePcmSessionOptions | undefined;
  let pumpSources: readonly SparsePcmPumpSource[] | undefined;
  let leaseClosed = 0;
  let storeClosed = 0;
  const lease: SparsePcmSessionLease = {
    leaseId: "sparse-lease",
    sources: [],
    async read() { throw new Error("custom pump does not read descriptors"); },
    async close() { leaseClosed += 1; events.push("sparse.map.close"); },
  };
  const store = {
    async openSession(options: SparsePcmSessionOptions) { request = options; events.push("sparse.open"); return lease; },
    async close() { storeClosed += 1; },
  };
  const host = {
    node: { connect() {}, disconnect() {} },
    async dispose() { events.push("host.dispose"); },
  } as unknown as BrowserEngine["host"];
  const session = await openSparseEngineWebSession({
    document: documentFor(sources), sources, leaseId: "sparse-lease", console: false,
    capabilityScope: capabilities(), store,
    scratchBoot: async () => ({ sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16,
      backend: "simd128", tracks: [], sources: compiled.map((source) => ({ id: source.id, channels: source.spec.channels, frames: BigInt(source.spec.frames) })) }),
    createContext: () => context,
    createHost: async () => host,
    createAttachNode: () => {
      const port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage(message: unknown) {
        const value = message as { op: string; rings?: SharedArrayBuffer[] };
        if (value.op === "attach") for (const ring of value.rings ?? []) Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1);
        else if (value.op === "prepare-seek") port.onmessage?.({ data: { ...value, op: "seek-prepared", kind: "confirmed" } } as MessageEvent);
      } };
      return { port, disconnect() {} };
    },
    createPump: async ({ lease: receivedLease, sources: receivedSources }) => {
      assert.equal(receivedLease, lease);
      pumpSources = receivedSources;
      for (const source of receivedSources) fillRing(source.ring, source.frames);
      return {
        async seekFrames(frame) {
          for (const source of receivedSources) {
            const writer = new Msb1RingWriter(source.ring);
            writer.seek(2n, BigInt(frame));
            const control = new Int32Array(source.ring);
            Atomics.store(control, MSB1_CONTROL.READ_INDEX, Atomics.load(control, MSB1_CONTROL.WRITE_INDEX));
            writer.reserve(4);
            writer.commit({ generation: 2n, startFrame: BigInt(frame), frames: 4, endOfRegion: false });
            writer.reserve(2);
            writer.commit({ generation: 2n, startFrame: BigInt(frame) + 4n, frames: 2, endOfRegion: true });
          }
          return 2n;
        },
        close() { events.push("pump.close"); },
      };
    },
    createOutput: () => ({ connect() {}, disconnect() {} }) as unknown as AudioNode,
  });
  assert.equal(request?.resolve, undefined, "omitted resolver remains preinstalled-only");
  assert.deepEqual(request?.sources.map((source) => ({
    sourceId: source.sourceId, identity: source.identity, sampleRateHz: source.sampleRateHz,
    channels: source.channels, bitDepth: source.bitDepth, frames: source.frames, canonicalBytes: source.canonicalBytes,
  })), [
    { sourceId: "source-a", identity: IDENTITY, sampleRateHz: 48_000, channels: 1, bitDepth: 16, frames: 8, canonicalBytes: 16 },
    { sourceId: "source-alias", identity: IDENTITY, sampleRateHz: 48_000, channels: 1, bitDepth: 16, frames: 8, canonicalBytes: 16 },
    { sourceId: "source-z", identity: IDENTITY_Z, sampleRateHz: 48_000, channels: 2, bitDepth: 24, frames: 8, canonicalBytes: 48 },
  ]);
  assert.deepEqual(pumpSources?.map((source) => ({ sourceId: source.sourceId, sampleRateHz: source.sampleRateHz })), [
    { sourceId: "source-a", sampleRateHz: 48_000 },
    { sourceId: "source-alias", sampleRateHz: 48_000 },
    { sourceId: "source-z", sampleRateHz: 48_000 },
  ]);
  await session.seekFrames(2);
  await session.close();
  await session.close();
  assert.equal(leaseClosed, 1);
  assert.equal(storeClosed, 0, "injected sparse stores remain caller-owned");
  assert.ok(events.indexOf("pump.close") < events.indexOf("sparse.map.close"));
});

test("sparse sessions retain common and scratch asset overrides", async () => {
  const events: string[] = [];
  const context = fakeContext(events);
  const sources: DeclaredStemSource[] = [
    { id: "source", spec: { channels: 1, bitDepth: 16, frames: 4, content: IDENTITY } },
    { id: "source-z", spec: { channels: 1, bitDepth: 16, frames: 4, content: IDENTITY_Z } },
  ];
  const hostModuleUrl = `data:text/javascript,${encodeURIComponent(`
    export async function createMisoAudioWorkletHost(request) {
      if (request.simd128ModuleUrl !== "sparse-wasm" || request.workletModuleUrl !== "sparse-worklet"
        || request.context.modules.at(-1) !== "sparse-feed") throw new Error("sparse asset override was dropped");
      return { node: { connect() {}, disconnect() {} }, async dispose() {} };
    }
  `)}`;
  const lease: SparsePcmSessionLease = {
    leaseId: "sparse-assets",
    sources: [],
    async read() { throw new Error("custom pump does not read descriptors"); },
    async close() { events.push("sparse.map.close"); },
  };
  const store = {
    async openSession(options: SparsePcmSessionOptions) {
      assert.equal(options.sources.length, sources.length);
      return lease;
    },
  };
  const scratchWorkerUrl = new URL("https://caller.invalid/sparse-scratch.js");
  const session = await openSparseEngineWebSession({
    document: documentFor(sources), sources, leaseId: "sparse-assets", console: false,
    capabilityScope: capabilities(), store,
    assets: {
      scratchWorkerUrl,
      engineWasmUrl: "sparse-wasm",
      engineWorkletModuleUrl: "sparse-worklet",
      engineHostModuleUrl: hostModuleUrl,
      feedWorkletModuleUrl: "sparse-feed",
      createWorker: (url, options) => {
        assert.equal(String(url), String(scratchWorkerUrl));
        assert.deepEqual(options, { type: "module" });
        return new ScratchWorker(events) as unknown as Worker;
      },
    },
    createContext: () => context,
    createAttachNode: () => ({ port: { postMessage(message: unknown) {
      const request = message as { readonly op: string; readonly rings?: readonly SharedArrayBuffer[] };
      if (request.op === "attach") for (const ring of request.rings ?? []) Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1);
    } }, disconnect() {} }),
    createPump: async ({ sources: pumpSources }) => {
      for (const source of pumpSources) fillRing(source.ring, source.frames);
      return { async seekFrames() { return 0n; }, close() { events.push("pump.close"); } };
    },
    createOutput: () => ({ connect() {}, disconnect() {} }) as unknown as AudioNode,
  });
  assert.ok(events.includes("scratch"), "sparse scratch preparation uses the caller Worker factory");
  await session.close();
  assert.ok(events.includes("sparse.map.close"));
});

test("public sparse sessions report cold, warm, and all-silent progress through prefill", async () => {
  const flac = new Uint8Array(readFileSync("tests/fixtures/native-silence.flac"));
  const activeFrames = 2_048;
  const activePcm = new Uint8Array(activeFrames * 2);
  const coldFixture = sessionSparseProgressFixture(flac, activePcm, 50_000, 12_000);
  const silentFixture = sessionSparseProgressFixture(undefined, undefined, 60_000, 0);
  const bodies = new Map<`blake3:${string}`, Uint8Array>([
    [coldFixture.expected.identity, coldFixture.body],
    [silentFixture.expected.identity, silentFixture.body],
  ]);
  const locations: string[] = [];
  const fetched: string[] = [];
  const workers: SessionProgressDecodeWorker[] = [];
  const resolver = createSparseStemResolver({
    locate: (identity) => {
      locations.push(identity);
      return `https://fixture.invalid/${identity}`;
    },
    fetch: async (input) => {
      const identity = new URL(String(input)).pathname.slice(1) as `blake3:${string}`;
      const body = bodies.get(identity);
      assert.ok(body, `fixture body for ${identity}`);
      fetched.push(identity);
      return new Response(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, {
        status: 200,
        headers: { "Content-Length": String(body.byteLength) },
      });
    },
    createWorker: () => {
      const worker = new SessionProgressDecodeWorker(activePcm);
      workers.push(worker);
      return worker;
    },
  });
  const backend = new MemoryStemStorageBackend();
  const store = new VerifiedSparsePcmStore({ backend, instanceId: "public-session-progress" });
  let leaseNumber = 0;
  const open = async (
    fixture: { readonly expected: SparsePcmExpectation },
    sourceId: string,
    events: StemProgress[],
    throwOnDecoding = false,
  ) => {
    const source: DeclaredStemSource = { id: sourceId, spec: {
      channels: fixture.expected.channels,
      bitDepth: fixture.expected.bitDepth,
      frames: fixture.expected.frames,
      content: fixture.expected.identity,
    } };
    const context = fakeContext([]);
    let callbackThrows = 0;
    const session = await openSparseEngineWebSession({
      document: documentFor([source]),
      sources: [source],
      leaseId: `public-session-progress-${leaseNumber++}`,
      console: false,
      capabilityScope: capabilities(),
      store,
      resolver,
      scratchBoot: async () => ({
        sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16, backend: "simd128",
        tracks: [], sources: [{ id: source.id, channels: source.spec.channels, frames: BigInt(source.spec.frames) }],
      }),
      createContext: () => context,
      createHost: async () => ({ node: { connect() {}, disconnect() {} }, async dispose() {} }) as unknown as BrowserEngine["host"],
      createAttachNode: () => ({ port: { postMessage(message: unknown) {
        const request = message as { readonly op: string; readonly rings?: readonly SharedArrayBuffer[] };
        if (request.op === "attach") for (const ring of request.rings ?? []) Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1);
      } }, disconnect() {} }),
      createPump: async ({ sources }) => {
        for (const item of sources) fillRing(item.ring, item.frames);
        return { async seekFrames() { return 0n; }, close() {} };
      },
      createOutput: () => ({ connect() {}, disconnect() {} }) as unknown as AudioNode,
      onProgress: (event) => {
        events.push(event);
        if (throwOnDecoding && event.stage === "decoding" && callbackThrows === 0) {
          callbackThrows += 1;
          throw new Error("progress observer failed");
        }
      },
    });
    assert.equal(callbackThrows, throwOnDecoding ? 1 : 0);
    return session;
  };

  const assertLifecycle = (events: readonly StemProgress[], expected: SparsePcmExpectation): void => {
    assert.equal(events[0]?.stage, "loading");
    const sourceReady = events.findIndex((event) => event.stage === "source-ready");
    const ready = events.findIndex((event) => event.stage === "ready");
    const prefilling = events.findIndex((event) => event.stage === "prefilling");
    assert.ok(sourceReady > 0, "source-ready follows loading");
    assert.ok(ready > sourceReady, "aggregate ready follows source-ready");
    assert.ok(prefilling > ready, "prefilling follows aggregate ready");
    assert.equal(events.at(-1)?.stage, "prefilling");
    const sourceReadyEvents = events.filter((event): event is StemProgress & { readonly stage: "source-ready" } => event.stage === "source-ready");
    assert.deepEqual(sourceReadyEvents.map((event) => event.bytes), [expected.canonicalBytes]);
    const readyEvents = events.filter((event): event is StemProgress & { readonly stage: "ready" } => event.stage === "ready");
    assert.deepEqual(readyEvents.map((event) => [event.sourcesReady, event.sourcesTotal]), [[1, 1]]);
  };

  try {
    const coldEvents: StemProgress[] = [];
    const cold = await open(coldFixture, "cold-source", coldEvents, true);
    assertLifecycle(coldEvents, coldFixture.expected);
    const coldDecoding = coldEvents.filter((event): event is StemProgress & { readonly stage: "decoding" } => event.stage === "decoding");
    const coldIngesting = coldEvents.filter((event): event is StemProgress & { readonly stage: "ingesting" } => event.stage === "ingesting");
    assert.ok(coldDecoding.length >= 2, "public wrapper retains a coalesced final decoding boundary");
    assert.equal(coldDecoding.at(-1)?.bytes, activePcm.byteLength);
    assert.equal(coldDecoding.at(-1)?.totalBytes, coldFixture.expected.canonicalBytes);
    assert.equal(coldIngesting.at(-1)?.bytes, coldFixture.expected.canonicalBytes);
    assert.equal(coldIngesting.at(-1)?.totalBytes, coldFixture.expected.canonicalBytes);
    assert.equal(locations.length, 1);
    assert.equal(fetched.length, 1);
    assert.equal(workers.length, 1);
    await cold.close();

    const warmEvents: StemProgress[] = [];
    const warm = await open(coldFixture, "warm-source", warmEvents);
    assertLifecycle(warmEvents, coldFixture.expected);
    const warmVerifying = warmEvents.filter((event): event is StemProgress & { readonly stage: "verifying" } => event.stage === "verifying");
    assert.ok(warmVerifying.length > 0, "warm public open verifies the committed sparse payload");
    assert.equal(warmVerifying.at(-1)?.bytes, coldFixture.expected.canonicalBytes);
    assert.equal(warmVerifying.at(-1)?.totalBytes, coldFixture.expected.canonicalBytes);
    assert.equal(warmEvents.some((event) => event.stage === "decoding"), false);
    assert.equal(locations.length, 1, "warm open does not locate the source again");
    assert.equal(fetched.length, 1, "warm open does not fetch the source again");
    assert.equal(workers.length, 1, "warm open does not create a decoder Worker");
    await warm.close();

    const silentEvents: StemProgress[] = [];
    const silent = await open(silentFixture, "silent-source", silentEvents);
    assertLifecycle(silentEvents, silentFixture.expected);
    assert.equal(silentEvents.some((event) => event.stage === "decoding"), false, "an all-silent source has no decoder work");
    assert.equal(locations.length, 2);
    assert.equal(fetched.length, 2);
    assert.equal(workers.length, 1, "an all-silent source does not create a decoder Worker");
    await silent.close();
  } finally {
    await store.close();
    for (const worker of workers) assert.equal(worker.terminated, true);
  }
});

test("sparse entry refuses dense and FLAC-shaped paths before any boot or store work", async () => {
  let scratches = 0;
  let stores = 0;
  const common = {
    ...baseOptions(), resolver: undefined,
    capabilityScope: { ...capabilities(), crossOriginIsolated: false },
    scratchBoot: async () => { scratches += 1; throw new Error("scratch must not run"); },
    store: { async openSession() { stores += 1; throw new Error("store must not run"); } },
  };
  await assert.rejects(
    openSparseEngineWebSession({ ...common, flac: {} } as unknown as Parameters<typeof openSparseEngineWebSession>[0]),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.input_path",
  );
  await assert.rejects(
    openSparseEngineWebSession({ ...common, resolver: { async resolve() { throw new Error("resolver must not run"); } } } as unknown as Parameters<typeof openSparseEngineWebSession>[0]),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.input_path",
  );
  assert.equal(scratches, 0);
  assert.equal(stores, 0);
});

test("sparse acquisition maps primary, lease, store and OPFS cleanup failures together", async (t) => {
  const primary = new EngineWebAdapterError("capability.opfs", "caller cancelled", { discriminator: "typed-primary" });
  const leaseFailure = new Error("lease cleanup failed");
  const storeFailure = new Error("store cleanup failed");
  const backendFailure = new Error("backend cleanup failed");
  const controller = new AbortController(); controller.abort(primary);
  const lease: SparsePcmSessionLease = {
    leaseId: "abandoned", sources: [],
    async read() { throw new Error("unreachable"); },
    async close() { throw leaseFailure; },
  };
  t.mock.method(VerifiedSparsePcmStore.prototype, "openSession", async () => lease);
  t.mock.method(VerifiedSparsePcmStore.prototype, "close", async () => { throw storeFailure; });
  t.mock.method(OpfsStorageBackend.prototype, "close", () => { throw backendFailure; });
  const denseBase = baseOptions();
  const sparseBase = { document: denseBase.document, sources: denseBase.sources!, leaseId: denseBase.leaseId! };
  await assert.rejects(
    openSparseEngineWebSession({
      ...sparseBase, resolver: undefined, signal: controller.signal, capabilityScope: capabilities(),
      scratchBoot: async () => ({ sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16,
        backend: "simd128", tracks: [], sources: [{ id: "source", channels: 1, frames: 4n }] }),
    }),
    (error: unknown) => {
      if (!(error instanceof EngineWebAdapterError) || !(error.cause instanceof AggregateError)) return false;
      const causes = error.cause.errors;
      return error.code === "capability.opfs" && error.details.discriminator === "typed-primary"
        && causes.includes(primary) && causes.includes(leaseFailure)
        && causes.includes(storeFailure) && causes.includes(backendFailure);
    },
  );
});

test("sparse opening settles a cancelled map before closing a late lease", async () => {
  const opened = deferred<void>();
  const late = deferred<SparsePcmSessionLease>();
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  let leaseClosed = 0;
  const lease: SparsePcmSessionLease = {
    leaseId: "late", sources: [],
    async read() { throw new Error("unreachable"); },
    async close() { leaseClosed += 1; },
  };
  const denseBase = baseOptions();
  const opening = openSparseEngineWebSession({
    document: denseBase.document, sources: denseBase.sources!, leaseId: "late", resolver: undefined,
    signal: controller.signal, capabilityScope: capabilities(),
    scratchBoot: async () => ({ sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16,
      backend: "simd128", tracks: [], sources: [{ id: "source", channels: 1, frames: 4n }] }),
    store: { async openSession(options) { observedSignal = options.signal; opened.resolve(); return late.promise; } },
  });
  await opened.promise;
  const reason = new Error("opening cancelled"); controller.abort(reason);
  assert.equal(observedSignal?.aborted, true);
  late.resolve(lease);
  await assert.rejects(opening, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.open");
  assert.equal(leaseClosed, 1, "a lease that settled after cancellation is closed exactly once");
});

test("sparse pump cancellation closes a pump that settles after opening is abandoned", async () => {
  const pumpReady = deferred<EnginePump>();
  const pumpCalled = deferred<void>();
  const controller = new AbortController();
  let leaseClosed = 0;
  const lease: SparsePcmSessionLease = {
    leaseId: "late-pump", sources: [],
    async read() { throw new Error("custom pump does not read descriptors"); },
    async close() { leaseClosed += 1; },
  };
  const events: string[] = [];
  const context = fakeContext(events);
  const denseBase = baseOptions();
  const opening = openSparseEngineWebSession({
    document: denseBase.document, sources: denseBase.sources!, leaseId: "late-pump", resolver: undefined,
    signal: controller.signal, console: false, capabilityScope: capabilities(),
    scratchBoot: async () => ({ sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16,
      backend: "simd128", tracks: [], sources: [{ id: "source", channels: 1, frames: 4n }] }),
    store: { async openSession() { return lease; } },
    createContext: () => context,
    createHost: async () => ({ node: { connect() {}, disconnect() {} }, async dispose() {} } as unknown as BrowserEngine["host"]),
    createAttachNode: () => ({ port: { postMessage(message: unknown) {
      const request = message as { op: string; rings?: SharedArrayBuffer[] };
      if (request.op === "attach") for (const ring of request.rings ?? []) Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1);
    } }, disconnect() {} }),
    createPump: async () => { pumpCalled.resolve(); return pumpReady.promise; },
    createOutput: () => ({ connect() {}, disconnect() {} }) as unknown as AudioNode,
  });
  await pumpCalled.promise;
  const reason = new Error("pump opening cancelled"); controller.abort(reason);
  let pumpClosed = 0;
  pumpReady.resolve({ async seekFrames() { return 0n; }, close() { pumpClosed += 1; } });
  await assert.rejects(opening, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.open");
  assert.equal(pumpClosed, 1, "a late pump is closed after the prefill observes cancellation");
  assert.equal(leaseClosed, 1);
});

test("sparse default ownership activates and releases its OPFS Worker on normal close", async (t) => {
  const events: string[] = [];
  const root = new SessionOpfsDirectory();
  const storage = { getDirectory: async () => root };
  const seed = sparseOwnedExpected();
  const seedBackend = new OpfsStorageBackend({ storage: storage as never, createWorker: () => sessionOpfsWorker(root, events) });
  const seedStore = new VerifiedSparsePcmStore({ backend: seedBackend, instanceId: "session-seed" });
  await seedStore.installSource(seed, { resolve: async () => sparseOwnedSpans(seed) });
  await seedStore.close(); seedBackend.close();
  const workers: Array<SessionOpfsWorkerState> = [];
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { storage }, configurable: true, writable: true });
  t.after(() => restoreNavigator(previousNavigator));
  const sources: DeclaredStemSource[] = [{ id: "owned-source", spec: {
    channels: seed.channels, bitDepth: seed.bitDepth, frames: seed.frames, content: seed.identity,
  } }];
  const context = fakeContext(events);
  const session = await openOwnedSparseSession({
    sources, context,
    assets: { createWorker: () => {
      const worker = sessionOpfsWorker(root, events); workers.push(worker); return worker as unknown as Worker;
    } },
  });
  assert.equal(workers.length, 1, "the default sparse backend must activate one write Worker");
  assert.equal(workers[0]!.terminated, false);
  await session.close();
  await session.close();
  assert.equal(workers[0]!.terminated, true, "session close must release the owned backend Worker");
  assert.equal(workers[0]!.terminations, 1);
});

test("sparse map cleanup failure still closes the owned store and OPFS Worker", async (t) => {
  const events: string[] = [];
  const root = new SessionOpfsDirectory();
  const storage = { getDirectory: async () => root };
  const seed = sparseOwnedExpected();
  const seedBackend = new OpfsStorageBackend({ storage: storage as never, createWorker: () => sessionOpfsWorker(root, events) });
  const seedStore = new VerifiedSparsePcmStore({ backend: seedBackend, instanceId: "session-seed-failure" });
  await seedStore.installSource(seed, { resolve: async () => sparseOwnedSpans(seed) });
  await seedStore.close(); seedBackend.close();
  events.length = 0;
  const workers: Array<SessionOpfsWorkerState> = [];
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { storage }, configurable: true, writable: true });
  t.after(() => restoreNavigator(previousNavigator));
  const originalOpen = VerifiedSparsePcmStore.prototype.openSession;
  const originalClose = VerifiedSparsePcmStore.prototype.close;
  let storeCloseCalls = 0;
  const mapFailure = new Error("map cleanup failed");
  t.mock.method(VerifiedSparsePcmStore.prototype, "openSession", async function (this: VerifiedSparsePcmStore, options: SparsePcmSessionOptions) {
    const lease = await originalOpen.call(this, options);
    return { ...lease, async close() { events.push("map"); throw mapFailure; } };
  });
  t.mock.method(VerifiedSparsePcmStore.prototype, "close", async function (this: VerifiedSparsePcmStore) {
    storeCloseCalls += 1; events.push("store"); return originalClose.call(this);
  });
  const sources: DeclaredStemSource[] = [{ id: "owned-source", spec: {
    channels: seed.channels, bitDepth: seed.bitDepth, frames: seed.frames, content: seed.identity,
  } }];
  const session = await openOwnedSparseSession({
    sources, context: fakeContext(events),
    assets: { createWorker: () => {
      const worker = sessionOpfsWorker(root, events); workers.push(worker); return worker as unknown as Worker;
    } },
  });
  assert.equal(workers.length, 1);
  const closing = session.close(); assert.equal(session.close(), closing);
  await assert.rejects(closing, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.open");
  assert.equal(storeCloseCalls, 1);
  assert.equal(workers[0]!.terminated, true, "backend release must run after a rejected map close");
  assert.deepEqual(events.filter((event) => ["map", "store", "backend"].includes(event)), ["map", "store", "backend"]);
});

test("sparse opening releases the owned OPFS Worker when write support fails before ready", async (t) => {
  const events: string[] = [];
  const root = new SessionOpfsDirectory();
  const storage = { getDirectory: async () => root };
  const workers: Array<SessionOpfsWorkerState> = [];
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { storage }, configurable: true, writable: true });
  t.after(() => restoreNavigator(previousNavigator));
  const sources: DeclaredStemSource[] = [{ id: "unready-source", spec: {
    channels: 1, bitDepth: 16, frames: 1, content: IDENTITY,
  } }];
  await assert.rejects(openSparseEngineWebSession({
    document: documentFor(sources), sources, console: false, capabilityScope: capabilities(),
    scratchBoot: async () => ({ sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16,
      backend: "simd128", tracks: [], sources: [{ id: "unready-source", channels: 1, frames: 1n }] }),
    assets: { createWorker: () => {
      const worker = sessionOpfsWorker(root, events, "error"); workers.push(worker); return worker as unknown as Worker;
    } },
  }), (error: unknown) => error instanceof EngineWebAdapterError);
  assert.equal(workers.length, 1);
  assert.equal(workers[0]!.terminated, true, "a failed handshake must terminate the owned Worker");
});

const SPARSE_OWNED_BYTES = new Uint8Array([1, 2]);

function sparseOwnedExpected(): SparsePcmExpectation {
  return {
    identity: identityFor(SPARSE_OWNED_BYTES),
    sampleRateHz: 48_000, channels: 1, bitDepth: 16, frames: 1, canonicalBytes: 2,
  };
}

function sparseOwnedSpans(_expected: SparsePcmExpectation): { readonly spans: AsyncIterable<{ readonly startFrame: number; readonly bytes: Uint8Array }> } {
  return { spans: (async function*() { yield { startFrame: 0, bytes: SPARSE_OWNED_BYTES }; })() };
}

async function openOwnedSparseSession(input: {
  readonly sources: readonly DeclaredStemSource[];
  readonly context: EngineAudioContext;
  readonly assets: NonNullable<EngineWebSessionOptions["assets"]>;
}): Promise<import("../src/session-types.js").EngineWebSession> {
  return openSparseEngineWebSession({
    document: documentFor(input.sources), sources: input.sources, console: false, capabilityScope: capabilities(), assets: input.assets,
    scratchBoot: async () => ({ sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16,
      backend: "simd128", tracks: [], sources: input.sources.map((source) => ({ id: source.id, channels: source.spec.channels, frames: BigInt(source.spec.frames) })) }),
    createContext: () => input.context,
    createHost: async () => ({ node: { connect() {}, disconnect() {} }, async dispose() {} } as unknown as BrowserEngine["host"]),
    createAttachNode: () => ({ port: { postMessage(message: unknown) {
      const request = message as { readonly op: string; readonly rings?: readonly SharedArrayBuffer[] };
      if (request.op === "attach") for (const ring of request.rings ?? []) Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1);
    } }, disconnect() {} }),
    createPump: async ({ sources }) => {
      for (const source of sources) fillRing(source.ring, source.frames);
      return { async seekFrames() { return 0n; }, close() {} };
    },
    createOutput: () => ({ connect() {}, disconnect() {} }) as unknown as AudioNode,
  });
}

function restoreNavigator(previous: PropertyDescriptor | undefined): void {
  if (previous === undefined) delete (globalThis as { navigator?: unknown }).navigator;
  else Object.defineProperty(globalThis, "navigator", previous);
}

class SessionOpfsDirectory {
  readonly kind = "directory" as const;
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Map<string, SessionOpfsDirectory>();

  async getDirectoryHandle(name: string, options: { readonly create?: boolean } = {}): Promise<SessionOpfsDirectory> {
    const existing = this.directories.get(name);
    if (existing !== undefined) return existing;
    if (options.create !== true) throw sessionOpfsNotFound(name);
    const created = new SessionOpfsDirectory(); this.directories.set(name, created); return created;
  }
  async getFileHandle(name: string, options: { readonly create?: boolean } = {}): Promise<SessionOpfsFileHandle> {
    if (!this.files.has(name) && options.create !== true) throw sessionOpfsNotFound(name);
    if (!this.files.has(name)) this.files.set(name, new Uint8Array());
    return new SessionOpfsFileHandle(this, name);
  }
  async removeEntry(name: string): Promise<void> { this.files.delete(name); this.directories.delete(name); }
  async *entries(): AsyncIterableIterator<[string, { readonly kind: "file" | "directory" }]> {
    for (const name of this.files.keys()) yield [name, { kind: "file" }];
    for (const name of this.directories.keys()) yield [name, { kind: "directory" }];
  }
}

class SessionOpfsFileHandle {
  readonly kind = "file" as const;
  constructor(private readonly directory: SessionOpfsDirectory, private readonly name: string) {}
  async getFile(): Promise<Blob> { return new Blob([(this.directory.files.get(this.name) ?? new Uint8Array()).buffer as ArrayBuffer]); }
  async move(directory: unknown, name: string): Promise<void> {
    const target = directory as SessionOpfsDirectory;
    const bytes = this.directory.files.get(this.name);
    if (bytes === undefined) throw sessionOpfsNotFound(this.name);
    target.files.set(name, bytes); this.directory.files.delete(this.name);
  }
}

function sessionOpfsNotFound(name: string): DOMException { return new DOMException(`${name} was not found`, "NotFoundError"); }

interface SessionOpfsWorkerState extends OpfsWorkerLike {
  readonly terminated: boolean;
  readonly terminations: number;
}

function sessionOpfsWorker(root: SessionOpfsDirectory, events: string[], mode: "ready" | "error" = "ready"): SessionOpfsWorkerState {
  const messages = new Set<(event: MessageEvent<OpfsWorkerResponse>) => void>();
  const errors = new Set<(event: ErrorEvent) => void>();
  const messageErrors = new Set<() => void>();
  const writers = new Map<number, { readonly directory: SessionOpfsDirectory; readonly name: string; bytes: Uint8Array }>();
  let dead = false;
  let terminations = 0;
  const emit = (message: OpfsWorkerResponse) => { if (!dead) for (const listener of messages) listener({ data: message } as MessageEvent<OpfsWorkerResponse>); };
  const worker: SessionOpfsWorkerState = {
    get terminated() { return dead; },
    get terminations() { return terminations; },
    postMessage(message: OpfsWorkerRequest) {
      if (dead) return;
      queueMicrotask(async () => {
        if (dead) return;
        if (message.type === "write-open") {
          const directory = await root.getDirectoryHandle(message.folderName, { create: true });
          await directory.getFileHandle(message.name, { create: true });
          writers.set(message.writerId, { directory, name: message.name, bytes: new Uint8Array() });
        } else {
          const writer = writers.get(message.writerId);
          if (writer === undefined) return;
          if (message.type === "write") {
            const bytes = new Uint8Array(writer.bytes.byteLength + message.chunk.byteLength);
            bytes.set(writer.bytes); bytes.set(message.chunk, writer.bytes.byteLength); writer.bytes = bytes;
          } else if (message.type === "write-close") {
            writer.directory.files.set(writer.name, writer.bytes); writers.delete(message.writerId);
          } else { writer.directory.files.delete(writer.name); writers.delete(message.writerId); }
        }
        emit({ type: "opfs-started", requestId: message.requestId });
        emit({ type: "opfs-ok", requestId: message.requestId });
      });
    },
    terminate() { if (!dead) { dead = true; terminations += 1; events.push("backend"); writers.clear(); } },
    addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void) {
      if (type === "message") messages.add(listener as (event: MessageEvent<OpfsWorkerResponse>) => void);
      else if (type === "error") errors.add(listener as (event: ErrorEvent) => void);
      else messageErrors.add(listener as () => void);
    },
    removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void) {
      if (type === "message") messages.delete(listener as (event: MessageEvent<OpfsWorkerResponse>) => void);
      else if (type === "error") errors.delete(listener as (event: ErrorEvent) => void);
      else messageErrors.delete(listener as () => void);
    },
  };
  queueMicrotask(() => {
    if (mode === "ready") emit({ type: "worker-ready", writeSupport: true });
    else {
      const error = new Error("intentional OPFS Worker startup failure");
      for (const listener of errors) listener({ error, message: error.message } as ErrorEvent);
    }
  });
  return worker;
}

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
  const policy = { sourceRingFrames: 16, console: { commandQueueRecords: 8, meterBlocks: 2 } };
  let scratchPolicy: unknown;
  let hostPolicy: unknown;
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
    policy,
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
      scratchPolicy = request.options;
      scratchStarted.resolve();
      await releaseScratch.promise;
      return {
        sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16, backend: "simd128",
        sources: [{ id: "source", channels: 1, frames: 4n }], tracks: [],
      };
    },
    createContext: () => context,
    createHost: async (request) => {
      assert.equal("preparedModule" in request, false, "custom shape-only scratch remains compatible");
      hostDocument = request.document; hostPolicy = request.options; return host;
    },
    createAttachNode: () => ({
      port: { postMessage(message: unknown) {
        const value = message as { op: string; rings?: SharedArrayBuffer[] };
        if (value.op === "attach") for (const ring of value.rings ?? []) Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1);
      } },
      disconnect() {},
    }),
    createPump: async ({ sources }) => {
      for (const source of sources) fillRing(source.ring, source.frames);
      return { async seekFrames() { return 0n; }, close() {} };
    },
    createOutput: () => ({ connect() {}, disconnect() {} }) as unknown as AudioNode,
  });
  await scratchStarted.promise;
  document.fill(0x78);
  policy.sourceRingFrames = 99;
  policy.console.commandQueueRecords = 99;
  policy.console.meterBlocks = 99;
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
  assert.deepEqual(scratchPolicy, { sourceRingFrames: 16, requireSampleRateHz: 0, requireQuantumFrames: 0,
    console: { commandQueueRecords: 8, meterBlocks: 2 } });
  assert.deepEqual(hostPolicy, { sourceRingFrames: 16, requireSampleRateHz: 48_000, requireQuantumFrames: 4,
    console: { commandQueueRecords: 8, meterBlocks: 2 } });
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

async function pausedSeekFixture(attached = true, hooks: {
  readonly failure?: Promise<unknown>;
  readonly onError?: (error: EngineWebAdapterError) => void;
  readonly onProgress?: EngineWebSessionCommonOptions["onProgress"];
  readonly cleanupGate?: Promise<void>;
  readonly sessionMap?: BrowserEngine["host"]["sessionMap"];
  readonly events?: string[];
} = {}) {
  const events: string[] = hooks.events ?? [];
  const context = fakeContext(events);
  const sources: DeclaredStemSource[] = [{ id: "source", spec: { channels: 1, bitDepth: 16, frames: 512, content: IDENTITY } }];
  let ring!: SharedArrayBuffer;
  let writer!: Msb1RingWriter;
  let generation = 1n;
  let request: any;
  let seekGate: Promise<void> = Promise.resolve();
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage(message: unknown) {
      const data = message as any;
      if (data.op === "attach") {
        ring = data.rings[0];
        if (attached) Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1);
      } else if (data.op === "prepare-seek") { events.push("prepare"); request = data; }
      else events.push("detach");
    },
  };
  const host = {
    node: { connect() {}, disconnect() {} },
    ...(hooks.sessionMap === undefined ? {} : { sessionMap: hooks.sessionMap }),
    async dispose() { events.push("dispose"); await hooks.cleanupGate; },
  } as unknown as BrowserEngine["host"];
  const session = await openEngineWebSession({
    ...baseOptions(), sources, document: documentFor(sources),
    ...(hooks.sessionMap === undefined ? { console: false as const } : {}),
    ...(hooks.onError === undefined ? {} : { onError: hooks.onError }),
    ...(hooks.onProgress === undefined ? {} : { onProgress: hooks.onProgress }),
    capabilityScope: capabilities(), createContext: () => context, createHost: async () => host,
    scratchBoot: async () => ({ sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16,
      backend: "simd128", sources: [{ id: "source", channels: 1, frames: 512n }], tracks: [] }),
    store: { async open() { return this; }, async openSession() { return {
      leaseId: "seek", stems: [{ sourceId: "source", identity: IDENTITY, bytes: 1024 }],
      async read() { return new Blob([new Uint8Array(1024)]); }, async close() { events.push("lease.close"); },
    }; } },
    createAttachNode: () => ({ port, disconnect() {} }),
    createPump: async () => {
      writer = new Msb1RingWriter(ring); writer.engage(generation);
      for (let index = 0; index < writer.capacity; index++) {
        writer.reserve(4)![0]!.fill(0.25);
        writer.commit({ generation, startFrame: BigInt(index * 4), frames: 4, endOfRegion: false });
      }
      return { ...(hooks.failure === undefined ? {} : { failure: hooks.failure }), async seekFrames(frame) {
        events.push("seek.start"); await seekGate;
        generation++; writer.seek(generation, BigInt(frame) > 512n ? 512n : BigInt(frame));
        events.push("seek.ack"); return generation;
      }, close() { writer.release(); events.push("pump.close"); } };
    },
  });
  return {
    session, events, context,
    attach() { Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1); },
    blockSeek(promise: Promise<void>) { seekGate = promise; },
    confirm(result = 0) {
      assert.ok(request);
      // Test consumer retires old slots; production owns this exclusively in the SDK.
      const control = new Int32Array(ring);
      Atomics.store(control, MSB1_CONTROL.READ_INDEX, Atomics.load(control, MSB1_CONTROL.WRITE_INDEX));
      const data = { op: "seek-prepared", requestId: request.requestId, seeks: request.seeks,
        kind: result === 0 ? "confirmed" : "refused", result };
      request = undefined; port.onmessage?.({ data } as MessageEvent);
    },
    fill(frame: bigint) {
      while (writer.occupancy < writer.capacity && frame < 512n) {
        const frames = Number(512n - frame < 4n ? 512n - frame : 4n);
        writer.reserve(frames)![0]!.fill(0.5);
        writer.commit({ generation, startFrame: frame, frames, endOfRegion: frame + BigInt(frames) === 512n });
        frame += BigInt(frames);
      }
    },
    retire() { const c = new Int32Array(ring); Atomics.store(c, MSB1_CONTROL.READ_INDEX, Atomics.load(c, MSB1_CONTROL.WRITE_INDEX)); },
    write(frame: bigint, chunkGeneration = generation) {
      writer.reserve(4)![0]!.fill(0.5);
      writer.commit({ generation: chunkGeneration, startFrame: frame, frames: 4, endOfRegion: false });
    },
  };
}

async function tick() { await new Promise<void>((resolve) => setTimeout(resolve, 5)); }

test("terminal pump failure closes a playing session before one post-cleanup callback", async () => {
  const failed = deferred<unknown>(); const cleanup = deferred<void>();
  const errors: EngineWebAdapterError[] = [];
  const f = await pausedSeekFixture(true, { failure: failed.promise, cleanupGate: cleanup.promise, onError: (error) => { errors.push(error); } });
  await f.session.play();
  const reason = new Error("pump worker crashed"); failed.resolve(reason);
  await tick();
  assert.equal(f.session.state, "closed");
  await assert.rejects(f.session.play(), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.closed");
  assert.equal(errors.length, 0, "notification follows cleanup even when cleanup is delayed");
  const closing = f.session.close(); assert.equal(f.session.close(), closing);
  cleanup.resolve(); await closing; await tick();
  assert.equal(errors.length, 1); assert.equal(errors[0]!.code, "session.playback"); assert.equal(errors[0]!.cause, reason);
  for (const event of ["pump.close", "dispose", "context.close", "lease.close"]) assert.equal(f.events.filter((value) => value === event).length, 1);
});

test("pump failure during a pending seek aborts the lifecycle and notifies once", async () => {
  const failed = deferred<unknown>(); const never = deferred<void>();
  let notifications = 0;
  const f = await pausedSeekFixture(true, { failure: failed.promise, onError: () => { notifications++; } });
  f.blockSeek(never.promise);
  const seeking = f.session.seekFrames(100);
  const rejected = assert.rejects(seeking, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.closed");
  await tick(); failed.resolve(new Error("read deadline")); await rejected; await tick();
  assert.equal(f.session.state, "closed"); assert.equal(notifications, 1);
  never.resolve(); await tick(); assert.equal(f.events.includes("context.resume"), false);
});

test("explicit close wins a late pump failure and callback errors cannot escape cleanup", async () => {
  const failed = deferred<unknown>(); let notifications = 0;
  const f = await pausedSeekFixture(true, { failure: failed.promise, onError: () => { notifications++; } });
  await f.session.close(); failed.resolve(new Error("late crash")); await tick();
  assert.equal(notifications, 0);
  for (const onError of [() => { throw new Error("observer throws"); }, async () => { throw new Error("observer rejects"); }]) {
    const terminal = deferred<unknown>();
    const g = await pausedSeekFixture(true, { failure: terminal.promise, onError });
    terminal.resolve(new Error("read rejected")); await tick(); await g.session.close(); await tick();
    assert.equal(g.session.state, "closed");
  }
});

test("pump failure during opening rejects open instead of duplicating a runtime callback", async () => {
  const failed = deferred<unknown>(); const reason = new Error("prefill worker failed"); let notifications = 0;
  await assert.rejects(pausedSeekFixture(true, {
    failure: failed.promise, onError: () => { notifications++; },
    onProgress: (progress) => { if (progress.stage === "prefilling") failed.resolve(reason); },
  }), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.playback" && error.cause === reason);
  assert.equal(notifications, 0);
});

test("pump failure interrupts either opening console map without awaiting late success or rejection", { timeout: 2000 }, async () => {
  for (const pendingMap of [1, 2]) for (const lateReject of [false, true]) {
    const failed = deferred<unknown>(); const entered = deferred<void>(); const release = deferred<void>();
    const events: string[] = []; const reason = new Error("pump failed while attaching console");
    let calls = 0; let notifications = 0;
    const opening = pausedSeekFixture(true, {
      failure: failed.promise, events, onError: () => { notifications++; },
      async sessionMap() {
        if (++calls === pendingMap) {
          entered.resolve(); await release.promise;
          if (lateReject) throw new Error("late map rejection");
        }
        return { tag: "miso.sessionmap.v1", requestId: calls, result: 0, tracks: [], sources: [{ id: "source", channels: 1, frames: 512n }], metersAttached: false };
      },
    });
    const refused = assert.rejects(opening, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.playback" && error.cause === reason);
    await entered.promise; failed.resolve(reason);
    await refused;
    assert.equal(notifications, 0, "opening failures only reject open");
    for (const event of ["pump.close", "dispose", "context.close", "lease.close"]) assert.equal(events.filter((value) => value === event).length, 1, event + " must not wait for a map");
    release.resolve(); await tick();
    assert.equal(notifications, 0);
    for (const event of ["pump.close", "dispose", "context.close", "lease.close"]) assert.equal(events.filter((value) => value === event).length, 1, "late attachment must not repeat " + event);
  }
});

test("same-turn console map completion and pump failure preserve the opening cause", async () => {
  for (const failFirst of [false, true]) {
    const failed = deferred<unknown>(); const entered = deferred<void>(); const release = deferred<void>();
    const events: string[] = []; const reason = new Error("same-turn failure"); let calls = 0;
    const opening = pausedSeekFixture(true, {
      failure: failed.promise, events,
      async sessionMap() {
        if (++calls === 2) { entered.resolve(); await release.promise; }
        return { tag: "miso.sessionmap.v1", requestId: calls, result: 0, tracks: [], sources: [{ id: "source", channels: 1, frames: 512n }], metersAttached: false };
      },
    });
    const refused = assert.rejects(opening, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.playback" && error.cause === reason);
    await entered.promise;
    if (failFirst) { failed.resolve(reason); release.resolve(); }
    else { release.resolve(); failed.resolve(reason); }
    await refused; await tick();
    for (const event of ["pump.close", "dispose", "context.close", "lease.close"]) assert.equal(events.filter((value) => value === event).length, 1);
  }
});

test("initial readiness waits for every source's full runway while accepting exact short tails", async () => {
  const sources: DeclaredStemSource[] = [
    { id: "source", spec: { channels: 1, bitDepth: 16, frames: 2, content: IDENTITY } },
    { id: "source-z", spec: { channels: 1, bitDepth: 16, frames: 513, content: IDENTITY_Z } },
  ];
  const events: string[] = [];
  let finish!: () => void;
  let settled = false;
  const opening = openEngineWebSession({
    ...baseOptions(), sources, document: documentFor(sources), console: false,
    capabilityScope: capabilities(), createContext: () => fakeContext(events),
    scratchBoot: async () => ({ sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16,
      backend: "simd128", tracks: [], sources: sources.map((source) => ({ id: source.id, channels: 1, frames: BigInt(source.spec.frames) })) }),
    store: { async open() { return this; }, async openSession() { return {
      leaseId: "mixed", stems: [], async read() { throw new Error("fixture pump owns PCM"); }, async close() {},
    }; } },
    createHost: async () => ({ node: { connect() {}, disconnect() {} }, async dispose() {} }) as unknown as BrowserEngine["host"],
    createAttachNode: () => ({ port: { postMessage() {} }, disconnect() {} }),
    createPump: async ({ sources: ready }) => {
      fillRing(ready[0]!.ring, 2);
      const writer = new Msb1RingWriter(ready[1]!.ring); writer.engage(1n);
      writer.reserve(4); writer.commit({ generation: 1n, startFrame: 0n, frames: 4, endOfRegion: false });
      finish = () => {
        for (let frame = 4; writer.occupancy < writer.capacity; frame += 4) {
          writer.reserve(4); writer.commit({ generation: 1n, startFrame: BigInt(frame), frames: 4, endOfRegion: false });
        }
      };
      return { async seekFrames() { return 2n; }, close() { writer.release(); } };
    },
  }).then((session) => { settled = true; return session; });
  await tick(); await tick();
  assert.equal(settled, false, "one ready short source and one quantum of the long source cannot start playback");
  finish();
  const session = await opening;
  assert.equal(session.state, "ready");
  await session.close();
});

test("seek runway clips to the exact source tail and EOF needs no invented PCM", async () => {
  const f = await pausedSeekFixture();
  const tail = f.session.seekFrames(510);
  await tick(); f.confirm(); f.fill(510n); await tail;
  assert.equal(f.context.state, "suspended");
  const eof = f.session.seekFrames(512);
  await tick(); f.confirm(); await eof;
  const beyond = f.session.seekFrames(600);
  await tick(); f.confirm(); await beyond;
  assert.equal(f.context.state, "suspended");
  await f.session.close();
});

test("initial paused seeks require attachment, producer ACK, preparation and full-generation target PCM before play", async () => {
  const f = await pausedSeekFixture(false);
  const release = deferred<void>(); f.blockSeek(release.promise);
  let settled = false;
  const seek = f.session.seekFrames(100).then(() => { settled = true; });
  await assert.rejects(f.session.play(), (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.busy");
  assert.equal(f.events.includes("context.resume"), false);
  await tick(); assert.equal(f.events.includes("seek.start"), false);
  f.attach(); await tick(); assert.equal(f.events.at(-1), "seek.start");
  release.resolve(); await tick();
  assert.deepEqual(f.events.slice(-2), ["seek.ack", "prepare"]);
  assert.equal(settled, false, "full old occupancy is not seek readiness");
  f.confirm(); await tick(); assert.equal(settled, false, "prepare alone is not producer prefill");
  f.write(100n, 2n + (1n << 32n)); await tick(); assert.equal(settled, false, "low-word generation collision is insufficient");
  f.retire();
  f.write(100n); await tick(); assert.equal(settled, false, "one fresh quantum is not a playback runway");
  f.fill(104n); await seek;
  assert.equal(f.context.state, "suspended");
  const play = f.session.play(); assert.equal(f.events.at(-1), "context.resume"); await play;
  await f.session.close();
});

test("queued seeks keep play busy through the last completion; running seeks prepare and EOF remains supported", async () => {
  const f = await pausedSeekFixture();
  const first = f.session.seekFrames(100);
  const second = f.session.seekFrames(512);
  await tick(); f.confirm(); f.fill(100n); await first;
  await assert.rejects(f.session.play(), (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.busy");
  await tick(); f.confirm(); await second;
  assert.equal(f.events.includes("context.resume"), false);
  await assert.rejects(f.session.seekFrames(0.5), RangeError);
  assert.equal(f.session.state, "ready", "invalid input leaves the session usable");
  await f.session.play();
  const count = f.events.filter((event) => event === "prepare").length;
  const runningSeek = f.session.seekFrames(20);
  await tick();
  assert.equal(f.context.state, "suspended");
  assert.deepEqual(f.events.slice(-4), ["context.suspend", "seek.start", "seek.ack", "prepare"]);
  f.confirm(); await tick();
  assert.equal(f.context.state, "suspended", "fresh target must precede restoration");
  f.fill(20n); await runningSeek;
  assert.equal(f.context.state, "running");
  assert.equal(f.events.filter((event) => event === "prepare").length, count + 1);
  await f.session.close();
});

test("paused prepare refusal retains result and closes; close interrupts preparation or refill promptly", async () => {
  const f = await pausedSeekFixture();
  const seeking = f.session.seekFrames(100);
  const rejected = assert.rejects(seeking, (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.seek"
    && e.cause instanceof EngineWebAdapterError && e.cause.cause instanceof PcmFeedError && e.cause.cause.result === 6);
  await tick(); f.confirm(6); await rejected;
  assert.equal(f.session.state, "closed");
  await assert.rejects(f.session.play(), (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.closed");
  assert.equal(f.events.includes("context.resume"), false);
  for (const prepared of [false, true]) {
    const g = await pausedSeekFixture();
    const pending = g.session.seekFrames(100);
    const closingSeek = assert.rejects(pending, (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.closed");
    await tick(); if (prepared) g.confirm(); await tick();
    const close = g.session.close(); assert.equal(g.session.close(), close);
    await Promise.race([close, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("close blocked on seek")), 100))]);
    await closingSeek;
    await assert.rejects(g.session.play(), (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.closed");
  }
});

test("wrong first target cannot be hidden by a later matching chunk", async () => {
  const f = await pausedSeekFixture();
  const seeking = f.session.seekFrames(100);
  const rejected = assert.rejects(seeking, (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.seek"
    && e.cause instanceof EngineWebAdapterError && e.cause.details.reason === "mismatch"
    && e.cause.details.sourceId === "source" && e.cause.cause instanceof PcmRunwayError);
  await tick(); f.confirm(); f.write(101n); f.write(100n);
  await rejected;
  assert.equal(f.session.state, "closed");
  assert.equal(f.events.includes("context.resume"), false);
});

test("paused preparation and fresh prefill deadlines close rather than allow play", { timeout: 6000 }, async () => {
  for (const prepared of [false, true]) {
    const f = await pausedSeekFixture();
    const seeking = f.session.seekFrames(100);
    const rejected = assert.rejects(seeking, (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.seek");
    await tick(); if (prepared) f.confirm();
    await rejected;
    assert.equal(f.session.state, "closed");
    await assert.rejects(f.session.play(), (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.closed");
    assert.equal(f.events.includes("context.resume"), false);
  }
});

test("running seeks preserve FIFO with later seeks and pause, without late restoration", async () => {
  const f = await pausedSeekFixture(); await f.session.play();
  await assert.rejects(f.session.seekFrames(-1), RangeError);
  assert.equal(f.context.state, "running");
  const first = f.session.seekFrames(100);
  const second = f.session.seekFrames(200);
  const pause = f.session.pause();
  await assert.rejects(f.session.play(), (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.busy");
  await tick(); f.confirm(); f.fill(100n); await first;
  await tick(); assert.equal(f.context.state, "suspended");
  f.confirm(); f.fill(200n); await second; await pause;
  assert.equal(f.context.state, "suspended"); assert.equal(f.session.state, "paused");
  const resumes = f.events.filter((event) => event === "context.resume").length;
  assert.equal(resumes, 3, "initial play plus one restoration per running seek");
  await tick(); assert.equal(f.events.filter((event) => event === "context.resume").length, resumes);
  await f.session.close();
});

test("seek context transitions preserve refusals and reject wrong settled states", async () => {
  for (const transition of ["suspend", "resume"] as const) {
    for (const fault of ["reject", "state"] as const) {
      const f = await pausedSeekFixture(); await f.session.play();
      const reason = new Error(transition + " refused");
      f.context[transition] = async () => { if (fault === "reject") throw reason; };
      const pending = f.session.seekFrames(100);
      const rejected = assert.rejects(pending, (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.seek"
        && (fault === "reject" ? e.cause === reason : e.cause instanceof EngineWebAdapterError));
      if (transition === "resume") { await tick(); f.confirm(); f.fill(100n); }
      await rejected;
      assert.equal(f.session.state, "closed");
      if (transition === "suspend") assert.equal(f.events.includes("seek.start"), false);
      await assert.rejects(f.session.play(), (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.closed");
    }
  }
});

test("hung seek context transitions time out and clear bounded timers", { timeout: 6000 }, async (t) => {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms?: number) => {
    const timer = nativeSet(callback, ms);
    if (ms === 2000) timers.add(timer);
    return timer;
  }) as typeof setTimeout);
  t.mock.method(globalThis, "clearTimeout", ((timer: ReturnType<typeof setTimeout>) => {
    timers.delete(timer); nativeClear(timer);
  }) as typeof clearTimeout);
  for (const transition of ["suspend", "resume"] as const) {
    const f = await pausedSeekFixture(); await f.session.play();
    f.context[transition] = () => new Promise<void>(() => undefined);
    const rejected = assert.rejects(f.session.seekFrames(100), (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.seek"
      && e.cause instanceof EngineWebAdapterError && e.cause.message.includes("timed out"));
    if (transition === "resume") { await tick(); f.confirm(); f.fill(100n); }
    await rejected;
    assert.equal(f.session.state, "closed"); assert.equal(timers.size, 0);
  }
});

test("close wins at every running seek await and late transitions never resume again", async () => {
  for (const stage of ["suspend", "prepare", "refill", "resume"] as const) {
    const f = await pausedSeekFixture(); await f.session.play();
    const transition = deferred<void>(); let restores = 0;
    if (stage === "suspend") f.context.suspend = () => transition.promise;
    const resume = f.context.resume.bind(f.context);
    f.context.resume = () => { restores++; return stage === "resume" ? transition.promise : resume(); };
    const pending = f.session.seekFrames(100);
    const rejected = assert.rejects(pending, (e: unknown) => e instanceof EngineWebAdapterError && e.code === "session.closed");
    await tick();
    if (stage === "refill" || stage === "resume") f.confirm();
    if (stage === "resume") f.fill(100n);
    await tick();
    await f.session.close(); await rejected;
    const expected = stage === "resume" ? 1 : 0;
    assert.equal(restores, expected); assert.equal(f.context.state, "closed");
    transition.resolve(); await tick();
    assert.equal(restores, expected); assert.equal(f.session.state, "closed");
  }
});

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

function sessionSparseProgressFixture(
  flac: Uint8Array | undefined,
  pcm: Uint8Array | undefined,
  frames: number,
  activeStartFrame: number,
): { readonly body: Uint8Array; readonly expected: SparsePcmExpectation } {
  const canonical = new Uint8Array(frames * 2);
  const identity = identityFor(canonical);
  const expected: SparsePcmExpectation = {
    identity, sampleRateHz: 48_000, channels: 1, bitDepth: 16, frames, canonicalBytes: canonical.byteLength,
  };
  const intervals = flac === undefined || pcm === undefined
    ? []
    : [{ startFrame: activeStartFrame, frames: pcm.byteLength / 2, packedFrameOffset: 0 }];
  const chunks = flac === undefined || pcm === undefined
    ? []
    : [{
      offset: 0, bytes: flac.byteLength, frames: pcm.byteLength / 2, packedStartFrame: 0,
      flacSha256: createHash("sha256").update(flac).digest("hex"),
      pcmSha256: createHash("sha256").update(pcm).digest("hex"),
    }];
  const manifest = {
    format: "miso_sparse_stem_v1" as const,
    identity, sampleRateHz: expected.sampleRateHz, channels: expected.channels, bitDepth: expected.bitDepth,
    frames, intervals, chunks,
  };
  const encoded = serializeSparseStemIndex(manifest);
  const header = new Uint8Array(16);
  header.set(new TextEncoder().encode("MISOSTM1"));
  new DataView(header.buffer).setUint32(8, encoded.byteLength, true);
  return { expected, body: new Uint8Array([...header, ...encoded, ...(flac ?? [])]) };
}

class SessionProgressDecodeWorker {
  readonly posted: FlacWorkerRequest[] = [];
  terminated = false;
  #slot: Extract<FlacWorkerRequest, { readonly type: "start" }>["inputSlot"] | undefined;
  #listeners = new Set<(event: { readonly data: FlacWorkerResponse }) => void>();
  #pendingOutputs: Array<{ readonly bytes: ArrayBuffer; readonly frames: number }> = [];
  #outputCredits = 0;
  #completeRequestId: number | undefined;
  #completePcmBytes = 0;
  #completeFrames = 0;

  constructor(readonly pcm: Uint8Array) {}

  postMessage(message: FlacWorkerRequest): void {
    if (this.terminated) return;
    this.posted.push(message);
    if (message.type === "start") {
      this.#slot = message.inputSlot;
      setTimeout(() => this.emit({ type: "ready", requestId: message.requestId }), 0);
    } else if (message.type === "initialize") {
      setTimeout(() => this.emit({ type: "input-credit", requestId: message.requestId, maximumBytes: 256 * 1024, phase: "audio", phaseBytesRemaining: 0 }), 0);
      setTimeout(() => this.poll(message.requestId, message.expectedFrames, message.totalPcmBytes), 0);
    } else if (message.type === "output-credit") {
      this.#outputCredits += 1;
      this.flushOutputs();
    }
  }

  terminate(): void { this.terminated = true; }

  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    if (type === "message") this.#listeners.add(listener);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    if (type === "message") this.#listeners.delete(listener);
  }

  private emit(message: FlacWorkerResponse): void {
    for (const listener of this.#listeners) listener({ data: message });
  }

  private poll(requestId: number, frames: number, pcmBytes: number): void {
    if (this.terminated || this.#slot === undefined) return;
    const control = new Int32Array(this.#slot.control);
    if (Atomics.load(control, 0) !== 1) {
      setTimeout(() => this.poll(requestId, frames, pcmBytes), 0);
      return;
    }
    const final = Atomics.load(control, 3) === 1;
    Atomics.store(control, 0, 0);
    if (!final) {
      setTimeout(() => this.emit({ type: "input-credit", requestId, maximumBytes: 256 * 1024, phase: "audio", phaseBytesRemaining: 0 }), 0);
      setTimeout(() => this.poll(requestId, frames, pcmBytes), 0);
      return;
    }
    const firstFrames = Math.floor(frames / 2);
    const frameBytes = pcmBytes / frames;
    const firstBytes = firstFrames * frameBytes;
    this.#pendingOutputs.push(
      { bytes: this.pcm.slice(0, firstBytes).buffer, frames: firstFrames },
      { bytes: this.pcm.slice(firstBytes).buffer, frames: frames - firstFrames },
    );
    this.#outputCredits = 2;
    this.#completeRequestId = requestId;
    this.#completePcmBytes = pcmBytes;
    this.#completeFrames = frames;
    this.flushOutputs();
  }

  private flushOutputs(): void {
    if (this.terminated || this.#completeRequestId === undefined) return;
    while (this.#outputCredits > 0 && this.#pendingOutputs.length > 0) {
      const output = this.#pendingOutputs.shift()!;
      this.#outputCredits -= 1;
      this.emit({ type: "pcm", requestId: this.#completeRequestId, bytes: output.bytes, frames: output.frames, totalPcmBytes: this.#completePcmBytes });
    }
    if (this.#pendingOutputs.length === 0) {
      const requestId = this.#completeRequestId;
      this.#completeRequestId = undefined;
      this.emit({ type: "complete", requestId, pcmBytes: this.#completePcmBytes, frames: this.#completeFrames });
    }
  }
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
  readonly module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  constructor(readonly events: string[]) {
    super();
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { type: "worker-ready" } })));
  }
  postMessage(message: { type?: string; requestId?: number }) {
    if (message.type !== "scratch" && message.type !== "prepare") return;
    this.events.push("scratch");
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
      type: "scratch-result", requestId: message.requestId, ok: true,
      ...(message.type === "prepare" ? { module: this.module } : {}),
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
  for (const boot of [scratchBootWithWorker, prepareBrowserSessionWithWorker]) for (const ready of [false, true]) {
    const worker = new FailingWorker();
    const pending = boot({ document: new Uint8Array(), options: {}, moduleUrl: "chosen-wasm",
      requestDeadlineMs: 5, assets: { createWorker: () => worker as unknown as Worker } });
    if (ready) worker.dispatchEvent(new MessageEvent("message", { data: { type: "worker-ready" } }));
    await assert.rejects(pending, (error: unknown) => error instanceof EngineWebAdapterError
      && error.code === "session.open" && error.cause instanceof BrowserBootError
      && error.cause.operation === "scratch-deadline");
    assert.equal(worker.terminated, true);
  }
});

test("delegated scratch retains caller Worker URL, Wasm URL and abort reason", async () => {
  for (const boot of [scratchBootWithWorker, prepareBrowserSessionWithWorker]) {
  const worker = new FailingWorker(); const controller = new AbortController();
  const workerUrl = new URL("https://caller.invalid/scratch.js");
  let received: unknown;
  worker.postMessage = (request?: unknown) => { received = request; };
  const opening = boot({ document: new Uint8Array([7]), options: {}, moduleUrl: "chosen-wasm",
    signal: controller.signal, assets: { scratchWorkerUrl: workerUrl, createWorker(url, options) {
      assert.equal(url, workerUrl); assert.deepEqual(options, { type: "module" }); return worker as unknown as Worker;
    } } });
  worker.dispatchEvent(new MessageEvent("message", { data: { type: "worker-ready" } }));
  assert.equal((received as { moduleUrl: string }).moduleUrl, "chosen-wasm");
  const reason = new Error("caller stopped"); controller.abort(reason);
  await assert.rejects(opening, (error: unknown) => error === reason);
  assert.equal(worker.terminated, true);
  }
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
      for (const source of sources) fillRing(source.ring, source.frames);
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
    { id: "z", spec: { channels: 1, bitDepth: 16, frames: 6, content: IDENTITY } },
    { id: "a", spec: { channels: 2, bitDepth: 24, frames: 6, content: IDENTITY_Z } },
    { id: "m", spec: { channels: 1, bitDepth: 16, frames: 6, content: IDENTITY } },
  ];
  const ordered = [declarations[1]!, declarations[2]!, declarations[0]!];
  for (const allocation of [undefined, { windowFrames: 17, maximumWindowBytes: 170 }]) {
    const rings: SharedArrayBuffer[] = [];
    const events: string[] = [];
    const session = await openEngineWebSession({
      ...baseOptions(), sources: declarations, document: documentFor(declarations), console: false,
      capabilityScope: capabilities(), createContext: () => fakeContext(events),
      scratchBoot: async () => ({ sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16,
        backend: "simd128", tracks: [], sources: ordered.map((source) => ({ id: source.id, channels: source.spec.channels, frames: 6n })) }),
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


test("per-open ingest diagnostics preserve warm admission lifetime, independent snapshots and unknown custom paths", { timeout: 5000 }, async () => {
  const early = createIngestDiagnostics();
  assert.deepEqual(early.snapshot(), { residency: null, reservation: null, processing: null });
  await assert.rejects(openEngineWebSession({ ...baseOptions(), ingestDiagnostics: early,
    capabilityScope: { crossOriginIsolated: false } }));
  assert.deepEqual(early.snapshot(), { residency: null, reservation: null, processing: null });
  await assert.rejects(openEngineWebSession({ ...baseOptions(), ingestDiagnostics: early }), /only one open/);

  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const identity = identityFor(pcm);
  const sources: DeclaredStemSource[] = [{ id: "source", spec: { channels: 1, bitDepth: 16, frames: 4, content: identity } }];
  const afterStore = new Error("stop after verified store");
  const makeWarm = () => {
    const backend = new MemoryStemStorageBackend();
    Object.assign(backend, { folderName: "miso-stems-v1" });
    backend.files.set(`blake3-${identity.slice(7)}`, pcm);
    backend.files.set("index.json", new TextEncoder().encode(JSON.stringify({ version: 1,
      stems: { [identity]: { bytes: pcm.length, pins: ["offline:existing"], lastUsedAt: 0 } } })));
    const reading = deferred<void>();
    const proceed = deferred<void>();
    const read = backend.read.bind(backend);
    backend.read = async name => { reading.resolve(); await proceed.promise; return read(name); };
    return { backend, reading, proceed, store: new VerifiedStemStore({ backend,
      // Separate in-memory origins: their identical content does not share browser locks.
      locks: { request: async (_name, _options, work) => work() },
    }) };
  };
  const common = {
    document: documentFor(sources), sources, capabilityScope: capabilities(),
    scratchBoot: async () => ({ sampleRateHz: 48000, quantumFrames: 4, sourceRingFrames: 16,
      backend: "simd128" as const, tracks: [], sources: [{ id: "source", channels: 1 as const, frames: 4n }] }),
    createContext: () => { throw afterStore; },
  };
  const one = makeWarm(); const two = makeWarm();
  const first = createIngestDiagnostics(); const second = createIngestDiagnostics();
  const open = (store: StemStore, diagnostics: ReturnType<typeof createIngestDiagnostics>, admission: BoundedStemAdmission, signal?: AbortSignal) =>
    openEngineWebSession({ ...common, store, ingestDiagnostics: diagnostics,
      ...(signal === undefined ? {} : { signal }),
      flac: { admission, locate: () => assert.fail("warm source must not deliver") },
    });
  const firstDone = assert.rejects(open(one.store, first, new BoundedStemAdmission(3)));
  const secondDone = assert.rejects(open(two.store, second, new BoundedStemAdmission(2)));
  await Promise.all([one.reading.promise, two.reading.promise]);
  assert.equal(first.snapshot().residency!.active, 1);
  assert.equal(second.snapshot().residency!.active, 1);
  assert.equal(first.snapshot().residency!.limit, 3);
  assert.equal(second.snapshot().residency!.limit, 2);
  assert.equal(first.snapshot().reservation!.fixedBufferBytes, 5_181_456);
  assert.equal(first.snapshot().reservation!.slotBytes, 8_388_608);
  assert.equal(first.snapshot().reservation!.headroomBytes, 3_207_152);
  const during = first.snapshot();
  one.proceed.resolve(); await firstDone;
  assert.equal(first.snapshot().residency!.active, 0);
  assert.equal(first.snapshot().residency!.activePeak, 1);
  assert.equal(second.snapshot().residency!.active, 1);
  assert.equal(during.residency!.active, 1);
  two.proceed.resolve(); await secondDone;
  assert.equal(second.snapshot().residency!.deliveredPeakBytes, 0);
  assert.equal(second.snapshot().residency!.decodedPeakBytes, 0);

  const queued = makeWarm();
  const admission = new BoundedStemAdmission(1);
  const held = await admission.acquire();
  const cancelled = createIngestDiagnostics();
  const abort = new AbortController();
  const queuedDone = assert.rejects(open(queued.store, cancelled, admission, abort.signal));
  while (admission.stats.queued === 0) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cancelled.snapshot().residency!.activePeak, 0);
  abort.abort("cancel before admission");
  await queuedDone; held.release();
  assert.equal(cancelled.snapshot().residency!.activePeak, 0);

  const empty = createIngestDiagnostics();
  await assert.rejects(openEngineWebSession({ ...common, document: documentFor([]), sources: [],
    scratchBoot: async () => ({ sampleRateHz: 48000, quantumFrames: 4, sourceRingFrames: 16,
      backend: "simd128", tracks: [], sources: [] }),
    store: new VerifiedStemStore({ backend: new MemoryStemStorageBackend() }),
    ingestDiagnostics: empty, flac: { hardwareConcurrency: 4, memoryBudgetBytes: 24 * 1024 * 1024,
      locate: () => assert.fail("empty source must not deliver") },
  }));
  assert.deepEqual(empty.snapshot().residency, { limit: 3, deliveredBytes: 0, deliveredPeakBytes: 0,
    decodedBytes: 0, decodedPeakBytes: 0, containers: 0, containersPeak: 0, active: 0, activePeak: 0 });

  const customStore = createIngestDiagnostics();
  await assert.rejects(open({ async open() { return this; }, async openSession() { throw afterStore; } }, customStore, new BoundedStemAdmission(1)));
  assert.deepEqual(customStore.snapshot(), { residency: null, reservation: null, processing: null });
  const customProducer = createIngestDiagnostics();
  await assert.rejects(openEngineWebSession({ ...common, ingestDiagnostics: customProducer,
    store: new VerifiedStemStore({ backend: new MemoryStemStorageBackend() }),
    resolver: { async resolve() { throw afterStore; } },
  }));
  assert.deepEqual(customProducer.snapshot(), { residency: null, reservation: null, processing: null });
});

function fillRing(ring: SharedArrayBuffer, total: number) {
  const writer = new Msb1RingWriter(ring); writer.engage(1n);
  for (let frame = 0; frame < total && writer.occupancy < writer.capacity; frame += writer.frameCapacity) {
    const frames = Math.min(writer.frameCapacity, total - frame); writer.reserve(frames);
    writer.commit({ generation: 1n, startFrame: BigInt(frame), frames, endOfRegion: frame + frames === total });
  }
}
