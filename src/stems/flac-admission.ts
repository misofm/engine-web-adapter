import { EngineWebAdapterError } from "../errors.js";
import { FLAC_INPUT_CONTROL_BYTES, FLAC_INPUT_SLOT_BYTES } from "./flac-input-slot.js";
import { FLAC_DECODER_MEMORY_BYTES, MAXIMUM_CANONICAL_OUTPUT_BYTES } from "./native-flac-decoder.js";
import { FLAC_DECODE_OUTPUT_CREDITS } from "./flac-worker-protocol.js";

export const FLAC_WORKER_RESERVATION_BYTES = 8 * 1024 * 1024;
export const DEFAULT_FLAC_MEMORY_BUDGET_BYTES = 16 * 1024 * 1024;
export const MINIMUM_FLAC_MEMORY_BUDGET_BYTES = 8 * 1024 * 1024;
export const MAXIMUM_FLAC_MEMORY_BUDGET_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAXIMUM_ACTIVE_FLAC_WORKERS = 4;
/** Conservative fixed-byte accounting; browser network/decoder internals are opaque and excluded. */
export const FLAC_PACKAGE_MEMORY_COMPONENTS = Object.freeze({
  exactRange: FLAC_INPUT_SLOT_BYTES,
  compressedInputSlot: FLAC_INPUT_SLOT_BYTES,
  decoderLinearMemory: FLAC_DECODER_MEMORY_BYTES,
  decodedOutputCredits: FLAC_DECODE_OUTPUT_CREDITS * MAXIMUM_CANONICAL_OUTPUT_BYTES,
  decodedInFlightWrite: MAXIMUM_CANONICAL_OUTPUT_BYTES,
  opfsWriteClone: MAXIMUM_CANONICAL_OUTPUT_BYTES,
  metadataAndControl: 4 * 1024 + FLAC_INPUT_CONTROL_BYTES,
});
export const FLAC_ACCOUNTED_FIXED_BUFFER_BYTES = Object.values(FLAC_PACKAGE_MEMORY_COMPONENTS)
  .reduce((sum, bytes) => sum + bytes, 0);
export const FLAC_ACCOUNTING_HEADROOM_BYTES = FLAC_WORKER_RESERVATION_BYTES - FLAC_ACCOUNTED_FIXED_BUFFER_BYTES;

export function defaultFlacMemoryBudgetBytes(deviceMemory?: number): number {
  if (deviceMemory === undefined || !Number.isFinite(deviceMemory) || deviceMemory <= 0) {
    return DEFAULT_FLAC_MEMORY_BUDGET_BYTES;
  }
  return Math.min(
    MAXIMUM_FLAC_MEMORY_BUDGET_BYTES,
    Math.max(MINIMUM_FLAC_MEMORY_BUDGET_BYTES, Math.floor(deviceMemory * FLAC_WORKER_RESERVATION_BYTES)),
  );
}

export function flacAdmissionWidth(options: {
  readonly hardwareConcurrency?: number;
  readonly memoryBudgetBytes?: number;
  readonly maximum?: number;
} = {}): number {
  const hardware =
    options.hardwareConcurrency !== undefined && Number.isFinite(options.hardwareConcurrency)
      ? Math.floor(options.hardwareConcurrency)
      : 2;
  const memoryBudget = options.memoryBudgetBytes ?? DEFAULT_FLAC_MEMORY_BUDGET_BYTES;
  const maximum = options.maximum ?? DEFAULT_MAXIMUM_ACTIVE_FLAC_WORKERS;
  if (!Number.isSafeInteger(memoryBudget) || memoryBudget < FLAC_WORKER_RESERVATION_BYTES) {
    throw new RangeError("memoryBudgetBytes must reserve at least one FLAC Worker");
  }
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError("maximum must be a positive integer");
  return Math.max(
    1,
    Math.min(Math.max(1, hardware - 1), Math.floor(memoryBudget / FLAC_WORKER_RESERVATION_BYTES), maximum),
  );
}

/** Opt-in decode and canonical-hash policy; each worker reserves 8 MiB. */
export interface FlacProcessingOptions {
  readonly maximumWorkers?: number;
  readonly memoryBudgetBytes?: number;
  /** Warm-cache verification remains independently bounded (default: download width). */
  readonly maximumVerifications?: number;
}

export interface FlacAdmissionOptions {
  readonly admission?: BoundedStemAdmission;
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
  readonly memoryBudgetBytes?: number;
  readonly maximumWorkers?: number;
  readonly processing?: FlacProcessingOptions;
}

/** Resolve truthful browser hints once; processing never expands physical delivery. */
export function flacPipelineWidths(options: FlacAdmissionOptions): Readonly<{
  processing: number; downloads: number; verification: number;
}> {
  const hints = typeof navigator === "undefined" ? undefined : navigator as Navigator & { readonly deviceMemory?: number };
  const hardwareConcurrency = options.hardwareConcurrency ?? hints?.hardwareConcurrency;
  const deviceMemory = options.deviceMemory ?? hints?.deviceMemory;
  const legacy = flacAdmissionWidth({
    ...(hardwareConcurrency === undefined ? {} : { hardwareConcurrency }),
    memoryBudgetBytes: options.memoryBudgetBytes ?? defaultFlacMemoryBudgetBytes(deviceMemory),
    ...(options.maximumWorkers === undefined ? {} : { maximum: options.maximumWorkers }),
  });
  if (options.processing === undefined) {
    const width = options.admission?.limit ?? legacy;
    return { processing: width, downloads: width, verification: width };
  }
  const maximum = options.processing.maximumWorkers ?? 16;
  const verificationMaximum = options.processing.maximumVerifications ?? 4;
  for (const [name, value, ceiling] of [["processing.maximumWorkers", maximum, 16], ["processing.maximumVerifications", verificationMaximum, 4]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new RangeError(`${name} must be between 1 and ${ceiling}`);
  }
  const automaticMemory = deviceMemory === undefined || !Number.isFinite(deviceMemory) || deviceMemory <= 0
    ? DEFAULT_FLAC_MEMORY_BUDGET_BYTES
    : Math.min(128 * 1024 * 1024, Math.max(MINIMUM_FLAC_MEMORY_BUDGET_BYTES, Math.floor(deviceMemory * 16 * 1024 * 1024)));
  const processing = flacAdmissionWidth({
    ...(hardwareConcurrency === undefined ? {} : { hardwareConcurrency }),
    memoryBudgetBytes: options.processing.memoryBudgetBytes ?? automaticMemory,
    maximum,
  });
  // A supplied shared processing admission can reduce, never bypass the policy.
  if (options.admission !== undefined && options.admission.limit > processing) {
    throw new RangeError("admission exceeds the device and memory bounded processing policy");
  }
  const downloads = Math.min(4, legacy);
  return { processing: options.admission?.limit ?? processing, downloads, verification: Math.min(downloads, verificationMaximum) };
}

export interface StemAdmissionLease {
  release(): void;
}

interface Waiter {
  readonly resolve: (lease: StemAdmissionLease) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
}

/** A duration-independent FIFO shared by cold decode and warm verification. */
export class BoundedStemAdmission {
  readonly limit: number;
  #active = 0;
  #queued: Waiter[] = [];
  #closed = false;
  #failure: unknown;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    this.limit = limit;
  }

  get stats(): Readonly<{ active: number; queued: number; limit: number }> {
    return { active: this.#active, queued: this.#queued.length, limit: this.limit };
  }

  /** Fail closed when a physical resource cannot be proven released. */
  close(reason: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = reason;
    for (const waiter of this.#queued.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(reason);
    }
  }

  acquire(signal?: AbortSignal): Promise<StemAdmissionLease> {
    if (this.#closed) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.reject(cancelled(signal.reason));
    if (this.#active < this.limit) {
      this.#active += 1;
      return Promise.resolve(this.#lease());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.#queued.indexOf(waiter);
          if (index < 0) return;
          this.#queued.splice(index, 1);
          reject(cancelled(signal?.reason));
        },
      };
      this.#queued.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lease = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      lease.release();
    }
  }

  #lease(): StemAdmissionLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
        this.#admitNext();
      },
    };
  }

  #admitNext(): void {
    if (this.#closed) return;
    while (this.#active < this.limit) {
      const waiter = this.#queued.shift();
      if (waiter === undefined) return;
      waiter.signal?.removeEventListener("abort", waiter.abort);
      if (waiter.signal?.aborted) {
        waiter.reject(cancelled(waiter.signal.reason));
        continue;
      }
      this.#active += 1;
      waiter.resolve(this.#lease());
    }
  }
}

function cancelled(cause: unknown): EngineWebAdapterError {
  return new EngineWebAdapterError("stem.cancelled", "Stem admission was cancelled", {}, cause);
}
