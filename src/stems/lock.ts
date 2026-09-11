import type { StemStorageBackend } from "./storage.js";

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

export interface SharedLockState { readonly locks: Map<string, Promise<void>> }

// This is the historical same-backend fallback registry shared by dense and
// sparse stores. Its lifetime is the backend object, not a module operation.
const SHARED = new WeakMap<object, SharedLockState>();

export function sharedFor(backend: StemStorageBackend): SharedLockState {
  let shared = SHARED.get(backend as object);
  if (shared === undefined) {
    shared = { locks: new Map() };
    SHARED.set(backend as object, shared);
  }
  return shared;
}

export async function withNamedLock<T>(
  locks: WebLockProvider | undefined,
  shared: SharedLockState,
  name: string,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (locks !== undefined) return locks.request(
    name, { mode: "exclusive", ...(signal === undefined ? {} : { signal }) },
    async () => { signal?.throwIfAborted(); return work(); },
  );
  const prior = shared.locks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.then(() => gate);
  shared.locks.set(name, tail);
  await prior;
  try { signal?.throwIfAborted(); return await work(); }
  finally { release(); if (shared.locks.get(name) === tail) shared.locks.delete(name); }
}
