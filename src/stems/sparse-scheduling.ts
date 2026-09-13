/**
 * Private registration for the native sparse resolver. The public resolver
 * remains a plain function; this identity-bound metadata lets the store use
 * the resolver's already-computed processing policy without granting the
 * same optimization to arbitrary wrappers or custom resolvers.
 */
export interface SparseResolverPool {
  readonly canRetain: boolean;
  retain(): { readonly release: () => Promise<void> };
}

/** Private preparation reservation for native warm verification workers. */
export interface SparseWarmPreparationClaim {
  readonly width: number;
  /** Idempotent; the owner calls this only after its warm pool has closed. */
  readonly release: () => Promise<void>;
}

export interface SparseResolverScheduling {
  readonly concurrency: number;
  readonly pool: SparseResolverPool;
  readonly tryClaimWarmPreparation?: () => SparseWarmPreparationClaim | undefined;
}

const registrations = new WeakMap<object, SparseResolverScheduling>();

export function registerSparseResolver(resolver: object, scheduling: SparseResolverScheduling): void {
  if (!Number.isSafeInteger(scheduling.concurrency) || scheduling.concurrency < 1) {
    throw new RangeError("sparse resolver concurrency must be a positive safe integer");
  }
  registrations.set(resolver, Object.freeze({ ...scheduling }));
}

export function sparseResolverScheduling(value: unknown): SparseResolverScheduling | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  return registrations.get(value);
}
