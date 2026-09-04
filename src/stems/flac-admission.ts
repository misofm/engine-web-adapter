import { EngineWebAdapterError } from "../errors.js";
import {
  MAXIMUM_DELIVERY_CHUNK_BYTES,
  MAXIMUM_DENSE_SEEK_POINTS,
  MAXIMUM_FLAC_FRAME_BYTES,
  MAXIMUM_FLAC_METADATA_BYTES,
} from "./flac-metadata.js";
import { MAXIMUM_CANONICAL_OUTPUT_BYTES } from "./flac-pcm.js";
import { FLAC_DECODE_OUTPUT_CREDITS, MAXIMUM_FLAC_DECODER_SUBMISSIONS } from "./flac-worker-protocol.js";

export const FLAC_WORKER_RESERVATION_BYTES = 8 * 1024 * 1024;
export const DEFAULT_FLAC_MEMORY_BUDGET_BYTES = 16 * 1024 * 1024;
export const MINIMUM_FLAC_MEMORY_BUDGET_BYTES = 8 * 1024 * 1024;
export const MAXIMUM_FLAC_MEMORY_BUDGET_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAXIMUM_ACTIVE_FLAC_WORKERS = 4;
const MAXIMUM_METADATA_SEEK_POINTS = Math.min(
  MAXIMUM_DENSE_SEEK_POINTS,
  Math.floor((MAXIMUM_FLAC_METADATA_BYTES - 4 - 4 - 34 - 4) / 18),
);

/** Conservative fixed-byte accounting; browser network/decoder internals are opaque and excluded. */
export const FLAC_PACKAGE_MEMORY_COMPONENTS = Object.freeze({
  exactRange: MAXIMUM_DELIVERY_CHUNK_BYTES,
  metadataParser: MAXIMUM_FLAC_METADATA_BYTES + 2 * MAXIMUM_DELIVERY_CHUNK_BYTES,
  packetizerPeak: 3 * MAXIMUM_FLAC_FRAME_BYTES + 2 * MAXIMUM_DELIVERY_CHUNK_BYTES,
  decoderSubmissions: MAXIMUM_FLAC_DECODER_SUBMISSIONS * MAXIMUM_FLAC_FRAME_BYTES,
  decodedOutputCredits: FLAC_DECODE_OUTPUT_CREDITS * MAXIMUM_CANONICAL_OUTPUT_BYTES,
  seekTable: MAXIMUM_METADATA_SEEK_POINTS * (8 + 8 + 2),
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

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    this.limit = limit;
  }

  get stats(): Readonly<{ active: number; queued: number; limit: number }> {
    return { active: this.#active, queued: this.#queued.length, limit: this.limit };
  }

  acquire(signal?: AbortSignal): Promise<StemAdmissionLease> {
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
