import { diagnosticResolver, initializeIngestDiagnostics, releaseDecoded, retainActive, type IngestDiagnostics } from "./ingest-diagnostics.js";
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
interface SharedState { locks: Map<string, Promise<void>> }
const SHARED = new WeakMap<object, SharedState>();

function sharedFor(backend: StemStorageBackend): SharedState {
  let shared = SHARED.get(backend as object);
  if (shared === undefined) {
    shared = { locks: new Map() };
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
  readonly #folderName: string;
  #opened: Promise<void> | undefined;

  constructor(options: VerifiedStemStoreOptions = {}) {
    this.#backend = options.backend ?? new OpfsStorageBackend();
    this.#locks = options.locks ?? browserLocks();
    this.#now = options.now ?? Date.now;
    this.#instanceId = options.instanceId ?? randomId();
    this.#readDeadlineMs = positive(options.readDeadlineMs ?? 30_000, "readDeadlineMs");
    this.#shared = sharedFor(this.#backend);
    this.#folderName = this.#backend.folderName ?? "miso-engine-web-stems-v1";
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
    readonly ingestDiagnostics?: IngestDiagnostics;
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

    const diagnostics = initializeIngestDiagnostics(options.ingestDiagnostics, options.resolver, options.admission?.limit ?? 1);
    const resolver = diagnosticResolver(options.resolver, diagnostics);
    const controller = new AbortController();
    const detach = forwardAbort(options.signal, controller);
    // The opening owns each verified source before releasing its stem lock.
    // The same unique ownership becomes the returned lease without a pin gap.
    const pin = `session:${this.#instanceId}:${leaseId}:${randomId()}`;
    const owned: StemRequirement[] = [];
    let releaseLock: (() => Promise<void>) | undefined;
    try {
      releaseLock = await this.#holdPinLock(pin, options.signal);
      const own = async (stem: StemRequirement): Promise<void> => {
        await this.#mutateIndex((index) => {
          const row = index.stems[stem.identity];
          if (row === undefined || row.bytes !== stem.bytes) {
            throw new EngineWebAdapterError("stem.corrupt", "Verified stem disappeared before leasing", { identity: stem.identity });
          }
          row.pins.push(pin);
          row.lastUsedAt = this.#now();
        }, controller.signal);
        owned.push(stem);
      };
      await runBounded(
        unique,
        options.admission?.limit ?? 1,
        async (stem) => {
          await this.#ensure(stem, resolver, controller.signal, own, options.onProgress, options.admission, diagnostics);
          controller.signal.throwIfAborted();
          options.onProgress?.({ stage: "source-ready", identity: stem.identity, bytes: stem.bytes });
          controller.signal.throwIfAborted();
        },
        (error) => controller.abort(error),
      );
      options.signal?.throwIfAborted();
      options.onProgress?.({ stage: "ready", sourcesReady: declared.length, sourcesTotal: declared.length });
      options.signal?.throwIfAborted();
      return new VerifiedStemSessionLease(this, leaseId, pin, declared, releaseLock);
    } catch (error) {
      try { if (owned.length > 0) await this.release(pin, owned); }
      finally { await releaseLock?.(); }
      if (options.signal?.aborted || isAbort(error)) {
        throw new EngineWebAdapterError("stem.cancelled", "Stem session open was cancelled", {}, error);
      }
      throw error;
    } finally {
      detach();
    }
  }

  /** Durable offline intent shares the existing version-1 index and pin encoding. */
  async setOfflinePin(identity: StemIdentity, pinId: string, pinned: boolean): Promise<void> {
    assertStemIdentity(identity);
    const pin = `offline:${nonempty(pinId, "pinId")}`;
    await this.open();
    await this.#mutateIndex((index) => {
      const row = index.stems[identity];
      if (row === undefined) {
        if (pinned) throw new EngineWebAdapterError("stem.not_found", "Cannot pin a missing stem", { identity });
        return false;
      }
      if (row.pins.includes(pin) === pinned) return false;
      if (pinned) row.pins.push(pin);
      else row.pins = row.pins.filter((candidate) => candidate !== pin);
    });
  }

  async verify(identity: StemIdentity, expectedBytes?: number, signal?: AbortSignal): Promise<boolean> {
    await this.open();
    assertStemIdentity(identity);
    return this.#withLock(this.#stemLock(identity), signal, async () => {
      const index = await this.#withLock("index", signal, () => this.#readIndex());
      const row = index.stems[identity];
      if (row === undefined || (expectedBytes !== undefined && row.bytes !== expectedBytes)) return false;
      return this.#verifyFile(identity, row.bytes, signal);
    });
  }

  async read(identity: StemIdentity): Promise<Blob> {
    await this.open();
    assertStemIdentity(identity);
    const index = await this.#withLock("index", undefined, () => this.#readIndex());
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
      const index = await this.#readIndex(liveLocks);
      for (const name of await this.#backend.list()) {
        if (name === INDEX_TEMP) await this.#backend.remove(name);
        if (name.startsWith(STAGING_PREFIX) && liveLocks !== undefined && !this.#hasLiveStem(liveLocks, name)) {
          await this.#backend.remove(name);
        }
      }
      for (const name of await this.#backend.list()) {
        if (name.startsWith(FINAL_PREFIX)) {
          const identity = `sha256:${name.slice(FINAL_PREFIX.length)}`;
          if (!Object.hasOwn(index.stems, identity) && liveLocks !== undefined && !this.#hasLiveStem(liveLocks, name)) {
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
    own: (stem: StemRequirement) => Promise<void>,
    onProgress?: (progress: StemProgress) => void,
    admission?: BoundedStemAdmission,
    diagnostics?: IngestDiagnostics,
  ): Promise<void> {
    let releaseActive: (() => void) | undefined;
    const admittedVerification = () => {
      releaseActive ??= retainActive(diagnostics);
      return this.#verifyIndexed(stem, signal, onProgress);
    };
    const verify = () => admission === undefined
      ? admittedVerification()
      : admission.run(admittedVerification, signal);
    try {
      const warm = await this.#withLock(this.#stemLock(stem.identity), signal, async () => {
        if (!(await verify())) return false;
        await own(stem);
        return true;
      });
      if (warm) return;
      // Eviction may wait for another stem. Never retain this stem's lock here.
      try {
        await this.#preflight(stem.bytes, signal, true);
      } catch (error) {
        // Reclamation persists metadata outside the ingest error boundary.
        if (isQuota(error)) {
          throw new EngineWebAdapterError("stem.quota", "Origin-private storage quota is insufficient", {
            identity: stem.identity, requiredBytes: stem.bytes,
          }, error);
        }
        throw error;
      }
      await this.#withLock(this.#stemLock(stem.identity), signal, async () => {
        // A concurrent opener may have installed the final while we reclaimed.
        if (!(await verify())) await this.#ingest(stem, resolver, signal, onProgress);
        await own(stem);
      });
    } finally { releaseActive?.(); }
  }

  async #verifyIndexed(
    stem: StemRequirement,
    signal: AbortSignal,
    onProgress?: (progress: StemProgress) => void,
  ): Promise<boolean> {
    const index = await this.#withLock("index", signal, () => this.#readIndex());
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
    await this.#preflight(stem.bytes, signal, false);
    const staging = `${STAGING_PREFIX}${this.#instanceId}-${digest(stem.identity)}`;
    await this.#backend.remove(staging);
    const writerLifetime = new AbortController();
    let writer: StemStorageWriter | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let promoted = false;
    let consumed = false;
    try {
      const resolved = await deadline(
        Promise.resolve(optionsResolve(resolver, stem.identity, signal, onProgress)),
        this.#readDeadlineMs,
        signal,
      );
      if (!(resolved.stream instanceof ReadableStream)) throw new TypeError("Resolver must return a ReadableStream");
      reader = resolved.stream.getReader();
      writer = await deadline(this.#backend.createWriter(staging, writerLifetime.signal), this.#readDeadlineMs, signal);
      const hash = new IncrementalSha256();
      let bytes = 0;
      while (true) {
        const result = await deadline(reader.read(), this.#readDeadlineMs, signal);
        if (result.done) { consumed = true; break; }
        try {
          if (!(result.value instanceof Uint8Array)) throw new TypeError("Resolver chunks must be Uint8Array");
          bytes += result.value.byteLength;
          if (bytes > stem.bytes) throw integrity(stem, bytes, "byte count exceeds declaration");
          hash.update(result.value);
          await deadline(writer.write(result.value), this.#readDeadlineMs, signal);
          onProgress?.({
            stage: "ingesting", sourceId: stem.sourceId, identity: stem.identity,
            bytes, totalBytes: stem.bytes, byteKind: "pcm",
          });
        } finally {
          if (result.value instanceof Uint8Array) releaseDecoded(result.value.buffer);
        }
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
        index.stems[stem.identity] = { bytes: stem.bytes, pins: index.stems[stem.identity]?.pins ?? [], lastUsedAt: this.#now() };
      }, signal);
    } catch (error) {
      // Cancel even when the open deadline expired before returning a writer.
      writerLifetime.abort(error);
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
      if (!consumed) await reader?.cancel(signal.reason).catch(() => undefined);
      try { reader?.releaseLock(); } catch { /* deadline may leave a read pending */ }
    }
  }

  async #availableBytes(): Promise<number | undefined> {
    const estimate: { readonly quota?: number; readonly usage?: number } = await this.#backend.estimate?.().catch(() => ({})) ?? {};
    if (estimate.quota === undefined || estimate.usage === undefined) return undefined;
    return Math.max(0, estimate.quota - estimate.usage);
  }

  async #preflight(requiredBytes: number, signal: AbortSignal, reclaim: boolean): Promise<void> {
    let availableBytes = await this.#availableBytes();
    if (availableBytes === undefined || availableBytes >= requiredBytes) return;
    if (reclaim) {
      const index = await this.#withLock("index", signal, () => this.#readIndex());
      const victims = Object.entries(index.stems)
        .filter(([, row]) => row.pins.length === 0)
        .sort(([a, left], [b, right]) => left.lastUsedAt - right.lastUsedAt || (a < b ? -1 : a > b ? 1 : 0));
      // One finite snapshot, with ownership rechecked at the protected mutation.
      // Unknown and stale-looking pins are deliberately retained.
      for (const [identity] of victims) {
        assertStemIdentity(identity);
        await this.#withLock(this.#stemLock(identity), signal, () =>
          this.#withLock("index", signal, async () => {
            const current = await this.#readIndex();
            const row = current.stems[identity];
            availableBytes = await this.#availableBytes();
            if (availableBytes === undefined || availableBytes >= requiredBytes || row === undefined || row.pins.length > 0) return;
            signal.throwIfAborted();
            await this.#backend.remove(finalName(identity));
            delete current.stems[identity];
            await this.#writeIndex(current);
          }));
        availableBytes = await this.#availableBytes();
        if (availableBytes === undefined || availableBytes >= requiredBytes) return;
      }
    }
    throw new EngineWebAdapterError("stem.quota", "Origin-private storage quota is insufficient", {
      requiredBytes, availableBytes,
    });
  }

  async #demote(identity: StemIdentity): Promise<void> {
    await this.#backend.remove(finalName(identity));
    await this.#mutateIndex((index) => {
      // A pin records ownership/intent, never proof that corrupt bytes are usable.
      // Retain pinned rows across repair; every session still hashes the final.
      if (index.stems[identity]?.pins.length === 0) delete index.stems[identity];
    });
  }

  async #readIndex(liveLocks?: ReadonlySet<string>): Promise<StoreIndex> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.#backend.readText(INDEX_FILE));
    } catch (error) {
      if (!isMissing(error)) {
        // Malformed and unreadable indexes take the same bounded recovery path.
      }
    }
    if (typeof parsed === "object" && parsed !== null && "version" in parsed && parsed.version !== INDEX_VERSION) {
      throw new EngineWebAdapterError("stem.corrupt", "Unsupported stem index version", { version: parsed.version });
    }
    if (validIndex(parsed)) return parsed;
    return this.#rebuildIndex(liveLocks ?? await this.#liveLockNames());
  }

  async #rebuildIndex(liveLocks: ReadonlySet<string> | undefined): Promise<StoreIndex> {
    const index = emptyIndex();
    for (const name of await this.#backend.list()) {
      if (!name.startsWith(FINAL_PREFIX) || name.length !== FINAL_PREFIX.length + 64) continue;
      if (liveLocks !== undefined && this.#hasLiveStem(liveLocks, name)) continue;
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

  async #mutateIndex(mutation: (index: StoreIndex) => void | false, signal?: AbortSignal): Promise<void> {
    await this.#withLock("index", signal, async () => {
      const index = await this.#readIndex();
      if (mutation(index) === false) return;
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
    // Fixed order: prior adapter global resource, then historical app folder resource.
    // Stem work may enter index work; index work never acquires a stem lock.
    const historical = name === "index" ? "index" : `ingest:${name.slice("stem:".length)}`;
    return this.#withNamedLock(`miso:engine-web:v1:${name}`, signal, () =>
      this.#withNamedLock(`miso:stem-store:v1:${this.#folderName}:${historical}`, signal, work));
  }

  #hasLiveStem(names: ReadonlySet<string>, file: string): boolean {
    const hash = file.slice(-64);
    return names.has(`miso:engine-web:v1:stem:${hash}`)
      || names.has(`miso:stem-store:v1:${this.#folderName}:ingest:${hash}`);
  }

  async #holdPinLock(pin: string, signal?: AbortSignal): Promise<() => Promise<void>> {
    let acquired!: () => void;
    let failed!: (reason: unknown) => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const request = this.#withNamedLock(`miso:stem-store:v1:${this.#folderName}:pin:${pin}`, signal, async () => {
      acquired();
      await hold;
    });
    void request.catch(failed);
    await ready;
    return async () => { release(); await request; };
  }

  async #withNamedLock<T>(name: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    if (this.#locks !== undefined) return this.#locks.request(
      name, { mode: "exclusive", ...(signal === undefined ? {} : { signal }) },
      async () => { signal?.throwIfAborted(); return work(); },
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
    const { folderName, storage, assets, createWorker, ...storeOptions } = options;
    super({
      ...storeOptions,
      backend: new OpfsStorageBackend({
        ...(folderName === undefined ? {} : { folderName }),
        ...(storage === undefined ? {} : { storage }),
        ...(assets === undefined ? {} : { assets }),
        ...(createWorker === undefined ? {} : { createWorker }),
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
  #closing: Promise<void> | undefined;
  readonly #releaseLock: () => Promise<void>;
  constructor(store: VerifiedStemStore, leaseId: string, pin: string, stems: readonly StemRequirement[], releaseLock: () => Promise<void>) {
    this.#store = store; this.leaseId = leaseId; this.#pin = pin; this.#releaseLock = releaseLock;
    this.stems = Object.freeze(stems.map((stem) => Object.freeze({ ...stem })));
  }
  async read(identity: StemIdentity): Promise<Blob> {
    if (this.#closed) throw new EngineWebAdapterError("session.closed", "Stem session lease is closed");
    if (!this.stems.some((stem) => stem.identity === identity)) {
      throw new EngineWebAdapterError("stem.not_found", "Stem is not part of this lease", { identity });
    }
    return this.#store.read(identity);
  }
  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closing ??= this.#store.release(this.#pin, this.stems).then(async () => {
      this.#closed = true;
      await this.#releaseLock();
    }).catch((error: unknown) => {
      this.#closing = undefined;
      throw error;
    });
    return this.#closing;
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
function digest(identity: StemIdentity): string { return identity.slice("sha256:".length); }
function nonempty(value: string, label: string): string { if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must not be empty`); return value; }
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
