import {
  FLAC_ACCOUNTED_FIXED_BUFFER_BYTES,
  FLAC_ACCOUNTING_HEADROOM_BYTES,
  FLAC_PACKAGE_MEMORY_COMPONENTS,
  FLAC_WORKER_RESERVATION_BYTES,
} from "./flac-admission.js";
import type { StemResolver } from "./types.js";

/** Package-owned main-realm buffers only; peaks survive completion and failure. */
export interface IngestResidency {
  readonly limit: number;
  readonly deliveredBytes: number;
  readonly deliveredPeakBytes: number;
  readonly decodedBytes: number;
  readonly decodedPeakBytes: number;
  readonly containers: number;
  readonly containersPeak: number;
  readonly active: number;
  readonly activePeak: number;
}

/** Configured per-slot envelope, including the live buffers counted above. */
export interface IngestReservation {
  readonly components: typeof FLAC_PACKAGE_MEMORY_COMPONENTS;
  readonly fixedBufferBytes: number;
  readonly slotBytes: number;
  readonly headroomBytes: number;
  readonly limit: number;
}

export interface IngestDiagnostics {
  readonly snapshot: () => Readonly<{
    residency: IngestResidency | null;
    reservation: IngestReservation | null;
  }>;
}

type MutableResidency = { -readonly [K in keyof IngestResidency]: IngestResidency[K] };
interface State { bound: boolean; residency?: MutableResidency }
type ResolverFactory = (collector: IngestDiagnostics) => StemResolver;
const states = new WeakMap<IngestDiagnostics, State>();
const resolvers = new WeakMap<StemResolver, ResolverFactory>();
const decoded = new WeakMap<ArrayBufferLike, () => void>();
const noop: () => void = () => undefined;

export function createIngestDiagnostics(): IngestDiagnostics {
  const state: State = { bound: false };
  const collector: IngestDiagnostics = Object.freeze({
    snapshot: () => Object.freeze({
      residency: state.residency === undefined ? null : Object.freeze({ ...state.residency }),
      reservation: state.residency === undefined ? null : Object.freeze({
        components: Object.freeze({ ...FLAC_PACKAGE_MEMORY_COMPONENTS }),
        fixedBufferBytes: FLAC_ACCOUNTED_FIXED_BUFFER_BYTES,
        slotBytes: FLAC_WORKER_RESERVATION_BYTES,
        headroomBytes: FLAC_ACCOUNTING_HEADROOM_BYTES,
        limit: state.residency.limit,
      }),
    }),
  });
  states.set(collector, state);
  return collector;
}

/** Internal single-invocation boundary; intentionally before asynchronous boot. */
export function bindIngestDiagnostics(collector: IngestDiagnostics | undefined): void {
  if (collector === undefined) return;
  const state = states.get(collector);
  if (state === undefined) throw new TypeError("ingestDiagnostics must come from createIngestDiagnostics");
  if (state.bound) throw new TypeError("ingestDiagnostics can belong to only one open invocation");
  state.bound = true;
}

export function registerFlacResolver(resolver: StemResolver, factory: ResolverFactory): void {
  resolvers.set(resolver, factory);
}

export function diagnosticResolver(resolver: StemResolver, collector: IngestDiagnostics | undefined): StemResolver {
  return collector === undefined ? resolver : resolvers.get(resolver)?.(collector) ?? resolver;
}

export function inheritFlacRegistration(
  wrapper: StemResolver, resolver: StemResolver, wrap: (producer: StemResolver) => StemResolver,
): void {
  const factory = resolvers.get(resolver);
  if (factory !== undefined) resolvers.set(wrapper, collector => wrap(factory(collector)));
}

/** Only the package store paired with its registered producer can claim residency. */
export function initializeIngestDiagnostics(
  collector: IngestDiagnostics | undefined, resolver: StemResolver, limit: number,
): IngestDiagnostics | undefined {
  if (collector === undefined || !resolvers.has(resolver)) return undefined;
  const state = states.get(collector);
  if (state === undefined) throw new TypeError("ingestDiagnostics must come from createIngestDiagnostics");
  if (state.residency !== undefined) throw new TypeError("ingestDiagnostics can initialize only one pipeline");
  state.residency = {
    limit, deliveredBytes: 0, deliveredPeakBytes: 0, decodedBytes: 0, decodedPeakBytes: 0,
    containers: 0, containersPeak: 0, active: 0, activePeak: 0,
  };
  return collector;
}

function retain(collector: IngestDiagnostics | undefined, field: "deliveredBytes" | "decodedBytes" | "containers" | "active", bytes: number): () => void {
  const residency = collector === undefined ? undefined : states.get(collector)?.residency;
  if (residency === undefined) return noop;
  const peak = { deliveredBytes: "deliveredPeakBytes", decodedBytes: "decodedPeakBytes", containers: "containersPeak", active: "activePeak" } as const;
  residency[field] += bytes;
  residency[peak[field]] = Math.max(residency[peak[field]], residency[field]);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    residency[field] -= bytes;
  };
}

/** One small numeric owner per resolve, never a retained buffer list. */
export function deliveredRangeOwner(collector: IngestDiagnostics | undefined): (bytes: number) => () => void {
  let ranges = 0;
  let releaseContainer = noop;
  return (bytes) => {
    if (ranges++ === 0) releaseContainer = retain(collector, "containers", 1);
    const releaseBytes = retain(collector, "deliveredBytes", bytes);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseBytes();
      if (--ranges === 0) releaseContainer();
    };
  };
}

export function retainDecoded(collector: IngestDiagnostics | undefined, buffer: ArrayBuffer): void {
  if (decoded.has(buffer)) return;
  decoded.set(buffer, retain(collector, "decodedBytes", buffer.byteLength));
}

export function releaseDecoded(buffer: ArrayBufferLike): void {
  decoded.get(buffer)?.();
  decoded.delete(buffer);
}

export function retainActive(collector: IngestDiagnostics | undefined): () => void {
  return retain(collector, "active", 1);
}
