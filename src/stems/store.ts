import { EngineWebAdapterError } from "../errors.js";
import { assertStemIdentity } from "./identity.js";
import { deadline, IncrementalSha256, sha256Stream } from "./sha256.js";
import type { BoundedStemAdmission } from "./flac-admission.js";
import { OpfsStorageBackend } from "./storage.js";
import type { StemStorageBackend, StemStorageWriter } from "./storage.js";
import type {
  StemIdentity,
  StemProgress,
  StemRequirement,
  StemResolver,
  StemSessionLease,
  StemStore,
} from "./types.js";

const INDEX_FILE = "index.json";
const INDEX_TEMP = "index.pending";
const FINAL_PREFIX = "sha256-";
const STAGING_PREFIX = "staging-";
const INDEX_VERSION = 1;

interface IndexRow { bytes: number; pins: string[]; lastUsedAt: number }
interface StoreIndex { version: 1; stems: Record<string, IndexRow> }
interface SharedState { locks: Map<string, Promise<void>>; flights: Map<string, Promise<void>> }
const SHARED = new WeakMap<object, SharedState>();

function sharedFor(backend: StemStorageBackend): SharedState {
  let shared = SHARED.get(backend as object);
  if (shared === undefined) {
    shared = { locks: new Map(), flights: new Map() };
    SHARED.set(backend as object, shared);
  }
  return shared;
}

export interface WebLockProvider {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive"; readonly signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
  query?(): Promise<{
    readonly held?: readonly { readonly name?: string }[];
    readonly pending?: readonly { readonly name?: string }[];
  }>;
}

export interface VerifiedStemStoreOptions {
  readonly backend?: StemStorageBackend;
  readonly locks?: WebLockProvider;
  readonly now?: () => number;
  readonly instanceId?: string;
  readonly readDeadlineMs?: number;
}

/**
 * Verify-on-every-open canonical PCM store. A final/index row becomes visible
 * only after exact byte count and incremental SHA-256 both match.
 */
export class VerifiedStemStore implements StemStore {
  readonly #backend: StemStorageBackend;
  readonly #locks: WebLockProvider | undefined;
  readonly #now: () => number;
  readonly #instanceId: string;
  readonly #readDeadlineMs: number;
  readonly #shared: SharedState;
  #opened: Promise<void> | undefined;

  constructor(options: VerifiedStemStoreOptions = {}) {
    this.#backend = options.backend ?? new OpfsStorageBackend();
    this.#locks = options.locks ?? browserLocks();
    this.#now = options.now ?? Date.now;
    this.#instanceId = options.instanceId ?? randomId();
    this.#readDeadlineMs = positive(options.readDeadlineMs ?? 30_000, "readDeadlineMs");
    this.#shared = sharedFor(this.#backend);
  }

  async open(): Promise<this> {
    this.#opened ??= this.#openOnce();
    try {
      await this.#opened;
      return this;
    } catch (error) {
      this.#opened = undefined;
      throw classify(error, "capability.opfs", "Unable to open origin-private stem storage");
    }
  }

  async openSession(options: {
    readonly leaseId: string;
    readonly stems: readonly StemRequirement[];
    readonly resolver: StemResolver;
    readonly admission?: BoundedStemAdmission;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: StemProgress) => void;
  }): Promise<StemSessionLease> {
    await this.open();
    const leaseId = nonempty(options.leaseId, "leaseId");
    if (typeof options.resolver?.resolve !== "function") throw new TypeError("openSession needs a StemResolver");
    const declared = normalizeRequirements(options.stems);
    const unique = uniqueRequirements(declared);
    if (options.signal?.aborted) {
      throw new EngineWebAdapterError("stem.cancelled", "Stem session open was cancelled", {}, options.signal.reason);
    }

    const controller = new AbortController();
    const detach = forwardAbort(options.signal, controller);
    try {
      await runBounded(
        unique,
        options.admission?.limit ?? 1,
        (stem) => this.#ensure(stem, options.resolver, controller.signal, options.onProgress, options.admission),
        (error) => controller.abort(error),
      );
    } catch (error) {
      if (options.signal?.aborted || isAbort(error)) {
        throw new EngineWebAdapterError("stem.cancelled", "Stem session open was cancelled", {}, error);
      }
      throw error;
    } finally {
      detach();
    }
    if (options.signal?.aborted) {
      throw new EngineWebAdapterError("stem.cancelled", "Stem session open was cancelled", {}, options.signal.reason);
    }

    // Pin only after every content identity crossed the hard verification gate.
    const pin = `session:${this.#instanceId}:${leaseId}`;
    await this.#mutateIndex((index) => {
      for (const stem of unique) {
        const row = index.stems[stem.identity];
        if (row === undefined || row.bytes !== stem.bytes) {
          throw new EngineWebAdapterError("stem.corrupt", "Verified stem disappeared before leasing", {
            identity: stem.identity,
          });
        }
        if (!row.pins.includes(pin)) row.pins.push(pin);
        row.lastUsedAt = this.#now();
      }
    }, options.signal);

    options.onProgress?.({ stage: "ready", sourcesReady: declared.length, sourcesTotal: declared.length });
    return new VerifiedStemSessionLease(this, leaseId, pin, declared);
  }

  async verify(identity: StemIdentity, expectedBytes?: number, signal?: AbortSignal): Promise<boolean> {
    await this.open();
    assertStemIdentity(identity);
    return this.#withLock(this.#stemLock(identity), signal, async () => {
      const index = await this.#readIndex();
      const row = index.stems[identity];
      if (row === undefined || (expectedBytes !== undefined && row.bytes !== expectedBytes)) return false;
      return this.#verifyFile(identity, row.bytes, signal);
    });
  }

  async read(identity: StemIdentity): Promise<Blob> {
    await this.open();
    assertStemIdentity(identity);
    const index = await this.#readIndex();
    if (index.stems[identity] === undefined) {
      throw new EngineWebAdapterError("stem.not_found", `Stem is not indexed: ${identity}`, { identity });
    }
    try {
      return await deadline(this.#backend.read(finalName(identity)), this.#readDeadlineMs);
    } catch (error) {
      await this.#demote(identity).catch(() => undefined);
      throw classify(error, "stem.corrupt", `Stored stem cannot be read: ${identity}`, { identity });
    }
  }

  async release(pin: string, stems: readonly StemRequirement[]): Promise<void> {
    await this.#mutateIndex((index) => {
      for (const identity of new Set(stems.map((stem) => stem.identity))) {
        const row = index.stems[identity];
        if (row !== undefined) row.pins = row.pins.filter((candidate) => candidate !== pin);
      }
    });
  }

  async #openOnce(): Promise<void> {
    await this.#backend.open();
    await this.#withLock("index", undefined, async () => {
      const liveLocks = await this.#liveLockNames();
      for (const name of await this.#backend.list()) {
        if (name === INDEX_TEMP) await this.#backend.remove(name);
        if (name.startsWith(STAGING_PREFIX) && liveLocks !== undefined && !liveLocks.has(lockForStorageName(name))) {
          await this.#backend.remove(name);
        }
      }
      const index = await this.#readIndex(liveLocks);
      for (const name of await this.#backend.list()) {
        if (name.startsWith(FINAL_PREFIX)) {
          const identity = `sha256:${name.slice(FINAL_PREFIX.length)}`;
          if (!Object.hasOwn(index.stems, identity) && liveLocks !== undefined && !liveLocks.has(lockForStorageName(name))) {
            await this.#backend.remove(name);
          }
        }
      }
    });
  }

  async #ensure(
    stem: StemRequirement,
    resolver: StemResolver,
    signal: AbortSignal,
    onProgress?: (progress: StemProgress) => void,
    admission?: BoundedStemAdmission,
  ): Promise<void> {
    const prior = this.#shared.flights.get(stem.identity);
    if (prior !== undefined) return prior;
    const flight = this.#withLock(this.#stemLock(stem.identity), signal, async () => {
      const verified = admission === undefined
        ? await this.#verifyIndexed(stem, signal, onProgress)
        : await admission.run(() => this.#verifyIndexed(stem, signal, onProgress), signal);
      if (verified) return;
      await this.#ingest(stem, resolver, signal, onProgress);
    });
    this.#shared.flights.set(stem.identity, flight);
    try {
      await flight;
    } finally {
      if (this.#shared.flights.get(stem.identity) === flight) this.#shared.flights.delete(stem.identity);
    }
  }

  async #verifyIndexed(
    stem: StemRequirement,
    signal: AbortSignal,
    onProgress?: (progress: StemProgress) => void,
  ): Promise<boolean> {
    const index = await this.#readIndex();
    const row = index.stems[stem.identity];
    if (row === undefined) return false;
    if (row.bytes !== stem.bytes) {
      if (await this.#verifyFile(stem.identity, row.bytes, signal, onProgress)) {
        throw new EngineWebAdapterError("stem.invalid_declaration", "Declared byte count conflicts with verified cached content", {
          identity: stem.identity, cachedBytes: row.bytes, declaredBytes: stem.bytes,
        });
      }
      await this.#demote(stem.identity);
      return false;
    }
    if (!(await this.#verifyFile(stem.identity, stem.bytes, signal, onProgress))) {
      await this.#demote(stem.identity);
      return false;
    }
    return true;
  }

  async #verifyFile(
    identity: StemIdentity,
    bytes: number,
    signal?: AbortSignal,
    onProgress?: (progress: StemProgress) => void,
  ): Promise<boolean> {
    if (!(await this.#backend.exists(finalName(identity)))) return false;
    try {
      const blob = await deadline(this.#backend.read(finalName(identity)), this.#readDeadlineMs, signal);
      const observed = await sha256Stream(blob.stream(), {
        ...(signal === undefined ? {} : { signal }),
        readDeadlineMs: this.#readDeadlineMs,
        onChunk: (count) => onProgress?.({
          stage: "verifying", identity, bytes: count, totalBytes: bytes, byteKind: "pcm",
        }),
      });
      return observed.bytes === bytes && observed.hex === digest(identity);
    } catch (error) {
      if (isAbort(error)) throw error;
      return false;
    }
  }

  async #ingest(
    stem: StemRequirement,
    resolver: StemResolver,
    signal: AbortSignal,
    onProgress?: (progress: StemProgress) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.#preflight(stem.bytes);
    const staging = `${STAGING_PREFIX}${this.#instanceId}-${digest(stem.identity)}`;
    await this.#backend.remove(staging);
    let writer: StemStorageWriter | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let promoted = false;
    try {
      const resolved = await deadline(
        Promise.resolve(optionsResolve(resolver, stem.identity, signal, onProgress)),
        this.#readDeadlineMs,
        signal,
      );
      if (!(resolved.stream instanceof ReadableStream)) throw new TypeError("Resolver must return a ReadableStream");
      writer = await deadline(this.#backend.createWriter(staging), this.#readDeadlineMs, signal);
      reader = resolved.stream.getReader();
      const hash = new IncrementalSha256();
      let bytes = 0;
      while (true) {
        const result = await deadline(reader.read(), this.#readDeadlineMs, signal);
        if (result.done) break;
        if (!(result.value instanceof Uint8Array)) throw new TypeError("Resolver chunks must be Uint8Array");
        bytes += result.value.byteLength;
        if (bytes > stem.bytes) throw integrity(stem, bytes, "byte count exceeds declaration");
        hash.update(result.value);
        await deadline(writer.write(result.value), this.#readDeadlineMs, signal);
        onProgress?.({
          stage: "ingesting", sourceId: stem.sourceId, identity: stem.identity,
          bytes, totalBytes: stem.bytes, byteKind: "pcm",
        });
      }
      const observed = hash.digestHex();
      if (bytes !== stem.bytes || observed !== digest(stem.identity)) {
        throw integrity(stem, bytes, observed !== digest(stem.identity) ? "SHA-256 mismatch" : "truncated stream");
      }
      await deadline(writer.close(), this.#readDeadlineMs, signal);
      writer = undefined;
      await deadline(this.#backend.move(staging, finalName(stem.identity)), this.#readDeadlineMs, signal);
      promoted = true;
      await this.#mutateIndex((index) => {
        index.stems[stem.identity] = { bytes: stem.bytes, pins: [], lastUsedAt: this.#now() };
      }, signal);
    } catch (error) {
      await writer?.abort(error).catch(() => undefined);
      await this.#backend.remove(staging).catch(() => undefined);
      if (promoted) await this.#backend.remove(finalName(stem.identity)).catch(() => undefined);
      if (isQuota(error)) {
        throw new EngineWebAdapterError("stem.quota", "Origin-private storage quota is insufficient", {
          identity: stem.identity,
          requiredBytes: stem.bytes,
        }, error);
      }
      if (isTimeout(error)) {
        throw new EngineWebAdapterError("stem.read_deadline", `Stem made no progress: ${stem.identity}`, {
          identity: stem.identity,
          milliseconds: this.#readDeadlineMs,
        }, error);
      }
      throw error;
    } finally {
      if (signal.aborted) await reader?.cancel(signal.reason).catch(() => undefined);
      try { reader?.releaseLock(); } catch { /* deadline may leave a read pending */ }
    }
  }

  async #preflight(requiredBytes: number): Promise<void> {
    const estimate: { readonly quota?: number; readonly usage?: number } =
      await this.#backend.estimate?.().catch(() => ({})) ?? {};
    if (estimate?.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < requiredBytes) {
      throw new EngineWebAdapterError("stem.quota", "Origin-private storage quota is insufficient", {
        requiredBytes,
        availableBytes: Math.max(0, estimate.quota - estimate.usage),
      });
    }
  }

  async #demote(identity: StemIdentity): Promise<void> {
    await this.#backend.remove(finalName(identity));
    await this.#mutateIndex((index) => { delete index.stems[identity]; });
  }

  async #readIndex(liveLocks?: ReadonlySet<string>): Promise<StoreIndex> {
    try {
      const parsed: unknown = JSON.parse(await this.#backend.readText(INDEX_FILE));
      if (validIndex(parsed)) return parsed;
    } catch (error) {
      if (!isMissing(error)) {
        // Malformed and unreadable indexes take the same bounded recovery path.
      }
    }
    return this.#rebuildIndex(liveLocks ?? await this.#liveLockNames());
  }

  async #rebuildIndex(liveLocks: ReadonlySet<string> | undefined): Promise<StoreIndex> {
    const index = emptyIndex();
    for (const name of await this.#backend.list()) {
      if (!name.startsWith(FINAL_PREFIX) || name.length !== FINAL_PREFIX.length + 64) continue;
      if (liveLocks?.has(lockForStorageName(name))) continue;
      const identity = `sha256:${name.slice(FINAL_PREFIX.length)}` as StemIdentity;
      try {
        assertStemIdentity(identity);
        const blob = await this.#backend.read(name);
        const observed = await sha256Stream(blob.stream(), { readDeadlineMs: this.#readDeadlineMs });
        if (observed.hex === digest(identity)) {
          index.stems[identity] = { bytes: observed.bytes, pins: [], lastUsedAt: this.#now() };
        } else if (liveLocks !== undefined) {
          await this.#backend.remove(name);
        }
      } catch {
        if (liveLocks !== undefined) await this.#backend.remove(name).catch(() => undefined);
      }
    }
    await this.#writeIndex(index);
    return index;
  }

  async #liveLockNames(): Promise<ReadonlySet<string> | undefined> {
    if (this.#locks?.query === undefined) return undefined;
    try {
      const snapshot = await this.#locks.query();
      return new Set([...(snapshot.held ?? []), ...(snapshot.pending ?? [])]
        .map((lock) => lock.name).filter((name): name is string => typeof name === "string"));
    } catch {
      // Without a reliable liveness snapshot recovery keeps ambiguous files.
      return undefined;
    }
  }

  async #mutateIndex(mutation: (index: StoreIndex) => void, signal?: AbortSignal): Promise<void> {
    await this.#withLock("index", signal, async () => {
      const index = await this.#readIndex();
      mutation(index);
      await this.#writeIndex(index);
    });
  }

  async #writeIndex(index: StoreIndex): Promise<void> {
    const writer = await this.#backend.createWriter(INDEX_TEMP);
    try {
      await writer.write(`${JSON.stringify(index)}\n`);
      await writer.close();
      await this.#backend.move(INDEX_TEMP, INDEX_FILE);
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
      await this.#backend.remove(INDEX_TEMP).catch(() => undefined);
      throw error;
    }
  }

  #stemLock(identity: StemIdentity): string { return `stem:${digest(identity)}`; }

  async #withLock<T>(name: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (this.#locks !== undefined) return this.#locks.request(
      `miso:engine-web:v1:${name}`,
      { mode: "exclusive", ...(signal === undefined ? {} : { signal }) },
      work,
    );
    const prior = this.#shared.locks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => gate);
    this.#shared.locks.set(name, tail);
    await prior;
    try { signal?.throwIfAborted(); return await work(); }
    finally { release(); if (this.#shared.locks.get(name) === tail) this.#shared.locks.delete(name); }
  }
}

export class OpfsStemStore extends VerifiedStemStore {
  constructor(options: Omit<VerifiedStemStoreOptions, "backend"> & ConstructorParameters<typeof OpfsStorageBackend>[0] = {}) {
    const { folderName, storage, ...storeOptions } = options;
    super({
      ...storeOptions,
      backend: new OpfsStorageBackend({
        ...(folderName === undefined ? {} : { folderName }),
        ...(storage === undefined ? {} : { storage }),
        ...(options.readDeadlineMs === undefined ? {} : { readDeadlineMs: options.readDeadlineMs }),
      }),
    });
  }
}

class VerifiedStemSessionLease implements StemSessionLease {
  readonly #store: VerifiedStemStore;
  readonly #pin: string;
  readonly stems: readonly StemRequirement[];
  readonly leaseId: string;
  #closed = false;
  constructor(store: VerifiedStemStore, leaseId: string, pin: string, stems: readonly StemRequirement[]) {
    this.#store = store; this.leaseId = leaseId; this.#pin = pin;
    this.stems = Object.freeze(stems.map((stem) => Object.freeze({ ...stem })));
  }
  async read(identity: StemIdentity): Promise<Blob> {
    if (this.#closed) throw new EngineWebAdapterError("session.closed", "Stem session lease is closed");
    if (!this.stems.some((stem) => stem.identity === identity)) {
      throw new EngineWebAdapterError("stem.not_found", "Stem is not part of this lease", { identity });
    }
    return this.#store.read(identity);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#store.release(this.#pin, this.stems);
  }
}

function optionsResolve(
  resolver: StemResolver,
  identity: StemIdentity,
  signal: AbortSignal,
  onProgress?: (progress: StemProgress) => void,
) {
  return resolver.resolve(identity, {
    signal,
    ...(onProgress === undefined ? {} : { onProgress }),
  });
}
function normalizeRequirements(stems: readonly StemRequirement[]): readonly StemRequirement[] {
  if (!Array.isArray(stems)) throw new TypeError("stems must be an array");
  return stems.map((stem) => {
    assertStemIdentity(stem.identity);
    nonempty(stem.sourceId, "sourceId");
    if (!Number.isSafeInteger(stem.bytes) || stem.bytes <= 0) throw new RangeError("stem bytes must be positive");
    return Object.freeze({ ...stem });
  });
}
function uniqueRequirements(stems: readonly StemRequirement[]): StemRequirement[] {
  const unique = new Map<StemIdentity, StemRequirement>();
  for (const stem of stems) {
    const prior = unique.get(stem.identity);
    if (prior !== undefined && prior.bytes !== stem.bytes) {
      throw new EngineWebAdapterError("stem.invalid_declaration", "One content identity has conflicting byte counts", {
        identity: stem.identity, firstBytes: prior.bytes, secondBytes: stem.bytes,
      });
    }
    unique.set(stem.identity, prior ?? stem);
  }
  return [...unique.values()];
}
async function runBounded<T>(
  values: readonly T[],
  width: number,
  work: (value: T) => Promise<void>,
  onFirstError: (error: unknown) => void,
): Promise<void> {
  let cursor = 0;
  let failed = false;
  let firstError: unknown;
  const next = async () => {
    while (!failed && cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try {
        await work(values[index]!);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
          onFirstError(error);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, values.length) }, next));
  if (failed) throw firstError;
}
function integrity(stem: StemRequirement, observedBytes: number, reason: string): EngineWebAdapterError {
  return new EngineWebAdapterError("stem.corrupt", `Resolved stem failed verification: ${reason}`, {
    identity: stem.identity, expectedBytes: stem.bytes, observedBytes, reason,
  });
}
function emptyIndex(): StoreIndex { return { version: INDEX_VERSION, stems: {} }; }
function validIndex(value: unknown): value is StoreIndex {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoreIndex>;
  if (candidate.version !== 1 || typeof candidate.stems !== "object" || candidate.stems === null) return false;
  return Object.entries(candidate.stems).every(([identity, row]) => {
    try { assertStemIdentity(identity); } catch { return false; }
    return typeof row === "object" && row !== null && Number.isSafeInteger(row.bytes) && row.bytes > 0 &&
      Number.isFinite(row.lastUsedAt) && Array.isArray(row.pins) && row.pins.every((pin) => typeof pin === "string");
  });
}
function finalName(identity: StemIdentity): string { return `${FINAL_PREFIX}${digest(identity)}`; }
function lockForStorageName(name: string): string {
  return `miso:engine-web:v1:stem:${name.slice(-64)}`;
}
function digest(identity: StemIdentity): string { return identity.slice("sha256:".length); }
function nonempty(value: string, label: string): string { if (value.length === 0) throw new TypeError(`${label} must not be empty`); return value; }
function positive(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be positive`); return value; }
function randomId(): string { return globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? Math.random().toString(36).slice(2); }
function browserLocks(): WebLockProvider | undefined { return globalThis.navigator?.locks as unknown as WebLockProvider | undefined; }
function forwardAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (parent === undefined) return () => undefined;
  const abort = () => child.abort(parent.reason);
  if (parent.aborted) abort(); else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}
function errorName(error: unknown): string | undefined { return typeof error === "object" && error !== null && "name" in error ? String((error as { name?: unknown }).name) : undefined; }
function isAbort(error: unknown): boolean { return errorName(error) === "AbortError"; }
function isTimeout(error: unknown): boolean { return errorName(error) === "TimeoutError"; }
function isQuota(error: unknown): boolean { return errorName(error) === "QuotaExceededError"; }
function isMissing(error: unknown): boolean { return errorName(error) === "NotFoundError"; }
function classify(
  error: unknown,
  code: ConstructorParameters<typeof EngineWebAdapterError>[0],
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): EngineWebAdapterError {
  return error instanceof EngineWebAdapterError ? error : new EngineWebAdapterError(code, message, details, error);
}
