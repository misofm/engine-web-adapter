// Packed-consumer OPFS write gate. Runs in Chromium and WebKit because the
// OPFS write method the store calls differs by engine: `createWritable()` is
// Safari 26+, while `createSyncAccessHandle()` is Safari 15.2+.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const supportModules = join(process.cwd(), "node_modules");
const root = await mkdtemp(join(tmpdir(), "engine-web-adapter-opfs-"));
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
await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
await writeFile(join(consumer, "index.html"), '<div id="status">loading</div><script type="module" src="/src/main.ts"></script>\n');
await mkdir(join(consumer, "src"));
await writeFile(join(consumer, "src", "main.ts"), browserSource());
run(join(supportModules, ".bin", "vite"), ["build"], consumer);

const dist = join(consumer, "dist");
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://local").pathname;
    if (pathname === "/favicon.ico") { response.statusCode = 204; response.end(); return; }
    const path = join(dist, pathname === "/" ? "index.html" : pathname.slice(1));
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Content-Type", mimeFor(path));
    response.end(await readFile(path));
  } catch (error) { if (process.env.OPFS_GATE_DEBUG) console.error("404", request.url, String(error)); response.statusCode = 404; response.end("not found"); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");

const { chromium, webkit } = await import(pathToFileURL(join(supportModules, "playwright-core", "index.mjs")).href);
const engines = [];
const chrome = resolveChromeExecutable();
if (chrome === undefined) throw new Error("Chrome/Chromium not found; set CHROME_EXECUTABLE");
// OPFS needs a real profile directory: WebKit returns UnknownError from
// getDirectory() in an ephemeral context, so both engines run persistent.
engines.push({
  name: "chromium",
  launch: async () => chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "opfs-chromium-")), {
    executablePath: chrome, headless: true,
  }),
});
if (existsSync(webkit.executablePath())) {
  engines.push({
    name: "webkit",
    launch: async () => webkit.launchPersistentContext(await mkdtemp(join(tmpdir(), "opfs-webkit-")), { headless: true }),
  });
} else {
  throw new Error(
    "WebKit is not installed for playwright-core. Run `node node_modules/playwright-core/cli.js install webkit`. "
    + "This gate is Chromium plus WebKit by design: a Chromium-only run cannot observe the OPFS write difference.",
  );
}

const report = [];
try {
  for (const engine of engines) {
    const context = await engine.launch();
    try {
      const page = await context.newPage();
      const consoleErrors = [];
      page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
      page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await page.waitForFunction(() => globalThis.__result !== undefined || globalThis.__error !== undefined, undefined, { timeout: 60_000 });
      const outcome = await page.evaluate(() => ({ result: globalThis.__result, error: globalThis.__error }));
      const label = engine.name;
      assert.equal(outcome.error, undefined, `${label}: ${JSON.stringify({ error: outcome.error, consoleErrors })}`);
      const result = outcome.result;
      assert.equal(result.userAgentHasSafari !== undefined, true);
      assert.equal(result.windowHasFileSystemFileHandle, true, `${label}: FileSystemFileHandle must exist on the window`);
      assert.equal(result.windowHasSyncAccessHandle, false, `${label}: createSyncAccessHandle is Worker-only; a window probe cannot see it`);
      assert.equal(result.coldIngest.verified, true, `${label}: cold OPFS ingest must verify`);
      assert.equal(result.coldIngest.bytes, result.coldIngest.declaredBytes, `${label}: cold ingest byte count`);
      assert.equal(result.coldIngest.warmResolverCalls, 0, `${label}: warm reopen must not resolve again`);
      assert.equal(result.createWritableCalls, 0, `${label}: the store must never call createWritable`);
      assert.equal(result.createWritableRemoved, true, `${label}: the Safari 17/18 simulation must actually remove createWritable`);
      assert.equal(result.withoutCreateWritable.verified, true, `${label}: OPFS ingest must work with no createWritable`);
      assert.equal(result.withoutCreateWritable.bytes, result.withoutCreateWritable.declaredBytes, `${label}: byte count without createWritable`);
      assert.equal(result.capabilityRefusal.name, "EngineWebAdapterError", `${label}: capability refusal must be the typed adapter error, got ${result.capabilityRefusal.name}`);
      assert.equal(result.capabilityRefusal.code, "capability.opfs", `${label}: capability refusal code`);
      assert.equal(result.capabilityRefusal.missing, "FileSystemFileHandle", `${label}: capability refusal must name what is missing`);
      assert.ok(typeof result.capabilityRefusal.remedy === "string" && result.capabilityRefusal.remedy.length > 0, `${label}: capability refusal must carry a remedy`);
      assert.equal(result.physicalLocks.sameExistingFileReacquired, true);
      assert.equal(result.cleanup.stagingRemoved, true);
      assert.deepEqual(consoleErrors, [], `${label}: console errors`);
      report.push({
        engine: label,
        userAgent: result.userAgent,
        browserVersion: context.browser()?.version(),
        physicalLocks: result.physicalLocks,
        cleanup: result.cleanup,
        coldBytes: result.coldIngest.bytes,
        withoutCreateWritableBytes: result.withoutCreateWritable.bytes,
        createWritableWasPresent: result.createWritableWasPresent,
      });
    } finally {
      await context.close();
    }
  }
  console.log(JSON.stringify({ gate: "opfs-write", engines: report }, undefined, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function mimeFor(path) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".wasm": "application/wasm" })[extname(path)] ?? "application/octet-stream";
}
function resolveChromeExecutable() {
  const candidates = [
    process.env.CHROME_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : undefined,
  ].filter((value) => typeof value === "string");
  return candidates.find((candidate) => existsSync(candidate));
}

function browserSource() { return String.raw`
import { EngineWebAdapterError, openEngineWebSession } from "@misofm/engine-web-adapter";
import { OpfsStemStore, OpfsStorageBackend, VerifiedStemStore } from "@misofm/engine-web-adapter/stems";

declare global { var __result: unknown; var __error: unknown }

const DECLARED_BYTES = 64 * 1024;

function canonicalBytes(seed: number): Uint8Array {
  // Deterministic so the reported byte total is a real assertion, not noise.
  const bytes = new Uint8Array(DECLARED_BYTES);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + 8_192);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

async function identityOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "sha256:" + [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function ingest(folderName: string, seed: number) {
  const bytes = canonicalBytes(seed);
  const identity = await identityOf(bytes);
  const requirement = { sourceId: "source-000", identity: identity as never, bytes: bytes.length };
  const store = new OpfsStemStore({ folderName, assets: { createWorker: (url, options) => new Worker(url, options) } });
  const cold = await store.openSession({
    leaseId: "cold", stems: [requirement],
    resolver: { async resolve() { return { stream: streamOf(bytes) }; } },
  });
  const blob = await cold.read(identity as never);
  const readBack = new Uint8Array(await blob.arrayBuffer());
  let verified = readBack.length === bytes.length;
  for (let index = 0; verified && index < bytes.length; index += 1) {
    if (readBack[index] !== bytes[index]) verified = false;
  }
  await cold.close();
  let warmResolverCalls = 0;
  const warm = await store.openSession({
    leaseId: "warm", stems: [requirement],
    resolver: { async resolve() { warmResolverCalls += 1; throw new Error("warm reopen must not resolve"); } },
  });
  await warm.close();
  return { verified, bytes: readBack.length, declaredBytes: DECLARED_BYTES, warmResolverCalls };
}

function expect(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

// A separate probe has no package code or imports. It opens only existing files.
function lockProbe() {
  const source = "const held = new Map(); onmessage = async ({data: q}) => {\n    try {\n      if(q.close) { held.get(q.name).close(); held.delete(q.name); }\n      else {\n        const root = await navigator.storage.getDirectory();\n        const dir = await root.getDirectoryHandle(q.folder, {create:false});\n        const file = await dir.getFileHandle(q.name, {create:false});\n        held.set(q.name, await file.createSyncAccessHandle());\n      }\n      postMessage({id:q.id, ok:true});\n    } catch(e) { postMessage({id:q.id, ok:false, error:e.name}); }\n  };";
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new Worker(url);
  let next = 0;
  return {
    async call(folder: string, name: string, close = false): Promise<{ ok: boolean; error?: string }> {
      const id = ++next;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.removeEventListener("message", receive); reject(new Error("lock probe deadline")); }, 3_000);
        function receive(event: MessageEvent) {
          if (event.data.id !== id) return;
          clearTimeout(timer); worker.removeEventListener("message", receive); resolve(event.data);
        }
        worker.addEventListener("message", receive);
        worker.postMessage({ id, folder, name, close });
      });
    },
    close() { worker.terminate(); URL.revokeObjectURL(url); },
  };
}

function holdOpenAck() {
  let notify!: (request: { folderName: string; name: string }) => void;
  const held = new Promise<{ folderName: string; name: string }>(resolve => { notify = resolve; });
  const timedWorkers: Worker[] = [];
  let terminations = 0;
  let enabled = false;
  return {
    held,
    enable() { enabled = true; },
    get terminations() { return terminations; },
    dispose() { for (const worker of timedWorkers) worker.terminate(); },
    assets: {
      createWorker(url: string | URL, options: WorkerOptions) {
        // The package chooses its shipped URL and module options unchanged.
        expect(options.type === "module", "package selects module worker options");
        expect(String(url).includes("engine-web-opfs-worker"), "package selects shipped OPFS worker URL");
        const real = new Worker(url, options);
        const events = new EventTarget();
        let selected: { requestId: number; folderName: string; name: string } | undefined;
        real.addEventListener("message", event => {
          if (selected && event.data.type === "opfs-ok" && event.data.requestId === selected.requestId) {
            notify(selected); return;
          }
          events.dispatchEvent(new MessageEvent("message", { data: event.data }));
        });
        real.addEventListener("error", event => events.dispatchEvent(new ErrorEvent("error", { error: event.error, message: event.message })));
        real.addEventListener("messageerror", () => events.dispatchEvent(new MessageEvent("messageerror")));
        return {
          postMessage(request: { type: string; requestId: number; folderName: string; name: string }) {
            if (enabled && request.type === "write-open") {
              selected = request; enabled = false; timedWorkers.push(real);
            }
            real.postMessage(request);
          },
          terminate() {
            if (selected) terminations += 1;
            real.terminate(); // MUTATION: omit only this timed worker termination
          },
          addEventListener: events.addEventListener.bind(events),
          removeEventListener: events.removeEventListener.bind(events),
        } as unknown as Worker;
      },
    },
  };
}

async function timeoutLocks() {
  const folderName = "opfs-timeout-physical";
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle(folderName, { create: true });
  await folder.getFileHandle("owned-existing", { create: true });
  await folder.getFileHandle("sentinel", { create: true });
  const owner = lockProbe();
  const contender = lockProbe();
  const gate = holdOpenAck();
  try {
    expect((await owner.call(folderName, "sentinel")).ok, "sentinel owner acquires existing file");
    const backend = new OpfsStorageBackend({ folderName, assets: gate.assets, readDeadlineMs: 1_500 });
    await backend.open();
    gate.enable();
    let settlements = 0;
    const opening = backend.createWriter("owned-existing").then(
      () => { settlements += 1; return "unexpected-success"; },
      error => { settlements += 1; return error.name; },
    );
    const selected = await gate.held;
    expect(selected.folderName === folderName && selected.name === "owned-existing", "ACK matches exact existing file");
    expect(gate.terminations === 0, "ACK holding owner is alive before competing probe");
    const held = await contender.call(folderName, selected.name);
    expect(!held.ok && ["NoModificationAllowedError", "InvalidStateError"].includes(held.error ?? ""), "owned existing file is locked before deadline: " + JSON.stringify(held));
    expect(!(await contender.call(folderName, "sentinel")).ok, "sentinel locked before deadline");
    expect(gate.terminations === 0, "both locked probes precede owner termination");
    expect(await opening === "TimeoutError", "held open rejects with TimeoutError");
    expect(settlements === 1 && gate.terminations === 1, "one settlement and termination");
    // No deletion or create:true occurs between held-lock proof and reacquisition.
    const acquired = await contender.call(folderName, selected.name);
    expect(acquired.ok, "same existing file reacquires after timeout termination before deletion");
    await contender.call(folderName, selected.name, true);
    expect(!(await contender.call(folderName, "sentinel")).ok, "sentinel remains locked after timeout");
    await owner.call(folderName, "sentinel", true);
    expect((await contender.call(folderName, "sentinel")).ok, "sentinel acquires only after owner release");
    await contender.call(folderName, "sentinel", true);
    return { lockRefusalName: held.error, heldBeforeDeadline: true, sameExistingFileReacquired: true, sentinelPreserved: true, settlements, terminations: gate.terminations };
  } finally { gate.dispose(); owner.close(); contender.close(); }
}

async function timeoutCleanup() {
  const folderName = "opfs-timeout-cleanup";
  await ingest(folderName, 31);
  const cached = canonicalBytes(31);
  const cachedIdentity = await identityOf(cached);
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle(folderName);
  const indexBefore = await (await (await folder.getFileHandle("index.json")).getFile()).text();
  const gate = holdOpenAck();
  const backend = new OpfsStorageBackend({ folderName, assets: gate.assets, readDeadlineMs: 1_500 });
  const removalErrors: string[] = [];
  const remove = backend.remove.bind(backend);
  backend.remove = async name => {
    try { await remove(name); }
    catch (error) { removalErrors.push((error as DOMException).name); throw error; }
  };
  const store = new VerifiedStemStore({ backend, instanceId: "failed", readDeadlineMs: 1_500 });
  const bytes = canonicalBytes(32);
  const identity = await identityOf(bytes);
  try {
    await store.open();
    const foreign = await backend.createWriter("staging-foreign");
    await foreign.write(new Uint8Array([91]));
    await foreign.close();
    gate.enable();
    const outcome = store.openSession({
      leaseId: "failed", stems: [{ sourceId: "failed", identity: identity as never, bytes: bytes.length }],
      resolver: { async resolve() { return { stream: streamOf(bytes) }; } },
    }).then(() => "unexpected-success", error => error.code);
    const selected = await gate.held;
    expect(await outcome === "stem.read_deadline", "store maps timed open to stem.read_deadline");
    expect(gate.terminations === 1, "store cleanup terminated timed worker");
    let stagingPresent = true;
    try { await folder.getFileHandle(selected.name, { create: false }); }
    catch (error) { if ((error as DOMException).name === "NotFoundError") stagingPresent = false; else throw error; }
    expect(!stagingPresent, "store removes its failed staging file after release: " + removalErrors.join(","));
    const indexAfter = await (await (await folder.getFileHandle("index.json")).getFile()).text();
    expect(indexAfter === indexBefore, "valid index bytes unchanged");
    const cache = new Uint8Array(await (await (await folder.getFileHandle("sha256-" + cachedIdentity.slice(7))).getFile()).arrayBuffer());
    expect(cache.length === cached.length && cache.every((value, i) => value === cached[i]), "valid cached PCM unchanged");
    expect(!(await backend.exists("sha256-" + identity.slice(7))), "failed final absent");
    expect(!Object.hasOwn(JSON.parse(indexAfter).stems, identity), "failed index row absent");
    expect(await backend.readText("staging-foreign") === "[", "foreign staging bytes preserved");
    return { stagingRemoved: true, validBytesPreserved: true, indexPreserved: true, failedFinalAbsent: true, foreignStagingPreserved: true };
  } finally { backend.close(); gate.dispose(); }
}

function refusalScope(fileHandle: unknown) {
  return {
    crossOriginIsolated: true,
    SharedArrayBuffer,
    Worker: class { } as unknown as typeof Worker,
    AudioContext: class { } as unknown as typeof AudioContext,
    AudioWorkletNode: class { } as unknown as typeof AudioWorkletNode,
    WebAssembly: { validate: () => true },
    navigator: { storage: { getDirectory() { } }, locks: { request() { } } },
    FileSystemFileHandle: fileHandle,
  };
}

function chain(error: unknown, depth = 0): unknown {
  if (depth > 4 || !(error instanceof Error)) return String(error);
  const value = error as Error & { code?: unknown; details?: unknown; cause?: unknown };
  return {
    name: value.name, message: value.message, code: value.code, details: value.details,
    stack: value.stack, cause: value.cause === undefined ? undefined : chain(value.cause, depth + 1),
  };
}

function describe(error: unknown): Record<string, unknown> {
  if (error instanceof EngineWebAdapterError) {
    const cause = (error as { cause?: unknown }).cause;
    return {
      name: error.name, code: error.code, message: error.message,
      missing: error.details["missing"], remedy: error.details["remedy"],
      cause: cause instanceof Error ? cause.name + ": " + cause.message : cause === undefined ? undefined : String(cause),
    };
  }
  return { name: error instanceof Error ? error.name : String(error), message: String(error) };
}

try {
  const prototype = FileSystemFileHandle.prototype as unknown as Record<string, unknown>;
  const syncAccessHandleAvailable = typeof prototype["createSyncAccessHandle"] === "function";
  const createWritableWasPresent = typeof prototype["createWritable"] === "function";
  let createWritableCalls = 0;
  if (createWritableWasPresent) {
    const original = prototype["createWritable"] as (...args: unknown[]) => unknown;
    prototype["createWritable"] = function patched(this: unknown, ...args: unknown[]) {
      createWritableCalls += 1;
      return original.apply(this, args);
    };
  }

  const coldIngest = await ingest("opfs-gate-present-v1", 1);

  // Safari 17/18 shape: OPFS is present, createWritable is not.
  delete prototype["createWritable"];
  const createWritableRemoved = typeof prototype["createWritable"] !== "function";
  const withoutCreateWritable = await ingest("opfs-gate-absent-v1", 2);

  const physicalLocks = await timeoutLocks();
  const cleanup = await timeoutCleanup();

  // A browser with no OPFS handles must refuse at the synchronous capability
  // boundary with the typed error, not an untyped TypeError from the store.
  let capabilityRefusal: Record<string, unknown> = { name: "none" };
  try {
    await openEngineWebSession({
      document: undefined, leaseId: "refused", sources: [],
      resolver: { async resolve() { throw new Error("unreachable"); } },
      capabilityScope: refusalScope(undefined),
    } as never);
  } catch (error) { capabilityRefusal = describe(error); }

  globalThis.__result = {
    userAgent: navigator.userAgent,
    userAgentHasSafari: navigator.userAgent.includes("Safari"),
    windowHasFileSystemFileHandle: typeof FileSystemFileHandle === "function",
    windowHasSyncAccessHandle: syncAccessHandleAvailable,
    createWritableWasPresent, createWritableCalls,
    createWritableRemoved, coldIngest, withoutCreateWritable,
    capabilityRefusal, physicalLocks, cleanup,
  };
} catch (error) {
  globalThis.__error = chain(error);
}
`; }
