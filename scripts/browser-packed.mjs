import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const profile = live ? {
  name: "live",
  url: "https://stems.miso.fm/ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1.flac",
  identity: "sha256:ba8f39a6c7b1f22bded6ce6d97361a01ce751282b3f1ab08f931b876c6734ae1",
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
  identity: "sha256:ad7facb2586fc6e966c004d7d1d16b024f5805ff7cb47c7a85dabd8b48892ca7",
  sampleRateHz: 48_000,
  channels: 1,
  bitDepth: 16,
  frames: 2_048,
  canonicalBytes: 4_096,
  remoteBytes: 206,
  etag: '"native-silence-v1"',
};
const indexedFixture = indexedSparse ? await prepareIndexedFixture() : undefined;
const chrome = resolveChromeExecutable();
const root = await mkdtemp(join(tmpdir(), "engine-web-adapter-browser-"));
process.env.npm_config_cache = join(root, "npm-cache");
const consumer = join(root, "consumer");
await mkdir(join(consumer, "node_modules", "@misofm"), { recursive: true });
const packed = run("npm", ["pack", "--json", "--pack-destination", root], process.cwd());
const tarball = join(root, JSON.parse(packed)[0].filename);
run("tar", ["-xzf", tarball, "-C", join(consumer, "node_modules", "@misofm")]);
await rename(join(consumer, "node_modules", "@misofm", "package"), join(consumer, "node_modules", "@misofm", "engine-web-adapter"));
await cp(join(process.cwd(), "node_modules", "@misofm", "engine"), join(consumer, "node_modules", "@misofm", "engine"), { recursive: true });
await cp(join(process.cwd(), "node_modules", "effect"), join(consumer, "node_modules", "effect"), { recursive: true });
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
await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
await writeFile(join(consumer, "index.html"), '<div id="status">loading</div><script type="module" src="/src/main.ts"></script>\n');
await mkdir(join(consumer, "src"));
await writeFile(join(consumer, "src", "main.ts"), indexedSparse
  ? indexedBrowserSource(indexedFixture.profile)
  : browserSource(profile));
await writeFile(join(consumer, "consumer-check.ts"), `
import { EngineWebAdapterError, openEngineWebSession, openSparseEngineWebSession } from "@misofm/engine-web-adapter";
import type {
  EngineWebConsole, EngineWebSession, EngineWebSessionOptions, SparseEngineWebSessionOptions, SourceObservation, FeedDiagnostics, MeterUpdate, TelemetryUpdate, TrackMeter,
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
declare const update: MeterUpdate;
const peak: TrackMeter | undefined = update.tracks.get("track-000");
declare const failure: EngineWebAdapterError;
const remedy: string = failure.remedy;
const transient: boolean = failure.transient;
void [openEngineWebSession, openSparseEngineWebSession, createFlacStemResolver, PcmPumpWorkerClient, ADAPTER_ASSETS, packageJson,
  minimal, sparseMinimal, live, meters, telemetry, peak, remedy, transient];
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
let flacRangeRequests = 0;
const dist = join(consumer, "dist");
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://local").pathname;
    if (pathname === "/favicon.ico") { response.statusCode = 204; response.end(); return; }
    if (indexedSparse && pathname === indexedFixture.profile.url) {
      if (request.method !== "GET" || request.headers.range !== undefined) { response.statusCode = 400; response.end("indexed delivery requires one full GET"); return; }
      requests.set(pathname, "application/octet-stream");
      response.statusCode = 200;
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", String(indexedFixture.body.byteLength));
      response.setHeader("ETag", indexedFixture.profile.etag);
      response.end(indexedFixture.body);
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
    const path = join(dist, relative);
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
const { chromium } = await import(pathToFileURL(join(supportModules, "playwright-core", "index.mjs")).href);
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
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
    assertIndexedResult(result.result, indexedFixture.profile, requests, consoleErrors, address.port);
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
  const requested = [...requests.entries()];
  assert.ok(requested.some(([path, mime]) => path.includes("engine-web-flac-decoder") && path.endsWith(".wasm") && mime === "application/wasm"), "decoder Wasm asset/MIME not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("miso-engine") && path.endsWith(".wasm") && mime === "application/wasm"), "Engine Wasm asset/MIME not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("scratch-worker") && mime.includes("javascript")), "scratch Worker asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("flac-worker") && mime.includes("javascript")), "FLAC Worker asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("pcm-pump-worker") && mime.includes("javascript")), "pump Worker asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("feed-worklet") && mime.includes("javascript")), "feed worklet asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("audio-worklet-host") && mime.includes("javascript")), "Engine host asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("audio-worklet-") && !path.includes("host") && mime.includes("javascript")), "Engine worklet asset not observed");
  console.log(JSON.stringify({ profile: profile.name, origin: `http://127.0.0.1:${address.port}`, ...result.result,
    assets: requested.filter(([path]) => /\.(?:js|wasm)$/u.test(path)).length, root }));
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function prepareIndexedFixture() {
  const fixtureDirectory = process.env.ADAPTER_71_MULTIBLOCK_DIR ?? join(process.cwd(), "tests", "fixtures");
  const fixtureFlac = "native-multiblock-stereo24.flac";
  const fixturePcm = process.env.ADAPTER_71_MULTIBLOCK_DIR === undefined ? "native-multiblock-stereo24.pcm" : "source.pcm";
  const outputDirectory = join(process.env.ADAPTER_71_EVIDENCE_DIR ?? join(process.cwd(), ".adapter-71-evidence"), "multiblock");
  await mkdir(outputDirectory, { recursive: true });
  const fixtureFlacBytes = new Uint8Array(await readFile(join(fixtureDirectory, fixtureFlac)));
  const fixturePcmBytes = new Uint8Array(await readFile(join(fixtureDirectory, fixturePcm)));
  const frameBytes = 2 * (24 / 8);
  const chunkFrames = fixturePcmBytes.byteLength / frameBytes;
  if (chunkFrames !== 72_000) throw new Error("indexed fixture is not the frozen 72000-frame stereo24 payload");
  if (sha256Hex(fixturePcmBytes) !== "4b5bc724ea7d855b3b5518b7a5e4da7222a41b9d0c98ca42880ca37e7458654d") {
    throw new Error("indexed fixture PCM SHA-256 changed");
  }
  if (sha256Hex(fixtureFlacBytes) !== "cfb6381ba955b097a8088a81d1956cb13a7d0b1c2c59a25843b832aa80a3d3cb") {
    throw new Error("indexed fixture FLAC SHA-256 changed");
  }
  const firstFlac = fixtureFlacBytes;
  const secondFlac = fixtureFlacBytes;
  const firstPcm = fixturePcmBytes;
  const secondPcm = fixturePcmBytes;
  const intervals = [
    { startFrame: 0, frames: 100_000, packedFrameOffset: 0 },
    { startFrame: 120_000, frames: 44_000, packedFrameOffset: 100_000 },
  ];
  const frames = 164_000;
  const canonical = new Uint8Array(frames * frameBytes);
  canonical.set(firstPcm, 0);
  canonical.set(secondPcm.subarray(0, 28_000 * frameBytes), 72_000 * frameBytes);
  canonical.set(secondPcm.subarray(28_000 * frameBytes), 120_000 * frameBytes);
  const identity = `sha256:${sha256Hex(canonical)}`;
  const manifest = {
    format: "miso_sparse_stem_v1",
    identity,
    sampleRateHz: 48_000,
    channels: 2,
    bitDepth: 24,
    frames,
    intervals,
    chunks: [
      { offset: 0, bytes: firstFlac.byteLength, frames: chunkFrames, packedStartFrame: 0, flacSha256: sha256Hex(firstFlac), pcmSha256: sha256Hex(firstPcm) },
      { offset: firstFlac.byteLength, bytes: secondFlac.byteLength, frames: chunkFrames, packedStartFrame: chunkFrames, flacSha256: sha256Hex(secondFlac), pcmSha256: sha256Hex(secondPcm) },
    ],
  };
  const encodedManifest = Buffer.from(canonicalJson(manifest));
  const header = Buffer.alloc(16);
  Buffer.from("MISOSTM1").copy(header, 0);
  header.writeUInt32LE(encodedManifest.byteLength, 8);
  const body = Buffer.concat([header, encodedManifest, Buffer.from(firstFlac), Buffer.from(secondFlac)]);
  await writeFile(join(outputDirectory, "sparse-package.bin"), body);
  return {
    body,
    profile: {
      name: "indexed-multiblock",
      url: "/native-multiblock.sparse",
      etag: '"adapter-71-multiblock-v1"',
      expected: { identity, sampleRateHz: 48_000, channels: 2, bitDepth: 24, frames, canonicalBytes: canonical.byteLength },
      activeBytes: 144_000 * frameBytes,
      canonicalPcmSha256: identity.slice(7),
      intervals: intervals.map((interval) => ({ startFrame: interval.startFrame, frames: interval.frames, byteOffset: interval.packedFrameOffset * frameBytes })),
      chunks: manifest.chunks.map((chunk) => ({ frames: chunk.frames, bytes: chunk.bytes, packedStartFrame: chunk.packedStartFrame })),
    },
  };
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

function assertIndexedResult(raw, profile, requests, consoleErrors, port) {
  assert.equal(raw?.locateCalls, 1, "indexed cold install must locate once");
  assert.equal(raw?.networkRequests, 1, "indexed cold install must make one full GET");
  assert.equal(raw?.flacWorkers, profile.chunks.length, "indexed install must decode both FLAC chunks");
  assert.ok((raw?.spanCount ?? 0) > 4, "indexed mapper did not emit multiple bounded spans");
  assert.equal(raw?.coldDataBytes, profile.activeBytes, "indexed cold payload size changed");
  assert.deepEqual(raw?.coldIntervals, profile.intervals, "indexed cold interval mapping changed");
  assert.equal(raw?.coldIdentity, profile.expected.identity, "indexed cold canonical identity changed");
  assert.equal(raw?.coldCanonicalBytes, profile.expected.canonicalBytes, "indexed cold canonical extent changed");
  assert.equal(raw?.warmDataBytes, profile.activeBytes, "indexed warm payload size changed");
  assert.equal(raw?.warmLocateCalls, 1, "indexed warm install reacquired the locator");
  assert.equal(raw?.warmNetworkRequests, 1, "indexed warm install made a network request");
  assert.equal(raw?.warmFlacWorkers, profile.chunks.length, "indexed warm install created a decoder worker");
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual([...requests.entries()].filter(([path]) => path === profile.url), [[profile.url, "application/octet-stream"]]);
  console.log(JSON.stringify({ profile: profile.name, origin: `http://127.0.0.1:${port}`,
    mapping: { chunks: profile.chunks, intervals: profile.intervals, spans: raw?.spanCount },
    canonical: { identity: profile.expected.identity, frames: profile.expected.frames, bytes: profile.expected.canonicalBytes },
    ...raw, requests: [...requests.entries()] }));
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

function indexedBrowserSource(profile) { return String.raw`
import { createSparseStemResolver, OpfsStorageBackend, VerifiedSparsePcmStore } from "@misofm/engine-web-adapter/stems";

declare global { var __result: unknown; var __error: unknown }
const profile = ${JSON.stringify(profile)} as const;
const assetUrl = new URL(profile.url, location.href).href;
const NativeFetch = globalThis.fetch;
const NativeWorker = Worker;
let locateCalls = 0;
let networkRequests = 0;
let flacWorkers = 0;
let opfsWorkers = 0;
let spanCount = 0;
const workerErrors: Array<{ readonly worker: string; readonly message: string | undefined; readonly filename?: string; readonly line?: number; readonly column?: number; readonly error?: string }> = [];
globalThis.Worker = class ObservedWorker extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    const label = String(url);
    if (label.includes("flac-worker")) flacWorkers += 1;
    if (label.includes("opfs-worker")) opfsWorkers += 1;
    this.addEventListener("error", (event) => workerErrors.push({ worker: label, message: event.message,
      filename: event.filename, line: event.lineno, column: event.colno, error: event.error?.message }));
  }
} as typeof Worker;
const fetchPackage: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : new URL(input, location.href).href;
  if (url === assetUrl) networkRequests += 1;
  return NativeFetch(input, init);
};
const resolver = createSparseStemResolver({
  locate(identity) {
    if (identity !== profile.expected.identity) throw new Error("indexed locator received an unexpected identity");
    locateCalls += 1;
    return assetUrl;
  },
  fetch: fetchPackage,
  readDeadlineMs: 30_000,
  maximumWorkers: 1,
});
const backend = new OpfsStorageBackend({
  folderName: "adapter71-indexed-multiblock-" + Date.now(),
});
const store = new VerifiedSparsePcmStore({ backend, instanceId: "indexed-multiblock" });
const expected = profile.expected;
let result: unknown;
let failure: unknown;
let failed = false;
try {
  const cold = await store.installSource(expected, {
    resolve: async (signal) => {
      const resolved = await resolver(expected, signal);
      return { ...resolved, spans: (async function*() {
        for await (const span of resolved.spans) { spanCount += 1; yield span; }
      })() };
    },
  });
  const coldLocateCalls = locateCalls;
  const coldNetworkRequests = networkRequests;
  const coldFlacWorkers = flacWorkers;
  const warm = await store.installSource(expected, {
    resolve: async () => { throw new Error("indexed warm install must not resolve"); },
  });
  result = {
    coldDataBytes: cold.data.size,
    coldIntervals: cold.index.intervals,
    coldIdentity: cold.index.identity,
    coldCanonicalBytes: cold.index.canonicalBytes,
    warmDataBytes: warm.data.size,
    warmLocateCalls: locateCalls,
    warmNetworkRequests: networkRequests,
    warmFlacWorkers: flacWorkers,
    locateCalls: coldLocateCalls,
    networkRequests: coldNetworkRequests,
    flacWorkers: coldFlacWorkers,
    opfsWorkers,
    spanCount,
    workerErrors,
  };
} catch (error) {
  failed = true;
  failure = error;
}
try {
  await store.close();
} catch (error) {
  failed = true;
  failure ??= error;
}
try {
  backend.close();
} catch (error) {
  failed = true;
  failure ??= error;
}
if (failed) {
  globalThis.__error = { error: describe(failure), workerErrors };
} else {
  globalThis.__result = result;
}
function describe(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error);
  const value = error as Error & { code?: unknown; details?: unknown; cause?: unknown };
  return { name: value.name, message: value.message, code: value.code, details: value.details, stack: value.stack,
    cause: value.cause === undefined ? undefined : describe(value.cause) };
}
`; }

function browserSource(profile) { return String.raw`
import { session } from "@misofm/engine";
import { createIngestDiagnostics, openEngineWebSession, openSparseEngineWebSession } from "@misofm/engine-web-adapter";
import { MSB1_CONTROL, PcmPumpWorkerClient } from "@misofm/engine-web-adapter/stems";
import { ADAPTER_ASSETS } from "@misofm/engine-web-adapter/assets";

declare global { var __result: unknown; var __error: unknown; var __seekStage: unknown }
const profile = ${JSON.stringify(profile)} as const;
void ADAPTER_ASSETS;
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
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pcm))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const model = session({ id: "seek-proof", sampleRateHz: 48_000, quantumFrames: 128 })
    .source("seek-source", { channels: 2, bitDepth: 16, frames, content: ("sha256:" + digest) as any })
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
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pcm))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const model = session({ id: "terminal-pump-" + mode, sampleRateHz: 48_000, quantumFrames: 128 })
    .source("terminal-source", { channels: 1, bitDepth: 16, frames, content: ("sha256:" + digest) as any })
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
  const identity = ("sha256:" + "3".repeat(64)) as any;
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
  const sparseIdentity = ("sha256:" + "4".repeat(64)) as any;
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
    document: sparseDocument, console: false, store,
    createPump: async ({ lease: receivedLease, sources, signal }) => PcmPumpWorkerClient.createSparse({
      lease: receivedLease, sources, signal, windowFrames: sparseFrames,
    }),
  });
  await engine.play();
  await engine.seekFrames(200);
  await engine.pause();
  await engine.close();
  if (engine.state !== "closed" || reads !== 1 || leaseClosed !== 1) throw new Error("packed sparse session lifecycle did not settle exactly once");
  return { state: engine.state, reads, leaseClosed };
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
