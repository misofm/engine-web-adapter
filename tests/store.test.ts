import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { EngineWebAdapterError } from "../src/errors.js";
import {
  MemoryStemResolver,
  MemoryStemStorageBackend,
  StemSessionGate,
  VerifiedStemStore,
} from "../src/stems/index.js";
import type { StemIdentity, StemResolver } from "../src/stems/index.js";
import type { StemStorageBackend, WebLockProvider } from "../src/stems/index.js";

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
  assert.deepEqual(index.stems[item.identity].pins, ["session:test:lease-a"]);
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

test("duplicate content single-flights and distinct source IDs share one verified Blob", async () => {
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
