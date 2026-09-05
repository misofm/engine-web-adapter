import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const supportModules = join(process.cwd(), "node_modules");
const live = process.argv.includes("--live");
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
await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
await writeFile(join(consumer, "index.html"), '<div id="status">loading</div><script type="module" src="/src/main.ts"></script>\n');
await mkdir(join(consumer, "src"));
await writeFile(join(consumer, "src", "main.ts"), browserSource(profile));
await writeFile(join(consumer, "consumer-check.ts"), `
import { EngineWebAdapterError, openEngineWebSession } from "@misofm/engine-web-adapter";
import type {
  EngineWebConsole, EngineWebSession, EngineWebSessionOptions, SourceObservation, FeedDiagnostics, MeterUpdate, TelemetryUpdate, TrackMeter,
} from "@misofm/engine-web-adapter";
import { createFlacStemResolver, PcmPumpWorkerClient } from "@misofm/engine-web-adapter/stems";
import { ADAPTER_ASSETS } from "@misofm/engine-web-adapter/assets";
import packageJson from "@misofm/engine-web-adapter/package.json" with { type: "json" };

// The documented zero-configuration open: a document and a locator, nothing else.
const minimal: EngineWebSessionOptions = {
  document: "{}",
  flac: { locate: () => "https://caller.invalid/stem.flac" },
};
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
void [openEngineWebSession, createFlacStemResolver, PcmPumpWorkerClient, ADAPTER_ASSETS, packageJson,
  minimal, live, meters, telemetry, peak, remedy, transient];
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
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(
    () => globalThis.__result !== undefined || globalThis.__error !== undefined,
    undefined,
    { timeout: live ? 180_000 : 30_000 },
  ).catch(async (error) => {
    throw new Error(JSON.stringify({ message: error.message, seekStage: await page.evaluate(() => globalThis.__seekStage),
      consoleErrors, requests: [...requests.entries()] }));
  });
  const result = await page.evaluate(() => ({ result: globalThis.__result, error: globalThis.__error }));
  assert.equal(result.error, undefined, JSON.stringify({ error: result.error, consoleErrors, requests: [...requests.entries()] }));
  assert.ok(result.result?.coldLocatorCalls > 0, "cold FLAC open must locate exact ranges");
  assert.equal(result.result?.warmLocatorCalls, result.result?.coldLocatorCalls, "warm open must make zero locator calls");
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
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
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

function browserSource(profile) { return String.raw`
import { session } from "@misofm/engine";
import { openEngineWebSession } from "@misofm/engine-web-adapter";
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
    flac: { locate(requested) {
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
    context.resume = async () => {
      resumeCalls++;
      if (mode === "running") {
        const observation = engine.observeSource("seek-source");
        try {
          if (observation.pull((chunk) => {
            if (chunk.generation !== 2n || chunk.startFrame !== 10_000n) throw new Error("automatic resume preceded target PCM");
          }, 1) !== 1) throw new Error("automatic resume preceded prefill");
        } finally { observation.close(); }
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
    if (mode !== "running") { prepared = await readPreparation(); capture = captureNext(); }
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
try {
  const cold = await open({ leaseId: "cold" });
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
      allocation.pump?.windowFrames !== 4096 || allocation.pump.maximumWindowBytes !== 4096 * profile.channels * profile.bitDepth / 8) throw new Error("incorrect buffer projection");
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
  const coldLocatorCalls = locatorCalls;
  const coldFlacWorkers = flacWorkers;
  const coldNetworkRequests = networkRequests;
  const warm = await open({ leaseId: "warm" });
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
  globalThis.__result = {
    coldLocatorCalls, warmLocatorCalls: locatorCalls,
    coldFlacWorkers, warmFlacWorkers: flacWorkers,
    coldNetworkRequests, warmNetworkRequests: networkRequests,
    observedRemoteBytes, observedEtag,
    observedChunks, observationBytes: allocation.observationBytes, coldClosed, warmClosed, consoleFirst, meterFirst, notAttached, meterNotAttached,
    ...counters, seekProofs,
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
