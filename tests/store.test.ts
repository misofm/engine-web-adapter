import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { EngineWebAdapterError } from "../src/errors.js";
import { BoundedStemAdmission } from "../src/stems/flac-admission.js";
import { StemSessionGate } from "../src/stems/gate.js";
import { MemoryStemResolver } from "../src/stems/memory-resolver.js";
import { MemoryStemStorageBackend } from "../src/stems/storage.js";
import { VerifiedStemStore } from "../src/stems/store.js";
import type { StemIdentity, StemResolver } from "../src/stems/types.js";
import type { StemStorageBackend } from "../src/stems/storage.js";
import type { WebLockProvider } from "../src/stems/store.js";

function fixture(values: readonly number[]): { bytes: Uint8Array; identity: StemIdentity } {
  const bytes = new Uint8Array(values);
  return {
    bytes,
    identity: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function requirement(sourceId: string, identity: StemIdentity, bytes: number) {
  return { sourceId, identity, bytes } as const;
}

test("ingest hashes and byte-counts before ready and lease pin", async () => {
  const item = fixture([0, 1, 2, 3, 4, 5]);
  const backend = new MemoryStemStorageBackend();
  const resolver = new MemoryStemResolver({ [item.identity]: item.bytes }, { chunkBytes: 2 });
  const store = new VerifiedStemStore({ backend, instanceId: "test", now: () => 7 });
  const progress: string[] = [];
  const lease = await store.openSession({
    leaseId: "lease-a",
    stems: [requirement("source-a", item.identity, item.bytes.length)],
    resolver,
    onProgress: (event) => progress.push(event.stage),
  });

  assert.equal(progress.at(-1), "ready");
  assert.equal(resolver.requests.length, 1);
  assert.equal(await (await lease.read(item.identity)).text(), String.fromCharCode(...item.bytes));
  const index = JSON.parse(new TextDecoder().decode(backend.files.get("index.json")!));
  assert.equal(index.stems[item.identity].pins.length, 1);
  assert.match(index.stems[item.identity].pins[0], /^session:test:lease-a:/);
  await lease.close();
  const closedIndex = JSON.parse(new TextDecoder().decode(backend.files.get("index.json")!));
  assert.deepEqual(closedIndex.stems[item.identity].pins, []);
  await lease.close();
});

test("corruption and truncation are removed then self-healed", async () => {
  const item = fixture([10, 20, 30, 40, 50, 60]);
  const backend = new MemoryStemStorageBackend();
  const resolver = new MemoryStemResolver({ [item.identity]: item.bytes }, { chunkBytes: 1 });
  const store = new VerifiedStemStore({ backend, instanceId: "heal" });
  const stems = [requirement("source", item.identity, item.bytes.length)];
  await (await store.openSession({ leaseId: "first", stems, resolver })).close();

  const final = `sha256-${item.identity.slice(7)}`;
  backend.files.set(final, new Uint8Array([10, 99, 30, 40, 50, 60]));
  await (await store.openSession({ leaseId: "corrupt", stems, resolver })).close();
  backend.files.set(final, item.bytes.slice(0, 3));
  await (await store.openSession({ leaseId: "truncated", stems, resolver })).close();

  assert.equal(resolver.requests.length, 3);
  assert.deepEqual(backend.files.get(final), item.bytes);
});

test("conflicting byte count cannot demote valid cached content or live pins", async () => {
  const item = fixture([31, 32, 33, 34, 35, 36]);
  const backend = new MemoryStemStorageBackend();
  const resolver = new MemoryStemResolver({ [item.identity]: item.bytes });
  const store = new VerifiedStemStore({ backend, instanceId: "conflict" });
  const valid = requirement("source-a", item.identity, item.bytes.length);
  const leaseA = await store.openSession({ leaseId: "a", stems: [valid], resolver });
  const conflictingResolver = new MemoryStemResolver({});
  await assert.rejects(
    store.openSession({
      leaseId: "b", stems: [requirement("source-b", item.identity, item.bytes.length + 2)], resolver: conflictingResolver,
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.invalid_declaration",
  );
  assert.equal(conflictingResolver.requests.length, 0);
  assert.deepEqual(new Uint8Array(await (await leaseA.read(item.identity)).arrayBuffer()), item.bytes);
  const index = JSON.parse(new TextDecoder().decode(backend.files.get("index.json")!));
  assert.equal(index.stems[item.identity].bytes, item.bytes.length);
  assert.equal(index.stems[item.identity].pins.length, 1);
  assert.match(index.stems[item.identity].pins[0], /^session:conflict:a:/);
  assert.equal(backend.files.has(`sha256-${item.identity.slice(7)}`), true);
  await leaseA.close();
});

test("missing or malformed index recovers verified finals without resolving", async () => {
  const item = fixture([1, 3, 3, 7]);
  const backend = new MemoryStemStorageBackend();
  const resolver = new MemoryStemResolver({ [item.identity]: item.bytes });
  const stems = [requirement("source", item.identity, item.bytes.length)];
  await (await new VerifiedStemStore({ backend }).openSession({ leaseId: "seed", stems, resolver })).close();
  backend.files.set("index.json", new TextEncoder().encode("{crashed"));
  backend.files.set("staging-dead", new Uint8Array([8, 8]));

  const recoveredResolver = new MemoryStemResolver({});
  const recovered = new VerifiedStemStore({ backend, locks: new TestLocks() });
  await (await recovered.openSession({ leaseId: "recovered", stems, resolver: recoveredResolver })).close();
  assert.equal(recoveredResolver.requests.length, 0);
  assert.equal(backend.files.has("staging-dead"), false);
});

test("recovery without lock query keeps ambiguous final and staging files", async () => {
  const backend = new MemoryStemStorageBackend();
  const digest = "c".repeat(64);
  const final = `sha256-${digest}`;
  backend.files.set(final, new Uint8Array([1, 2, 3]));
  backend.files.set(`staging-tab-${digest}`, new Uint8Array([1]));
  backend.files.set("index.json", new TextEncoder().encode("{broken"));
  const locks = new TestLocks();
  const requestOnly: WebLockProvider = { request: locks.request.bind(locks) };
  await new VerifiedStemStore({ backend, locks: requestOnly }).open();
  assert.equal(backend.files.has(final), true);
  assert.equal(backend.files.has(`staging-tab-${digest}`), true);
});

test("duplicate content locks once and distinct source IDs share one verified Blob", async () => {
  const item = fixture([2, 4, 6, 8, 10, 12, 14, 16]);
  const backend = new MemoryStemStorageBackend();
  const resolver = new MemoryStemResolver({ [item.identity]: item.bytes }, { chunkBytes: 1 });
  const store = new VerifiedStemStore({ backend });
  const stems = [
    requirement("left-edit", item.identity, item.bytes.length),
    requirement("right-edit", item.identity, item.bytes.length),
  ];
  const [a, b] = await Promise.all([
    store.openSession({ leaseId: "a", stems, resolver }),
    store.openSession({ leaseId: "b", stems, resolver }),
  ]);
  assert.equal(resolver.requests.length, 1);
  assert.equal(a.stems.length, 2);
  assert.equal((await a.read(item.identity)).size, item.bytes.length);
  assert.equal((await b.read(item.identity)).size, item.bytes.length);
  assert.equal([...backend.files.keys()].filter((name) => name.startsWith("sha256-")).length, 1);
  await Promise.all([a.close(), b.close()]);
});

test("cancelling one open cannot contaminate or deadlock an independent same-stem open", async () => {
  const item = fixture([71, 72, 73, 74]);
  const backend = new MemoryStemStorageBackend();
  const store = new VerifiedStemStore({ backend, readDeadlineMs: 100 });
  const stems = [requirement("source", item.identity, item.bytes.length)];
  const firstStarted = deferred<void>();
  let firstCancelled = false;
  const firstResolver: StemResolver = {
    async resolve(_identity, options) {
      firstStarted.resolve();
      options?.signal?.addEventListener("abort", () => { firstCancelled = true; }, { once: true });
      return { stream: new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      }) };
    },
  };
  const firstAbort = new AbortController();
  const first = store.openSession({ leaseId: "cancelled", stems, resolver: firstResolver, signal: firstAbort.signal });
  await firstStarted.promise;
  const secondResolver = new MemoryStemResolver({ [item.identity]: item.bytes });
  const second = store.openSession({ leaseId: "independent", stems, resolver: secondResolver });
  firstAbort.abort(new DOMException("cancel first", "AbortError"));
  await assert.rejects(
    first,
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled",
  );
  const lease = await Promise.race([
    second,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("independent open deadlocked")), 100)),
  ]);
  assert.equal(firstCancelled, true);
  assert.equal(secondResolver.requests.length, 1);
  assert.deepEqual(new Uint8Array(await (await lease.read(item.identity)).arrayBuffer()), item.bytes);
  await lease.close();
});

test("cancellation during OPFS write awaits writer abort and removes staging", async () => {
  const item = fixture([81, 82, 83, 84]);
  const storage = new MemoryStemStorageBackend();
  const writeStarted = deferred<void>();
  const writeStopped = deferred<void>();
  let writerAborted = false;
  const backend: StemStorageBackend = {
    ...backendView(storage),
    async createWriter(name) {
      if (!name.startsWith("staging-")) return storage.createWriter(name);
      return {
        async write() {
          writeStarted.resolve();
          await writeStopped.promise;
          if (writerAborted) throw new DOMException("write aborted", "AbortError");
        },
        async close() { assert.fail("cancelled staging writer closed"); },
        async abort() { writerAborted = true; writeStopped.resolve(); },
      };
    },
  };
  const abort = new AbortController();
  const opening = new VerifiedStemStore({ backend }).openSession({
    leaseId: "opfs-cancel",
    stems: [requirement("source", item.identity, item.bytes.length)],
    resolver: new MemoryStemResolver({ [item.identity]: item.bytes }),
    signal: abort.signal,
  });
  await writeStarted.promise;
  abort.abort(new DOMException("cancel OPFS write", "AbortError"));
  await assert.rejects(
    opening,
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled",
  );
  assert.equal(writerAborted, true);
  assert.equal([...storage.files.keys()].some((name) => name.startsWith("staging-") || name.startsWith("sha256-")), false);
});

test("Web Locks serialize separate tab/store instances into one resolve", async () => {
  const item = fixture([11, 12, 13, 14, 15]);
  const storage = new MemoryStemStorageBackend();
  const locks = new TestLocks();
  const resolver = new MemoryStemResolver({ [item.identity]: item.bytes }, { chunkBytes: 1 });
  const stems = [requirement("source", item.identity, item.bytes.length)];
  const [one, two] = await Promise.all([
    new VerifiedStemStore({ backend: backendView(storage), locks, instanceId: "tab-one" })
      .openSession({ leaseId: "one", stems, resolver }),
    new VerifiedStemStore({ backend: backendView(storage), locks, instanceId: "tab-two" })
      .openSession({ leaseId: "two", stems, resolver }),
  ]);
  assert.equal(resolver.requests.length, 1);
  await Promise.all([one.close(), two.close()]);
});

test("late-opening store preserves a live promoted final until its index commit", async () => {
  const item = fixture([21, 22, 23, 24, 25, 26]);
  const storage = new MemoryStemStorageBackend();
  const locks = new TestLocks();
  const promoted = deferred<void>();
  const releaseMove = deferred<void>();
  const firstBackend: StemStorageBackend = {
    ...backendView(storage),
    async move(from, to) {
      await storage.move(from, to);
      if (to.startsWith("sha256-")) { promoted.resolve(); await releaseMove.promise; }
    },
  };
  const stems = [requirement("source", item.identity, item.bytes.length)];
  const resolver = new MemoryStemResolver({ [item.identity]: item.bytes }, { chunkBytes: 1 });
  const opening = new VerifiedStemStore({ backend: firstBackend, locks, instanceId: "writer" })
    .openSession({ leaseId: "writer", stems, resolver });
  await promoted.promise;

  const late = new VerifiedStemStore({ backend: backendView(storage), locks, instanceId: "late" });
  await late.open();
  assert.equal(storage.files.has(`sha256-${item.identity.slice(7)}`), true);
  releaseMove.resolve();
  await (await opening).close();
  const warmResolver = new MemoryStemResolver({});
  await (await late.openSession({ leaseId: "warm", stems, resolver: warmResolver })).close();
  assert.equal(warmResolver.requests.length, 0);
});

test("warm verification uses bounded task and admission width", async () => {
  const items = [
    fixture([1, 1, 1, 1]),
    fixture([2, 2, 2, 2]),
    fixture([3, 3, 3, 3]),
    fixture([4, 4, 4, 4]),
  ];
  const stems = items.map((item, index) => requirement(`source-${index}`, item.identity, item.bytes.length));
  const storage = new MemoryStemStorageBackend();
  const resolver = new MemoryStemResolver(Object.fromEntries(items.map((item) => [item.identity, item.bytes])));
  await (await new VerifiedStemStore({ backend: storage }).openSession({ leaseId: "seed", stems, resolver })).close();

  let active = 0;
  let maximum = 0;
  const delayed = backendView(storage);
  const read = delayed.read;
  delayed.read = async (name) => {
    if (!name.startsWith("sha256-")) return read(name);
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return await read(name);
    } finally { active -= 1; }
  };
  const warmResolver = new MemoryStemResolver({});
  const warm = new VerifiedStemStore({ backend: delayed });
  await (await warm.openSession({
    leaseId: "warm",
    stems,
    resolver: warmResolver,
    admission: new BoundedStemAdmission(2),
  })).close();
  assert.equal(warmResolver.requests.length, 0);
  assert.equal(maximum, 2);
});

test("bounded open aborts sibling work and awaits cleanup before rejecting", async () => {
  const failed = fixture([41, 42, 43, 44]);
  const sibling = fixture([51, 52, 53, 54]);
  const queued = fixture([61, 62, 63, 64]);
  const siblingStarted = deferred<void>();
  const cancellationObserved = deferred<void>();
  const cleanupRelease = deferred<void>();
  const authoritative = new EngineWebAdapterError("stem.corrupt", "authoritative first failure");
  const started: StemIdentity[] = [];
  let cleanupFinished = false;
  const resolver: StemResolver = {
    async resolve(identity) {
      started.push(identity);
      if (identity === failed.identity) {
        await siblingStarted.promise;
        throw authoritative;
      }
      if (identity === queued.identity) throw new Error("queued work must not start after failure");
      siblingStarted.resolve();
      let emitted = false;
      return {
        stream: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!emitted) {
              emitted = true;
              controller.enqueue(sibling.bytes.subarray(0, 1));
              return;
            }
            return new Promise<void>(() => undefined);
          },
          async cancel() {
            cancellationObserved.resolve();
            await cleanupRelease.promise;
            cleanupFinished = true;
          },
        }),
      };
    },
  };
  const backend = new MemoryStemStorageBackend();
  const opening = new VerifiedStemStore({ backend }).openSession({
    leaseId: "fail-close",
    stems: [
      requirement("failed", failed.identity, failed.bytes.length),
      requirement("sibling", sibling.identity, sibling.bytes.length),
      requirement("queued", queued.identity, queued.bytes.length),
    ],
    resolver,
    admission: new BoundedStemAdmission(2),
  });
  let publiclyRejected = false;
  const observed = opening.catch((error: unknown) => {
    publiclyRejected = true;
    return error;
  });

  await cancellationObserved.promise;
  assert.equal(publiclyRejected, false);
  assert.deepEqual(started, [failed.identity, sibling.identity]);
  cleanupRelease.resolve();
  assert.equal(await observed, authoritative);
  assert.equal(cleanupFinished, true);
  assert.equal([...backend.files.keys()].some((name) => name.startsWith("staging-") || name.startsWith("sha256-")), false);
  const settledFiles = [...backend.files.keys()].sort();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.deepEqual([...backend.files.keys()].sort(), settledFiles);
});

test("quota, integrity, cancellation, and no-progress deadline are typed", async () => {
  const item = fixture(Array.from({ length: 32 }, (_, index) => index));
  const stems = [requirement("source", item.identity, item.bytes.length)];
  const quotaStore = new VerifiedStemStore({
    backend: new MemoryStemStorageBackend({ quotaBytes: 40 }),
  });
  await assert.rejects(
    quotaStore.openSession({ leaseId: "quota", stems, resolver: new MemoryStemResolver({ [item.identity]: item.bytes }) }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.quota",
  );

  const wrong = fixture([9, 9, 9, 9]);
  await assert.rejects(
    new VerifiedStemStore({ backend: new MemoryStemStorageBackend() }).openSession({
      leaseId: "integrity", stems, resolver: new MemoryStemResolver({ [item.identity]: wrong.bytes }),
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.corrupt",
  );

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    new VerifiedStemStore({ backend: new MemoryStemStorageBackend() }).openSession({
      leaseId: "cancel", stems, resolver: new MemoryStemResolver({ [item.identity]: item.bytes }), signal: cancelled.signal,
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled",
  );

  const stalled: StemResolver = {
    async resolve() {
      return { stream: new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }) };
    },
  };
  await assert.rejects(
    new VerifiedStemStore({ backend: new MemoryStemStorageBackend(), readDeadlineMs: 5 }).openSession({
      leaseId: "deadline", stems, resolver: stalled,
    }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.read_deadline",
  );
});

test("session gate serializes replacement and close is idempotent", async () => {
  const item = fixture([4, 3, 2, 1]);
  const resolver = new MemoryStemResolver({ [item.identity]: item.bytes });
  const gate = new StemSessionGate(
    new VerifiedStemStore({ backend: new MemoryStemStorageBackend() }),
    resolver,
  );
  const lease = await gate.open({
    leaseId: "gate", stems: [requirement("source", item.identity, item.bytes.length)],
  });
  assert.equal(gate.state, "ready");
  await gate.close();
  await gate.close();
  assert.equal(gate.state, "idle");
  await assert.rejects(lease.read(item.identity));
});

function seededCache(pins: string[] = []) {
  const item = fixture([101, 102, 103, 104]);
  const backend = new MemoryStemStorageBackend();
  backend.files.set(`sha256-${item.identity.slice(7)}`, item.bytes.slice());
  backend.files.set("index.json", new TextEncoder().encode(JSON.stringify({ version: 1, stems: {
    [item.identity]: { bytes: item.bytes.length, pins, lastUsedAt: 11 },
  } }) + "\n"));
  const row = () => JSON.parse(new TextDecoder().decode(backend.files.get("index.json")!)).stems[item.identity] as { pins: string[]; lastUsedAt: number };
  return { item, backend, row };
}

test("durable offline pins share the historical cache and preserve metadata across reopen and repair", async () => {
  const { item, backend, row } = seededCache(["offline:existing", "session:unknown-owner:old"]);
  const before = backend.files.get("index.json")!.slice();
  const store = new VerifiedStemStore({ backend });
  await store.open();
  assert.deepEqual(backend.files.get("index.json"), before);
  assert.deepEqual(new Uint8Array(await (await store.read(item.identity)).arrayBuffer()), item.bytes);
  await store.setOfflinePin(item.identity, "one", true);
  await store.setOfflinePin(item.identity, "one", true);
  const reopened = new VerifiedStemStore({ backend });
  await reopened.setOfflinePin(item.identity, "two", true);
  await reopened.setOfflinePin(item.identity, "one", false);
  await reopened.setOfflinePin(item.identity, "one", false);
  assert.deepEqual(row().pins, ["offline:existing", "session:unknown-owner:old", "offline:two"]);
  assert.equal(row().lastUsedAt, 11);
  await assert.rejects(store.setOfflinePin(item.identity, " ", true), TypeError);
  const missing = fixture([201]).identity;
  await assert.rejects(store.setOfflinePin(missing, "missing", true), { code: "stem.not_found" });
  await store.setOfflinePin(missing, "missing", false);
  backend.files.set(`sha256-${item.identity.slice(7)}`, new Uint8Array([0]));
  const resolver = new MemoryStemResolver({ [item.identity]: item.bytes });
  const lease = await store.openSession({ leaseId: "repair", stems: [requirement("source", item.identity, item.bytes.length)], resolver });
  assert.equal(resolver.requests.length, 1, "pins never bypass corrupt-content verification");
  await lease.close();
  assert.deepEqual(row().pins, ["offline:existing", "session:unknown-owner:old", "offline:two"]);
  assert.deepEqual(backend.files.get(`sha256-${item.identity.slice(7)}`), item.bytes);
});

test("missing and already-equal offline mutations are true no-ops without persistence", async () => {
  const { item, backend } = seededCache(["offline:keep"]);
  const store = new VerifiedStemStore({ backend: { ...backendView(backend), async createWriter() { throw new Error("no index writes allowed"); } } });
  const before = backend.files.get("index.json")!.slice();
  await store.setOfflinePin(item.identity, "keep", true);
  await store.setOfflinePin(item.identity, "absent", false);
  await store.setOfflinePin(fixture([202]).identity, "absent", false);
  assert.deepEqual(backend.files.get("index.json"), before);
});

test("same caller lease IDs own distinct historical lifetime locks and close independently", async () => {
  const { item, backend, row } = seededCache(["offline:keep"]);
  const locks = new TestLocks();
  const view = { ...backendView(backend), folderName: "miso-stems-v1" };
  const store = new VerifiedStemStore({ backend: view, locks, instanceId: "tab" });
  const options = { leaseId: "same", stems: [requirement("source", item.identity, item.bytes.length)], resolver: new MemoryStemResolver({}) };
  const [one, two] = await Promise.all([store.openSession(options), store.openSession(options)]);
  const pins = row().pins.filter(pin => pin.startsWith("session:"));
  assert.equal(new Set(pins).size, 2);
  const lifetime = (pin: string) => `miso:stem-store:v1:miso-stems-v1:pin:${pin}`;
  assert.deepEqual((await locks.query()).held.map(lock => lock.name).sort(), pins.map(lifetime).sort());
  await one.close();
  assert.equal(row().pins.length, 2);
  assert.deepEqual((await locks.query()).held.map(lock => lock.name), row().pins.filter(pin => pin.startsWith("session:")).map(lifetime));
  assert.deepEqual(new Uint8Array(await (await two.read(item.identity)).arrayBuffer()), item.bytes);
  await two.close();
  assert.deepEqual(row().pins, ["offline:keep"]);
  assert.deepEqual((await locks.query()).held, []);
});

test("pin persistence failure never acknowledges and a failed lease close retains ownership for retry", async () => {
  const { item, backend, row } = seededCache(["offline:keep"]);
  const locks = new TestLocks();
  let fail = false;
  const view = { ...backendView(backend), async move(from: string, to: string) {
    if (fail && to === "index.json") throw new Error("index persistence failed");
    await backend.move(from, to);
  } };
  const store = new VerifiedStemStore({ backend: view, locks });
  await store.open();
  fail = true;
  await assert.rejects(store.setOfflinePin(item.identity, "lost", true), /index persistence failed/);
  assert.deepEqual(row().pins, ["offline:keep"]);
  fail = false;
  const lease = await store.openSession({ leaseId: "retry", stems: [requirement("source", item.identity, item.bytes.length)], resolver: new MemoryStemResolver({}) });
  const owned = row().pins.slice();
  fail = true;
  await assert.rejects(lease.close(), /index persistence failed/);
  assert.deepEqual(row().pins, owned);
  assert.equal((await locks.query()).held.length, 1, "failed close retains live ownership");
  fail = false;
  await lease.close();
  assert.deepEqual(row().pins, ["offline:keep"]);
  assert.deepEqual((await locks.query()).held, []);
  fail = true;
  await assert.rejects(store.openSession({ leaseId: "failed", stems: [requirement("source", item.identity, item.bytes.length)], resolver: new MemoryStemResolver({}) }), /index persistence failed/);
  assert.deepEqual(row().pins, ["offline:keep"]);
  assert.deepEqual((await locks.query()).held, []);
});

test("cancellation racing pin persistence rolls back only its own pin and releases its lock", async () => {
  for (const phase of ["persist", "ready"] as const) {
  const { item, backend, row } = seededCache(["offline:keep"]);
  const locks = new TestLocks();
  const controller = new AbortController();
  const view = { ...backendView(backend), async move(from: string, to: string) {
    await backend.move(from, to);
    if (phase === "persist" && to === "index.json" && row().pins.some(pin => pin.startsWith("session:"))) controller.abort();
  } };
  const store = new VerifiedStemStore({ backend: view, locks });
  await assert.rejects(store.openSession({ leaseId: "cancel", stems: [requirement("source", item.identity, item.bytes.length)], resolver: new MemoryStemResolver({}), signal: controller.signal, onProgress: event => { if (phase === "ready" && event.stage === "ready") controller.abort(); } }), { code: "stem.cancelled" });
  assert.deepEqual(row().pins, ["offline:keep"]);
  assert.deepEqual((await locks.query()).held, []);
  }
});

test("abort before lifetime pin lock grant retains typed cancellation without persisting ownership", async () => {
  const { item, backend } = seededCache(["offline:keep"]);
  const before = backend.files.get("index.json")!.slice();
  const controller = new AbortController();
  const waiting = deferred<void>();
  const proceed = deferred<void>();
  const locks = new TestLocks();
  let pinGranted = false;
  const provider: WebLockProvider = {
    async request(name, options, callback) {
      if (name.includes(":pin:")) {
        waiting.resolve();
        await proceed.promise;
        options.signal?.throwIfAborted();
        pinGranted = true;
      }
      return locks.request(name, options, callback);
    },
    query: () => locks.query(),
  };
  const opening = new VerifiedStemStore({ backend, locks: provider }).openSession({
    leaseId: "pre-grant", stems: [requirement("source", item.identity, item.bytes.length)],
    resolver: new MemoryStemResolver({}), signal: controller.signal,
  });
  await waiting.promise;
  const reason = new Error("caller cancellation reason");
  controller.abort(reason);
  proceed.resolve();
  await assert.rejects(opening, (error: unknown) => error instanceof EngineWebAdapterError
    && error.code === "stem.cancelled" && error.cause === reason);
  assert.equal(pinGranted, false);
  assert.deepEqual(backend.files.get("index.json"), before);
  assert.deepEqual((await locks.query()).held, []);
});

test("prior adapter and historical app index clients serialize pin mutations in fixed order", async () => {
  for (const legacy of ["miso:engine-web:v1:index", "miso:stem-store:v1:miso-stems-v1:index"]) {
    const { item, backend, row } = seededCache();
    const locks = new TestLocks();
    const store = new VerifiedStemStore({ backend: { ...backendView(backend), folderName: "miso-stems-v1" }, locks });
    await store.open();
    const acquired = deferred<void>();
    const release = deferred<void>();
    const oldMutation = locks.request(legacy, { mode: "exclusive" }, async () => {
      acquired.resolve(); await release.promise;
      const index = JSON.parse(await backend.readText("index.json"));
      index.stems[item.identity].pins.push("offline:old-client");
      backend.files.set("index.json", new TextEncoder().encode(JSON.stringify(index) + "\n"));
    });
    await acquired.promise;
    let settled = false;
    const mutation = store.setOfflinePin(item.identity, "new-client", true).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release.resolve(); await oldMutation; await mutation;
    assert.deepEqual(row().pins, ["offline:old-client", "offline:new-client"]);
    const recent = locks.requests.slice(-2);
    assert.deepEqual(recent, ["miso:engine-web:v1:index", "miso:stem-store:v1:miso-stems-v1:index"]);
  }
});

test("unsupported index version refuses before touching historical files", async () => {
  const { backend } = seededCache();
  backend.files.set("index.json", new TextEncoder().encode('{"version":2,"stems":{}}'));
  backend.files.set("index.pending", new Uint8Array([4]));
  backend.files.set("staging-old", new Uint8Array([5]));
  backend.files.set("staging/old", new Uint8Array([6]));
  const before = [...backend.files].map(([name, bytes]) => [name, [...bytes]]);
  await assert.rejects(new VerifiedStemStore({ backend, locks: new TestLocks() }).open(), { code: "stem.corrupt" });
  assert.deepEqual([...backend.files].map(([name, bytes]) => [name, [...bytes]]), before);
});

function backendView(storage: MemoryStemStorageBackend): StemStorageBackend {
  return {
    open: () => storage.open(),
    list: () => storage.list(),
    exists: (name) => storage.exists(name),
    read: (name) => storage.read(name),
    readText: (name) => storage.readText(name),
    createWriter: (name) => storage.createWriter(name),
    move: (from, to) => storage.move(from, to),
    remove: (name) => storage.remove(name),
    estimate: () => storage.estimate(),
  };
}

class TestLocks implements WebLockProvider {
  readonly requests: string[] = [];
  readonly #tails = new Map<string, Promise<void>>();
  readonly #held = new Set<string>();
  readonly #pending = new Set<string>();
  async query() {
    return {
      held: [...this.#held].map((name) => ({ name })),
      pending: [...this.#pending].map((name) => ({ name })),
    };
  }
  async request<T>(
    name: string,
    options: { readonly mode: "exclusive"; readonly signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T> {
    options.signal?.throwIfAborted();
    this.requests.push(name);
    const prior = this.#tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => gate);
    this.#tails.set(name, tail);
    this.#pending.add(name);
    await prior;
    this.#pending.delete(name);
    this.#held.add(name);
    try { options.signal?.throwIfAborted(); return await callback(); }
    finally {
      this.#held.delete(name); release();
      if (this.#tails.get(name) === tail) this.#tails.delete(name);
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function quotaCache(items: readonly ReturnType<typeof fixture>[], capacity: number) {
  const storage = new MemoryStemStorageBackend();
  const stems = Object.fromEntries(items.map(item => {
    storage.files.set(`sha256-${item.identity.slice(7)}`, item.bytes);
    return [item.identity, { bytes: item.bytes.length, pins: [] as string[], lastUsedAt: 0 }];
  }));
  storage.files.set("index.json", new TextEncoder().encode(JSON.stringify({ version: 1, stems })));
  const backend: StemStorageBackend = { ...backendView(storage), async estimate() {
    return { quota: capacity, usage: [...storage.files].reduce((sum, [name, bytes]) =>
      sum + (name.startsWith("sha256-") || name.startsWith("staging-") ? bytes.length : 0), 0) };
  } };
  const open = (store: VerifiedStemStore, id: string, entries: readonly ReturnType<typeof fixture>[]) => store.openSession({
    leaseId: id, stems: entries.map(item => requirement(item.identity, item.identity, item.bytes.length)),
    resolver: new MemoryStemResolver(Object.fromEntries(entries.map(item => [item.identity, item.bytes]))),
  });
  return { storage, backend, open, row: async () => JSON.parse(await storage.readText("index.json")).stems };
}

test("quota reclaims oldest unpinned entries with identity ties and stops at sufficient capacity", async () => {
  const items = [fixture([1]), fixture([2]), fixture([3])].sort((a, b) => a.identity < b.identity ? -1 : 1);
  const cache = quotaCache(items, 3);
  const index = await cache.row();
  index[items[2]!.identity].lastUsedAt = -1;
  cache.storage.files.set("index.json", new TextEncoder().encode(JSON.stringify({ version: 1, stems: index })));
  const lease = await cache.open(new VerifiedStemStore({ backend: cache.backend }), "new", [fixture([8, 9])]);
  const rows = await cache.row();
  assert.equal(rows[items[2]!.identity], undefined, "oldest first");
  assert.equal(rows[items[0]!.identity], undefined, "identity breaks equal timestamps");
  assert.ok(rows[items[1]!.identity], "does not over-reclaim");
  await lease.close();
});

test("quota preserves every offline and independent live pin", async () => {
  const item = fixture([11, 12]);
  const cache = quotaCache([item], 2);
  const store = new VerifiedStemStore({ backend: cache.backend, locks: new TestLocks() });
  const a = await cache.open(store, "same", [item]);
  const b = await cache.open(store, "same", [item]);
  await store.setOfflinePin(item.identity, "one", true);
  await store.setOfflinePin(item.identity, "two", true);
  const refuse = () => assert.rejects(cache.open(store, "pressure", [fixture([13])]), { code: "stem.quota" });
  await refuse(); await a.close(); await refuse(); await b.close(); await refuse();
  await store.setOfflinePin(item.identity, "one", false); await refuse();
  assert.deepEqual((await cache.row())[item.identity].pins, ["offline:two"]);
  await store.setOfflinePin(item.identity, "two", false);
  await (await cache.open(store, "fits", [fixture([13])])).close();
});

test("provisional verified sources survive quota pressure and failed opens roll back only their ownership", async () => {
  const first = fixture([21, 22]);
  const cache = quotaCache([first], 2);
  const store = new VerifiedStemStore({ backend: cache.backend, locks: new TestLocks() });
  await assert.rejects(cache.open(store, "partial", [first, fixture([23])]), { code: "stem.quota" });
  assert.deepEqual((await cache.row())[first.identity].pins, []);
  assert.deepEqual(cache.storage.files.get(`sha256-${first.identity.slice(7)}`), first.bytes);
  const lease = await cache.open(store, "other", [first]);
  await assert.rejects(cache.open(store, "partial", [first, fixture([24])]), { code: "stem.quota" });
  assert.equal((await cache.row())[first.identity].pins.length, 1);
  assert.deepEqual(new Uint8Array(await (await lease.read(first.identity)).arrayBuffer()), first.bytes);
  await lease.close();
});

test("pin admitted after victim selection wins the coordinated eviction recheck", async () => {
  const item = fixture([31]);
  const cache = quotaCache([item], 1);
  const locks = new TestLocks();
  const selected = deferred<void>();
  const proceed = deferred<void>();
  const provider: WebLockProvider = {
    query: () => locks.query(),
    async request(name, options, callback) {
      if (name === `miso:engine-web:v1:stem:${item.identity.slice(7)}`) {
        selected.resolve(); await proceed.promise;
      }
      return locks.request(name, options, callback);
    },
  };
  const evictor = new VerifiedStemStore({ backend: cache.backend, locks: provider });
  const other = new VerifiedStemStore({ backend: cache.backend, locks });
  await other.open();
  const opening = cache.open(evictor, "pressure", [fixture([32])]);
  await selected.promise;
  await other.setOfflinePin(item.identity, "race", true);
  proceed.resolve();
  await assert.rejects(opening, { code: "stem.quota" });
  assert.deepEqual((await cache.row())[item.identity].pins, ["offline:race"]);
  assert.ok(cache.storage.files.has(`sha256-${item.identity.slice(7)}`));
});

test("two concurrent cold opens finish without nested victim and ingest lock deadlock", { timeout: 2000 }, async () => {
  const cache = quotaCache([fixture([41]), fixture([42])], 2);
  const locks = new TestLocks();
  const results = await Promise.allSettled([43, 44].map(value =>
    cache.open(new VerifiedStemStore({ backend: cache.backend, locks }), String(value), [fixture([value])])));
  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const stem of result.value.stems) assert.equal((await result.value.read(stem.identity)).size, stem.bytes);
      await result.value.close();
    } else assert.equal(result.reason.code, "stem.quota");
  }
  assert.ok(results.some(result => result.status === "fulfilled"));
  assert.deepEqual((await locks.query()).held, []);
});
