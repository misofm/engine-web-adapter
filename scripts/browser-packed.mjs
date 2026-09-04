import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const supportModules = join(process.cwd(), "node_modules");
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
await cp(join(process.cwd(), "tests", "fixtures", "dense-silence.flac"), join(consumer, "public", "dense-silence.flac"));
await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
await writeFile(join(consumer, "index.html"), '<div id="status">loading</div><script type="module" src="/src/main.ts"></script>\n');
await mkdir(join(consumer, "src"));
await writeFile(join(consumer, "src", "main.ts"), browserSource());
await writeFile(join(consumer, "consumer-check.ts"), `
import { openEngineWebSession } from "@misofm/engine-web-adapter";
import { createFlacStemResolver, PcmPumpWorkerClient } from "@misofm/engine-web-adapter/stems";
import { ADAPTER_ASSETS } from "@misofm/engine-web-adapter/assets";
import packageJson from "@misofm/engine-web-adapter/package.json" with { type: "json" };
void [openEngineWebSession, createFlacStemResolver, PcmPumpWorkerClient, ADAPTER_ASSETS, packageJson];
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
    if (pathname === "/dense-silence.flac") {
      const bytes = await readFile(join(dist, "dense-silence.flac"));
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
      response.setHeader("ETag", '"dense-silence-v1"');
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
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  await page.waitForFunction(() => globalThis.__result !== undefined || globalThis.__error !== undefined, undefined, { timeout: 30_000 });
  const result = await page.evaluate(() => ({ result: globalThis.__result, error: globalThis.__error }));
  assert.equal(result.error, undefined, JSON.stringify({ error: result.error, consoleErrors, requests: [...requests.entries()] }));
  assert.ok(result.result?.coldLocatorCalls > 0, "cold FLAC open must locate exact ranges");
  assert.equal(result.result?.warmLocatorCalls, result.result?.coldLocatorCalls, "warm open must make zero locator calls");
  assert.equal(result.result?.coldFlacWorkers, 1, "cold open must construct one FLAC Worker");
  assert.equal(result.result?.warmFlacWorkers, result.result?.coldFlacWorkers, "warm open must construct zero FLAC Workers");
  assert.equal(flacRangeRequests, result.result?.coldLocatorCalls, "every physical locator attempt must be one 206 request");
  assert.ok(result.result?.submitted > 0, "Engine worklet must consume PCM");
  assert.ok(result.result?.seeksApplied > 0, "unaligned seek must reach the Engine worklet");
  assert.equal(result.result?.refused, 0);
  assert.equal(result.result?.torn, 0);
  assert.equal(result.result?.errors, 0);
  assert.equal(result.result?.coldClosed, true);
  assert.equal(result.result?.warmClosed, true);
  assert.deepEqual(consoleErrors, []);
  const requested = [...requests.entries()];
  assert.ok(requested.some(([path, mime]) => path.endsWith(".wasm") && mime === "application/wasm"), "Wasm asset/MIME not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("scratch-worker") && mime.includes("javascript")), "scratch Worker asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("flac-worker") && mime.includes("javascript")), "FLAC Worker asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("pcm-pump-worker") && mime.includes("javascript")), "pump Worker asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("feed-worklet") && mime.includes("javascript")), "feed worklet asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("audio-worklet-host") && mime.includes("javascript")), "Engine host asset not observed");
  assert.ok(requested.some(([path, mime]) => path.includes("audio-worklet-") && !path.includes("host") && mime.includes("javascript")), "Engine worklet asset not observed");
  console.log(JSON.stringify({ ...result.result, assets: requested.filter(([path]) => /\.(?:js|wasm)$/u.test(path)).length, root }));
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

function browserSource() { return String.raw`
import { session } from "@misofm/engine";
import { openEngineWebSession } from "@misofm/engine-web-adapter";
import { MSB1_CONTROL, PcmPumpWorkerClient } from "@misofm/engine-web-adapter/stems";
import { ADAPTER_ASSETS } from "@misofm/engine-web-adapter/assets";

declare global { var __result: unknown; var __error: unknown }
const frames = 2048;
void ADAPTER_ASSETS;
const identity = "sha256:ad7facb2586fc6e966c004d7d1d16b024f5805ff7cb47c7a85dabd8b48892ca7";
const source = { id: "source-000", spec: { channels: 1 as const, bitDepth: 16 as const, frames, content: identity as any } };
const document = session({ id: "packed-browser", sampleRateHz: 48000, quantumFrames: 128 })
  .source(source.id, source.spec)
  .track("track-000", { source: { id: source.id, left: 0, right: 0 } })
  .output("main-out")
  .route({
    id: "route-000", source: { kind: "track", trackId: "track-000", tap: "post_matrix" },
    destination: { kind: "output_input", outputId: "main-out" },
  });
let locatorCalls = 0;
let flacWorkers = 0;
const NativeWorker = Worker;
globalThis.Worker = class ObservedWorker extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    if (String(url).includes("flac-worker")) flacWorkers += 1;
    super(url, options);
  }
} as typeof Worker;
let rings: readonly SharedArrayBuffer[] = [];
async function open(leaseId: string) {
  return openEngineWebSession({
    document, leaseId, sources: [source],
    flac: { locate(requested) {
      if (requested !== identity) throw new Error("unexpected identity");
      locatorCalls += 1;
      return "/dense-silence.flac";
    } },
    createPump: async (options) => {
      rings = options.sources.map((item) => item.ring);
      return PcmPumpWorkerClient.create(options);
    },
  });
}
try {
  const cold = await open("cold");
  await cold.play();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await cold.pause();
  if (cold.state !== "paused") throw new Error("cold pause did not settle");
  await cold.seekFrames(3);
  await cold.play();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await cold.pause();
  const control = new Int32Array(rings[0]);
  const counters = {
    submitted: Atomics.load(control, MSB1_CONTROL.SUBMITTED),
    seeksApplied: Atomics.load(control, MSB1_CONTROL.SEEKS_APPLIED),
    refused: Atomics.load(control, MSB1_CONTROL.REFUSED),
    torn: Atomics.load(control, MSB1_CONTROL.TORN),
    errors: Atomics.load(control, MSB1_CONTROL.ERRORS),
  };
  await cold.close();
  const coldClosed = cold.state === "closed";
  const coldLocatorCalls = locatorCalls;
  const coldFlacWorkers = flacWorkers;
  const warm = await open("warm");
  await warm.play(); await new Promise((resolve) => setTimeout(resolve, 50)); await warm.pause(); await warm.close();
  const warmClosed = warm.state === "closed";
  globalThis.__result = {
    coldLocatorCalls, warmLocatorCalls: locatorCalls,
    coldFlacWorkers, warmFlacWorkers: flacWorkers,
    coldClosed, warmClosed, ...counters,
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
