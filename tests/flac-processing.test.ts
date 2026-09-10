import assert from "node:assert/strict";
import test from "node:test";
import { BoundedStemAdmission, flacPipelineWidths } from "../src/stems/flac-admission.js";
import { readExactFlacRange } from "../src/stems/flac-delivery.js";
import { createIngestDiagnostics } from "../src/stems/ingest-diagnostics.js";
import { flacResult } from "../src/stems/flac-result.js";

const identity = `sha256:${"a".repeat(64)}` as const;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("processing adapts through 16 while preserving legacy and low-device download widths", () => {
  assert.deepEqual(flacPipelineWidths({ hardwareConcurrency: 32, deviceMemory: 8 }), { processing: 4, downloads: 4, verification: 4 });
  for (const maximumWorkers of [4, 8, 16]) {
    assert.deepEqual(flacPipelineWidths({ hardwareConcurrency: 32, deviceMemory: 8, processing: { maximumWorkers } }),
      { processing: maximumWorkers, downloads: 4, verification: 4 });
  }
  assert.deepEqual(flacPipelineWidths({ hardwareConcurrency: 2, deviceMemory: 1, processing: {} }), { processing: 1, downloads: 1, verification: 1 });
  assert.deepEqual(flacPipelineWidths({ hardwareConcurrency: 32, processing: {} }), { processing: 2, downloads: 2, verification: 2 });
  assert.deepEqual(flacPipelineWidths({ hardwareConcurrency: NaN, processing: {} }), { processing: 1, downloads: 1, verification: 1 });
  assert.deepEqual(flacPipelineWidths({ hardwareConcurrency: 32, deviceMemory: 8, maximumWorkers: 32,
    memoryBudgetBytes: 256 * 1024 * 1024, processing: { maximumWorkers: 16, maximumVerifications: 2 } }),
  { processing: 16, downloads: 4, verification: 2 });
  assert.throws(() => flacPipelineWidths({ processing: { maximumWorkers: 17 } }), RangeError);
  assert.throws(() => flacPipelineWidths({ processing: { memoryBudgetBytes: 1 } }), RangeError);
  assert.throws(() => flacPipelineWidths({ processing: {}, admission: new BoundedStemAdmission(16) }), RangeError);
});

test("download permits span delayed response bodies and failed-body cancellation before retry", async () => {
  const admission = new BoundedStemAdmission(2);
  let active = 0;
  let peak = 0;
  let cancelled = 0;
  let calls = 0;
  const transport: typeof fetch = async (_input, init) => {
    const number = calls++;
    active += 1; peak = Math.max(peak, active);
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { if (!done) { done = true; active -= 1; } };
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (number === 0) return; // rejected HTTP body must be explicitly cancelled
        timer = setTimeout(() => { controller.enqueue(new Uint8Array([7])); controller.close(); finish(); }, 15);
      },
      cancel() { if (timer !== undefined) clearTimeout(timer); cancelled += 1; finish(); },
    }), { status: number === 0 ? 503 : 206, headers: { "Content-Range": "bytes 0-0/1", "Content-Length": "1" } });
  };
  const requests = Array.from({ length: 9 }, (_, index) => readExactFlacRange({
    identity, phase: index % 3 === 0 ? "probe" : index % 3 === 1 ? "metadata" : "audio",
    start: 0, end: 0, signal: new AbortController().signal, state: {},
    locate: () => "https://caller.invalid/stem", fetch: transport, downloadAdmission: admission,
    readDeadlineMs: 100, maximumAttempts: 2,
  }));
  for (const result of await Promise.all(requests)) { assert.equal(result.bytes[0], 7); result.release(); }
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(calls, 10);
  assert.equal(cancelled, 1);
  assert.deepEqual(admission.stats, { active: 0, queued: 0, limit: 2 });
});

test("queue time does not consume the HTTP deadline and queued cancellation leaves no permit", async () => {
  const admission = new BoundedStemAdmission(1);
  const held = await admission.acquire();
  const abort = new AbortController();
  let calls = 0;
  const request = (signal: AbortSignal) => readExactFlacRange({
    identity, phase: "audio", start: 0, end: 0, signal, state: {}, downloadAdmission: admission,
    readDeadlineMs: 10, maximumAttempts: 1, locate: () => "https://caller.invalid/stem",
    fetch: async () => { calls += 1; return new Response(new Uint8Array([7]), {
      status: 206, headers: { "Content-Range": "bytes 0-0/1", "Content-Length": "1" },
    }); },
  });
  const cancelled = assert.rejects(request(abort.signal));
  const succeeds = request(new AbortController().signal);
  await delay(40);
  assert.equal(calls, 0);
  abort.abort("queued");
  await cancelled;
  held.release();
  (await succeeds).release();
  assert.equal(calls, 1);
  assert.deepEqual(admission.stats, { active: 0, queued: 0, limit: 1 });
});

test("active-body abort cancels body before admitting the next download", async () => {
  const admission = new BoundedStemAdmission(1);
  const abort = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let cancelled = false;
  const first = readExactFlacRange({ identity, phase: "audio", start: 0, end: 0,
    signal: abort.signal, state: {}, downloadAdmission: admission, locate: () => "https://caller.invalid/stem",
    fetch: async () => new Response(new ReadableStream({ start() { started(); }, cancel() { cancelled = true; } }), {
      status: 206, headers: { "Content-Range": "bytes 0-0/1", "Content-Length": "1" },
    }),
  });
  const refused = assert.rejects(first);
  await ready;
  const next = admission.acquire();
  abort.abort("body");
  await refused;
  const lease = await next;
  assert.equal(cancelled, true);
  lease.release();
  assert.equal(admission.stats.active, 0);
});

test("public result-shaped digest fields cannot grant package verification or disable read deadlines", () => {
  const forged = { stream: new ReadableStream<Uint8Array>(), canonicalBytes: 1, digest: () => "a".repeat(64) };
  assert.equal(flacResult(forged), undefined);
  assert.equal(createIngestDiagnostics().snapshot().processing, null);
});

test("unsettled body cancellation is bounded and closes download admission without retry", async () => {
  for (const scenario of ["http", "stall", "oversized", "rejected-cancel"] as const) {
    const status = scenario === "http" || scenario === "rejected-cancel" ? 503 : 206;
    const admission = new BoundedStemAdmission(1);
    let requests = 0;
    const started = performance.now();
    await assert.rejects(readExactFlacRange({ identity, phase: "audio", start: 0, end: 0,
      signal: new AbortController().signal, state: {}, downloadAdmission: admission,
      locate: () => "https://caller.invalid/uncancellable", readDeadlineMs: 10, maximumAttempts: 3,
      fetch: async () => { requests += 1; return new Response(new ReadableStream({
        start(controller) { if (scenario === "oversized") controller.enqueue(new Uint8Array([1, 2])); },
        cancel: () => scenario === "rejected-cancel" ? Promise.reject(new Error("cannot cancel")) : new Promise<void>(() => {}),
      }), { status, headers: { "Content-Range": "bytes 0-0/1", "Content-Length": "1" } }); },
    }), (error: unknown) => error instanceof Error && "code" in error && error.code === "stem.delivery.stall");
    assert.ok(performance.now() - started < 500);
    assert.equal(requests, 1);
    await assert.rejects(admission.acquire());
    assert.deepEqual(admission.stats, { active: 0, queued: 0, limit: 1 });
  }
});

test("late headers from an abort-ignoring fetch quarantine capacity instead of overlapping a retry", async () => {
  const admission = new BoundedStemAdmission(1);
  let calls = 0;
  let cancelled = false;
  await assert.rejects(readExactFlacRange({ identity, phase: "probe", start: 0, end: 0,
    signal: new AbortController().signal, state: {}, downloadAdmission: admission,
    readDeadlineMs: 10, maximumAttempts: 3, locate: () => "https://caller.invalid/late",
    fetch: async () => {
      calls += 1;
      await delay(70);
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
        status: 206, headers: { "Content-Range": "bytes 0-0/1", "Content-Length": "1" },
      });
    },
  }));
  assert.equal(calls, 1);
  await assert.rejects(admission.acquire());
  await delay(80);
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});
