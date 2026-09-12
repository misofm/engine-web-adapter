import type { StemIdentity, StemProgress } from "./types.js";

/**
 * Sparse progress is observational. A broken observer must never change the
 * operation's integrity or cleanup result, and a thenable returned by a
 * JavaScript caller must not become an unhandled rejection.
 */
export type ProgressObserver = (progress: StemProgress) => void;

const COALESCE_MS = 50;

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
      if (!stageStart && !terminal && !meaningful && now - previousAt < COALESCE_MS) return;
      delivered.set(key, bounded);
      deliveredAt.set(key, now);
      observeProgress(observer, progress);
      return;
    }
    observeProgress(observer, progress);
  };

  return {
    emit,
    close: () => { attached = false; },
  };
}

function addContext(progress: StemProgress, identity: StemIdentity | undefined, sourceId: string | undefined): StemProgress {
  return Object.freeze({
    ...progress,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(identity === undefined ? {} : { identity }),
  });
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}
