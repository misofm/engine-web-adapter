import {
  FLAC_ACCOUNTED_FIXED_BUFFER_BYTES,
  FLAC_ACCOUNTING_HEADROOM_BYTES,
  FLAC_PACKAGE_MEMORY_COMPONENTS,
  FLAC_WORKER_RESERVATION_BYTES,
} from "./flac-admission.js";
import type { BoundedStemAdmission } from "./flac-admission.js";
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

export interface IngestStage {
  readonly active: number;
  readonly peak: number;
  readonly count: number;
  /** Aggregate wall time in this stage, not operating-system CPU time. */
  readonly milliseconds: number;
}
export interface IngestProcessing {
  readonly downloadLimit: number;
  readonly workerLimit: number;
  readonly verificationLimit: number;
  readonly downloads: IngestStage;
  readonly downloadQueue: IngestStage;
  readonly workers: IngestStage;
  readonly verification: IngestStage;
  readonly writes: IngestStage;
  readonly decodeMs: number;
  readonly hashMs: number;
  readonly inputWaitMs: number;
  readonly outputWaitMs: number;
  readonly blocks: number;
  /** Simultaneously runnable decode/hash sections; excludes input and credit waits. */
  readonly runnablePeak: number;
}
export type WorkerProcessingMetrics = Readonly<{ decodeMs: number; hashMs: number; inputWaitMs: number; outputWaitMs: number; blocks: number }>;
type StageName = "downloads" | "downloadQueue" | "workers" | "verification" | "writes";
type MutableProcessing = { -readonly [K in keyof IngestProcessing]: IngestProcessing[K] };

export interface IngestDiagnostics {
  readonly snapshot: () => Readonly<{
    residency: IngestResidency | null;
    processing: IngestProcessing | null;
    reservation: IngestReservation | null;
  }>;
}

type MutableResidency = { -readonly [K in keyof IngestResidency]: IngestResidency[K] };
interface State { bound: boolean; residency?: MutableResidency; processing?: MutableProcessing; runnable?: Int32Array; workerSlots?: number }
type ResolverFactory = (collector: IngestDiagnostics) => StemResolver;
const states = new WeakMap<IngestDiagnostics, State>();
const resolvers = new WeakMap<StemResolver, ResolverFactory>();
const scheduling = new WeakMap<StemResolver, { readonly limit: number; readonly verification: BoundedStemAdmission }>();
const decoded = new WeakMap<ArrayBufferLike, () => void>();
const noop: () => void = () => undefined;

export function createIngestDiagnostics(): IngestDiagnostics {
  const state: State = { bound: false };
  const collector: IngestDiagnostics = Object.freeze({
    snapshot: () => Object.freeze({
      processing: state.processing === undefined ? null : Object.freeze({ ...state.processing,
        ...Object.fromEntries((["downloads", "downloadQueue", "workers", "verification", "writes"] as const)
          .map(name => [name, Object.freeze({ ...state.processing![name] })])),
        runnablePeak: state.runnable === undefined ? 0 : Atomics.load(state.runnable, 1),
      }),
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

export function registerFlacResolver(resolver: StemResolver, factory: ResolverFactory,
  policy?: { readonly limit: number; readonly verification: BoundedStemAdmission }): void {
  resolvers.set(resolver, factory);
  if (policy !== undefined) scheduling.set(resolver, policy);
}
export function flacResolverScheduling(resolver: StemResolver): { readonly limit: number; readonly verification: BoundedStemAdmission } | undefined {
  return scheduling.get(resolver);
}

export function diagnosticResolver(resolver: StemResolver, collector: IngestDiagnostics | undefined): StemResolver {
  return collector === undefined ? resolver : resolvers.get(resolver)?.(collector) ?? resolver;
}

export function inheritFlacRegistration(
  wrapper: StemResolver, resolver: StemResolver, wrap: (producer: StemResolver) => StemResolver,
): void {
  const factory = resolvers.get(resolver);
  if (factory !== undefined) resolvers.set(wrapper, collector => wrap(factory(collector)));
  const policy = scheduling.get(resolver);
  if (policy !== undefined) scheduling.set(wrapper, policy);
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

/** Per-open counters contain numbers only, never a per-frame event history. */
export function configureProcessingDiagnostics(collector: IngestDiagnostics | undefined, limits: {
  readonly processing: number; readonly downloads: number; readonly verification: number;
}): SharedArrayBuffer | undefined {
  const state = collector === undefined ? undefined : states.get(collector);
  if (state === undefined) return undefined;
  const stage = (): IngestStage => ({ active: 0, peak: 0, count: 0, milliseconds: 0 });
  state.processing ??= {
    downloadLimit: limits.downloads, workerLimit: limits.processing, verificationLimit: limits.verification,
    downloads: stage(), downloadQueue: stage(), workers: stage(), verification: stage(), writes: stage(),
    decodeMs: 0, hashMs: 0, inputWaitMs: 0, outputWaitMs: 0, blocks: 0, runnablePeak: 0,
  };
  state.runnable ??= new Int32Array(new SharedArrayBuffer(8));
  return state.runnable.buffer as SharedArrayBuffer;
}

export function beginIngestStage(collector: IngestDiagnostics | undefined, name: StageName): () => void {
  const stage = (collector === undefined ? undefined : states.get(collector)?.processing?.[name]) as
    { -readonly [K in keyof IngestStage]: IngestStage[K] } | undefined;
  if (stage === undefined) return noop;
  const start = performance.now();
  stage.active += 1;
  stage.peak = Math.max(stage.peak, stage.active);
  stage.count += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    stage.active -= 1;
    stage.milliseconds += performance.now() - start;
  };
}

export function recordWorkerProcessing(collector: IngestDiagnostics | undefined, metrics: WorkerProcessingMetrics): void {
  const processing = collector === undefined ? undefined : states.get(collector)?.processing;
  if (processing === undefined) return;
  for (const name of ["decodeMs", "hashMs", "inputWaitMs", "outputWaitMs", "blocks"] as const) processing[name] += metrics[name];
}

/** A reusable bit belongs to one physical Worker until its termination settles. */
export function ownRunnableWorker(collector: IngestDiagnostics | undefined): {
  readonly buffer: SharedArrayBuffer; readonly mask: number; release(): void;
} | undefined {
  const state = collector === undefined ? undefined : states.get(collector);
  if (state?.runnable === undefined || (state.processing?.workerLimit ?? 0) > 32) return undefined;
  const slots = state.workerSlots ?? 0;
  let slot = 0;
  while (slot < 32 && (slots & (1 << slot)) !== 0) slot += 1;
  if (slot === 32) return undefined;
  const mask = 1 << slot;
  state.workerSlots = slots | mask;
  let released = false;
  return { buffer: state.runnable.buffer as SharedArrayBuffer, mask, release() {
    if (released) return;
    released = true;
    Atomics.and(state.runnable!, 0, ~mask);
    state.workerSlots = (state.workerSlots ?? 0) & ~mask;
  } };
}
