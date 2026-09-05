import type { AdapterAssetOverrides } from "../assets.js";
import { EngineWebAdapterError } from "../errors.js";
import { OpfsWriteWorkerClient } from "./opfs-worker-client.js";
import { OPFS_WRITE_REMEDY } from "./opfs-worker-protocol.js";
import type { OpfsWorkerLike } from "./opfs-worker-protocol.js";
import { deadline } from "./sha256.js";

export interface StemStorageWriter {
  write(chunk: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

/** Minimal persistence seam; final PCM reads remain streaming. */
export interface StemStorageBackend {
  open(): Promise<void>;
  list(): Promise<readonly string[]>;
  exists(name: string): Promise<boolean>;
  read(name: string): Promise<Blob>;
  readText(name: string): Promise<string>;
  createWriter(name: string): Promise<StemStorageWriter>;
  move(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
  estimate?(): Promise<{ readonly quota?: number; readonly usage?: number }>;
}

interface FileLike {
  stream(): ReadableStream<Uint8Array>;
  text(): Promise<string>;
}

interface FileHandleLike {
  getFile(): Promise<FileLike>;
  move?: (directory: DirectoryHandleLike, name: string) => Promise<void>;
}

interface DirectoryHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string): Promise<void>;
  entries(): AsyncIterableIterator<[string, { readonly kind: "file" | "directory" }]>;
}

export interface StorageManagerLike {
  getDirectory(): Promise<DirectoryHandleLike>;
  estimate?(): Promise<{ readonly quota?: number; readonly usage?: number }>;
}

/**
 * Flat OPFS directory backend. All large-file operations are streamed.
 *
 * Reads run on the calling thread. Writes run through one OPFS Worker because
 * `createSyncAccessHandle()` is the only write API every target engine ships
 * and its handle is synchronous, so it cannot be created on the main thread.
 */
export class OpfsStorageBackend implements StemStorageBackend {
  readonly #folderName: string;
  readonly #storage: StorageManagerLike | undefined;
  readonly #readDeadlineMs: number;
  readonly #writes: OpfsWriteWorkerClient;
  #directory: DirectoryHandleLike | undefined;

  constructor(options: {
    readonly folderName?: string;
    readonly storage?: StorageManagerLike;
    readonly readDeadlineMs?: number;
    readonly assets?: AdapterAssetOverrides;
    readonly createWorker?: () => OpfsWorkerLike;
  } = {}) {
    this.#folderName = options.folderName ?? "miso-engine-web-stems-v1";
    if (this.#folderName.length === 0 || this.#folderName === "." || this.#folderName === ".." || this.#folderName.includes("/")) {
      throw new RangeError("folderName must be one non-empty OPFS path component");
    }
    this.#storage = options.storage ?? browserStorage();
    this.#readDeadlineMs = options.readDeadlineMs ?? 15_000;
    this.#writes = new OpfsWriteWorkerClient({
      ...(options.assets === undefined ? {} : { assets: options.assets }),
      ...(options.createWorker === undefined ? {} : { createWorker: options.createWorker }),
      // The worker generation owns the same bounded deadline as backend
      // operations, so a stalled handshake/request is torn down with its
      // physical handles before a replacement generation can be observed.
      deadlineMs: this.#readDeadlineMs,
    });
  }

  async open(): Promise<void> {
    if (this.#directory !== undefined) return;
    if (this.#storage === undefined) {
      throw new EngineWebAdapterError("capability.opfs", "Origin-private storage is unavailable", {
        missing: "navigator.storage.getDirectory",
        remedy: OPFS_WRITE_REMEDY,
      });
    }
    // The Worker is the only scope that can see the write method, so the
    // refusal happens here: still before any resolver, network, or decode work.
    await this.#writes.assertWriteSupport();
    const root = await deadline(this.#storage.getDirectory(), this.#readDeadlineMs);
    this.#directory = await deadline(root.getDirectoryHandle(this.#folderName, { create: true }), this.#readDeadlineMs);
  }

  /** Release the OPFS write Worker. Idempotent; the backend stays usable. */
  close(): void { this.#writes.close(); }

  async list(): Promise<readonly string[]> {
    const directory = this.#opened();
    const names: string[] = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === "file") names.push(name);
    }
    return names.sort();
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.#opened().getFileHandle(name);
      return true;
    } catch (error) {
      if (domName(error) === "NotFoundError") return false;
      throw error;
    }
  }

  async read(name: string): Promise<Blob> {
    const handle = await deadline(this.#opened().getFileHandle(name), this.#readDeadlineMs);
    const file = await deadline(handle.getFile(), this.#readDeadlineMs);
    return file as unknown as Blob;
  }

  async readText(name: string): Promise<string> {
    const handle = await deadline(this.#opened().getFileHandle(name), this.#readDeadlineMs);
    const file = await deadline(handle.getFile(), this.#readDeadlineMs);
    return deadline(file.text(), this.#readDeadlineMs);
  }

  async createWriter(name: string): Promise<StemStorageWriter> {
    this.#opened();
    // The worker client owns this deadline so a timeout terminates the shared
    // generation before the public promise is abandoned.
    const writer = await this.#writes.createWriter(this.#folderName, name);
    return {
      write: (chunk) => writer.write(chunk),
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    };
  }

  async move(from: string, to: string): Promise<void> {
    const directory = this.#opened();
    const source = await directory.getFileHandle(from);
    if (typeof source.move === "function") {
      await source.move(directory, to);
      return;
    }
    const input = (await source.getFile()).stream().getReader();
    const output = await this.createWriter(to);
    try {
      while (true) {
        const result = await deadline(input.read(), this.#readDeadlineMs);
        if (result.done) break;
        await deadline(output.write(result.value), this.#readDeadlineMs);
      }
      await output.close();
      await directory.removeEntry(from);
    } catch (error) {
      await output.abort(error).catch(() => undefined);
      await this.remove(to).catch(() => undefined);
      throw error;
    } finally {
      try { input.releaseLock(); } catch { /* deadline may leave a read pending */ }
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await this.#opened().removeEntry(name);
    } catch (error) {
      if (domName(error) !== "NotFoundError") throw error;
    }
  }

  async estimate(): Promise<{ readonly quota?: number; readonly usage?: number }> {
    return (await this.#storage?.estimate?.()) ?? {};
  }

  #opened(): DirectoryHandleLike {
    if (this.#directory === undefined) throw new Error("Stem storage backend is not open");
    return this.#directory;
  }
}

/** Deterministic injectable backend. It intentionally models storage, not browser memory bounds. */
export class MemoryStemStorageBackend implements StemStorageBackend {
  readonly files = new Map<string, Uint8Array>();
  quotaBytes: number | undefined;
  readonly #failMoveOnce = new Set<string>();

  constructor(options: {
    readonly files?: Readonly<Record<string, Uint8Array | string>>;
    readonly quotaBytes?: number;
  } = {}) {
    for (const [name, value] of Object.entries(options.files ?? {})) {
      this.files.set(name, typeof value === "string" ? new TextEncoder().encode(value) : value.slice());
    }
    this.quotaBytes = options.quotaBytes;
  }

  async open(): Promise<void> {}
  async list(): Promise<readonly string[]> { return [...this.files.keys()].sort(); }
  async exists(name: string): Promise<boolean> { return this.files.has(name); }
  async read(name: string): Promise<Blob> {
    const bytes = this.#get(name);
    return new Blob([bytes.slice()]);
  }
  async readText(name: string): Promise<string> { return new TextDecoder().decode(this.#get(name)); }

  async createWriter(name: string): Promise<StemStorageWriter> {
    const chunks: Uint8Array[] = [];
    let closed = false;
    return {
      write: async (chunk) => {
        if (closed) throw new Error("writer is closed");
        chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk.slice());
      },
      close: async () => {
        if (closed) return;
        const bytes = concat(chunks);
        const prior = this.files.get(name)?.byteLength ?? 0;
        const usage = this.#usage() - prior + bytes.byteLength;
        if (this.quotaBytes !== undefined && usage > this.quotaBytes) {
          throw new DOMException("Memory backend quota exceeded", "QuotaExceededError");
        }
        this.files.set(name, bytes);
        closed = true;
      },
      abort: async () => { closed = true; },
    };
  }

  async move(from: string, to: string): Promise<void> {
    if (this.#failMoveOnce.delete(from)) throw new Error("injected move crash");
    this.files.set(to, this.#get(from));
    this.files.delete(from);
  }
  async remove(name: string): Promise<void> { this.files.delete(name); }
  async estimate(): Promise<{ readonly quota?: number; readonly usage?: number }> {
    return { ...(this.quotaBytes === undefined ? {} : { quota: this.quotaBytes }), usage: this.#usage() };
  }
  failNextMove(from: string): void { this.#failMoveOnce.add(from); }

  #get(name: string): Uint8Array {
    const value = this.files.get(name);
    if (value === undefined) throw new DOMException(`${name} was not found`, "NotFoundError");
    return value.slice();
  }
  #usage(): number { return [...this.files.values()].reduce((sum, value) => sum + value.byteLength, 0); }
}

function browserStorage(): StorageManagerLike | undefined {
  return globalThis.navigator?.storage as unknown as StorageManagerLike | undefined;
}

function domName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { readonly name?: unknown }).name)
    : undefined;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
