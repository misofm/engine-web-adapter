import { EngineWebAdapterError, serializeEngineWebAdapterCause } from "../errors.js";
import { OPFS_WRITE_METHOD, OPFS_WRITE_REMEDY } from "../stems/opfs-worker-protocol.js";
import type { OpfsWorkerRequest, OpfsWorkerResponse } from "../stems/opfs-worker-protocol.js";

interface SyncAccessHandleLike {
  write(data: Uint8Array, options?: { readonly at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

interface FileHandleLike {
  createSyncAccessHandle?: () => Promise<SyncAccessHandleLike>;
}

interface DirectoryHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<OpfsWorkerRequest>) => void) | null;
  postMessage(message: OpfsWorkerResponse): void;
}

const scope = ((globalThis as unknown as { readonly self?: WorkerScope }).self ?? globalThis) as unknown as WorkerScope;
const handles = new Map<number, { readonly handle: SyncAccessHandleLike; offset: number }>();
const chains = new Map<number, Promise<void>>();
let folder: { readonly name: string; readonly directory: Promise<DirectoryHandleLike> } | undefined;

scope.onmessage = (event) => {
  const request = event.data;
  const prior = chains.get(request.writerId) ?? Promise.resolve();
  const next = prior.then(async () => {
    try {
      scope.postMessage({ type: "opfs-started", requestId: request.requestId });
      await apply(request);
      scope.postMessage({ type: "opfs-ok", requestId: request.requestId });
    } catch (error) {
      scope.postMessage({ type: "opfs-error", requestId: request.requestId, error: serialize(error) });
    }
  });
  chains.set(request.writerId, next);
  if (request.type === "write-close" || request.type === "write-abort") {
    void next.then(() => { if (chains.get(request.writerId) === next) chains.delete(request.writerId); });
  }
};
scope.postMessage({ type: "worker-ready", writeSupport: writeSupported() });

/** True when this Worker scope exposes the write method the store calls. */
function writeSupported(): boolean {
  const handle = (globalThis as unknown as {
    readonly FileSystemFileHandle?: { readonly prototype?: { readonly createSyncAccessHandle?: unknown } };
  }).FileSystemFileHandle;
  return typeof handle?.prototype?.createSyncAccessHandle === "function";
}

async function apply(request: OpfsWorkerRequest): Promise<void> {
  switch (request.type) {
    case "write-open": {
      const directory = await directoryFor(request.folderName);
      const file = await directory.getFileHandle(request.name, { create: true });
      if (typeof file.createSyncAccessHandle !== "function") {
        throw new EngineWebAdapterError("capability.opfs", "Origin-private file storage cannot be written", {
          missing: OPFS_WRITE_METHOD,
          remedy: OPFS_WRITE_REMEDY,
        });
      }
      const handle = await file.createSyncAccessHandle();
      try {
        handle.truncate(0);
      } catch (error) {
        let closeFailed = false;
        let closeError: unknown;
        try { handle.close(); }
        catch (cause) { closeFailed = true; closeError = cause; }
        if (closeFailed) throw compoundPhysicalFailure("OPFS writer open failed during cleanup", error, closeError);
        throw error;
      }
      handles.set(request.writerId, { handle, offset: 0 });
      return;
    }
    case "write": {
      const entry = opened(request.writerId);
      const written = entry.handle.write(request.chunk, { at: entry.offset });
      if (written !== request.chunk.byteLength) {
        throw new EngineWebAdapterError("storage.io", "Origin-private file storage wrote a short chunk", {
          expectedBytes: request.chunk.byteLength,
          writtenBytes: written,
          failureKind: "io",
        });
      }
      entry.offset += written;
      return;
    }
    case "write-close": {
      const entry = opened(request.writerId);
      handles.delete(request.writerId);
      let flushFailed = false;
      let flushError: unknown;
      try { entry.handle.flush(); }
      catch (cause) { flushFailed = true; flushError = cause; }
      let closeFailed = false;
      let closeError: unknown;
      try { entry.handle.close(); }
      catch (cause) { closeFailed = true; closeError = cause; }
      if (flushFailed && closeFailed) throw compoundPhysicalFailure("OPFS writer close failed during flush and cleanup", flushError, closeError);
      if (flushFailed) throw flushError;
      if (closeFailed) throw closeError;
      return;
    }
    case "write-abort": {
      // Abort must stay idempotent: the caller aborts on paths where the open
      // itself failed, and the store removes the staging file afterwards.
      const entry = handles.get(request.writerId);
      if (entry === undefined) return;
      handles.delete(request.writerId);
      try { entry.handle.truncate(0); } catch { /* discarding, not repairing */ }
      entry.handle.close();
      return;
    }
  }
}

async function directoryFor(name: string): Promise<DirectoryHandleLike> {
  if (folder?.name !== name) {
    const storage = (globalThis as unknown as {
      readonly navigator?: { readonly storage?: { getDirectory?: () => Promise<DirectoryHandleLike> } };
    }).navigator?.storage;
    if (typeof storage?.getDirectory !== "function") {
      throw new EngineWebAdapterError("capability.opfs", "Origin-private storage is unavailable", {
        missing: "navigator.storage.getDirectory",
        remedy: OPFS_WRITE_REMEDY,
      });
    }
    const directory = storage.getDirectory().then((root) => root.getDirectoryHandle(name, { create: true }));
    folder = { name, directory };
    // A rejected resolution must not become a permanently cached failure.
    directory.catch(() => { if (folder?.directory === directory) folder = undefined; });
  }
  return folder.directory;
}

function opened(writerId: number): { readonly handle: SyncAccessHandleLike; offset: number } {
  const entry = handles.get(writerId);
  if (entry === undefined) throw new EngineWebAdapterError("session.closed", "OPFS writer is not open");
  return entry;
}

function serialize(error: unknown): Extract<OpfsWorkerResponse, { type: "opfs-error" }>["error"] {
  const serialized = serializeEngineWebAdapterCause(error);
  return {
    name: serialized.name,
    message: serialized.message,
    ...(serialized.role === undefined ? {} : { role: serialized.role }),
    ...(serialized.truncated === undefined ? {} : { truncated: serialized.truncated }),
    ...(serialized.code === undefined ? {} : { code: serialized.code }),
    ...(serialized.details === undefined ? {} : { details: serialized.details }),
    ...(serialized.cause === undefined ? {} : { cause: serialized.cause }),
    ...(serialized.causes === undefined ? {} : { causes: serialized.causes }),
  };
}

function compoundPhysicalFailure(message: string, body: unknown, finalizer: unknown): AggregateError {
  return new AggregateError([
    roleFailure("body", body),
    roleFailure("finalizer", finalizer),
  ], message);
}

function roleFailure(role: "body" | "finalizer", error: unknown): Error {
  const wrapped = new Error(error instanceof Error ? error.message : String(error), { cause: error });
  wrapped.name = error instanceof Error ? error.name : "Error";
  Object.defineProperty(wrapped, "role", { value: role, enumerable: true, configurable: true });
  return wrapped;
}
