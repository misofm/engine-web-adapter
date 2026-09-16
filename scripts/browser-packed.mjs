import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { blake3 } from "hash-wasm";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const supportModules = join(process.cwd(), "node_modules");
const live = process.argv.includes("--live");
const indexedSparse = process.argv.includes("--indexed-sparse");
const useWebKit = process.argv.includes("--webkit");
assert.ok(!useWebKit || (indexedSparse && !live), "--webkit requires --indexed-sparse and cannot use --live");
const profile = live ? {
  name: "live",
  url: "https://stems.miso.fm/ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1.flac",
  identity: "blake3:63205b19c19952f986938d4b9d303e82ec8b404e268185b67387f6b40e106f0c",
  sampleRateHz: 44_100,
  channels: 2,
  bitDepth: 24,
  frames: 6_207_923,
  canonicalBytes: 37_247_538,
  remoteBytes: 4_198_461,
  etag: '"5cc22b5075610fc68f75247c7d135dd9"',
} : {
  name: "fixture",
  url: "/native-silence.flac",
  identity: "blake3:b6fb73fc46938c981e2b0b4b1ef282adcfc89854d01bfe3972fdc4785b41b2c7",
  sampleRateHz: 48_000,
  channels: 1,
  bitDepth: 16,
  frames: 2_048,
  canonicalBytes: 4_096,
  remoteBytes: 206,
  etag: '"native-silence-v1"',
};
const indexedFixture = indexedSparse ? await prepareIndexedFixture() : undefined;
const chrome = useWebKit ? undefined : resolveChromeExecutable();
const root = await mkdtemp(join(tmpdir(), "engine-web-adapter-browser-"));
process.env.npm_config_cache = join(root, "npm-cache");
const consumer = join(root, "consumer");
await mkdir(join(consumer, "node_modules", "@misofm"), { recursive: true });
const packed = run("npm", ["pack", "--json", "--pack-destination", root], process.cwd());
const tarball = join(root, JSON.parse(packed)[0].filename);
run("tar", ["-xzf", tarball, "-C", join(consumer, "node_modules", "@misofm")]);
await rename(join(consumer, "node_modules", "@misofm", "package"), join(consumer, "node_modules", "@misofm", "engine-web-adapter"));
await cp(join(process.cwd(), "node_modules", "@misofm", "engine"), join(consumer, "node_modules", "@misofm", "engine"), { recursive: true });
await cp(join(process.cwd(), "node_modules", "@misofm", "codec"), join(consumer, "node_modules", "@misofm", "codec"), { recursive: true });
await cp(join(process.cwd(), "node_modules", "effect"), join(consumer, "node_modules", "effect"), { recursive: true });
await cp(join(process.cwd(), "node_modules", "hash-wasm"), join(consumer, "node_modules", "hash-wasm"), { recursive: true });
for (const dependency of ["fast-check", "pure-rand", "msgpackr", "msgpackr-extract"]) {
  await cp(join(process.cwd(), "node_modules", dependency), join(consumer, "node_modules", dependency), { recursive: true });
}
await mkdir(join(consumer, "public"));
await cp(join(process.cwd(), "tests", "fixtures", "native-silence.flac"), join(consumer, "public", "native-silence.flac"));
// Existing SDK457 first-output recorder, scoped to this packed consumer fixture.
await writeFile(join(consumer, "public", "capture.js"), `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.sent = false; }
  process(inputs, outputs) {
    const input = inputs[0];
    if (!this.sent && input?.length === 2 && input[0].length === 128) {
      this.sent = true; this.port.postMessage([Array.from(input[0]), Array.from(input[1])]);
    }
    for (let channel = 0; channel < outputs[0].length; channel++) if (input?.[channel]) outputs[0][channel].set(input[channel]);
    return true;
  }
}
registerProcessor('capture-first-quantum', Capture);
`);
// Test-only worker entry used by the indexed lane. It instruments the actual
// packed verification worker realm, while the production worker entry remains
// untouched and the main-thread observer only sees ordinary protocol events.
await writeFile(join(consumer, "public", "sparse-disposal-wrapper.js"), `
const nativePostMessage = self.postMessage.bind(self);
const nativeSlice = Blob.prototype.slice;
const readBuffers = [];
const readLengths = [];
const queuedMessages = [];
let entryLoaded = false;
const queueUntilEntryLoaded = (event) => {
  if (!entryLoaded) queuedMessages.push(event);
};
self.addEventListener("message", queueUntilEntryLoaded);
const isDetached = (buffer) => {
  try { new Uint8Array(buffer); return false; } catch { return true; }
};
Blob.prototype.slice = function(...args) {
  const child = nativeSlice.apply(this, args);
  const nativeArrayBuffer = child.arrayBuffer.bind(child);
  Object.defineProperty(child, "arrayBuffer", { configurable: true, value: async (...readArgs) => {
    const value = await nativeArrayBuffer(...readArgs);
    const beforeNext = readBuffers.every(isDetached);
    readBuffers.push(value);
    readLengths.push(value.byteLength);
    nativePostMessage({ type: "__miso_sparse_disposal_read__", beforeNext, length: value.byteLength });
    return value;
  }});
  return child;
};
const postMessage = self.postMessage.bind(self);
self.postMessage = (message, transfer) => {
  if (message?.type === "complete" || message?.type === "failure") {
    postMessage({ type: "__miso_sparse_disposal_terminal__", terminal: message.type,
      jobId: message.jobId, generation: message.generation, identity: message.identity,
      allDetached: readBuffers.every(isDetached), readCount: readBuffers.length, lengths: [...readLengths] });
    readBuffers.length = 0;
    readLengths.length = 0;
  }
  return transfer === undefined ? postMessage(message) : postMessage(message, transfer);
};
try { await import("/node_modules/@misofm/engine-web-adapter/dist/internal/engine-web-sparse-verify-worker.js"); }
catch (error) { nativePostMessage({ type: "__miso_sparse_disposal_error__", message: String(error?.stack ?? error) }); throw error; }
entryLoaded = true;
for (const event of queuedMessages.splice(0)) self.onmessage?.(event);
`);
await writeFile(join(consumer, "fault-pump-worker.ts"), `
import "./node_modules/@misofm/engine-web-adapter/dist/internal/engine-web-pcm-pump-worker.js";
let fault;
const originalSlice = Blob.prototype.slice;
Blob.prototype.slice = function(...args) {
  if (fault === "reject") throw new Error("injected playback storage rejection");
  if (fault === "stall") return { arrayBuffer() { return new Promise(() => {}); } };
  return originalSlice.apply(this, args);
};
const handle = self.onmessage;
self.onmessage = (event) => {
  if (event.data.type !== "test-fault") { handle(event); return; }
  fault = event.data.mode;
  if (fault === "crash") setTimeout(() => { throw new Error("injected worker crash"); }, 0);
};
`);
// A fresh worker realm forces the packed adapter through its unsupported-SIMD
// selection before any hasher is created. The worker imports the actual packed
// deep module and checks streamed input against hash-wasm's scalar fallback.
await writeFile(join(consumer, "blake3-fallback-worker.ts"), `
const nativeValidate = WebAssembly.validate;
WebAssembly.validate = (() => false) as typeof WebAssembly.validate;
(async () => {
  try {
    const { createIncrementalBlake3 } = await import("./node_modules/@misofm/engine-web-adapter/dist/stems/blake3.js");
    const { blake3: scalarBlake3 } = await import("hash-wasm");
    const input = new TextEncoder().encode("abc");
    const hash = await createIncrementalBlake3();
    hash.update(input.subarray(0, 1));
    hash.update(input.subarray(1, 2));
    hash.update(input.subarray(2));
    const digest = hash.digest("hex");
    const expected = await scalarBlake3(input);
    self.postMessage({ type: "result", ok: digest === expected && digest === "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85", digest, expected });
  } catch (error) {
    self.postMessage({ type: "failure", error: String(error?.stack ?? error) });
  } finally {
    WebAssembly.validate = nativeValidate;
  }
})();
`);
await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
await writeFile(join(consumer, "vite.config.mjs"), `
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BUNDLED_ENGINE_ASSETS, BUNDLED_ENGINE_FILES } from "@misofm/engine/assets";

const manifestSha256 = createHash("sha256")
  .update(readFileSync(BUNDLED_ENGINE_ASSETS.manifest))
  .digest("hex");
const hostDirectory = "assets/engine-" + manifestSha256;
const hostClosure = new Set([
  BUNDLED_ENGINE_FILES.hostModule,
  BUNDLED_ENGINE_FILES.abiLayout,
]);

export default {
  build: {
    rollupOptions: {
      output: {
        assetFileNames: (asset) => hostClosure.has(asset.name ?? "")
          ? hostDirectory + "/[name][extname]"
          : "assets/[name]-[hash][extname]",
      },
    },
  },
  plugins: [{
    name: "packed-engine-host-closure",
    generateBundle(_, bundle) {
      for (const fileName of hostClosure) {
        if (!Object.values(bundle).some((entry) => entry.type === "asset" && entry.name === fileName)) {
          throw new Error("Vite did not emit Engine host asset " + fileName);
        }
      }
      this.emitFile({
        type: "asset",
        fileName: hostDirectory + "/" + BUNDLED_ENGINE_FILES.preparedControl,
        source: readFileSync(new URL(BUNDLED_ENGINE_FILES.preparedControl, BUNDLED_ENGINE_ASSETS.hostModule)),
      });
    },
  }],
};
`);
await writeFile(join(consumer, "index.html"), '<div id="status">loading</div><script type="module" src="/src/main.ts"></script>\n');
await mkdir(join(consumer, "src"));
await writeFile(join(consumer, "src", "main.ts"), indexedSparse
  ? indexedBrowserSource(indexedFixture)
  : browserSource(profile));
await writeFile(join(consumer, "consumer-check.ts"), `
import { EngineWebAdapterError, openEngineWebSession, openSparseEngineWebSession } from "@misofm/engine-web-adapter";
import type {
  EngineWebConsole, EngineWebSession, EngineWebSessionOptions, SparseEngineWebSessionOptions, SourceObservation, FeedDiagnostics, MeterUpdate, TelemetryUpdate, TrackMeter, SessionEngine,
} from "@misofm/engine-web-adapter";
import { createFlacStemResolver, PcmPumpWorkerClient } from "@misofm/engine-web-adapter/stems";
import { ADAPTER_ASSETS } from "@misofm/engine-web-adapter/assets";
import packageJson from "@misofm/engine-web-adapter/package.json" with { type: "json" };

// The documented zero-configuration open: a document and a locator, nothing else.
const minimal: EngineWebSessionOptions = {
  document: "{}",
  flac: { locate: () => "https://caller.invalid/stem.flac" },
};
const sparseMinimal: SparseEngineWebSessionOptions = { document: "{}" };
declare const session: EngineWebSession;
const live: EngineWebConsole = session.console;
const observation: SourceObservation = session.observeSource("source");
const diagnostics: FeedDiagnostics = session.feedDiagnostics();
observation.pull((chunk) => { const planes: readonly Float32Array[] = chunk.planes; void planes; }, 1);
const observedBytes: number = diagnostics.allocation.observationBytes;
const pumpFrames: number | undefined = diagnostics.allocation.pump?.windowFrames;
void [observedBytes, pumpFrames];
const meters: (listener: (update: MeterUpdate) => void) => Promise<() => void> = session.meters;
const telemetry: (listener: (update: TelemetryUpdate) => void) => Promise<() => void> = session.telemetry;
const sdk: SessionEngine = session.engine;
const directMeters: SessionEngine["subscribeMeters"] = sdk.subscribeMeters;
const directTelemetry: SessionEngine["subscribeTelemetry"] = sdk.subscribeTelemetry;
const directResponse: SessionEngine["queryTrackResponse"] = sdk.queryTrackResponse;
const directSpectrum: SessionEngine["querySpectrum"] = sdk.querySpectrum;
declare const update: MeterUpdate;
const peak: TrackMeter | undefined = update.tracks.get("track-000");
declare const failure: EngineWebAdapterError;
const remedy: string = failure.remedy;
const transient: boolean = failure.transient;
void [openEngineWebSession, openSparseEngineWebSession, createFlacStemResolver, PcmPumpWorkerClient, ADAPTER_ASSETS, packageJson,
  minimal, sparseMinimal, live, meters, telemetry, sdk, directMeters, directTelemetry, directResponse, directSpectrum, peak, remedy, transient];
`);
await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: {
  strict: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
  lib: ["ESNext", "DOM"], resolveJsonModule: true, skipLibCheck: false,
}, files: ["consumer-check.ts"] }));
await writeFile(join(consumer, "import-check.mjs"), `
await import("@misofm/engine-web-adapter");
await import("@misofm/engine-web-adapter/stems");
await import("@misofm/engine-web-adapter/assets");
await import("@misofm/engine-web-adapter/package.json", { with: { type: "json" } });
`);
run(join(process.cwd(), "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], consumer);
run(process.execPath, ["import-check.mjs"], consumer);
run(join(supportModules, ".bin", "vite"), ["build"], consumer);

const requests = new Map();
const requestCounts = new Map();
let flacRangeRequests = 0;
const dist = join(consumer, "dist");
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://local").pathname;
    requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
    if (pathname === "/favicon.ico") { response.statusCode = 204; response.end(); return; }
    const indexedDelivery = indexedSparse ? indexedFixture.sourcesByUrl.get(pathname) : undefined;
    if (indexedDelivery !== undefined) {
      if (request.method !== "GET" || request.headers.range !== undefined) { response.statusCode = 400; response.end("indexed delivery requires one full GET"); return; }
      requests.set(pathname, "application/octet-stream");
      response.statusCode = 200;
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", String(indexedDelivery.body.byteLength));
      response.setHeader("ETag", indexedDelivery.profile.etag);
      response.end(indexedDelivery.body);
      return;
    }
    if (pathname === "/native-silence.flac") {
      const bytes = await readFile(join(dist, "native-silence.flac"));
      const match = /^bytes=(\d+)-(\d+)$/u.exec(String(request.headers.range ?? ""));
      if (match === null) { response.statusCode = 400; response.end("exact range required"); return; }
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (start < 0 || end < start || end >= bytes.byteLength) { response.statusCode = 416; response.end(); return; }
      flacRangeRequests += 1;
      requests.set(pathname, "audio/flac");
      response.statusCode = 206;
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      response.setHeader("Content-Type", "audio/flac");
      response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.byteLength}`);
      response.setHeader("Content-Length", String(end - start + 1));
      response.setHeader("ETag", '"native-silence-v1"');
      response.end(bytes.subarray(start, end + 1));
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const packagePrefix = "/node_modules/@misofm/engine-web-adapter/";
    const path = pathname.startsWith(packagePrefix)
      ? join(consumer, "node_modules", "@misofm", "engine-web-adapter", pathname.slice(packagePrefix.length))
      : join(dist, relative);
    const mime = mimeFor(path);
    requests.set(pathname, mime);
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Content-Type", mime);
    response.end(await readFile(path));
  } catch { response.statusCode = 404; response.end("not found"); }
});
await new Promise((resolve) => server.listen(live ? 5173 : 0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const { chromium, webkit } = await import(pathToFileURL(join(supportModules, "playwright-core", "index.mjs")).href);
let browser;
try {
  browser = useWebKit
    ? await webkit.launchPersistentContext(await mkdtemp(join(tmpdir(), "indexed-sparse-webkit-")), { headless: true })
    : await chromium.launch({ executablePath: chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  console.log(JSON.stringify({ gate: "packed-browser", browser: useWebKit ? "webkit" : "chromium",
    browserVersion: useWebKit ? browser.browser()?.version() : browser.version(), indexedSparse }));
  const page = await browser.newPage();
  const consoleErrors = [];
  const requestFailures = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
  page.on("requestfailed", (request) => requestFailures.push({ url: request.url(), failure: request.failure()?.errorText ?? "unknown" }));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(
    () => globalThis.__result !== undefined || globalThis.__error !== undefined,
    undefined,
    { timeout: live ? 180_000 : 30_000 },
  ).catch(async (error) => {
    throw new Error(JSON.stringify({ message: error.message, seekStage: await page.evaluate(() => globalThis.__seekStage),
      consoleErrors, requestFailures, requests: [...requests.entries()] }));
  });
  const result = await page.evaluate(() => ({ result: globalThis.__result, error: globalThis.__error }));
  if (indexedSparse) {
    assert.equal(result.error, undefined, JSON.stringify({ error: result.error, consoleErrors, requestFailures, requests: [...requests.entries()] }));
    assertIndexedResult(result.result, indexedFixture, requests, requestCounts, requestFailures, consoleErrors, address.port);
  } else {
  assert.equal(result.error, undefined, JSON.stringify({ error: result.error, consoleErrors, requests: [...requests.entries()] }));
  assert.ok(result.result?.coldLocatorCalls > 0, "cold FLAC open must locate exact ranges");
  assert.equal(result.result?.warmLocatorCalls, result.result?.coldLocatorCalls, "warm open must make zero locator calls");
  assert.ok(result.result?.coldProcessing.hashMs > 0, "cold digest must run in the packaged decoder Worker");
  assert.equal(result.result?.coldProcessing.runnablePeak, 1);
  assert.equal(result.result?.coldProcessing.workers.active, 0);
  assert.equal(result.result?.warmProcessing.workers.count, 0);
  assert.equal(result.result?.warmProcessing.downloads.count, 0);
  assert.equal(result.result?.coldFlacWorkers, 1, "cold open must construct one FLAC Worker");
  assert.equal(result.result?.warmFlacWorkers, result.result?.coldFlacWorkers, "warm open must construct zero FLAC Workers");
  assert.equal(result.result?.warmNetworkRequests, result.result?.coldNetworkRequests, "warm open must make zero network requests");
  if (!live) assert.equal(flacRangeRequests, result.result?.coldLocatorCalls, "every physical locator attempt must be one 206 request");
  assert.equal(result.result?.observedRemoteBytes, profile.remoteBytes, "remote FLAC byte total changed");
  assert.equal(result.result?.observedEtag, profile.etag, "remote FLAC ETag changed");
  assert.ok(result.result?.submitted > 0, "Engine worklet must consume PCM");
  assert.ok(result.result?.seeksApplied > 0, "unaligned seek must reach the Engine worklet");
  assert.equal(result.result?.refused, 0);
  assert.equal(result.result?.torn, 0);
  assert.equal(result.result?.errors, 0);
  assert.equal(result.result?.observedChunks, 1);
  assert.equal(result.result?.observationBytes, 2 * profile.channels * 128 * 4);
  assert.equal(result.result?.coldClosed, true);
  assert.equal(result.result?.warmClosed, true);
  assert.ok(result.result?.sparseWorker?.writes > 0, "sparse packed Worker did not publish any gap/active windows");
  assert.equal(result.result?.sparseWorker?.reads, 1, "sparse packed Worker resolved the canonical asset more than once");
  assert.equal(result.result?.sparseWorker?.generation, "2", "sparse packed Worker seek did not advance generation");
  assert.equal(result.result?.sparseWorker?.scratch, 256 * profile.channels * profile.bitDepth / 8, "sparse packed Worker scratch bound changed");
  for (const [order, observed] of [["console first", result.result?.consoleFirst], ["meters first", result.result?.meterFirst]]) {
    assert.ok(observed?.meterUpdates > 0, `${order}: no meter update arrived`);
    assert.deepEqual(observed?.meterTrackIds, [observed?.trackId], `${order}: meters are not keyed by track id`);
    assert.equal(observed?.meterHasMaster, true, `${order}: master fold missing`);
  }
  assert.equal(result.result?.notAttached, "console.not_attached");
  assert.equal(result.result?.meterNotAttached, "console.not_attached");
  const { createOfflineEngine } = await import("@misofm/engine/headless");
  for (const proof of result.result.seekProofs) {
    assert.equal(proof.busy, "session.busy");
    assert.equal(proof.resumeCallsDuringSeek, proof.mode === "running" ? 1 : 0);
    assert.equal(proof.suspendedBeforeProducer, true);
    if (proof.mode === "running") assert.equal(proof.stateAfterSeek, "running");
    assert.equal(proof.staleOccupancy, 64);
    assert.equal(proof.internalBackpressure, 6);
    assert.equal(proof.prepared.state, "suspended");
    assert.equal(proof.prepared.timeUnchanged, true);
    assert.equal(proof.prepared.sampleUnchanged, true);
    assert.equal(proof.staleReleased, 64);
    assert.equal(proof.underruns, 0);
    assert.equal(proof.refused, 0);
    assert.equal(proof.torn, 0);
    assert.equal(proof.errors, 0);
    const oracle = await createOfflineEngine(proof.document);
    try {
      assert.equal(oracle.seekSource({ sourceId: "seek-source", generation: 2n, sourceFrame: 10_000n }).ok, true);
      const planes = [0, 1].map((channel) => Float32Array.from({ length: 128 }, (_, index) =>
        (((10_000 + index) % 1024) - 512) * (channel === 0 ? 32 : -16) / 32768));
      assert.equal(oracle.submitSource({ sourceId: "seek-source", generation: 2n, startFrame: 10_000n, planes, endOfRegion: false }).ok, true);
      const rendered = oracle.render();
      assert.equal(rendered.left.some((value) => value !== 0), true);
      assert.deepEqual(proof.pcm, [[...rendered.left], [...rendered.right]], `${proof.mode}: exact first target output`);
    } finally { oracle.dispose(); }
  }
  assert.deepEqual(result.result.seekProofs.map((proof) => proof.mode), ["initial", "resumed", "running"]);
  assert.deepEqual(result.result.terminalPumpFailures.map((proof) => proof.mode), ["reject", "stall", "crash"]);
  for (const proof of result.result.terminalPumpFailures) {
    assert.equal(proof.notifications, 1); assert.equal(proof.terminations, 1);
    assert.equal(proof.state, "closed"); assert.equal(proof.context, "closed");
    assert.equal(proof.code, "session.playback");
    if (proof.mode === "stall") assert.equal(proof.causeCode, "stem.read_deadline");
  }
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(requestFailures, []);
  const requested = [...requests.entries()];
  assert.ok(requested.some(([path, mime]) => (path.includes("engine-web-flac-decoder") || path.includes("flac-decoder")) && path.endsWith(".wasm") && mime === "application/wasm"), "decoder Wasm asset/MIME not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("miso-engine") && path.endsWith(".wasm") && mime === "application/wasm"), "Engine Wasm asset/MIME not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("scratch-worker") && mime.includes("javascript")), "scratch Worker asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("flac-worker") && mime.includes("javascript")), "FLAC Worker asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("pcm-pump-worker") && mime.includes("javascript")), "pump Worker asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("feed-worklet") && mime.includes("javascript")), "feed worklet asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("audio-worklet-host") && mime.includes("javascript")), "Engine host asset not observed");
  assert.ok(requested.some(([path, mime]) => path.endsWith("/prepared-control.js") && mime.includes("javascript")), "Engine prepared-control companion not observed");
  assert.ok(requested.some(([path]) => path.endsWith("/miso-engine-v1-abi-layout.json")), "Engine ABI-layout companion not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("audio-worklet-") && !path.includes("host") && mime.includes("javascript")), "Engine worklet asset not observed");
  console.log(JSON.stringify({ profile: profile.name, origin: `http://127.0.0.1:${address.port}`, ...result.result,
    assets: requested.filter(([path]) => /\.(?:js|wasm)$/u.test(path)).length, root, requestFailures, consoleErrors }));
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

async function prepareIndexedFixture() {
  const fixtureDirectory = process.env.ADAPTER_71_MULTIBLOCK_DIR ?? join(process.cwd(), "tests", "fixtures");
  const firstFlacName = "native-multiblock-stereo24.flac";
  const firstPcmName = process.env.ADAPTER_71_MULTIBLOCK_DIR === undefined ? "native-multiblock-stereo24.pcm" : "source.pcm";
  const secondFlacName = "native-variable-stereo24.flac";
  const outputDirectory = join(process.env.ADAPTER_71_EVIDENCE_DIR ?? join(process.cwd(), ".adapter-71-evidence"), "indexed-multisource");
  await mkdir(outputDirectory, { recursive: true });
  const firstFlac = new Uint8Array(await readFile(join(fixtureDirectory, firstFlacName)));
  const firstPcm = new Uint8Array(await readFile(join(fixtureDirectory, firstPcmName)));
  const secondFlac = new Uint8Array(await readFile(join(fixtureDirectory, secondFlacName)));
  const secondPcm = makeVariableStereo24Pcm(41_024);
  const frameBytes = 2 * (24 / 8);
  const firstFrames = firstPcm.byteLength / frameBytes;
  const secondFrames = secondPcm.byteLength / frameBytes;
  if (firstFrames !== 72_000 || secondFrames !== 41_024) throw new Error("indexed fixtures changed their frozen frame counts");
  if (sha256Hex(firstPcm) !== "4b5bc724ea7d855b3b5518b7a5e4da7222a41b9d0c98ca42880ca37e7458654d") {
    throw new Error("indexed first fixture PCM SHA-256 changed");
  }
  if (sha256Hex(firstFlac) !== "cfb6381ba955b097a8088a81d1956cb13a7d0b1c2c59a25843b832aa80a3d3cb") {
    throw new Error("indexed first fixture FLAC SHA-256 changed");
  }
  if (sha256Hex(secondFlac) !== "552f89c4d91fa7d83867a6f572457c07493cef232e33698ffa319bc48fbf0eee") {
    throw new Error("indexed second fixture FLAC SHA-256 changed");
  }
  if (sha256Hex(secondPcm) !== "1c56647d30a67bd892fd802860925f85eed692a706151dd1738235e0dc62889f") {
    throw new Error("indexed second fixture PCM SHA-256 changed");
  }
  const chunks = [
    { flac: firstFlac, pcm: firstPcm, frames: firstFrames, packedStartFrame: 0 },
    { flac: secondFlac, pcm: secondPcm, frames: secondFrames, packedStartFrame: firstFrames },
    { flac: firstFlac, pcm: firstPcm, frames: firstFrames, packedStartFrame: firstFrames + secondFrames },
  ];
  const sourceShapes = [
    {
      name: "indexed-source-a",
      url: "/native-indexed-source-a.sparse",
      etag: '"adapter-76-source-a-v1"',
      frames: 280_000,
      intervals: [
        { startFrame: 0, frames: firstFrames, packedFrameOffset: 0 },
        { startFrame: 100_000, frames: secondFrames, packedFrameOffset: firstFrames },
        { startFrame: 200_000, frames: firstFrames, packedFrameOffset: firstFrames + secondFrames },
      ],
    },
    {
      name: "indexed-source-b",
      url: "/native-indexed-source-b.sparse",
      etag: '"adapter-76-source-b-v1"',
      frames: 320_000,
      intervals: [
        { startFrame: 20_000, frames: firstFrames, packedFrameOffset: 0 },
        { startFrame: 150_000, frames: secondFrames, packedFrameOffset: firstFrames },
        { startFrame: 240_000, frames: firstFrames, packedFrameOffset: firstFrames + secondFrames },
      ],
    },
    {
      name: "indexed-source-c",
      url: "/native-indexed-source-c.sparse",
      etag: '"adapter-99-source-c-v1"',
      frames: 196_000,
      intervals: [
        { startFrame: 0, frames: firstFrames, packedFrameOffset: 0 },
        { startFrame: 80_000, frames: secondFrames, packedFrameOffset: firstFrames },
        { startFrame: 124_000, frames: firstFrames, packedFrameOffset: firstFrames + secondFrames },
      ],
    },
  ];
  const makeDelivery = async (shape) => {
    const canonical = new Uint8Array(shape.frames * frameBytes);
    for (const [index, interval] of shape.intervals.entries()) {
      const chunk = chunks[index];
      if (chunk === undefined) throw new Error("indexed source has an unsupported chunk count");
      canonical.set(chunk.pcm, interval.startFrame * frameBytes);
    }
    const identity = `blake3:${await blake3(canonical, 256)}`;
    const manifest = {
      format: "miso_sparse_stem_v1",
      identity,
      sampleRateHz: 48_000,
      channels: 2,
      bitDepth: 24,
      frames: shape.frames,
      intervals: shape.intervals,
      chunks: chunks.map((chunk, index) => ({
        offset: chunks.slice(0, index).reduce((sum, prior) => sum + prior.flac.byteLength, 0),
        bytes: chunk.flac.byteLength,
        frames: chunk.frames,
        packedStartFrame: chunk.packedStartFrame,
        flacSha256: sha256Hex(chunk.flac),
        pcmSha256: sha256Hex(chunk.pcm),
      })),
    };
    const encodedManifest = Buffer.from(canonicalJson(manifest));
    const header = Buffer.alloc(16);
    Buffer.from("MISOSTM1").copy(header, 0);
    header.writeUInt32LE(encodedManifest.byteLength, 8);
    const body = Buffer.concat([header, encodedManifest, ...chunks.map((chunk) => Buffer.from(chunk.flac))]);
    await writeFile(join(outputDirectory, `${shape.name}.sparse`), body);
    const intervals = shape.intervals.map((interval) => ({
      startFrame: interval.startFrame,
      frames: interval.frames,
      byteOffset: interval.packedFrameOffset * frameBytes,
    }));
    const activeBytes = chunks.reduce((sum, chunk) => sum + chunk.pcm.byteLength, 0);
    const windowStarts = shape.name.endsWith("-a")
      ? [[0, 1024], [72_000, 1024], [100_000, 1024], [141_024, 1024], [200_000, 1024], [279_000, 1000]]
      : shape.name.endsWith("-b")
        ? [[0, 1024], [20_000, 1024], [92_000, 1024], [150_000, 1024], [191_024, 1024], [240_000, 1024], [319_000, 1000]]
        : [[0, 1024], [72_000, 1024], [80_000, 1024], [121_024, 1024], [124_000, 1024], [195_000, 1000]];
    return {
      body,
      profile: {
        name: shape.name,
        url: shape.url,
        etag: shape.etag,
        expected: { identity, sampleRateHz: 48_000, channels: 2, bitDepth: 24, frames: shape.frames, canonicalBytes: canonical.byteLength },
        containerBytes: body.byteLength,
        activeBytes,
        canonicalPcmBlake3: identity.slice(7),
        intervals,
        chunks: manifest.chunks.map((chunk) => ({ frames: chunk.frames, bytes: chunk.bytes, packedStartFrame: chunk.packedStartFrame })),
        windowProofs: windowStarts.map(([startFrame, frames]) => ({ startFrame, frames, sha256: sha256Hex(canonical.subarray(startFrame * frameBytes, (startFrame + frames) * frameBytes)) })),
      },
    };
  };
  const allSources = [];
  for (const shape of sourceShapes) allSources.push(await makeDelivery(shape));
  const sources = allSources.slice(0, 2);
  const threeWarmSources = allSources;
  const silentFrames = 131_072;
  const silentCanonical = new Uint8Array(silentFrames * frameBytes);
  const silentIdentity = `blake3:${await blake3(silentCanonical, 256)}`;
  const silentManifest = {
    format: "miso_sparse_stem_v1",
    identity: silentIdentity,
    sampleRateHz: 48_000,
    channels: 2,
    bitDepth: 24,
    frames: silentFrames,
    intervals: [],
    chunks: [],
  };
  const silentEncodedManifest = Buffer.from(canonicalJson(silentManifest));
  const silentHeader = Buffer.alloc(16);
  Buffer.from("MISOSTM1").copy(silentHeader, 0);
  silentHeader.writeUInt32LE(silentEncodedManifest.byteLength, 8);
  const silentBody = Buffer.concat([silentHeader, silentEncodedManifest]);
  await writeFile(join(outputDirectory, "indexed-all-silent.sparse"), silentBody);
  const silent = {
    body: silentBody,
    profile: {
      name: "indexed-all-silent",
      url: "/native-indexed-all-silent.sparse",
      etag: '"adapter-76-all-silent-v1"',
      expected: { identity: silentIdentity, sampleRateHz: 48_000, channels: 2, bitDepth: 24, frames: silentFrames, canonicalBytes: silentCanonical.byteLength },
      containerBytes: silentBody.byteLength,
      activeBytes: 0,
      canonicalPcmBlake3: silentIdentity.slice(7),
      intervals: [],
      chunks: [],
      windowProofs: [[0, 1024], [65_000, 1024], [130_000, 1024]].map(([startFrame, frames]) => ({ startFrame, frames, sha256: sha256Hex(silentCanonical.subarray(startFrame * frameBytes, (startFrame + frames) * frameBytes)) })),
    },
  };
  return {
    sources,
    threeWarmSources,
    silent,
    sourcesByUrl: new Map([...threeWarmSources, silent].map((delivery) => [delivery.profile.url, delivery])),
  };
}

function makeVariableStereo24Pcm(frames) {
  const pcm = new Uint8Array(frames * 6);
  for (let sample = 0; sample < frames; sample += 1) {
    const left = (sample * 7919) % 16_000_001 - 8_000_000;
    const right = -Math.trunc(left / 2);
    let offset = sample * 6;
    for (const value of [left, right]) {
      pcm[offset] = value & 0xff;
      pcm[offset + 1] = (value >> 8) & 0xff;
      pcm[offset + 2] = (value >> 16) & 0xff;
      offset += 3;
    }
  }
  return pcm;
}

function sha256Hex(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  throw new Error("unsupported canonical JSON value");
}

function assertIndexedResult(raw, fixture, requests, requestCounts, requestFailures, consoleErrors, port) {
  assert.equal(raw?.failed, undefined, raw?.failure === undefined ? undefined : JSON.stringify(raw.failure));
  assert.equal(raw?.cold?.locateCalls, 1, "indexed cold source must locate once");
  assert.equal(raw?.cold?.networkRequests, 1, "indexed cold source must make one full GET");
  assert.equal(raw?.cold?.physicalWorkers, 1, "one indexed source must retain one physical FLAC Worker");
  assert.equal(raw?.cold?.jobs, fixture.sources[0].profile.chunks.length, "one indexed source must decode both FLAC chunks");
  assert.deepEqual(raw?.cold?.workerJobCounts, [fixture.sources[0].profile.chunks.length], "one indexed source did not reuse its Worker across chunks");
  assert.equal(raw?.cold?.decoderAssetFetches, 1, "one indexed resolver must fetch one decoder asset");
  assert.equal(raw?.cold?.decoderCompileCalls, 1, "one indexed resolver must compile one decoder module");
  assert.equal(raw?.cold?.runnablePeak, 1, "single indexed Worker did not report its runnable decode section");
  assert.deepEqual(raw?.cold?.workerResetCounts, [fixture.sources[0].profile.chunks.length], "indexed chunks did not complete reset handshakes");
  assert.equal(new Set(raw?.cold?.workerInputSlotIds).size, raw?.cold?.jobs, "indexed jobs reused a mutable input slot");
  assert.equal(raw?.cold?.workerModuleFlags?.every((provided) => provided), true, "indexed job did not receive the compiled decoder module");
  assert.ok((raw?.cold?.spanCount ?? 0) > 4, "indexed mapper did not emit multiple bounded spans");
  assert.equal(raw?.cold?.workersAtOpen?.length, 1, "indexed cold preparation did not construct its expected Worker");
  assert.equal(raw?.cold?.workersAtOpen?.every((worker) => worker.terminated), true, "indexed cold Worker remained alive after preparation resolved");
  assert.equal(raw?.warm?.locateCalls, 0, "indexed warm open reacquired a locator");
  assert.equal(raw?.warm?.networkRequests, 0, "indexed warm open made a network request");
  assert.equal(raw?.warm?.physicalWorkers, 0, "indexed warm open created a decoder Worker");
  assert.equal(raw?.warm?.decoderAssetFetches, 0, "indexed warm open fetched a decoder asset");
  assert.equal(raw?.warm?.decoderCompileCalls, 0, "indexed warm open compiled a decoder module");
  assert.equal(raw?.warm?.jobs, 0, "indexed warm open launched a decoder job");
  assert.equal(raw?.warm?.sparseVerifyWorkers, 2, "indexed warm open did not construct two verification Workers");
  assert.ok((raw?.warm?.sparseVerifyProgress ?? 0) > 0, "indexed warm Worker emitted no progress");
  assert.equal(raw?.warm?.sparseVerifyCompletions, 2, "indexed warm Workers did not complete exactly once per source");
  const disposalReads = raw?.warm?.disposalReads ?? [];
  const disposalTerminals = raw?.warm?.disposalTerminals ?? [];
  const expectedReadLengths = new Map([
    [fixture.sources[0].profile.expected.identity, [432_000, 246_144, 432_000]],
    [fixture.sources[1].profile.expected.identity, [432_000, 246_144, 432_000]],
  ]);
  assert.ok(disposalReads.length > 0, "indexed warm native Workers did not expose any Blob reads");
  assert.equal(disposalReads.every((read) => read.beforeNext === true), true, "indexed warm Worker retained a prior read buffer");
  assert.equal(disposalTerminals.length, raw?.warm?.sparseVerifyCompletions, "indexed warm disposal terminal count changed: " + JSON.stringify({ disposalTerminals, warm: raw?.warm }));
  for (const terminal of disposalTerminals) {
    assert.deepEqual(terminal.lengths, expectedReadLengths.get(terminal.identity), "indexed warm Worker read slices changed for " + terminal.identity);
  }
  assert.equal(disposalTerminals.every((terminal) => terminal.terminal === "complete" && terminal.allDetached === true && terminal.readCount > 0), true,
    "indexed warm Worker did not detach every consumed read buffer before completion");
  assert.equal(disposalTerminals.reduce((sum, terminal) => sum + terminal.readCount, 0), disposalReads.length,
    "indexed warm disposal read and terminal counts diverged");
  assert.equal(raw?.tail?.sparseVerifyWorkers, 1, "indexed active-tail proof did not construct one native verification Worker");
  assert.equal(raw?.tail?.sparseVerifyCompletions, 1, "indexed active-tail proof did not complete exactly once");
  assert.deepEqual(raw?.tail?.disposalReads?.map((read) => read.length), [512 * 1024, 512 * 1024, 61_568],
    "indexed active-tail proof did not take two full reads and one tail");
  assert.equal(raw?.tail?.disposalReads?.every((read) => read.beforeNext === true), true, "indexed active-tail proof retained a read buffer");
  assert.equal(raw?.tail?.disposalTerminals?.length, 1, "indexed active-tail terminal count changed");
  assert.equal(raw?.tail?.disposalTerminals?.[0]?.terminal, "complete");
  assert.equal(raw?.tail?.disposalTerminals?.[0]?.allDetached, true, "indexed active-tail proof did not detach every read buffer");
  assert.equal(raw?.tail?.disposalTerminals?.[0]?.readCount, 3);
  assert.deepEqual(raw?.tail?.disposalTerminals?.[0]?.lengths, [512 * 1024, 512 * 1024, 61_568]);
  assert.equal(raw?.tail?.complete?.identity, raw?.tail?.identity);
  assert.equal("blake3:" + raw?.tail?.complete?.digest, raw?.tail?.identity, "indexed active-tail digest did not match its independent oracle");
  assert.equal(raw?.tail?.complete?.canonicalBytes, 1_110_144);
  assert.equal(raw?.tail?.complete?.hashedBytes, 1_110_144);
  assert.equal(raw?.tail?.complete?.progressBytes, 1_110_144);
  assert.equal(raw?.tail?.complete?.readCalls, 3);
  assert.equal(raw?.tail?.complete?.readBytes, 1_110_144);
  assert.equal(raw?.tail?.complete?.zeroUpdates, 0);
  assert.equal(raw?.tail?.complete?.hashUpdates, 3);
  assert.equal(raw?.warm?.spanCount, 0, "indexed warm open remapped stored PCM");
  assert.equal(raw?.warm?.progress?.stages?.[0], "verifying", "indexed warm progress omitted verification");
  assert.equal(raw?.warm?.progress?.stages?.at(-1), "ready", "indexed warm progress omitted aggregate readiness");
  assert.deepEqual(new Set(raw?.threeWarm?.sourceIdentities), new Set(fixture.threeWarmSources.map((source) => source.profile.expected.identity)), "three-lane proof did not use three distinct source identities");
  for (const [label, proof] of [["first", raw?.threeWarm?.first], ["reopen", raw?.threeWarm?.reopen]]) {
    assert.equal(proof?.locateCalls, 0, `three-lane ${label} warm open reacquired a locator`);
    assert.equal(proof?.networkRequests, 0, `three-lane ${label} warm open made a network request`);
    assert.equal(proof?.physicalWorkers, 0, `three-lane ${label} warm open created a decoder Worker`);
    assert.equal(proof?.sparseVerifyWorkers, 3, `three-lane ${label} warm open did not construct exactly three verification Workers`);
    assert.equal(proof?.sparseVerifyCompletions, 3, `three-lane ${label} warm open did not complete exactly three verification Workers`);
    assert.equal(proof?.progress?.sourceReady, 3, `three-lane ${label} warm open did not publish three source-ready facts`);
    assert.equal(proof?.progress?.stages?.at(-1), "ready", `three-lane ${label} warm open did not publish aggregate readiness`);
    assert.equal(proof?.sparseWorkers?.length, 3, `three-lane ${label} did not observe three native Worker records`);
    assert.equal(new Set(proof?.sparseWorkers?.map((worker) => worker.id)).size, 3, `three-lane ${label} reused a Worker URL record`);
    assert.equal(proof?.sparseWorkers?.every((worker) => worker.terminated), true, `three-lane ${label} left a verification Worker alive`);
    assert.equal(proof?.sparseWorkers?.every((worker) => worker.label.includes("sparse-verify-worker")), true, `three-lane ${label} did not use the packaged verification Worker URL`);
  }
  const multiSourceJobs = fixture.sources.length * fixture.sources[0].profile.chunks.length;
  assert.equal(raw?.serial?.maximumWorkers, 1, "indexed serial comparison used the wrong worker policy");
  assert.equal(raw?.serial?.physicalWorkers, 1, "indexed serial comparison constructed more than one Worker");
  assert.equal(raw?.serial?.jobs, multiSourceJobs, "indexed serial comparison did not process every source chunk");
  assert.deepEqual(raw?.serial?.workerJobCounts, [multiSourceJobs], "indexed serial comparison did not reuse its Worker across sources");
  assert.equal(raw?.serial?.runnablePeak, 1, "indexed serial comparison reported overlapping runnable workers");
  assert.equal(raw?.serial?.decoderAssetFetches, 1, "indexed serial comparison fetched more than one decoder asset");
  assert.equal(raw?.serial?.decoderCompileCalls, 1, "indexed serial comparison compiled more than one decoder module");
  assert.ok(raw?.serial?.elapsedMs > 0, "indexed serial preparation elapsed time was not recorded");
  assert.equal(raw?.serial?.workersAtOpen?.length, 1, "indexed serial preparation did not construct its expected Worker");
  assert.equal(raw?.serial?.workersAtOpen?.every((worker) => worker.terminated), true, "indexed serial Worker remained alive after preparation resolved");
  assert.equal(raw?.concurrent?.physicalWorkers, 2, "eligible indexed sources must use two physical Workers");
  assert.equal(raw?.concurrent?.maximumWorkers, 2, "eligible indexed comparison used the wrong worker policy");
  assert.equal(raw?.concurrent?.jobs, multiSourceJobs, "eligible indexed sources must decode every chunk");
  assert.equal(raw?.concurrent?.processingOverlap, true, "eligible indexed sources never overlapped real Worker PCM processing: " + JSON.stringify(raw?.concurrent));
  assert.ok((raw?.concurrent?.processingOutputWorkers?.length ?? 0) > 1, "eligible indexed sources produced PCM from only one Worker");
  assert.ok(raw?.concurrent?.workerJobCounts?.every((count) => count > 1), "eligible indexed Worker pool did not reuse each Worker");
  assert.equal(raw?.concurrent?.decoderAssetFetches, 1, "concurrent indexed sources must share one decoder asset fetch");
  assert.equal(raw?.concurrent?.decoderCompileCalls, 1, "concurrent indexed sources must share one decoder module compile");
  assert.ok((raw?.concurrent?.runnablePeak ?? 0) > 1, "eligible indexed sources did not overlap worker-side runnable decode sections");
  assert.ok(raw?.concurrent?.elapsedMs > 0, "indexed concurrent preparation elapsed time was not recorded");
  assert.equal(raw?.concurrent?.workersAtOpen?.length, 2, "eligible indexed preparation did not construct two Workers");
  assert.equal(raw?.concurrent?.workersAtOpen?.every((worker) => worker.terminated), true, "indexed concurrent Worker remained alive after preparation resolved");
  assert.deepEqual(raw?.concurrent?.workerResetCounts, fixture.sources.map((source) => source.profile.chunks.length), "concurrent chunks did not complete reset handshakes");
  assert.equal(new Set(raw?.concurrent?.workerInputSlotIds).size, raw?.concurrent?.jobs, "concurrent jobs reused a mutable input slot");
  assert.equal(raw?.concurrent?.workerModuleFlags?.every((provided) => provided), true, "concurrent job did not receive the compiled decoder module");
  assert.equal(raw?.silent?.locateCalls, 1, "all-silent source must locate once");
  assert.equal(raw?.silent?.networkRequests, 1, "all-silent source must make one full GET");
  assert.equal(raw?.silent?.jobs, 0, "all-silent source must not launch a decoder job");
  assert.equal(raw?.silent?.decoderAssetFetches, 0, "all-silent source must not fetch a decoder asset");
  assert.equal(raw?.silent?.decoderCompileCalls, 0, "all-silent source must not compile a decoder module");
  assert.deepEqual(raw?.silent?.progress?.stages, ["probing", "fetching", "ingesting", "source-ready", "ready"], "all-silent source did not expose zero-byte progress");
  assert.equal(raw?.workers?.allTerminated, true, "indexed physical Workers did not terminate after store close");
  assert.equal(raw?.workers?.sparseAllTerminated, true, "indexed verification Workers did not terminate after store close");
  assert.deepEqual(raw?.workers?.errors, []);
  assert.deepEqual(requestFailures, []);
  assert.deepEqual(consoleErrors, []);
  for (const [delivery, expectedCount] of [[fixture.sources[0], 3], [fixture.sources[1], 3], [fixture.threeWarmSources[2], 1], [fixture.silent, 1]]) {
    assert.equal(requestCounts.get(delivery.profile.url), expectedCount, `${delivery.profile.name} was fetched an unexpected number of times`);
    assert.equal(requests.get(delivery.profile.url), "application/octet-stream", `${delivery.profile.name} MIME changed`);
  }
  const decoderPaths = [...requests.keys()].filter((path) => (path.includes("engine-web-flac-decoder") || path.includes("flac-decoder")) && path.endsWith(".wasm"));
  assert.equal(decoderPaths.length, 1, "decoder Wasm URL changed or was fetched through multiple assets");
  assert.equal(requests.get(decoderPaths[0]), "application/wasm", "decoder Wasm MIME changed");
  assert.equal(requestCounts.get(decoderPaths[0]), 4, "each native resolver did not fetch its decoder asset exactly once");
  console.log(JSON.stringify({ profile: "indexed-sparse-reuse", origin: `http://127.0.0.1:${port}`,
    sources: fixture.sources.map((delivery) => ({ name: delivery.profile.name, ...delivery.profile })),
    silent: fixture.silent.profile, ...raw, requests: [...requests.entries()], requestCounts: [...requestCounts.entries()], requestFailures, consoleErrors }));
}

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function mimeFor(path) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm" })[extname(path)] ?? "application/octet-stream";
}
function resolveChromeExecutable() {
  const configured = process.env.CHROME_EXECUTABLE;
  const candidates = [
    configured,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : undefined,
  ].filter((value) => typeof value === "string");
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (executable === undefined) throw new Error("Chrome/Chromium not found; set CHROME_EXECUTABLE");
  return executable;
}

function indexedBrowserSource(fixture) {
  const browserFixture = {
    sources: fixture.sources.map((delivery) => delivery.profile),
    threeWarmSources: fixture.threeWarmSources.map((delivery) => delivery.profile),
    silent: fixture.silent.profile,
  };
  return String.raw`
import { createSparseStemResolver, OpfsStorageBackend, VerifiedSparsePcmStore, readSparsePcmWindow } from "@misofm/engine-web-adapter/stems";
import { blake3 } from "hash-wasm";

declare global { var __result: unknown; var __error: unknown }
const fixture = ${JSON.stringify(browserFixture)} as const;
const sourceByIdentity = new Map([...fixture.sources, ...fixture.threeWarmSources, fixture.silent].map((source) => [source.expected.identity, source]));
const NativeFetch = globalThis.fetch;
const NativeWorker = Worker;
const nativeCompile = WebAssembly.compile.bind(WebAssembly);
let locateCalls = 0;
let networkRequests = 0;
let decoderAssetFetches = 0;
let decoderCompileCalls = 0;
let flacWorkers = 0;
let sparseVerifyWorkers = 0;
let sparseVerifyProgress = 0;
let sparseVerifyCompletions = 0;
let spanCount = 0;
let activeJobs = 0;
let activePeak = 0;
let nextWorkerId = 1;
let nextInputSlotId = 1;
const inputSlotIds = new WeakMap<object, number>();
const workerByObject = new WeakMap<object, WorkerRecord>();
const workerRecords: WorkerRecord[] = [];
const workerErrors: Array<Record<string, unknown>> = [];
interface WorkerJob {
  readonly requestId: number;
  readonly inputSlotId: number | undefined;
  readonly moduleProvided: boolean;
  readonly startedAt: number;
  completed: boolean;
  completedAt: number | undefined;
  pcmBlocks: number;
  decodeMs: number;
  firstPcmAt: number | undefined;
  lastPcmAt: number | undefined;
}
interface RunnablePhase {
  readonly buffer: SharedArrayBuffer;
  readonly buffers: Set<SharedArrayBuffer>;
  readonly disposalReads: Array<{ readonly beforeNext: boolean; readonly length: number }>;
  readonly disposalTerminals: Array<{ readonly workerId: number; readonly terminal: string; readonly jobId: number; readonly generation: number; readonly identity: string | undefined; readonly allDetached: boolean; readonly readCount: number; readonly lengths: readonly number[] }>;
  nextBit: number;
}
interface WorkerRecord {
  readonly id: number;
  readonly label: string;
  readonly jobs: WorkerJob[];
  readonly completions: Array<{ readonly requestId: number; readonly reset: boolean }>;
  terminated: boolean;
  resetCount: number;
  runnablePhase: RunnablePhase | undefined;
  runnableMask: number | undefined;
}
let runnablePhase: RunnablePhase | undefined;
const sparseDisposalWrapperUrl = new URL("/sparse-disposal-wrapper.js", location.href);
const observedFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : new URL(input, location.href).href;
  if (identityForUrl(url) !== undefined) networkRequests += 1;
  if ((url.includes("engine-web-flac-decoder") || url.includes("flac-decoder")) && url.endsWith(".wasm")) decoderAssetFetches += 1;
  return NativeFetch(input, init);
};
globalThis.fetch = observedFetch;
try {
  WebAssembly.compile = ((source: BufferSource) => {
    // hash-wasm also compiles its BLAKE3 module through this API. Count only
    // the pinned public FLAC decoder asset for decoder reuse assertions.
    if (source.byteLength === 75_923) decoderCompileCalls += 1;
    return nativeCompile(source);
  }) as typeof WebAssembly.compile;
} catch (error) {
  workerErrors.push({ worker: "main", error: "compile instrumentation failed", message: String(error) });
}
globalThis.Worker = class ObservedWorker extends NativeWorker {
  readonly observedRecord: WorkerRecord;
  readonly disposalRelays = new Map<any, (event: MessageEvent) => void>();
  constructor(url: string | URL, options?: WorkerOptions) {
    const label = String(url);
    super(label.includes("sparse-verify-worker") ? sparseDisposalWrapperUrl : url, options);
    const record: WorkerRecord = { id: nextWorkerId++, label, jobs: [], completions: [], terminated: false,
      resetCount: 0, runnablePhase: undefined, runnableMask: undefined };
    this.observedRecord = record;
    workerByObject.set(this, record);
    workerRecords.push(record);
    if (label.includes("flac-worker")) flacWorkers += 1;
    if (label.includes("sparse-verify-worker")) sparseVerifyWorkers += 1;
    if (label.includes("sparse-verify-worker")) {
      super.addEventListener("message", (event) => {
        const message = event.data as { readonly type?: string; readonly beforeNext?: boolean; readonly length?: number;
          readonly terminal?: string; readonly jobId?: number; readonly generation?: number; readonly identity?: string;
          readonly allDetached?: boolean; readonly readCount?: number; readonly lengths?: unknown };
        if (message.type === "__miso_sparse_disposal_read__" && runnablePhase !== undefined) {
          runnablePhase.disposalReads.push({ beforeNext: message.beforeNext === true, length: Number(message.length) });
        } else if (message.type === "__miso_sparse_disposal_terminal__" && runnablePhase !== undefined) {
          runnablePhase.disposalTerminals.push({ workerId: record.id, terminal: String(message.terminal), jobId: Number(message.jobId), generation: Number(message.generation), identity: message.identity,
            allDetached: message.allDetached === true, readCount: Number(message.readCount), lengths: Array.isArray(message.lengths) ? message.lengths.map(Number) : [] });
        }
      });
    }
    this.addEventListener("message", (event) => {
      const message = event.data as { readonly type?: string; readonly requestId?: number; readonly reset?: boolean; readonly metrics?: { readonly decodeMs?: number } };
      if (label.includes("sparse-verify-worker")) {
        if (message.type === "progress") sparseVerifyProgress += 1;
        if (message.type === "complete") sparseVerifyCompletions += 1;
        return;
      }
      if (!label.includes("flac-worker") || typeof message.requestId !== "number") return;
      const job = [...record.jobs].reverse().find((candidate) => candidate.requestId === message.requestId && !candidate.completed);
      if (job === undefined) return;
      if (message.type === "pcm") {
        const now = performance.now();
        job.pcmBlocks += 1;
        job.decodeMs += typeof message.metrics?.decodeMs === "number" ? message.metrics.decodeMs : 0;
        job.firstPcmAt ??= now;
        job.lastPcmAt = now;
        return;
      }
      if (message.type !== "complete") return;
      job.completed = true;
      job.completedAt = performance.now();
      const reset = message.reset === true;
      record.completions.push({ requestId: message.requestId, reset });
      if (reset) record.resetCount += 1;
      activeJobs = Math.max(0, activeJobs - 1);
    });
    this.addEventListener("error", (event) => {
      if (label.includes("flac-worker") || label.includes("sparse-verify-worker")) workerErrors.push({ worker: label, message: event.message,
        filename: event.filename, line: event.lineno, column: event.colno, error: event.error?.message });
    });
    this.addEventListener("messageerror", () => {
      if (label.includes("flac-worker") || label.includes("sparse-verify-worker")) workerErrors.push({ worker: label, error: "messageerror" });
    });
  }
  override addEventListener(type: string, listener: any, options?: any): void {
    const record = workerByObject.get(this);
    if (type !== "message" || record === undefined || !record.label.includes("sparse-verify-worker")) {
      super.addEventListener(type, listener, options);
      return;
    }
    const relay = (event: MessageEvent) => {
      const message = event.data as { readonly type?: string; readonly beforeNext?: boolean; readonly length?: number;
        readonly terminal?: string; readonly jobId?: number; readonly generation?: number; readonly identity?: string;
        readonly allDetached?: boolean; readonly readCount?: number; readonly lengths?: unknown };
      if (message.type === "__miso_sparse_disposal_read__") {
        return;
      }
      if (message.type === "__miso_sparse_disposal_terminal__") {
        return;
      }
      if (message.type === "__miso_sparse_disposal_error__") {
        workerErrors.push({ worker: record.label, error: "wrapper-error", message: String(message.message) });
        return;
      }
      if (message.type === "__miso_sparse_disposal_boot__") {
        workerErrors.push({ worker: record.label, error: "wrapper-boot" });
        return;
      }
      listener(event);
    };
    this.disposalRelays.set(listener, relay);
    super.addEventListener(type, relay, options);
  }
  override removeEventListener(type: string, listener: any, options?: any): void {
    const relay = this.disposalRelays.get(listener);
    if (type === "message" && relay !== undefined) {
      this.disposalRelays.delete(listener);
      super.removeEventListener(type, relay, options);
      return;
    }
    super.removeEventListener(type, listener, options);
  }
  override postMessage(message: any, transfer?: Transferable[]): void {
    const record = workerByObject.get(this);
    if (record !== undefined && record.label.includes("flac-worker") && message?.type === "start" && typeof message.requestId === "number") {
      const phase = runnablePhase;
      if (phase === undefined) throw new Error("indexed FLAC Worker started outside an instrumented phase");
      let mask = record.runnablePhase === phase ? record.runnableMask : undefined;
      if (message.runnable === undefined) {
        if (mask === undefined) {
          if (phase.nextBit >= 31) throw new Error("indexed runnable worker mask exhausted");
          mask = 1 << phase.nextBit++;
          record.runnablePhase = phase;
          record.runnableMask = mask;
        }
        phase.buffers.add(phase.buffer);
      } else {
        phase.buffers.add(message.runnable as SharedArrayBuffer);
      }
      const slot = message.inputSlot?.bytes as object | undefined;
      let inputSlotId: number | undefined;
      if (slot !== undefined) {
        inputSlotId = inputSlotIds.get(slot);
        if (inputSlotId === undefined) { inputSlotId = nextInputSlotId++; inputSlotIds.set(slot, inputSlotId); }
      }
      record.jobs.push({ requestId: message.requestId, inputSlotId, moduleProvided: message.decoderModule !== undefined,
        startedAt: performance.now(), completed: false, completedAt: undefined, pcmBlocks: 0, decodeMs: 0,
        firstPcmAt: undefined, lastPcmAt: undefined });
      activeJobs += 1;
      activePeak = Math.max(activePeak, activeJobs);
    }
    const instrumented = record !== undefined && record.label.includes("flac-worker") && message?.type === "start" &&
      message.runnable === undefined && runnablePhase !== undefined
      ? { ...message, runnable: runnablePhase.buffer, runnableMask: record.runnableMask }
      : message;
    if (transfer === undefined) super.postMessage(instrumented);
    else super.postMessage(instrumented, transfer);
  }
  override terminate(): void {
    const record = workerByObject.get(this);
    if (record !== undefined) record.terminated = true;
    super.terminate();
  }
} as typeof Worker;
function sourceUrl(source: SourceProfile): string { return new URL(source.url, location.href).href; }
function identityForUrl(url: string): string | undefined {
  for (const source of [...fixture.sources, ...fixture.threeWarmSources, fixture.silent]) if (sourceUrl(source) === url) return source.expected.identity;
  return undefined;
}
function resolverFor(maximumWorkers: number) {
  return createSparseStemResolver({
    locate(identity) {
      const source = sourceByIdentity.get(identity);
      if (source === undefined) throw new Error("indexed locator received an unexpected identity");
      locateCalls += 1;
      return sourceUrl(source);
    },
    fetch: observedFetch,
    readDeadlineMs: 30_000,
    maximumWorkers,
    // Candidate warm verification is funded only by explicit unused headroom;
    // the derived cold width remains capped by maximumWorkers.
    memoryBudgetBytes: maximumWorkers * 8 * 1024 * 1024 + (maximumWorkers >= 3 ? 6 : 4) * 1024 * 1024,
    hardwareConcurrency: maximumWorkers === 1 ? 2 : 4,
    deviceMemory: maximumWorkers === 1 ? 1 : 2,
  });
}
function newStore(label: string) {
  const folderName = "adapter76-indexed-" + label + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const backend = new OpfsStorageBackend({ folderName });
  const store = new VerifiedSparsePcmStore({ backend, instanceId: "indexed-" + label });
  return { backend, store };
}
function startPhase(): Counters {
  if (activeJobs !== 0) throw new Error("indexed Worker jobs remained active between phases");
  activePeak = 0;
  const buffer = new SharedArrayBuffer(8);
  runnablePhase = { buffer, buffers: new Set([buffer]), disposalReads: [], disposalTerminals: [], nextBit: 0 };
  return counters();
}
function counters() {
  return { locateCalls, networkRequests, decoderAssetFetches, decoderCompileCalls, flacWorkers, sparseVerifyWorkers, sparseVerifyProgress, sparseVerifyCompletions, spanCount,
    starts: workerRecords.reduce((sum, worker) => sum + worker.jobs.length, 0), workerCount: workerRecords.length, runnablePhase };
}
function runnablePeaks(phase: RunnablePhase | undefined): number[] {
  return phase === undefined ? [] : [...phase.buffers].map((buffer) => Atomics.load(new Int32Array(buffer), 1));
}
function workersAtOpen(before: Counters) {
  return workerRecords.slice(before.workerCount).filter((worker) => worker.label.includes("flac-worker"))
    .map((worker) => ({ id: worker.id, jobs: worker.jobs.length, terminated: worker.terminated }));
}
function delta(before: Counters) {
  const workers = workerRecords.slice(before.workerCount).filter((worker) => worker.label.includes("flac-worker"));
  const outputJobs = workers.flatMap((worker) => worker.jobs.filter((job) => job.pcmBlocks > 0).map((job) => ({ workerId: worker.id, job })));
  const phasePeaks = runnablePeaks(before.runnablePhase);
  const phasePeak = Math.max(0, ...phasePeaks);
  return {
    locateCalls: locateCalls - before.locateCalls,
    networkRequests: networkRequests - before.networkRequests,
    decoderAssetFetches: decoderAssetFetches - before.decoderAssetFetches,
    decoderCompileCalls: decoderCompileCalls - before.decoderCompileCalls,
    physicalWorkers: flacWorkers - before.flacWorkers,
    sparseVerifyWorkers: sparseVerifyWorkers - before.sparseVerifyWorkers,
    sparseVerifyProgress: sparseVerifyProgress - before.sparseVerifyProgress,
    sparseVerifyCompletions: sparseVerifyCompletions - before.sparseVerifyCompletions,
    jobs: workerRecords.reduce((sum, worker) => sum + worker.jobs.length, 0) - before.starts,
    spanCount: spanCount - before.spanCount,
    activePeak,
    runnablePeaks: phasePeaks,
    runnablePeak: phasePeak,
    processingOverlap: phasePeak > 1,
    processingEvents: outputJobs.reduce((sum, item) => sum + item.job.pcmBlocks, 0),
    processingOutputWorkers: [...new Set(outputJobs.map((item) => item.workerId))],
    workerJobCounts: workers.map((worker) => worker.jobs.length),
    workerJobs: workers.map((worker) => worker.jobs.map((job) => ({ requestId: job.requestId, startedAt: job.startedAt, completedAt: job.completedAt, firstPcmAt: job.firstPcmAt, lastPcmAt: job.lastPcmAt, pcmBlocks: job.pcmBlocks, decodeMs: job.decodeMs }))),
    workerResetCounts: workers.map((worker) => worker.resetCount),
    workerInputSlotIds: workers.flatMap((worker) => worker.jobs.map((job) => job.inputSlotId)),
    workerModuleFlags: workers.flatMap((worker) => worker.jobs.map((job) => job.moduleProvided)),
    disposalReads: before.runnablePhase?.disposalReads ?? [],
    disposalTerminals: before.runnablePhase?.disposalTerminals ?? [],
    stages: [],
  };
}
async function runTailDisposalProof() {
  const frameBytes = 6;
  const frames = 185_024;
  const payload = new Uint8Array(frames * frameBytes);
  for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 29 + 7) & 0xff;
  const identity = "blake3:" + await blake3(payload, 256);
  const intervals = new Float64Array([0, frames, 0]).buffer;
  const before = startPhase();
  const worker = new Worker("/node_modules/@misofm/engine-web-adapter/dist/internal/engine-web-sparse-verify-worker.js", { type: "module" });
  let complete;
  let timer;
  let onTerminal;
  try {
    complete = await new Promise((resolve, reject) => {
      const finish = (result, error) => {
        if (timer !== undefined) clearTimeout(timer);
        worker.removeEventListener("message", onTerminal);
        if (error === undefined) resolve(result);
        else reject(error);
      };
      onTerminal = (event) => {
        const message = event.data;
        if (message?.type === "progress") {
          worker.postMessage({ type: "ack", version: 1, jobId: message.jobId, generation: message.generation, bytes: message.bytes });
        } else if (message?.type === "complete") finish(message);
        else if (message?.type === "failure") finish(undefined, new Error("tail disposal proof failed: " + message.kind + ": " + message.message));
      };
      worker.addEventListener("message", onTerminal);
      timer = setTimeout(() => finish(undefined, new Error("tail disposal proof timed out")), 10_000);
      worker.postMessage({ type: "start", version: 1, jobId: 1, generation: 1, identity, frames, channels: 2, bitDepth: 24,
        frameBytes, canonicalBytes: payload.byteLength, activeBytes: payload.byteLength, intervalCount: 1, intervals,
        data: new Blob([payload]), readDeadlineMs: 5_000 }, [intervals]);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onTerminal !== undefined) worker.removeEventListener("message", onTerminal);
    worker.terminate();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { ...delta(before), identity, complete };
}
function stageSummary(events: readonly Record<string, unknown>[]): string[] {
  const stages: string[] = [];
  for (const event of events) {
    const stage = event.stage;
    if (typeof stage === "string" && stages[stages.length - 1] !== stage) stages.push(stage);
  }
  return stages;
}
function sourceDeclaration(source: SourceProfile, sourceId: string) {
  return { sourceId, ...source.expected };
}
async function openCold(store: VerifiedSparsePcmStore, resolver: ReturnType<typeof resolverFor>, source: SourceProfile, sourceId: string, events: Record<string, unknown>[]) {
  const lease = await store.openSession({
    leaseId: sourceId,
    sources: [sourceDeclaration(source, sourceId)],
    resolve: async (expected, signal, context) => {
      const resolved = await resolver(expected, signal, context);
      return { ...resolved, spans: (async function*() {
        for await (const span of resolved.spans) { spanCount += 1; yield span; }
      })() };
    },
    onProgress: (event) => events.push({ ...event }),
  });
  return lease;
}
async function openConcurrent(store: VerifiedSparsePcmStore, resolver: ReturnType<typeof resolverFor>, sources: readonly SourceProfile[], events: Record<string, unknown>[]) {
  return store.openSession({
    leaseId: "concurrent-sources",
    sources: sources.map((source, index) => sourceDeclaration(source, "concurrent-" + index)),
    // Pass the exact native resolver so the store can use its private bounded
    // scheduling registration. Wrapping it would intentionally lose that
    // optimization and turn this into the custom-resolver sequential path.
    resolve: resolver,
    onProgress: (event) => events.push({ ...event }),
  });
}
async function runThreeWarmScenario(resources, primeResolver) {
  const sources = fixture.threeWarmSources;
  // The first two descriptors are already committed by the preceding
  // two-source proof. Commit only the third source, then exercise the native
  // warm pool against the same OPFS generation. Each open owns three
  // physical verification Worker URLs.
  startPhase();
  const third = sources[2];
  if (third === undefined) throw new Error("three-lane fixture omitted its third source");
  const lease = await openCold(resources.store, primeResolver, third, "three-prime-" + third.name, []);
  await lease.close();
    const firstEvents: Record<string, unknown>[] = [];
    const firstBefore = startPhase();
    const firstLease = await openConcurrent(resources.store, resolverFor(3), sources, firstEvents);
    const firstProofs = [];
    for (const source of sources) firstProofs.push(await proveDescriptor(await firstLease.read(source.expected.identity), source));
    const firstProgress = assertProgress(firstEvents, sources, ["verifying", "source-ready", "ready"]);
    await firstLease.close();
    const first = { ...delta(firstBefore), progress: firstProgress, proofs: firstProofs,
      sparseWorkers: workerRecords.slice(firstBefore.workerCount).filter((worker) => worker.label.includes("sparse-verify-worker")).map((worker) => ({ id: worker.id, label: worker.label, terminated: worker.terminated })) };
    if (first.sparseVerifyWorkers !== 3 || first.sparseVerifyCompletions !== 3 || first.sparseWorkers.length !== 3 || !first.sparseWorkers.every((worker) => worker.terminated)) {
      throw new Error("three-lane warm open did not construct and tear down three native verification Workers: " + JSON.stringify(first));
    }
    const reopenEvents: Record<string, unknown>[] = [];
    const reopenBefore = startPhase();
    const reopenLease = await openConcurrent(resources.store, resolverFor(3), sources, reopenEvents);
    const reopenProofs = [];
    for (const source of sources) reopenProofs.push(await proveDescriptor(await reopenLease.read(source.expected.identity), source));
    const reopenProgress = assertProgress(reopenEvents, sources, ["verifying", "source-ready", "ready"]);
    await reopenLease.close();
    const reopen = { ...delta(reopenBefore), progress: reopenProgress, proofs: reopenProofs,
      sparseWorkers: workerRecords.slice(reopenBefore.workerCount).filter((worker) => worker.label.includes("sparse-verify-worker")).map((worker) => ({ id: worker.id, label: worker.label, terminated: worker.terminated })) };
    if (reopen.sparseVerifyWorkers !== 3 || reopen.sparseVerifyCompletions !== 3 || reopen.sparseWorkers.length !== 3 || !reopen.sparseWorkers.every((worker) => worker.terminated)) {
      throw new Error("three-lane warm reopen did not construct and tear down three native verification Workers: " + JSON.stringify(reopen));
    }
  return { sourceIdentities: sources.map((source) => source.expected.identity), first, reopen };
}
async function proveDescriptor(descriptor: any, source: SourceProfile) {
  if (descriptor.kind !== "sparse-pcm" || descriptor.data.size !== source.activeBytes) throw new Error("indexed descriptor payload size changed for " + source.name);
  if (descriptor.index.identity !== source.expected.identity || descriptor.index.canonicalBytes !== source.expected.canonicalBytes || descriptor.index.activeBytes !== source.activeBytes) throw new Error("indexed descriptor shape changed for " + source.name);
  if (JSON.stringify(descriptor.index.intervals) !== JSON.stringify(source.intervals)) throw new Error("indexed descriptor intervals changed for " + source.name);
  for (const proof of source.windowProofs) {
    const bytes = await readSparsePcmWindow(descriptor.index, descriptor.data, proof.startFrame, proof.frames);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== proof.sha256) throw new Error("indexed PCM window changed for " + source.name + " at frame " + proof.startFrame);
  }
  return { payloadBytes: descriptor.data.size, index: descriptor.index, windows: source.windowProofs.length };
}
function assertProgress(events: readonly Record<string, unknown>[], sources: readonly SourceProfile[], expectedStages: readonly string[], silent = false) {
  if (events.length === 0) throw new Error("indexed progress callback received no events");
  const sourceMap = new Map(sources.map((source) => [source.expected.identity, source]));
  const previousBytes = new Map<string, number>();
  const requiredWorkStages = expectedStages.includes("decoding")
    ? ["decoding", "ingesting"]
    : expectedStages.includes("verifying") ? ["verifying"] : ["ingesting"];
  for (const event of events) {
    const identity = event.identity;
    if (typeof identity === "string") {
      const source = sourceMap.get(identity);
      if (source === undefined) throw new Error("indexed progress identity is not declared");
      if (typeof event.bytes === "number" && typeof event.totalBytes === "number") {
        if (!Number.isSafeInteger(event.bytes) || event.bytes < 0 || !Number.isSafeInteger(event.totalBytes) || event.totalBytes < 0 || event.bytes > event.totalBytes) throw new Error("indexed progress counter is outside its finite total");
        const key = identity + ":" + event.stage + ":" + event.byteKind;
        const prior = previousBytes.get(key);
        if (prior !== undefined && event.bytes < prior) throw new Error("indexed progress counter regressed for " + key);
        previousBytes.set(key, event.bytes);
        if (["probing", "fetching"].includes(String(event.stage)) && event.totalBytes !== source.containerBytes) throw new Error("indexed container progress total changed");
        if (["decoding", "ingesting", "verifying"].includes(String(event.stage)) && event.totalBytes !== source.expected.canonicalBytes) throw new Error("indexed canonical progress total changed");
      }
    }
    if (event.stage === "source-ready") {
      if (typeof event.bytes !== "number" || !Number.isSafeInteger(event.bytes) || event.bytes < 0) throw new Error("indexed source-ready bytes are invalid");
      const source = sourceMap.get(String(event.identity));
      if (source === undefined || event.bytes !== source.expected.canonicalBytes) throw new Error("indexed source-ready bytes changed");
    }
  }
  const stages = stageSummary(events);
  for (const stage of expectedStages) if (!stages.includes(stage)) throw new Error("indexed progress omitted " + stage + ": " + stages.join(","));
  const readyIndex = stages.indexOf("ready");
  const sourceReadyIndex = stages.indexOf("source-ready");
  if (readyIndex < 0 || sourceReadyIndex < 0 || readyIndex <= sourceReadyIndex) throw new Error("indexed aggregate ready preceded source readiness");
  const declarations = Number((events.find((event) => event.stage === "ready") as any)?.sourcesTotal);
  if (declarations !== sources.length) throw new Error("indexed ready declaration total changed");
  const readyEvents = events.filter((event) => event.stage === "source-ready");
  if (readyEvents.length !== sources.length) throw new Error("indexed source-ready declaration count changed");
  for (const source of sources) {
    const matching = events.filter((event) => event.identity === source.expected.identity && ["decoding", "ingesting", "verifying"].includes(String(event.stage)));
    for (const stage of requiredWorkStages) {
      const final = [...matching].reverse().find((event) => event.stage === stage);
      const expectedBytes = stage === "decoding" ? source.activeBytes : source.expected.canonicalBytes;
      if (final === undefined || final.totalBytes !== source.expected.canonicalBytes) throw new Error("indexed " + stage + " did not reach its declared total for " + source.name + ": " + JSON.stringify({ expectedBytes, final, stages: stageSummary(events), matching: matching.slice(-5) }));
      if (stage === "decoding") {
        const values = matching.filter((event) => event.stage === stage).map((event) => Number(event.bytes));
        const highest = Math.max(...values);
        const frameBytes = source.expected.channels * (source.expected.bitDepth / 8);
        const firstChunkBytes = source.chunks[0].frames * frameBytes;
        if (highest <= firstChunkBytes || highest !== expectedBytes || final.bytes !== expectedBytes) throw new Error("indexed decoding did not reach its declared active EOF for " + source.name + ": " + JSON.stringify({ expectedBytes, highest, firstChunkBytes, final }));
      } else if (final.bytes !== expectedBytes) {
        throw new Error("indexed " + stage + " did not reach its declared EOF for " + source.name + ": " + JSON.stringify({ expectedBytes, final }));
      }
    }
    if (silent && matching.some((event) => event.stage === "decoding")) throw new Error("indexed all-silent source decoded bytes");
  }
  return { stages, sourceReady: readyEvents.length, eventCount: events.length };
}
let result: any;
let failure: unknown;
try {
  const first = fixture.sources[0];
  const second = fixture.sources[1];
  const coldEvents: Record<string, unknown>[] = [];
  const coldResources = newStore("cold");
  const coldPrimeResolver = resolverFor(1);
  // Prime the second committed source before the measured cold arm so the
  // candidate warm arm can exercise two native Worker URLs without adding a
  // second source to the shipped one-source cold comparison.
  startPhase();
  const warmPrime = await openCold(coldResources.store, coldPrimeResolver, second, "warm-prime-second", []);
  await warmPrime.close();
  const coldBefore = startPhase();
  const coldResolver = resolverFor(1);
  const coldLease = await openCold(coldResources.store, coldResolver, first, "cold-source", coldEvents);
  const coldWorkersAtOpen = workersAtOpen(coldBefore);
  const coldDescriptor = await coldLease.read(first.expected.identity);
  const coldProof = await proveDescriptor(coldDescriptor, first);
  const coldProgress = assertProgress(coldEvents, [first], ["probing", "fetching", "decoding", "ingesting", "source-ready", "ready"]);
  await coldLease.close();
  const cold = { ...delta(coldBefore), maximumWorkers: 1, workersAtOpen: coldWorkersAtOpen, progress: coldProgress, proof: coldProof };
  const warmEvents: Record<string, unknown>[] = [];
  const warmBefore = startPhase();
  const warmResolver = resolverFor(2);
  const warmLease = await coldResources.store.openSession({
    leaseId: "warm-source",
    sources: [sourceDeclaration(first, "warm-source-first"), sourceDeclaration(second, "warm-source-second")],
    // Preserve the native resolver registration so this packed fixture covers
    // the preparation-owned warm Worker path.
    resolve: warmResolver,
    onProgress: (event) => warmEvents.push({ ...event }),
  });
  const warmProofs = [];
  for (const source of [first, second]) warmProofs.push(await proveDescriptor(await warmLease.read(source.expected.identity), source));
  const warmProgress = assertProgress(warmEvents, [first, second], ["verifying", "source-ready", "ready"]);
  await warmLease.close();
  const warm = { ...delta(warmBefore), maximumWorkers: 2, workersAtOpen: [], progress: warmProgress, proofs: warmProofs };
  const threeWarm = await runThreeWarmScenario(coldResources, coldPrimeResolver);
  await coldResources.store.close();
  coldResources.backend.close();
  const tail = await runTailDisposalProof();

  const serialEvents: Record<string, unknown>[] = [];
  const serialResources = newStore("serial");
  const serialResolver = resolverFor(1);
  const serialBefore = startPhase();
  const serialStartedAt = performance.now();
  const serialLease = await openConcurrent(serialResources.store, serialResolver, [first, second], serialEvents);
  const serialElapsedMs = performance.now() - serialStartedAt;
  const serialWorkersAtOpen = workersAtOpen(serialBefore);
  const serialProofs = [];
  for (const source of [first, second]) serialProofs.push(await proveDescriptor(await serialLease.read(source.expected.identity), source));
  const serialProgress = assertProgress(serialEvents, [first, second], ["probing", "fetching", "decoding", "ingesting", "source-ready", "ready"]);
  await serialLease.close();
  await serialResources.store.close();
  serialResources.backend.close();
  const serial = { ...delta(serialBefore), maximumWorkers: 1, elapsedMs: serialElapsedMs, workersAtOpen: serialWorkersAtOpen,
    progress: serialProgress, proofs: serialProofs };

  const concurrentEvents: Record<string, unknown>[] = [];
  const concurrentResources = newStore("concurrent");
  const concurrentResolver = resolverFor(2);
  const concurrentBefore = startPhase();
  const concurrentStartedAt = performance.now();
  const concurrentLease = await openConcurrent(concurrentResources.store, concurrentResolver, [first, second], concurrentEvents);
  const concurrentElapsedMs = performance.now() - concurrentStartedAt;
  const concurrentWorkersAtOpen = workersAtOpen(concurrentBefore);
  const concurrentProofs = [];
  for (const source of [first, second]) concurrentProofs.push(await proveDescriptor(await concurrentLease.read(source.expected.identity), source));
  const concurrentProgress = assertProgress(concurrentEvents, [first, second], ["probing", "fetching", "decoding", "ingesting", "source-ready", "ready"]);
  await concurrentLease.close();
  await concurrentResources.store.close();
  concurrentResources.backend.close();
  const concurrent = { ...delta(concurrentBefore), maximumWorkers: 2, elapsedMs: concurrentElapsedMs, workersAtOpen: concurrentWorkersAtOpen,
    progress: concurrentProgress, proofs: concurrentProofs };

  const silentEvents: Record<string, unknown>[] = [];
  const silentResources = newStore("silent");
  const silentResolver = resolverFor(1);
  const silentBefore = startPhase();
  const silentLease = await openCold(silentResources.store, silentResolver, fixture.silent, "silent-source", silentEvents);
  const silentDescriptor = await silentLease.read(fixture.silent.expected.identity);
  const silentProof = await proveDescriptor(silentDescriptor, fixture.silent);
  const silentProgress = assertProgress(silentEvents, [fixture.silent], ["probing", "fetching", "ingesting", "source-ready", "ready"], true);
  await silentLease.close();
  await silentResources.store.close();
  silentResources.backend.close();
  const silent = { ...delta(silentBefore), progress: silentProgress, proof: silentProof };

  // Let reset/completion and terminate tasks publish their final browser events before reporting evidence.
  await new Promise((resolve) => setTimeout(resolve, 0));
  result = { cold, warm, tail, threeWarm, serial, concurrent, silent, workers: {
    allTerminated: workerRecords.filter((worker) => worker.label.includes("flac-worker")).every((worker) => worker.terminated),
    sparseAllTerminated: workerRecords.filter((worker) => worker.label.includes("sparse-verify-worker")).every((worker) => worker.terminated),
    records: workerRecords.filter((worker) => worker.label.includes("flac-worker")).map((worker) => ({ id: worker.id, jobs: worker.jobs.length, completions: worker.completions, resetCount: worker.resetCount, terminated: worker.terminated })),
    sparseRecords: workerRecords.filter((worker) => worker.label.includes("sparse-verify-worker")).map((worker) => ({ id: worker.id, terminated: worker.terminated })),
    errors: workerErrors,
  } };
} catch (error) {
  failure = error;
}
if (failure === undefined) globalThis.__result = result;
else globalThis.__error = { error: describe(failure), workers: workerRecords.filter((worker) => worker.label.includes("flac-worker")).map((worker) => ({ id: worker.id, jobs: worker.jobs, completions: worker.completions, resetCount: worker.resetCount, terminated: worker.terminated })), workerErrors };
function describe(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error);
  const value = error as Error & { code?: unknown; details?: unknown; cause?: unknown };
  return { name: value.name, message: value.message, code: value.code, details: value.details, stack: value.stack,
    cause: value.cause === undefined ? undefined : describe(value.cause) };
}
type SourceProfile = typeof fixture.sources[number];
type Counters = ReturnType<typeof counters>;
`; }

function browserSource(profile) { return String.raw`
import { session } from "@misofm/engine";
import { createIngestDiagnostics, openEngineWebSession, openSparseEngineWebSession } from "@misofm/engine-web-adapter";
import { MSB1_CONTROL, PcmPumpWorkerClient } from "@misofm/engine-web-adapter/stems";
import { ADAPTER_ASSETS } from "@misofm/engine-web-adapter/assets";
import { blake3 } from "hash-wasm";

declare global { var __result: unknown; var __error: unknown; var __seekStage: unknown }
const profile = ${JSON.stringify(profile)} as const;
void ADAPTER_ASSETS;
const packedBlake3Fallback = await new Promise<{ readonly type?: string; readonly ok?: boolean; readonly digest?: string; readonly expected?: string; readonly error?: string }>((resolve, reject) => {
  const worker = new Worker(new URL("../blake3-fallback-worker.ts", import.meta.url), { type: "module" });
  const timer = setTimeout(() => { worker.terminate(); reject(new Error("packed BLAKE3 fallback worker timed out")); }, 30_000);
  worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
  worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message || "packed BLAKE3 fallback worker failed")); };
});
if (packedBlake3Fallback.type !== "result" || packedBlake3Fallback.ok !== true) {
  throw new Error("packed BLAKE3 fallback proof failed: " + JSON.stringify(packedBlake3Fallback));
}
const identity = profile.identity;
const source = { id: "source-000", spec: {
  channels: profile.channels, bitDepth: profile.bitDepth, frames: profile.frames, content: identity as any,
} };
const document = session({ id: "packed-browser", sampleRateHz: profile.sampleRateHz, quantumFrames: 128 })
  .source(source.id, source.spec)
  .track("track-000", { source: { id: source.id, left: 0, right: profile.channels - 1 } })
  .output("main-out")
  .route({
    id: "route-000", source: { kind: "track", trackId: "track-000", tap: "post_matrix" },
    destination: { kind: "output_input", outputId: "main-out" },
  });
let locatorCalls = 0;
let flacWorkers = 0;
let networkRequests = 0;
let observedRemoteBytes = 0;
let observedEtag = "";
const assetUrl = new URL(profile.url, location.href).href;
const NativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : new URL(input, location.href).href;
  if (url === assetUrl) networkRequests += 1;
  const response = await NativeFetch(input, init);
  if (url === assetUrl && response.status === 206) {
    const contentRange = response.headers.get("Content-Range") ?? "";
    const match = /\/(\d+)$/u.exec(contentRange);
    if (match !== null) observedRemoteBytes = Number(match[1]);
    observedEtag = response.headers.get("ETag") ?? "";
  }
  return response;
}) as typeof fetch;
const NativeWorker = Worker;
globalThis.Worker = class ObservedWorker extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    if (String(url).includes("flac-worker")) flacWorkers += 1;
    super(url, options);
  }
} as typeof Worker;
let rings: readonly SharedArrayBuffer[] = [];
async function open(overrides: Record<string, unknown> = {}) {
  return openEngineWebSession({
    document,
    flac: { ...(overrides.leaseId === "cold" || overrides.leaseId === "warm" ? { processing: { maximumWorkers: 16 } } : {}), locate(requested) {
      if (requested !== identity) throw new Error("unexpected identity");
      locatorCalls += 1;
      return assetUrl;
    } },
    createPump: async (options) => {
      rings = options.sources.map((item) => item.ring);
      return PcmPumpWorkerClient.create(options);
    },
    ...overrides,
  });
}
/** Both orders, because a first control call must not need a retry either way. */
async function exerciseControl(engine: any, consoleFirst: boolean) {
  const trackId = engine.shape.tracks[0];
  const updates: any[] = [];
  const submit = () => {
    const track = engine.console.edit.track(trackId);
    return engine.console.submit(track.faderDb(-6), track.mute(false));
  };
  const subscribe = () => engine.meters((update: any) => updates.push(update));
  let stop: () => void;
  if (consoleFirst) { await submit(); stop = await subscribe(); }
  else { stop = await subscribe(); await submit(); }
  await new Promise((resolve) => setTimeout(resolve, 120));
  stop();
  const last = updates.at(-1);
  return {
    trackId,
    meterUpdates: updates.length,
    meterTrackIds: last === undefined ? [] : [...last.tracks.keys()],
    meterHasMaster: last === undefined ? false : typeof last.master.peak === "number",
  };
}
async function exercisePausedSeek(mode: "initial" | "resumed" | "running") {
  globalThis.__seekStage = { mode, stage: "open" };
  const frames = 48_000;
  const pcm = new Uint8Array(frames * 4);
  const view = new DataView(pcm.buffer);
  for (let frame = 0; frame < frames; frame++) {
    view.setInt16(frame * 4, ((frame % 1024) - 512) * 32, true);
    view.setInt16(frame * 4 + 2, ((frame % 1024) - 512) * -16, true);
  }
  const digest = await blake3(pcm, 256);
  const model = session({ id: "seek-proof", sampleRateHz: 48_000, quantumFrames: 128 })
    .source("seek-source", { channels: 2, bitDepth: 16, frames, content: ("blake3:" + digest) as any })
    .track("seek-track", { source: { id: "seek-source", left: 0, right: 1 } })
    .output("seek-output")
    .route({ id: "seek-route", source: { kind: "track", trackId: "seek-track", tap: "post_matrix" },
      destination: { kind: "output_input", outputId: "seek-output" } });
  let beforeProducerSeek = async () => {};
  const engine = await openEngineWebSession({ document: model, leaseId: "seek-" + mode, console: false,
    policy: { sourceRingFrames: 512 },
    resolver: { async resolve() { return { stream: new Blob([pcm]).stream(), canonicalBytes: pcm.length }; } },
    createPump: async (options) => {
      const pump = await PcmPumpWorkerClient.create(options);
      return { allocation: pump.allocation,
        async seekFrames(frame) { await beforeProducerSeek(); return pump.seekFrames(frame); },
        close: () => pump.close() };
    },
  });
  const context = engine.context as AudioContext;
  globalThis.__seekStage = { mode, stage: "opened" };
  const sleep = () => new Promise((resolve) => setTimeout(resolve, 1));
  try {
    await context.audioWorklet.addModule("/capture.js");
    const captureNext = () => {
      const capture = new AudioWorkletNode(context, "capture-first-quantum", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      });
      const first = new Promise<number[][]>((resolve) => { capture.port.onmessage = ({ data }) => resolve(data); });
      engine.host.node.connect(capture); capture.connect(context.destination);
      return { first, close() { engine.host.node.disconnect(capture); capture.disconnect(); } };
    };
    if (mode !== "initial") {
      globalThis.__seekStage = { mode, stage: "initial-play" };
      const initial = captureNext();
      await engine.play();
      const started = await initial.first;
      if (!started.some((plane) => plane.some((sample) => sample !== 0))) throw new Error("initial playback was silent");
      if (mode === "resumed") await engine.pause();
      initial.close();
    }
    let old: ReturnType<typeof engine.feedDiagnostics>["sources"][number];
    let before: Awaited<ReturnType<typeof engine.host.status>>;
    let beforeTime = 0;
    let suspendedBeforeProducer = false;
    let internalBackpressure = 0;
    const fillOldQueues = async () => {
      suspendedBeforeProducer = context.state === "suspended";
      if (!suspendedBeforeProducer) throw new Error("adapter did not suspend before producer seek");
      const deadline = performance.now() + 2000;
      globalThis.__seekStage = { mode, stage: "fill" };
      while (engine.feedDiagnostics().sources[0]!.occupancy !== 64) {
        if (performance.now() >= deadline) throw new Error("old shared queue did not fill");
        await sleep();
      }
      old = engine.feedDiagnostics().sources[0]!;
      let nextFrame = old.submitted * 128;
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await engine.host.submitSource({ sourceId: "seek-source", generation: 1n,
          startFrame: BigInt(nextFrame), sampleRateHz: 48_000, frames: 128,
          planes: [new Float32Array(128).fill(.25), new Float32Array(128).fill(-.25)], endOfRegion: false,
        }).catch((error) => error);
        if (result.result === 6) { internalBackpressure = 6; break; }
        if (result.result !== 0) throw new Error("old internal PCM admission failed: " + result.result);
        nextFrame += 128;
      }
      if (internalBackpressure !== 6) throw new Error("old internal queue was not full");
      before = await engine.host.status(); beforeTime = context.currentTime;
    };
    if (mode === "running") beforeProducerSeek = fillOldQueues;
    else await fillOldQueues();
    globalThis.__seekStage = { mode, stage: "seek" };
    let resumeCalls = 0;
    let capture: ReturnType<typeof captureNext>;
    let prepared: { state: string; timeUnchanged: boolean; sampleUnchanged: boolean };
    const readPreparation = async () => {
      const after = await engine.host.status();
      return { state: context.state, timeUnchanged: context.currentTime === beforeTime,
        sampleUnchanged: after.nextAbsoluteSample === before.nextAbsoluteSample };
    };
    const nativeResume = context.resume.bind(context);
    const assertPreparedRunway = () => {
      const observation = engine.observeSource("seek-source");
      let next = 10_000n;
      let chunks = 0;
      try {
        for (let pass = 0; pass < 2; pass++) chunks += observation.pull((chunk) => {
          if (chunk.generation !== 2n || chunk.startFrame !== next || chunk.frames !== 128) throw new Error("resume preceded contiguous target PCM");
          next += BigInt(chunk.frames);
        }, 32);
        if (chunks !== 64 || next !== 18_192n) throw new Error("resume preceded the complete playback runway");
      } finally { observation.close(); }
    };
    context.resume = async () => {
      resumeCalls++;
      if (mode === "running") {
        assertPreparedRunway();
        prepared = await readPreparation();
        // Arm only at the actual suspended resume boundary, so earlier audio cannot satisfy it.
        capture = captureNext();
      }
      await nativeResume();
    };
    const seeking = engine.seekFrames(10_000);
    let busy = "";
    try { await engine.play(); } catch (error) { busy = (error as { code?: string }).code ?? ""; }
    await seeking;
    const stateAfterSeek = context.state;
    const resumeCallsDuringSeek = resumeCalls;
    context.resume = nativeResume;
    if (mode !== "running") { assertPreparedRunway(); prepared = await readPreparation(); capture = captureNext(); }
    globalThis.__seekStage = { mode, stage: "target-play", prepared };
    if (mode !== "running") await engine.play();
    const first = await capture.first; await engine.pause(); capture.close();
    const counters = engine.feedDiagnostics().sources[0]!;
    return { mode, document: model.toJson(), busy, resumeCallsDuringSeek, suspendedBeforeProducer, stateAfterSeek, staleOccupancy: old.occupancy,
      internalBackpressure, prepared, pcm: first, staleReleased: counters.stale - old.stale,
      underruns: counters.underruns - old.underruns, refused: counters.refused - old.refused,
      torn: counters.torn - old.torn, errors: counters.errors - old.errors };
  } finally { await engine.close(); }
}
async function exerciseTerminalPumpFailure(mode: "reject" | "stall" | "crash") {
  const frames = 48_000 * 2;
  const pcm = new Uint8Array(frames * 2);
  const digest = await blake3(pcm, 256);
  const model = session({ id: "terminal-pump-" + mode, sampleRateHz: 48_000, quantumFrames: 128 })
    .source("terminal-source", { channels: 1, bitDepth: 16, frames, content: ("blake3:" + digest) as any })
    .track("terminal-track", { source: { id: "terminal-source", left: 0, right: 0 } })
    .output("terminal-output")
    .route({ id: "terminal-route", source: { kind: "track", trackId: "terminal-track", tap: "post_matrix" },
      destination: { kind: "output_input", outputId: "terminal-output" } });
  let worker: Worker;
  let terminations = 0;
  let notifications = 0;
  let resolveFailure: (error: any) => void;
  const failed = new Promise<any>((resolve) => { resolveFailure = resolve; });
  const engine = await openEngineWebSession({ document: model, leaseId: "terminal-" + mode, console: false,
    resolver: { async resolve() { return { stream: new Blob([pcm]).stream(), canonicalBytes: pcm.length }; } },
    onError(error) { notifications++; resolveFailure(error); },
    createPump: async (options) => {
      worker = new Worker(new URL("../fault-pump-worker.ts", import.meta.url), { type: "module" });
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => { terminations++; terminate(); };
      return PcmPumpWorkerClient.create({ ...options, worker });
    },
  });
  const started = performance.now();
  try {
    if (notifications !== 0 || engine.state !== "ready") throw new Error("terminal test did not start from a fully ready session");
    await engine.play();
    worker.postMessage({ type: "test-fault", mode });
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("terminal pump failure did not propagate")), 7500); });
    const error = await Promise.race([failed, timeout]).finally(() => clearTimeout(timer));
    if (engine.state !== "closed" || engine.context.state !== "closed" || notifications !== 1 || terminations !== 1 || error.code !== "session.playback") throw new Error("terminal failure did not close and notify exactly once");
    let playCode = "";
    try { await engine.play(); } catch (failure) { playCode = (failure as { code?: string }).code ?? ""; }
    if (playCode !== "session.closed") throw new Error("terminal session resumed");
    await engine.close();
    return { mode, notifications, terminations, state: engine.state, context: engine.context.state,
      code: error.code, causeCode: error.cause?.code ?? null, milliseconds: performance.now() - started };
  } finally { await engine.close(); }
}
async function exerciseSparseWorker(ring: SharedArrayBuffer) {
  const frames = 256;
  const frameBytes = profile.channels * (profile.bitDepth / 8);
  const intervals = [{ startFrame: 2, frames: 2, byteOffset: 0 }, { startFrame: 200, frames: 2, byteOffset: 2 * frameBytes }];
  const packed = new Uint8Array(4 * frameBytes);
  const view = new DataView(packed.buffer);
  for (let frame = 0; frame < 4; frame++) for (let channel = 0; channel < profile.channels; channel++) {
    const sample = (frame + 1) * (channel === 0 ? 4096 : -2048);
    const offset = (frame * profile.channels + channel) * (profile.bitDepth / 8);
    if (profile.bitDepth === 16) view.setInt16(offset, sample, true);
    else { view.setUint8(offset, sample & 0xff); view.setUint8(offset + 1, (sample >> 8) & 0xff); view.setUint8(offset + 2, (sample >> 16) & 0xff); }
  }
  const identity = ("blake3:" + "3".repeat(64)) as any;
  const descriptor = { kind: "sparse-pcm" as const, data: new Blob([packed]), index: {
    format: "miso_sparse_pcm_v1" as const, identity, sampleRateHz: profile.sampleRateHz,
    channels: profile.channels, bitDepth: profile.bitDepth, frames, intervals,
  }};
  let reads = 0;
  const controlBefore = new Int32Array(ring, 0, 32);
  const wroteBefore = Atomics.load(controlBefore, MSB1_CONTROL.WROTE);
  const pump = await PcmPumpWorkerClient.createSparse({
    lease: { async read() { reads++; return descriptor; } },
    sources: [{ sourceId: "source-000", identity, sampleRateHz: profile.sampleRateHz,
      channels: profile.channels, bitDepth: profile.bitDepth, frames, ring }],
    windowFrames: frames,
  });
  const control = new Int32Array(ring, 0, 32);
  const waitForWrites = async (before: number) => {
    const deadline = performance.now() + 5000;
    while (Atomics.load(control, MSB1_CONTROL.WROTE) <= before) {
      if (performance.now() >= deadline) throw new Error("sparse packed Worker did not publish PCM");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };
  try {
    await waitForWrites(wroteBefore);
    const firstWrote = Atomics.load(control, MSB1_CONTROL.WROTE);
    const pcmOffset = Atomics.load(control, MSB1_CONTROL.PCM_OFFSET);
    const capacity = Atomics.load(control, MSB1_CONTROL.CAPACITY);
    const channels = Atomics.load(control, MSB1_CONTROL.CHANNELS);
    const frameCapacity = Atomics.load(control, MSB1_CONTROL.FRAME_CAPACITY);
    const slot = (Atomics.load(control, MSB1_CONTROL.WRITE_INDEX) - 1) & (capacity - 1);
    const firstPlane = new Float32Array(ring, pcmOffset + slot * channels * frameCapacity * 4, frameCapacity);
    if (!firstPlane.some((sample) => sample !== 0)) throw new Error(JSON.stringify({ message: "sparse packed Worker published only gap silence", first: [...firstPlane].slice(0, 16), slot, write: Atomics.load(control, MSB1_CONTROL.WRITE_INDEX), frameCapacity, channels }));
    Atomics.store(control, MSB1_CONTROL.READ_INDEX, Atomics.load(control, MSB1_CONTROL.WRITE_INDEX));
    const generation = await pump.seekFrames(200);
    if (generation !== 2n) throw new Error("sparse packed Worker seek generation changed unexpectedly");
    await waitForWrites(firstWrote);
    if (reads !== 1) throw new Error("sparse packed Worker resolved an asset more than once");
    return { writes: Atomics.load(control, MSB1_CONTROL.WROTE), reads, generation: String(generation), scratch: pump.allocation.maximumReadScratchBytes };
  } finally { await pump.close(); }
}
async function exerciseSparseSession() {
  const sparseFrames = 256;
  const sparseIdentity = ("blake3:" + "4".repeat(64)) as any;
  const sparseSource = { id: "sparse-source-000", spec: {
    channels: profile.channels, bitDepth: profile.bitDepth, frames: sparseFrames, content: sparseIdentity,
  } };
  const sparseDocument = session({ id: "packed-sparse", sampleRateHz: profile.sampleRateHz, quantumFrames: 128 })
    .source(sparseSource.id, sparseSource.spec)
    .track("sparse-track-000", { source: { id: sparseSource.id, left: 0, right: profile.channels - 1 } })
    .output("sparse-out")
    .route({ id: "sparse-route", source: { kind: "track", trackId: "sparse-track-000", tap: "post_matrix" }, destination: { kind: "output_input", outputId: "sparse-out" } });
  const frameBytes = profile.channels * (profile.bitDepth / 8);
  const packed = new Uint8Array(4 * frameBytes);
  const view = new DataView(packed.buffer);
  for (let frame = 0; frame < 4; frame++) for (let channel = 0; channel < profile.channels; channel++) {
    const sample = (frame + 1) * (channel === 0 ? 4096 : -2048);
    const offset = (frame * profile.channels + channel) * (profile.bitDepth / 8);
    if (profile.bitDepth === 16) view.setInt16(offset, sample, true);
    else { view.setUint8(offset, sample & 0xff); view.setUint8(offset + 1, (sample >> 8) & 0xff); view.setUint8(offset + 2, (sample >> 16) & 0xff); }
  }
  const descriptor = { kind: "sparse-pcm" as const, data: new Blob([packed]), index: {
    format: "miso_sparse_pcm_v1" as const, identity: sparseIdentity, sampleRateHz: profile.sampleRateHz,
    channels: profile.channels, bitDepth: profile.bitDepth, frames: sparseFrames,
    intervals: [{ startFrame: 2, frames: 2, byteOffset: 0 }, { startFrame: 200, frames: 2, byteOffset: 2 * frameBytes }],
  } };
  let reads = 0;
  let leaseClosed = 0;
  const lease = {
    leaseId: "packed-sparse", sources: [],
    async read(identity: string) { if (identity !== sparseIdentity) throw new Error("unexpected sparse identity"); reads += 1; return descriptor; },
    async close() { leaseClosed += 1; },
  };
  const store = { async openSession(options: any) { return { ...lease, sources: options.sources }; } };
  const engine = await openSparseEngineWebSession({
    document: sparseDocument, store,
    spectrumCollection: {
      entries: [
        { target: { kind: "trackPostMatrix", trackId: "sparse-track-000" }, channels: "both" },
        { target: { kind: "output", outputId: "sparse-out" }, channels: "both" },
      ],
      // The budget covers both prepared capture owners and their queues, not only FFT input bytes.
      maximumCaptureBytes: 1_048_576,
    },
    responseSubscriptionLimits: { maximumHandles: 2, maximumJobs: 2 },
    spectrumSubscriptionLimits: { maximumHandles: 2 },
    createPump: async ({ lease: receivedLease, sources, signal }) => PcmPumpWorkerClient.createSparse({
      lease: receivedLease, sources, signal, windowFrames: sparseFrames,
    }),
  });
  const sdk = engine.engine;
  const meterUpdates: any[] = [];
  const stopMeters = await sdk.subscribeMeters((update: any) => meterUpdates.push(update));
  const response = await sdk.subscribeTrackResponse({
    trackId: "sparse-track-000",
    grid: { kind: "linear", points: 16, minimumHz: 20, maximumHz: 20_000 },
    channels: "both",
    cadenceMs: 50,
  });
  const spectrum = await sdk.subscribeSpectrum({
    target: { kind: "output", outputId: "sparse-out" },
    channels: "both",
    cadenceMs: 50,
  });
  const waitForSpectrum = async (kind: "output" | "trackPostMatrix", afterSample: bigint) => {
    const deadline = performance.now() + 3_000;
    while (performance.now() < deadline) {
      await spectrum.pump();
      const result = spectrum.readLatest();
      if (result?.target.kind === kind && result.endSample > afterSample) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("packed spectrum did not deliver a fresh " + kind + " frame before its deadline");
  };
  let proof: any;
  try {
    await engine.play();
    await engine.seekFrames(200);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await response.pump();
    const initialSpectrum = await waitForSpectrum("output", 0n);
    const responseResult = response.readLatest();
    if (meterUpdates.length === 0 || responseResult?.trackId !== "sparse-track-000"
      || responseResult.frequenciesHz.length !== 16 || initialSpectrum?.target.kind !== "output"
      || initialSpectrum.target.outputId !== "sparse-out" || initialSpectrum.binCount === 0) {
      throw new Error("packed SDK measurements did not deliver the prepared response and output spectrum");
    }
    const responseReady = true;
    const spectrumReady = true;
    const priorTarget = spectrum.configuration.target;
    const selected = await spectrum.update({
      target: { kind: "trackPostMatrix", trackId: "sparse-track-000" },
      channels: "both",
      cadenceMs: 50,
    });
    if (selected.configuration.target.kind !== "trackPostMatrix" || engine.state !== "playing") {
      throw new Error("managed spectrum target switch did not preserve the running session");
    }
    const switchedSpectrum = await waitForSpectrum("trackPostMatrix", initialSpectrum.endSample);
    if (switchedSpectrum?.target.kind !== "trackPostMatrix" || switchedSpectrum.target.trackId !== "sparse-track-000"
      || switchedSpectrum.endSample <= initialSpectrum.endSample || engine.context.state !== "running") {
      throw new Error("managed spectrum selection did not deliver a fresh track frame while running");
    }
    const selectedJob = spectrum.job;
    let refused = false;
    try {
      await spectrum.update({ target: { kind: "output", outputId: "missing-output" }, channels: "both", cadenceMs: 50 });
    } catch { refused = true; }
    if (!refused || spectrum.configuration.target.kind !== "trackPostMatrix") {
      throw new Error("refused spectrum target did not preserve the active stream");
    }
    const retainedSpectrum = await waitForSpectrum("trackPostMatrix", switchedSpectrum.endSample);
    if (spectrum.job !== selectedJob || retainedSpectrum?.target.kind !== "trackPostMatrix"
      || retainedSpectrum.target.trackId !== "sparse-track-000" || retainedSpectrum.endSample <= switchedSpectrum.endSample
      || engine.state !== "playing" || engine.context.state !== "running") {
      throw new Error(JSON.stringify({ message: "refused spectrum selection did not preserve fresh delivery from the running track stream", job: String(spectrum.job), selectedJob: String(selectedJob), target: retainedSpectrum?.target, priorSample: String(switchedSpectrum.endSample), retainedSample: String(retainedSpectrum?.endSample), state: engine.state, context: engine.context.state }));
    }
    await engine.pause();
    proof = {
      stateBeforeClose: engine.state,
      reads,
      leaseClosed,
      meterUpdates: meterUpdates.length,
      responseReady,
      spectrumReady,
      initialSpectrumTarget: priorTarget,
      selectedSpectrumTarget: spectrum.configuration.target,
      responseConfiguration: response.configuration,
      spectrumSamples: [initialSpectrum.endSample, switchedSpectrum.endSample, retainedSpectrum.endSample].map(String),
    };
  } finally {
    await response.close().catch(() => {});
    await spectrum.close().catch(() => {});
    stopMeters();
    await engine.close();
  }
  const closedMeterCount = meterUpdates.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (meterUpdates.length !== closedMeterCount) throw new Error("SDK meters delivered after aggregate close");
  if (engine.state !== "closed" || reads !== 1 || leaseClosed !== 1) throw new Error("packed sparse session lifecycle did not settle exactly once");
  return { ...proof, state: engine.state, reads, leaseClosed };
}
try {
  const coldIngest = createIngestDiagnostics();
  const warmIngest = createIngestDiagnostics();
  const cold = await open({ leaseId: "cold", ingestDiagnostics: coldIngest });
  const initialDiagnostics = cold.feedDiagnostics();
  const sourceObservation = cold.observeSource(source.id);
  const observedChunks = sourceObservation.pull((chunk) => {
    if (chunk.frames < 1 || chunk.frames > 128 || chunk.planes.length !== profile.channels) throw new Error("invalid source observation");
  }, 1);
  if (observedChunks !== 1 || sourceObservation.sampleRateHz !== profile.sampleRateHz || sourceObservation.channels !== profile.channels) throw new Error("source observation did not map the compiled source");
  const scratchBytes = profile.channels * 128 * Float32Array.BYTES_PER_ELEMENT;
  const allocation = cold.feedDiagnostics().allocation;
  if (initialDiagnostics.allocation.observationBytes !== scratchBytes || allocation.observationBytes !== 2 * scratchBytes ||
      allocation.ringBytes !== rings.reduce((sum, ring) => sum + ring.byteLength, 0) || allocation.engineMemoryBytes !== cold.host.memoryBytes ||
      allocation.pump?.windowFrames !== 8192 || allocation.pump.maximumWindowBytes !== 2 * 8192 * profile.channels * profile.bitDepth / 8) throw new Error("incorrect buffer projection");
  await cold.play();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await cold.pause();
  if (cold.state !== "paused") throw new Error("cold pause did not settle");
  await cold.seekFrames(3);
  await cold.play();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await cold.pause();
  sourceObservation.pull(() => undefined, 1);
  const counters = cold.feedDiagnostics().sources[0];
  await cold.close();
  const coldClosed = cold.state === "closed";
  if (sourceObservation.pull(() => { throw new Error("closed observation delivered PCM"); }) !== 0) throw new Error("observer survived session close");
  const sparseWorker = await exerciseSparseWorker(rings[0]!);
  const sparseSession = await exerciseSparseSession();
  const coldLocatorCalls = locatorCalls;
  const coldFlacWorkers = flacWorkers;
  const coldNetworkRequests = networkRequests;
  const warm = await open({ leaseId: "warm", ingestDiagnostics: warmIngest });
  await warm.play(); await new Promise((resolve) => setTimeout(resolve, 50));
  const consoleFirst = await exerciseControl(warm, true);
  await warm.pause(); await warm.close();
  const warmClosed = warm.state === "closed";

  // Zero configuration: no leaseId, no sources, no policy.
  const minimal = await open();
  await minimal.play();
  const meterFirst = await exerciseControl(minimal, false);
  await minimal.close();

  const playbackOnly = await open({ leaseId: "playback-only", console: false });
  let notAttached = "";
  try { void playbackOnly.console; } catch (error) { notAttached = (error as { code?: string }).code ?? ""; }
  let meterNotAttached = "";
  try { await playbackOnly.meters(() => undefined); }
  catch (error) { meterNotAttached = (error as { code?: string }).code ?? ""; }
  await playbackOnly.close();
  const seekProofs = [await exercisePausedSeek("initial"), await exercisePausedSeek("resumed"), await exercisePausedSeek("running")];
  const terminalPumpFailures = [await exerciseTerminalPumpFailure("reject"), await exerciseTerminalPumpFailure("stall"), await exerciseTerminalPumpFailure("crash")];
  globalThis.__result = {
    coldProcessing: coldIngest.snapshot().processing, warmProcessing: warmIngest.snapshot().processing,
    coldLocatorCalls, warmLocatorCalls: locatorCalls,
    coldFlacWorkers, warmFlacWorkers: flacWorkers,
    coldNetworkRequests, warmNetworkRequests: networkRequests,
    observedRemoteBytes, observedEtag,
    observedChunks, observationBytes: allocation.observationBytes, coldClosed, warmClosed, consoleFirst, meterFirst, notAttached, meterNotAttached,
    packedBlake3Fallback,
    ...counters, seekProofs, terminalPumpFailures, sparseWorker, sparseSession,
  };
} catch (error) {
  globalThis.__error = describe(error);
}
function describe(error: unknown, depth = 0): unknown {
  if (depth > 3) return String(error);
  if (!(error instanceof Error)) {
    if (typeof error === "object" && error !== null) {
      return Object.fromEntries(Object.entries(error).map(([key, value]) => [key, describe(value, depth + 1)]));
    }
    return error;
  }
  const value = error as Error & { code?: unknown; details?: unknown; cause?: unknown };
  return { name: value.name, message: value.message, code: value.code, details: value.details, stack: value.stack, cause: value.cause === undefined ? undefined : describe(value.cause, depth + 1) };
}
`; }
