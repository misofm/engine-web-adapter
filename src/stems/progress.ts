import type { StemIdentity, StemProgress } from "./types.js";

/**
 * Sparse progress is observational. A broken observer must never change the
 * operation's integrity or cleanup result, and a thenable returned by a
 * JavaScript caller must not become an unhandled rejection.
 */
export type ProgressObserver = (progress: StemProgress) => void;

const COALESCE_MS = 50;
const forcedBoundaries = new WeakSet<object>();
const forcedObservers = new WeakMap<ProgressObserver, ProgressObserver>();

/** Register the private force path for a forwarding observer. */
export function registerForcedProgressObserver(observer: ProgressObserver, forced: ProgressObserver): void {
  forcedObservers.set(observer, forced);
}

export function observeProgress(observer: ProgressObserver | undefined, progress: StemProgress): void {
  if (observer === undefined) return;
  try {
    const result = observer(progress) as unknown;
    if (isThenable(result)) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // Progress is an observation only. The operation owns its failure channel.
  }
}

export interface SparseProgressReporter {
  readonly emit: (progress: StemProgress) => void;
  /** Deliver a successful terminal byte boundary through nested reporters. */
  readonly emitForced: (progress: StemProgress) => void;
  /** Flush the latest coalesced byte boundary after a successful operation. */
  readonly flush: () => void;
  readonly close: () => void;
}

/**
 * Coalesce high-frequency byte notifications per operation and source while
 * retaining stage starts, meaningful elapsed work, and terminal boundaries.
 */
export function sparseProgressReporter(
  observer: ProgressObserver | undefined,
  identity?: StemIdentity,
  sourceId?: string,
): SparseProgressReporter {
  let attached = true;
  const last = new Map<string, number>();
  const delivered = new Map<string, number>();
  const deliveredAt = new Map<string, number>();
  const pending = new Map<string, StemProgress>();

  const deliver = (progress: StemProgress, key: string, bytes: number, at = monotonicNow()): void => {
    pending.delete(key);
    delivered.set(key, bytes);
    deliveredAt.set(key, at);
    observeProgress(observer, progress);
  };

  const emit = (input: StemProgress): void => {
    if (!attached) return;
    const progress = addContext(input, identity, sourceId);
    const identityKey = progress.identity === undefined ? "" : `:${progress.identity}`;
    const sourceKey = progress.sourceId === undefined ? "" : `:${progress.sourceId}`;
    const key = progress.stage + ":" + ("byteKind" in progress ? progress.byteKind : "count") + identityKey + sourceKey;
    const total = "totalBytes" in progress ? progress.totalBytes : undefined;
    const current = "bytes" in progress ? progress.bytes : undefined;
    if (current !== undefined && total !== undefined) {
      if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(total) || total < 0) return;
      const bounded = Math.min(current, total);
      const prior = last.get(key) ?? 0;
      if (bounded < prior) return;
      if (bounded !== current) {
        // All package-owned events have finite totals. Keep this branch for
        // a defensive boundary in case a custom resolver sends an overrun.
        return;
      }
      last.set(key, bounded);
      const now = monotonicNow();
      const terminal = bounded >= total;
      const stageStart = prior === 0;
      const previousDelivered = delivered.get(key) ?? 0;
      const meaningful = bounded - previousDelivered >= Math.max(1, Math.ceil(total / 20));
      const previousAt = deliveredAt.get(key) ?? -Infinity;
      if (!forcedBoundaries.has(progress) && !stageStart && !terminal && !meaningful && now - previousAt < COALESCE_MS) {
        pending.set(key, progress);
        return;
      }
      deliver(progress, key, bounded, now);
      return;
    }
    observeProgress(observer, progress);
  };

  const emitForced = (input: StemProgress): void => {
    if (!attached) return;
    const progress = addContext(input, identity, sourceId);
    if (!("bytes" in progress) || !("totalBytes" in progress)) {
      forcedBoundaries.add(progress);
      observeProgress(observer, progress);
      return;
    }
    if (!Number.isSafeInteger(progress.bytes) || progress.bytes < 0 ||
      !Number.isSafeInteger(progress.totalBytes) || progress.totalBytes < 0 ||
      progress.bytes > progress.totalBytes) return;
    const identityKey = progress.identity === undefined ? "" : `:${progress.identity}`;
    const sourceKey = progress.sourceId === undefined ? "" : `:${progress.sourceId}`;
    const key = progress.stage + ":" + ("byteKind" in progress ? progress.byteKind : "count") + identityKey + sourceKey;
    const prior = delivered.get(key) ?? 0;
    const queued = pending.get(key);
    if (queued !== undefined && "bytes" in queued && queued.bytes === progress.bytes) {
      forcedBoundaries.add(queued);
      deliver(queued, key, queued.bytes);
      return;
    }
    pending.delete(key);
    if (progress.bytes < prior) return;
    if (progress.bytes === prior) {
      // The current reporter already delivered this boundary. If its
      // observer is another reporter, ask that reporter to force its own
      // pending copy instead of delivering a duplicate to the caller.
      forcedBoundaries.add(progress);
      const forced = forcedObservers.get(observer as ProgressObserver);
      if (forced !== undefined) observeProgress(forced, progress);
      return;
    }
    forcedBoundaries.add(progress);
    deliver(progress, key, progress.bytes);
  };

  const flush = (): void => {
    if (!attached) return;
    for (const [key, progress] of pending) {
      if (!attached) return;
      if (!("bytes" in progress) || !("totalBytes" in progress) ||
        !Number.isSafeInteger(progress.bytes) || progress.bytes < 0 ||
        !Number.isSafeInteger(progress.totalBytes) || progress.totalBytes < 0) {
        pending.delete(key);
        continue;
      }
      const prior = delivered.get(key) ?? 0;
      if (progress.bytes < prior) {
        pending.delete(key);
        continue;
      }
      pending.delete(key);
      delivered.set(key, progress.bytes);
      deliveredAt.set(key, monotonicNow());
      forcedBoundaries.add(progress);
      observeProgress(observer, progress);
    }
  };

  forcedObservers.set(emit, emitForced);
  return {
    emit,
    emitForced,
    flush,
    close: () => { attached = false; pending.clear(); },
  };
}

function addContext(progress: StemProgress, identity: StemIdentity | undefined, sourceId: string | undefined): StemProgress {
  const contextualized = Object.freeze({
    ...progress,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(identity === undefined ? {} : { identity }),
  });
  if (forcedBoundaries.has(progress)) forcedBoundaries.add(contextualized);
  return contextualized;
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}
