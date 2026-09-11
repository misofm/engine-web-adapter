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

export interface LockLease { readonly release: () => Promise<void> }

/** Hold one historical lock across a scoped Effect resource. */
export async function acquireNamedLock(
  locks: WebLockProvider | undefined,
  shared: SharedLockState,
  name: string,
  signal: AbortSignal | undefined,
): Promise<LockLease> {
  signal?.throwIfAborted();
  if (locks !== undefined) {
    let acquired!: () => void;
    let failed!: (reason: unknown) => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const request = locks.request(name, { mode: "exclusive", ...(signal === undefined ? {} : { signal }) }, async () => {
      acquired();
      await hold;
    });
    void request.catch(failed);
    try { await ready; }
    catch (error) { await request.catch(() => undefined); throw error; }
    return { release: async () => { release(); await request; } };
  }
  const prior = shared.locks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.then(() => gate);
  shared.locks.set(name, tail);
  let acquired = false;
  try {
    await waitForSignal(prior, signal);
    acquired = true;
    signal?.throwIfAborted();
    return { release: async () => {
      release();
      await tail;
      if (shared.locks.get(name) === tail) shared.locks.delete(name);
    } };
  } catch (error) {
    release();
    void tail.then(() => { if (shared.locks.get(name) === tail) shared.locks.delete(name); });
    throw error;
  }
}

function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Operation aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function acquireStemLock(
  options: { readonly locks?: WebLockProvider; readonly shared: SharedLockState; readonly folderName: string },
  identityHex: string,
  signal: AbortSignal | undefined,
): Promise<LockLease> {
  const global = await acquireNamedLock(options.locks, options.shared, `miso:engine-web:v1:stem:${identityHex}`, signal);
  try {
    const historical = await acquireNamedLock(options.locks, options.shared, `miso:stem-store:v1:${options.folderName}:ingest:${identityHex}`, signal);
    return { release: async () => {
      let first: unknown;
      try { await historical.release(); } catch (error) { first = error; }
      try { await global.release(); } catch (error) { first ??= error; }
      if (first !== undefined) throw first;
    } };
  } catch (error) {
    let releaseFailure: unknown;
    try { await global.release(); } catch (releaseError) { releaseFailure = releaseError; }
    if (releaseFailure !== undefined) throw new AggregateError([error, releaseFailure], "Stem lock acquisition cleanup failed");
    throw error;
  }
}
