import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BoundedStemAdmission } from "../src/stems/flac-admission.js";
import { FlacWorkerPool } from "../src/stems/flac-worker-pool.js";
import type { FlacWorkerLike, FlacWorkerRequest, FlacWorkerResponse } from "../src/stems/flac-worker-protocol.js";

class ResetWorker implements FlacWorkerLike {
  readonly messages: FlacWorkerRequest[] = [];
  terminated = false;
  #listeners = new Map<string, Set<(event: any) => void>>();

  postMessage(message: FlacWorkerRequest): void {
    if (this.terminated) return;
    this.messages.push(message);
  }

  terminate(): void { this.terminated = true; }

  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(message: FlacWorkerResponse): void {
    for (const listener of this.#listeners.get("message") ?? []) listener({ data: message });
  }
}

function reset(worker: ResetWorker, requestId: number): void {
  worker.emit({ type: "complete", requestId, pcmBytes: 0, frames: 0, reset: true });
}

test("a privately retained pool reuses only a reset worker and closes at the final epoch lease", async () => {
  const workers: ResetWorker[] = [];
  const pool = new FlacWorkerPool({
    hardwareConcurrency: 2,
    createWorker: () => { const worker = new ResetWorker(); workers.push(worker); return worker; },
  });
  const epoch = pool.retain();
  let released = 0;
  const run = (requestId: number) => pool.run({
    requestId,
    work: async (worker) => { reset(worker as ResetWorker, requestId); return requestId; },
    onReleased: () => { released += 1; },
  });

  assert.equal(await run(1), 1);
  assert.equal(await run(2), 2);
  assert.equal(workers.length, 1, "a healthy reset realm serves multiple jobs");
  assert.equal(workers[0]!.terminated, false);
  assert.equal(released, 2);
  await epoch.release();
  assert.equal(workers[0]!.terminated, true, "the final epoch release terminates the idle realm");
  await epoch.release();
  assert.equal(workers[0]!.terminated, true, "epoch release is idempotent");
  const nextEpoch = pool.retain();
  assert.equal(await run(3), 3, "a later preparation can open a fresh epoch");
  assert.equal(workers.length, 2);
  assert.equal(workers[1]!.terminated, false);
  await nextEpoch.release();
  assert.equal(workers[1]!.terminated, true);
});

test("a custom worker without reset proof and a shared-admission pool keep one-job physical lifetime", async () => {
  const noReset: ResetWorker[] = [];
  const pool = new FlacWorkerPool({
    hardwareConcurrency: 2,
    createWorker: () => { const worker = new ResetWorker(); noReset.push(worker); return worker; },
  });
  const epoch = pool.retain();
  await pool.run({ requestId: 1, work: async () => 1 });
  await pool.run({ requestId: 2, work: async () => 2 });
  assert.equal(noReset.length, 2);
  assert.equal(noReset.every((worker) => worker.terminated), true);
  await epoch.release();

  const shared: ResetWorker[] = [];
  const sharedPool = new FlacWorkerPool({
    admission: new BoundedStemAdmission(1),
    createWorker: () => { const worker = new ResetWorker(); shared.push(worker); return worker; },
  });
  await sharedPool.run({ requestId: 3, work: async () => 3 });
  await sharedPool.run({ requestId: 4, work: async () => 4 });
  assert.equal(shared.length, 2);
  assert.equal(shared.every((worker) => worker.terminated), true);
});

test("a shared-admission one-shot job retains its reservation until residual output is released", async () => {
  const admission = new BoundedStemAdmission(1);
  const workers: ResetWorker[] = [];
  const pool = new FlacWorkerPool({
    admission,
    createWorker: () => { const worker = new ResetWorker(); workers.push(worker); return worker; },
  });
  let releaseResidual!: () => void;
  const residualReleased = new Promise<void>(resolve => { releaseResidual = resolve; });
  let firstStarted!: () => void;
  const firstWorkStarted = new Promise<void>(resolve => { firstStarted = resolve; });
  let secondStarted = false;
  let releaseCallbacks = 0;
  const first = pool.run({
    requestId: 41,
    work: async () => { firstStarted(); return 41; },
    waitForRelease: () => residualReleased,
    onReleased: () => { releaseCallbacks += 1; },
  });
  await firstWorkStarted;
  assert.equal(admission.stats.active, 1);
  assert.equal(workers[0]?.terminated, false);

  const second = pool.run({
    requestId: 42,
    work: async () => { secondStarted = true; return 42; },
  });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(secondStarted, false);
  assert.equal(admission.stats.active, 1, "the slow consumer still owns the shared reservation");
  assert.equal(releaseCallbacks, 0);

  releaseResidual();
  assert.equal(await first, 41);
  assert.equal(await second, 42);
  assert.equal(secondStarted, true);
  assert.equal(workers.length, 2);
  assert.equal(releaseCallbacks, 1);
  assert.equal(admission.stats.active, 0);
});

test("native retained pools single-flight and cache one validated decoder module", async () => {
  const wasm = new Uint8Array(await readFile("src/internal/engine-web-flac-decoder.wasm"));
  const originalFetch = globalThis.fetch;
  const originalWorker = globalThis.Worker;
  const originalCompile = WebAssembly.compileStreaming;
  let fetches = 0;
  let compiles = 0;
  const contexts: Array<WebAssembly.Module | undefined> = [];
  class BrowserWorker extends ResetWorker {
    constructor(_url: string | URL, _options?: WorkerOptions) { super(); }
  }
  globalThis.Worker = BrowserWorker as unknown as typeof Worker;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(wasm.slice(), { headers: { "Content-Type": "application/wasm" } });
  }) as typeof fetch;
  WebAssembly.compileStreaming = (async (source) => {
    compiles += 1;
    return originalCompile(source);
  }) as typeof WebAssembly.compileStreaming;
  try {
    const pool = new FlacWorkerPool({ hardwareConcurrency: 2 });
    const epoch = pool.retain();
    const run = (requestId: number) => pool.run({
      requestId,
      work: async (worker, context) => {
        contexts.push(context?.decoderModule);
        reset(worker as ResetWorker, requestId);
        return requestId;
      },
    });
    assert.deepEqual(await Promise.all([run(11), run(12)]), [11, 12]);
    assert.equal(fetches, 1);
    assert.equal(compiles, 1);
    assert.equal(contexts.length, 2);
    assert.ok(contexts[0] instanceof WebAssembly.Module);
    assert.equal(contexts[0], contexts[1]);
    await epoch.release();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Worker = originalWorker;
    WebAssembly.compileStreaming = originalCompile;
  }
});

test("a failed native module load can retry in a later job of the same epoch", async () => {
  const wasm = new Uint8Array(await readFile("src/internal/engine-web-flac-decoder.wasm"));
  const originalFetch = globalThis.fetch;
  const originalWorker = globalThis.Worker;
  let requests = 0;
  class BrowserWorker extends ResetWorker {
    constructor(_url: string | URL, _options?: WorkerOptions) { super(); }
  }
  globalThis.Worker = BrowserWorker as unknown as typeof Worker;
  globalThis.fetch = (async () => {
    requests += 1;
    return requests === 1
      ? new Response(new Uint8Array([0]), { headers: { "Content-Type": "application/wasm" } })
      : new Response(wasm.slice(), { headers: { "Content-Type": "application/wasm" } });
  }) as typeof fetch;
  try {
    const pool = new FlacWorkerPool({ hardwareConcurrency: 2 });
    const epoch = pool.retain();
    await assert.rejects(pool.run({ requestId: 21, work: async () => 21 }), (error: unknown) =>
      typeof error === "object" && error !== null && (error as { code?: unknown }).code === "stem.decode.asset");
    assert.equal(await pool.run({
      requestId: 22,
      work: async (worker) => { reset(worker as ResetWorker, 22); return 22; },
    }), 22);
    assert.equal(requests, 2);
    await epoch.release();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Worker = originalWorker;
  }
});

test("last module-load owner cancellation discards a late compile", async () => {
  const wasm = new Uint8Array(await readFile("src/internal/engine-web-flac-decoder.wasm"));
  const originalFetch = globalThis.fetch;
  const originalWorker = globalThis.Worker;
  const originalCompile = WebAssembly.compileStreaming;
  const compileGate = (() => {
    let resolve!: (module: WebAssembly.Module | PromiseLike<WebAssembly.Module>) => void;
    const promise = new Promise<WebAssembly.Module>((done) => { resolve = done; });
    return { promise, resolve };
  })();
  let fetches = 0;
  let compiles = 0;
  let firstCompileStarted = false;
  class BrowserWorker extends ResetWorker {
    constructor(_url: string | URL, _options?: WorkerOptions) { super(); }
  }
  globalThis.Worker = BrowserWorker as unknown as typeof Worker;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(wasm.slice(), { headers: { "Content-Type": "application/wasm" } });
  }) as typeof fetch;
  WebAssembly.compileStreaming = (async (source) => {
    compiles += 1;
    if (compiles === 1) {
      firstCompileStarted = true;
      return compileGate.promise;
    }
    return originalCompile(source);
  }) as typeof WebAssembly.compileStreaming;
  try {
    const pool = new FlacWorkerPool({ hardwareConcurrency: 2 });
    const epoch = pool.retain();
    const abort = new AbortController();
    const first = pool.run({ signal: abort.signal, requestId: 31, work: async () => 31 });
    for (let index = 0; index < 100 && !firstCompileStarted; index += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    assert.equal(firstCompileStarted, true);
    abort.abort("cancelled module waiter");
    compileGate.resolve(originalCompile(new Response(wasm.slice(), { headers: { "Content-Type": "application/wasm" } })));
    await assert.rejects(first, (error: unknown) => error instanceof Error && "code" in error && error.code === "stem.cancelled");
    assert.equal(await pool.run({
      requestId: 32,
      work: async (worker) => { reset(worker as ResetWorker, 32); return 32; },
    }), 32);
    assert.equal(fetches, 2, "the cancelled late compile was not cached");
    assert.equal(compiles, 2);
    await epoch.release();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Worker = originalWorker;
    WebAssembly.compileStreaming = originalCompile;
  }
});
