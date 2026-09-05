import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";

import { EngineWebAdapterError } from "../src/errors.js";
import { OpfsStorageBackend } from "../src/stems/storage.js";
import { OpfsWriteWorkerClient } from "../src/stems/opfs-worker-client.js";
import { VerifiedStemStore } from "../src/stems/store.js";
import { IncrementalSha256 } from "../src/stems/sha256.js";
import type { OpfsWorkerLike, OpfsWorkerRequest, OpfsWorkerResponse } from "../src/stems/opfs-worker-protocol.js";
import type { StemIdentity } from "../src/stems/types.js";

/**
 * The OPFS backend had no coverage at all, which is how a Safari-26-only write
 * method survived. These tests drive the real Worker module against an
 * in-memory OPFS whose file handles deliberately expose no `createWritable`.
 */

interface FakeEntry { bytes: Uint8Array }

class FakeDirectory {
  readonly kind = "directory" as const;
  readonly files = new Map<string, FakeEntry>();
  readonly directories = new Map<string, FakeDirectory>();
  readonly locked = new Set<string>();
  handlesWithoutSyncAccess = false;

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<FakeDirectory> {
    const existing = this.directories.get(name);
    if (existing !== undefined) return existing;
    if (options.create !== true) throw named(`${name} was not found`, "NotFoundError");
    const created = new FakeDirectory();
    created.handlesWithoutSyncAccess = this.handlesWithoutSyncAccess;
    this.directories.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FakeFileHandle> {
    if (!this.files.has(name)) {
      if (options.create !== true) throw named(`${name} was not found`, "NotFoundError");
      this.files.set(name, { bytes: new Uint8Array(0) });
    }
    const handle = new FakeFileHandle(this, name);
    if (this.handlesWithoutSyncAccess) {
      delete (handle as { createSyncAccessHandle?: unknown }).createSyncAccessHandle;
      Object.defineProperty(handle, "createSyncAccessHandle", { value: undefined, configurable: true });
    }
    return handle;
  }

  async removeEntry(name: string): Promise<void> {
    if (this.locked.has(name)) throw named(`${name} is locked`, "NoModificationAllowedError");
    if (!this.files.delete(name)) throw named(`${name} was not found`, "NotFoundError");
  }

  async *entries(): AsyncIterableIterator<[string, { readonly kind: "file" | "directory" }]> {
    for (const name of [...this.files.keys()]) yield [name, { kind: "file" }];
    for (const [name, value] of this.directories) yield [name, { kind: value.kind }];
  }
}

/** Safari 17/18 shape: a sync access handle and no `createWritable` at all. */
class FakeFileHandle {
  constructor(private readonly directory: FakeDirectory, private readonly name: string) {}

  async getFile(): Promise<{ stream(): ReadableStream<Uint8Array>; text(): Promise<string> }> {
    const bytes = this.#entry().bytes.slice();
    return {
      stream: () => new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); controller.close(); },
      }),
      text: async () => new TextDecoder().decode(bytes),
    };
  }

  async createSyncAccessHandle(): Promise<{
    write(data: Uint8Array, options?: { at?: number }): number;
    truncate(size: number): void;
    flush(): void;
    close(): void;
  }> {
    if (this.directory.locked.has(this.name)) throw named(`${this.name} is locked`, "NoModificationAllowedError");
    this.directory.locked.add(this.name);
    const entry = this.#entry();
    const directory = this.directory;
    const name = this.name;
    let closed = false;
    return {
      write: (data, options = {}) => {
        if (closed) throw named("handle is closed", "InvalidStateError");
        const at = options.at ?? 0;
        const size = Math.max(entry.bytes.byteLength, at + data.byteLength);
        const grown = new Uint8Array(size);
        grown.set(entry.bytes, 0);
        grown.set(data, at);
        entry.bytes = grown;
        return data.byteLength;
      },
      truncate: (size) => {
        if (closed) throw named("handle is closed", "InvalidStateError");
        entry.bytes = entry.bytes.slice(0, size);
      },
      flush: () => { if (closed) throw named("handle is closed", "InvalidStateError"); },
      close: () => { closed = true; directory.locked.delete(name); },
    };
  }

  #entry(): FakeEntry {
    const entry = this.directory.files.get(this.name);
    if (entry === undefined) throw named(`${this.name} was not found`, "NotFoundError");
    return entry;
  }
}

let workerInstance = 0;

/** Loads a private instance of the real Worker module and speaks the wire protocol to it. */
function fakeOpfsWorker(root: FakeDirectory, options: { readonly scopeWithoutSyncAccess?: boolean; readonly withholdWriteOpen?: boolean } = {}): OpfsWorkerLike {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const emit = (type: string, event: unknown) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };
  const scope: { onmessage: ((event: { data: OpfsWorkerRequest }) => void) | null } = { onmessage: null };
  const worker = {
    onmessage: scope.onmessage,
    postMessage: (message: OpfsWorkerResponse) => {
      queueMicrotask(() => emit("message", { data: structuredClone(message) }));
    },
  };
  const inbox: OpfsWorkerRequest[] = [];
  let terminated = false;
  let live = false;
  const ownedHandles: Array<{ readonly close: () => void }> = [];
  Object.defineProperty(globalThis, "self", { value: worker, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", {
    value: { storage: { getDirectory: async () => root } },
    configurable: true,
    writable: true,
  });
  // The Worker scope is the only place createSyncAccessHandle is exposed, so
  // that is where the store's write support is decided.
  Object.defineProperty(globalThis, "FileSystemFileHandle", {
    value: options.scopeWithoutSyncAccess === true ? class { async getFile() { } } : FakeFileHandle,
    configurable: true,
    writable: true,
  });
  const loaded = import(`../src/internal/engine-web-opfs-worker.js?instance=${workerInstance++}`)
    .then(() => {
      live = true;
      const drained = inbox.splice(0);
      if (!terminated) for (const message of drained) worker.onmessage?.({ data: message } as never);
    });
  return {
    postMessage(message: OpfsWorkerRequest) {
      if (terminated) return;
      const cloned = structuredClone(message);
      if (options.withholdWriteOpen === true && cloned.type === "write-open") {
        queueMicrotask(async () => {
          const folder = await root.getDirectoryHandle(cloned.folderName, { create: true });
          const file = await folder.getFileHandle(cloned.name, { create: true });
          const handle = await file.createSyncAccessHandle();
          ownedHandles.push({ close: handle.close });
          inbox.push(cloned);
        });
        return;
      }
      if (live) worker.onmessage?.({ data: cloned } as never);
      else { inbox.push(cloned); void loaded; }
    },
    terminate() { terminated = true; live = false; for (const handle of ownedHandles.splice(0)) handle.close(); },
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
}

function backendFor(root: FakeDirectory, folderName: string): OpfsStorageBackend {
  return new OpfsStorageBackend({
    folderName,
    storage: { getDirectory: async () => root } as never,
    createWorker: () => fakeOpfsWorker(root),
    readDeadlineMs: 5_000,
  });
}

test("a timed-out writer open terminates its generation and ignores a late reply", async () => {
  const workers: Array<{
    readonly messages: OpfsWorkerRequest[];
    readonly emit: (message: OpfsWorkerResponse) => void;
    readonly terminated: () => boolean;
  }> = [];
  const backend = new OpfsStorageBackend({
    folderName: "opfs-late-open-v1",
    storage: { getDirectory: async () => new FakeDirectory() } as never,
    readDeadlineMs: 30,
    createWorker: () => {
      const listeners = new Set<(event: MessageEvent<OpfsWorkerResponse>) => void>();
      const messages: OpfsWorkerRequest[] = [];
      let dead = false;
      const worker = {
        postMessage(message: OpfsWorkerRequest) {
          if (!dead) messages.push(message);
        },
        terminate() { dead = true; },
        addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void) {
          if (type === "message") listeners.add(listener);
        },
        removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void) {
          if (type === "message") listeners.delete(listener);
        },
      } satisfies OpfsWorkerLike;
      const entry = {
        messages,
        emit(message: OpfsWorkerResponse) {
          if (!dead) for (const listener of [...listeners]) listener({ data: message } as never);
        },
        terminated: () => dead,
      };
      workers.push(entry);
      queueMicrotask(() => entry.emit({ type: "worker-ready", writeSupport: true }));
      return worker;
    },
  });
  await backend.open();
  await assert.rejects(backend.createWriter("staging-timeout"), (error: unknown) =>
    error instanceof DOMException && error.name === "TimeoutError");
  const worker = workers.at(-1)!;
  const request = worker.messages.find((message) => message.type === "write-open")!;
  worker.emit({ type: "opfs-ok", requestId: request.requestId });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(worker.terminated(), true);
});

function historicalWorkerHarness(options: { readonly ready?: boolean } = {}) {
  const listeners = new Set<(event: MessageEvent<OpfsWorkerResponse>) => void>();
  const history = new Set<(event: MessageEvent<OpfsWorkerResponse>) => void>();
  const errors = new Set<(event: ErrorEvent) => void>();
  const errorHistory = new Set<(event: ErrorEvent) => void>();
  const messageErrors = new Set<(event?: unknown) => void>();
  const messageErrorHistory = new Set<(event?: unknown) => void>();
  const messages: OpfsWorkerRequest[] = [];
  let terminations = 0;
  const worker = {
    postMessage(message: OpfsWorkerRequest) { messages.push(message); },
    terminate() { terminations += 1; },
    addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void) {
      if (type === "message") { listeners.add(listener); history.add(listener); }
      if (type === "error") { errors.add(listener); errorHistory.add(listener); }
      if (type === "messageerror") { messageErrors.add(listener); messageErrorHistory.add(listener); }
    },
    removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void) {
      if (type === "message") listeners.delete(listener);
      if (type === "error") errors.delete(listener);
      if (type === "messageerror") messageErrors.delete(listener);
    },
  } satisfies OpfsWorkerLike;
  const emit = (message: OpfsWorkerResponse) => {
    for (const listener of [...history]) listener({ data: message } as never);
  };
  const emitError = (error = new Error("historical worker error")) => {
    for (const listener of [...errorHistory]) listener({ error, message: error.message } as never);
  };
  const emitMessageError = () => { for (const listener of [...messageErrorHistory]) listener(); };
  if (options.ready === true) queueMicrotask(() => emit({ type: "worker-ready", writeSupport: true }));
  return { worker, messages, emit, emitError, emitMessageError, listeners, history, errors, messageErrors, get terminations() { return terminations; } };
}

/** Retains removed callbacks deliberately, so stale delivery is real. */
function controlledWorkerHarness() {
  type Message = (event: MessageEvent<OpfsWorkerResponse>) => void;
  type Failure = (event: ErrorEvent) => void;
  type CloneFailure = () => void;
  const listeners = new Set<Message>();
  const history = new Set<Message>();
  const errorListeners = new Set<Failure>();
  const errorHistory = new Set<Failure>();
  const messageErrorListeners = new Set<CloneFailure>();
  const messageErrorHistory = new Set<CloneFailure>();
  const messages: OpfsWorkerRequest[] = [];
  let terminations = 0;
  const worker = {
    postMessage(message: OpfsWorkerRequest) { messages.push(message); },
    terminate() { terminations += 1; },
    addEventListener(type: "message" | "error" | "messageerror", listener: Message | Failure | CloneFailure) {
      if (type === "message") { listeners.add(listener as Message); history.add(listener as Message); }
      if (type === "error") { errorListeners.add(listener as Failure); errorHistory.add(listener as Failure); }
      if (type === "messageerror") { messageErrorListeners.add(listener as CloneFailure); messageErrorHistory.add(listener as CloneFailure); }
    },
    removeEventListener(type: "message" | "error" | "messageerror", listener: Message | Failure | CloneFailure) {
      if (type === "message") listeners.delete(listener as Message);
      if (type === "error") errorListeners.delete(listener as Failure);
      if (type === "messageerror") messageErrorListeners.delete(listener as CloneFailure);
    },
  } satisfies OpfsWorkerLike;
  return {
    worker, messages, listeners, history, errorListeners, messageErrorListeners,
    counts: () => [listeners.size, errorListeners.size, messageErrorListeners.size],
    historicalCounts: () => [history.size, errorHistory.size, messageErrorHistory.size],
    emit(message: OpfsWorkerResponse) { for (const listener of history) listener({ data: message } as MessageEvent<OpfsWorkerResponse>); },
    emitError() { for (const listener of errorHistory) listener({ error: new Error("retired"), message: "retired" } as ErrorEvent); },
    emitMessageError() { for (const listener of messageErrorHistory) listener(); },
    get terminations() { return terminations; },
  };
}

for (const phase of ["handshake", "open", "write", "shared", "close"] as const) {
  test(`retired generation lifecycle accounting: ${phase}`, async () => {
    const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
    const originalSet = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
    let created = 0;
    let cleared = 0;
    let fired = 0;
    globalThis.setTimeout = ((callback: () => void) => {
      const id = ++created as unknown as ReturnType<typeof setTimeout>;
      timers.set(id, callback);
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      cleared += 1;
      timers.delete(id);
    }) as typeof clearTimeout;
    const first = controlledWorkerHarness();
    const second = controlledWorkerHarness();
    const oldLifetime = new AbortController();
    const freshLifetime = new AbortController();
    let generations = 0;
    const client = new OpfsWriteWorkerClient({ createWorker: () => (generations++ === 0 ? first : second).worker });
    let unsettled = 0;
    let settlements = 0;
    const tracked = <T>(promise: Promise<T>) => {
      unsettled += 1;
      return promise.then(value => { unsettled -= 1; settlements += 1; return { value }; }, error => {
        unsettled -= 1; settlements += 1; return { error: error as unknown };
      });
    };
    try {
      const count = phase === "shared" ? 2 : 1;
      const openings = Array.from({ length: count }, (_, i) => tracked(client.createWriter("folder", `old-${i}`, oldLifetime.signal)));
      if (phase !== "handshake") {
        first.emit({ type: "worker-ready", writeSupport: true });
        await flush();
      }
      const writers: Awaited<ReturnType<typeof client.createWriter>>[] = [];
      let pending = openings;
      if (phase === "write" || phase === "shared" || phase === "close") {
        for (const request of first.messages) first.emit({ type: "opfs-ok", requestId: request.requestId });
        for (const result of await Promise.all(openings)) { assert.ok("value" in result); writers.push(result.value); }
        // The tracked value is irrelevant here; keep one result shape for the table.
        pending = writers.map(writer => tracked(writer.write(new Uint8Array([1])).then(() => writer)));
      }
      const oldCreated = phase === "handshake" ? 1 : phase === "open" ? 2 : 1 + count * 2;
      assert.equal(getEventListeners(oldLifetime.signal, "abort").length, count, phase);
      assert.equal(created, oldCreated, phase);
      assert.equal(timers.size, phase === "handshake" ? 1 : count, phase);
      if (phase === "close") client.close();
      else {
        const [id, callback] = timers.entries().next().value!;
        timers.delete(id); fired += 1; callback();
      }
      // Replacement starts synchronously before old rejection continuations run.
      const replacement = tracked(client.createWriter("folder", "replacement", freshLifetime.signal));
      const replay = (requestId: number) => {
        first.emit({ type: "worker-ready", writeSupport: true });
        first.emit({ type: "opfs-ok", requestId });
        first.emitError();
        first.emitMessageError();
      };
      replay(999);
      assert.deepEqual(second.counts(), [2, 2, 2], phase);
      assert.equal(second.terminations, 0, phase);
      for (const result of await Promise.all(pending)) {
        assert.ok("error" in result);
        if (phase === "close") assert.ok(result.error instanceof EngineWebAdapterError && result.error.code === "session.closed");
        else assert.ok(result.error instanceof DOMException && result.error.name === "TimeoutError");
      }
      assert.deepEqual(first.counts(), [0, 0, 0], phase);
      assert.deepEqual(first.historicalCounts(), [2, 2, 2], phase);
      assert.equal(first.terminations, 1, phase);
      assert.equal(getEventListeners(oldLifetime.signal, "abort").length, 0, phase);
      assert.equal(first.messages.length, oldCreated - 1, phase);
      assert.equal(timers.size, 1, phase);
      assert.equal(unsettled, 1, phase);
      second.emit({ type: "worker-ready", writeSupport: true });
      await flush();
      assert.equal(second.terminations, 0, "retired open catch must preserve replacement");
      assert.equal(second.messages.length, 1, "replacement posts its own open");
      const open = second.messages[0]!;
      replay(open.requestId); // deliberately colliding ID tests the actual receive guard
      await flush();
      assert.equal(unsettled, 1, "old success cannot acknowledge replacement open");
      assert.equal(timers.size, 1, phase);
      second.emit({ type: "opfs-ok", requestId: open.requestId });
      const fresh = await replacement;
      assert.ok("value" in fresh);
      replay(open.requestId);
      for (const writer of writers) {
        await assert.rejects(writer.write(new Uint8Array([2])), { code: "session.closed" });
        if (writer === writers[1]) await writer.abort(new Error("old"));
        else await assert.rejects(writer.close(), { code: "session.closed" });
      }
      assert.equal(second.messages.length, 1, phase);
      assert.equal(second.terminations, 0, "stale writer release must preserve replacement ownership");
      assert.deepEqual(second.counts(), [1, 1, 1], phase);
      oldLifetime.abort(new Error("retired lifetime"));
      assert.equal(client.workersActive, 1, phase);
      assert.equal(getEventListeners(freshLifetime.signal, "abort").length, 1, phase);
      assert.equal(unsettled, 0, phase);
      assert.equal(timers.size, 0, phase);
      assert.equal(created, oldCreated + 2, phase);
      assert.equal(cleared, created, phase);
      assert.equal(fired, phase === "close" ? 0 : 1, phase);
      assert.equal(settlements, (writers.length ? count * 2 : count) + 1, phase);
      const closing = tracked(fresh.value.close());
      const close = second.messages[1]!;
      second.emit({ type: "opfs-ok", requestId: close.requestId });
      await closing;
      assert.equal(second.terminations, 1, phase);
      assert.equal(getEventListeners(freshLifetime.signal, "abort").length, 0, phase);
      assert.deepEqual(second.counts(), [0, 0, 0], phase);
      assert.equal(second.messages.length, 2, phase);
      assert.equal(created, oldCreated + 3, phase);
      assert.equal(cleared, created, phase);
      assert.equal(unsettled + timers.size, 0, phase);
    } finally {
      client.close();
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    }
  });
}

test("a never-ready generation times out once and a late ready cannot poison its replacement", async () => {
  const generations = [controlledWorkerHarness(), controlledWorkerHarness()];
  let next = 0;
  const client = new OpfsWriteWorkerClient({ deadlineMs: 15, createWorker: () => generations[next++]!.worker });
  await assert.rejects(client.createWriter("folder", "never-ready"), (error: unknown) =>
    error instanceof DOMException && error.name === "TimeoutError");
  assert.equal(generations[0]!.terminations, 1);
  assert.equal(generations[0]!.listeners.size, 0);
  assert.equal(generations[0]!.errorListeners.size, 0);
  assert.equal(generations[0]!.messageErrorListeners.size, 0);
  generations[0]!.emit({ type: "worker-ready", writeSupport: true });
  generations[0]!.emitError();
  generations[0]!.emitMessageError();
  const opening = client.createWriter("folder", "fresh");
  generations[1]!.emit({ type: "worker-ready", writeSupport: true });
  await new Promise((resolve) => setImmediate(resolve));
  const open = generations[1]!.messages.find((message) => message.type === "write-open")!;
  generations[1]!.emit({ type: "opfs-ok", requestId: open.requestId });
  const writer = await opening;
  const closing = writer.close();
  await new Promise((resolve) => setImmediate(resolve));
  const close = generations[1]!.messages.find((message) => message.type === "write-close")!;
  generations[1]!.emit({ type: "opfs-ok", requestId: close.requestId });
  await closing;
  assert.equal(generations[1]!.terminations, 1);
});

test("close during handshake, open, and write settles once and permits a fresh generation", async () => {
  const phases = ["handshake", "open", "write"] as const;
  for (const phase of phases) {
    const first = controlledWorkerHarness();
    const second = controlledWorkerHarness();
    let generation = 0;
    const client = new OpfsWriteWorkerClient({ deadlineMs: 100, createWorker: () => (generation++ === 0 ? first.worker : second.worker) });
    const opening = client.createWriter("folder", phase);
    if (phase !== "handshake") {
      first.emit({ type: "worker-ready", writeSupport: true });
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (phase === "write") {
      const open = first.messages.find((message) => message.type === "write-open")!;
      first.emit({ type: "opfs-ok", requestId: open.requestId });
      const writer = await opening;
      const pending = writer.write(new Uint8Array([1]));
      client.close();
      await assert.rejects(pending, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.closed");
    } else {
      client.close();
      await assert.rejects(opening, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.closed");
    }
    client.close();
    assert.equal(first.terminations, 1);
    const replacement = client.createWriter("folder", "replacement");
    second.emit({ type: "worker-ready", writeSupport: true });
    await new Promise((resolve) => setImmediate(resolve));
    const open = second.messages.find((message) => message.type === "write-open")!;
    second.emit({ type: "opfs-ok", requestId: open.requestId });
    const writer = await replacement;
    const closing = writer.close();
    await new Promise((resolve) => setImmediate(resolve));
    const close = second.messages.find((message) => message.type === "write-close")!;
    second.emit({ type: "opfs-ok", requestId: close.requestId });
    await closing;
    assert.equal(second.terminations, 1);
  }
});

test("a shared writer timeout rejects both writers and leaves stale events inert", async () => {
  const first = controlledWorkerHarness();
  const second = controlledWorkerHarness();
  let generation = 0;
  const client = new OpfsWriteWorkerClient({ deadlineMs: 15, createWorker: () => (generation++ === 0 ? first.worker : second.worker) });
  const firstOpening = client.createWriter("folder", "one");
  const secondOpening = client.createWriter("folder", "two");
  first.emit({ type: "worker-ready", writeSupport: true });
  await new Promise((resolve) => setImmediate(resolve));
  const opens = first.messages.filter((message) => message.type === "write-open");
  for (const open of opens) first.emit({ type: "opfs-ok", requestId: open.requestId });
  const [one, two] = await Promise.all([firstOpening, secondOpening]);
  const oneWrite = one.write(new Uint8Array([1]));
  const twoWrite = two.write(new Uint8Array([2]));
  await assert.rejects(oneWrite, (error: unknown) => error instanceof DOMException && error.name === "TimeoutError");
  await assert.rejects(twoWrite, (error: unknown) => error instanceof DOMException && error.name === "TimeoutError");
  assert.equal(first.terminations, 1);
  for (const message of first.messages.filter((value) => value.type === "write")) {
    first.emit({ type: "opfs-ok", requestId: message.requestId });
  }
  await assert.rejects(one.write(new Uint8Array([3])), (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.closed");
  const replacement = client.createWriter("folder", "new");
  second.emit({ type: "worker-ready", writeSupport: true });
  await new Promise((resolve) => setImmediate(resolve));
  const open = second.messages.find((message) => message.type === "write-open")!;
  second.emit({ type: "opfs-ok", requestId: open.requestId });
  const writer = await replacement;
  const closing = writer.close();
  await new Promise((resolve) => setImmediate(resolve));
  const close = second.messages.find((message) => message.type === "write-close")!;
  second.emit({ type: "opfs-ok", requestId: close.requestId });
  await closing;
});

test("termination closes the only owned physical lock and preserves unrelated files", async () => {
  const root = new FakeDirectory();
  const backend = backendFor(root, "opfs-owned-lock-v1");
  await backend.open();
  const writer = await backend.createWriter("owned");
  await writer.write(new Uint8Array([1]));
  const folder = root.directories.get("opfs-owned-lock-v1")!;
  folder.files.set("unrelated", { bytes: new Uint8Array([9]) });
  await writer.abort(new Error("terminate"));
  assert.equal(folder.locked.size, 0);
  assert.deepEqual([...folder.files.get("unrelated")!.bytes], [9]);
});

test("timed staging open maps stem.read_deadline and preserves verified bytes and index", async () => {
  const cachedBytes = new Uint8Array([4, 5, 6]);
  const cachedHash = new IncrementalSha256();
  cachedHash.update(cachedBytes);
  const cachedIdentity = `sha256:${cachedHash.digestHex()}` as StemIdentity;
  const bytes = new Uint8Array([7, 8, 9]);
  const contentHash = new IncrementalSha256();
  contentHash.update(bytes);
  const identity = `sha256:${contentHash.digestHex()}` as StemIdentity;
  const finalName = `sha256-${cachedIdentity.slice("sha256:".length)}`;
  const index = JSON.stringify({ version: 1, stems: { [cachedIdentity]: { bytes: cachedBytes.byteLength, pins: [], lastUsedAt: 1 } } }) + "\n";
  const root = new FakeDirectory();
  const folder = new FakeDirectory();
  root.directories.set("opfs-store-timeout-v1", folder);
  folder.files.set(finalName, { bytes: cachedBytes.slice() });
  folder.files.set("index.json", { bytes: new TextEncoder().encode(index) });
  folder.files.set("staging-foreign", { bytes: new Uint8Array([8]) });
  const backend = new OpfsStorageBackend({
    folderName: "opfs-store-timeout-v1",
    storage: { getDirectory: async () => root } as never,
    readDeadlineMs: 1_000,
    createWorker: () => fakeOpfsWorker(root, { withholdWriteOpen: true }),
  });
  await backend.open();
  const unrelated = await folder.getFileHandle("unrelated", { create: true });
  const unrelatedHandle = await unrelated.createSyncAccessHandle();
  const store = new VerifiedStemStore({ backend, instanceId: "owned", readDeadlineMs: 20 });
  const beforeIndex = folder.files.get("index.json")!.bytes.slice();
  const started = performance.now();
  const session = store.openSession({
    leaseId: "lease-timeout",
    stems: [{ sourceId: "source", identity, bytes: bytes.byteLength }],
    resolver: { async resolve() { return { stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) }; } },
  });
  await assert.rejects(session, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.read_deadline");
  assert.ok(performance.now() - started < 250, "store cancellation does not wait for the worker deadline");
  assert.deepEqual([...folder.files.get(finalName)!.bytes], [...cachedBytes]);
  assert.deepEqual([...folder.files.get("index.json")!.bytes], [...beforeIndex]);
  assert.equal(folder.files.has(`staging-owned-${identity.slice("sha256:".length)}`), false);
  assert.deepEqual([...folder.files.get("staging-foreign")!.bytes], [8]);
  assert.equal(folder.locked.has("unrelated"), true);
  unrelatedHandle.close();
});

test("OPFS removal retries transient locks and bounds permanent locks and stalled removal", async () => {
  for (const scenario of ["transient", "permanent", "stalled", "other"] as const) {
    const root = new FakeDirectory();
    const folder = await root.getDirectoryHandle("remove", { create: true });
    folder.files.set("owned", { bytes: new Uint8Array([1]) });
    folder.files.set("sentinel", { bytes: new Uint8Array([9]) });
    let attempts = 0;
    const remove = folder.removeEntry.bind(folder);
    folder.removeEntry = async name => {
      assert.equal(name, "owned");
      attempts += 1;
      if (scenario === "stalled") return await new Promise<void>(() => undefined);
      if (scenario === "other") throw named("denied", "SecurityError");
      if (scenario === "permanent" || attempts < 3) throw named("locked", "NoModificationAllowedError");
      await remove(name);
    };
    const backend = new OpfsStorageBackend({
      folderName: "remove", storage: { getDirectory: async () => root } as never,
      createWorker: () => fakeOpfsWorker(root), readDeadlineMs: 35,
    });
    await backend.open();
    const started = performance.now();
    if (scenario === "transient") {
      await backend.remove("owned");
      assert.equal(attempts, 3);
      assert.equal(folder.files.has("owned"), false);
    } else {
      await assert.rejects(backend.remove("owned"), { name: scenario === "other" ? "SecurityError" : "TimeoutError" });
      assert.equal(folder.files.has("owned"), true);
      if (scenario === "permanent") assert.ok(attempts >= 2 && attempts <= 5, `bounded attempts: ${attempts}`);
      else assert.equal(attempts, 1);
      assert.ok(performance.now() - started < 250, "one bounded removal budget");
    }
    assert.deepEqual([...folder.files.get("sentinel")!.bytes], [9]);
  }
});

test("a timed-out write invalidates the writer and makes its historical reply inert", async () => {
  const generation = historicalWorkerHarness();
  const client = new OpfsWriteWorkerClient({ deadlineMs: 10, createWorker: () => generation.worker });
  const opening = client.createWriter("folder", "write-timeout");
  await new Promise((resolve) => setImmediate(resolve));
  generation.emit({ type: "worker-ready", writeSupport: true });
  await new Promise((resolve) => setImmediate(resolve));
  const open = generation.messages.find((message) => message.type === "write-open")!;
  generation.emit({ type: "opfs-ok", requestId: open.requestId });
  const writer = await opening;
  const write = writer.write(new Uint8Array([1]));
  const request = generation.messages.find((message) => message.type === "write")!;
  await assert.rejects(write, (error: unknown) => error instanceof DOMException && error.name === "TimeoutError");
  assert.equal(generation.terminations, 1);
  generation.emit({ type: "opfs-ok", requestId: request.requestId });
  await assert.rejects(writer.write(new Uint8Array([2])), (error: unknown) =>
    error instanceof EngineWebAdapterError && error.code === "session.closed");
});

test("OPFS staging is written through createSyncAccessHandle, never createWritable", async () => {
  const root = new FakeDirectory();
  const backend = backendFor(root, "opfs-write-v1");
  await backend.open();
  const writer = await backend.createWriter("staging-a");
  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.write(new Uint8Array([4, 5]));
  await writer.write("!");
  await writer.close();

  const folder = root.directories.get("opfs-write-v1")!;
  assert.deepEqual([...folder.files.get("staging-a")!.bytes], [1, 2, 3, 4, 5, 0x21]);
  assert.equal(await backend.readText("staging-a"), "!");
  // No handle in this fake defines createWritable; reaching for it would throw.
  assert.equal("createWritable" in FakeFileHandle.prototype, false);
  // The Worker is released once the last writer settles.
  assert.equal(folder.locked.size, 0);
});

test("aborting an OPFS writer discards its bytes and closes the sync access handle", async () => {
  const root = new FakeDirectory();
  const backend = backendFor(root, "opfs-abort-v1");
  await backend.open();
  const writer = await backend.createWriter("staging-b");
  await writer.write(new Uint8Array([9, 9, 9, 9]));
  await writer.abort(new Error("cancelled"));
  const folder = root.directories.get("opfs-abort-v1")!;
  assert.equal(folder.files.get("staging-b")!.bytes.byteLength, 0);
  assert.equal(folder.locked.size, 0);
  await assert.rejects(writer.write(new Uint8Array([1])), (error: unknown) =>
    error instanceof EngineWebAdapterError && error.code === "session.closed");
  // A released Worker does not block the next writer.
  const next = await backend.createWriter("staging-c");
  await next.write(new Uint8Array([7]));
  await next.close();
  assert.deepEqual([...folder.files.get("staging-c")!.bytes], [7]);
});

test("concurrent OPFS writers share one Worker and each own their own file", async () => {
  const root = new FakeDirectory();
  const backend = backendFor(root, "opfs-parallel-v1");
  await backend.open();
  const [first, second] = await Promise.all([backend.createWriter("staging-d"), backend.createWriter("staging-e")]);
  await Promise.all([first.write(new Uint8Array([1])), second.write(new Uint8Array([2]))]);
  await Promise.all([first.write(new Uint8Array([3])), second.write(new Uint8Array([4]))]);
  await Promise.all([first.close(), second.close()]);
  const folder = root.directories.get("opfs-parallel-v1")!;
  assert.deepEqual([...folder.files.get("staging-d")!.bytes], [1, 3]);
  assert.deepEqual([...folder.files.get("staging-e")!.bytes], [2, 4]);
  assert.equal(folder.locked.size, 0);
});

test("a Worker scope with no sync access handle refuses at open(), before any write", async () => {
  const root = new FakeDirectory();
  const backend = new OpfsStorageBackend({
    folderName: "opfs-refuse-v1",
    storage: { getDirectory: async () => root } as never,
    createWorker: () => fakeOpfsWorker(root, { scopeWithoutSyncAccess: true }),
    readDeadlineMs: 5_000,
  });
  await assert.rejects(backend.open(), (error: unknown) =>
    error instanceof EngineWebAdapterError
    && error.code === "capability.opfs"
    && error.details["missing"] === "FileSystemFileHandle.createSyncAccessHandle"
    && typeof error.details["remedy"] === "string");
  assert.equal(root.directories.size, 0, "no directory is created for a browser that cannot write");
});

test("a file handle without createSyncAccessHandle fails typed, never as a bare TypeError", async () => {
  const root = new FakeDirectory();
  root.handlesWithoutSyncAccess = true;
  const backend = backendFor(root, "opfs-handle-v1");
  await backend.open();
  await assert.rejects(backend.createWriter("staging-f"), (error: unknown) =>
    error instanceof EngineWebAdapterError
    && error.code === "capability.opfs"
    && error.details["missing"] === "FileSystemFileHandle.createSyncAccessHandle");
});

test("the verified store ingests, promotes, and rereads canonical PCM on the OPFS backend", async () => {
  const root = new FakeDirectory();
  const backend = backendFor(root, "opfs-store-v1");
  const bytes = new Uint8Array(4_096);
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = (index * 31) & 0xff;
  const hash = new IncrementalSha256();
  hash.update(bytes);
  const digest = hash.digestHex();
  const identity = `sha256:${digest}` as StemIdentity;
  const store = new VerifiedStemStore({ backend, readDeadlineMs: 5_000 });
  const requirement = { sourceId: "source-000", identity, bytes: bytes.byteLength };
  const resolver = {
    async resolve() {
      return {
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 1_000));
            controller.enqueue(bytes.subarray(1_000));
            controller.close();
          },
        }),
      };
    },
  };

  const lease = await store.openSession({ leaseId: "lease-000", stems: [requirement], resolver });
  const blob = await lease.read(identity);
  assert.deepEqual(await collect(blob.stream()), bytes);
  const folder = root.directories.get("opfs-store-v1")!;
  assert.deepEqual(
    [...folder.files.keys()].sort(),
    ["index.json", `sha256-${digest}`].sort(),
  );
  assert.equal(folder.locked.size, 0);

  // Warm reopen verifies from OPFS without resolving again.
  let resolved = false;
  const warm = await store.openSession({
    leaseId: "lease-001",
    stems: [requirement],
    resolver: { async resolve() { resolved = true; throw new Error("unreachable"); } },
  });
  assert.equal(resolved, false);
  await warm.close();
  await lease.close();
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function named(message: string, name: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
