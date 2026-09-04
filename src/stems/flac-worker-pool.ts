import { createFlacWorker, type AdapterAssetOverrides } from "../assets.js";
import { BoundedStemAdmission, defaultFlacMemoryBudgetBytes, flacAdmissionWidth } from "./flac-admission.js";
import type { StemProgress } from "./types.js";
import type { FlacWorkerLike } from "./flac-worker-protocol.js";

export interface FlacWorkerPoolOptions {
  readonly admission?: BoundedStemAdmission;
  readonly assets?: AdapterAssetOverrides;
  readonly createWorker?: () => FlacWorkerLike;
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
  readonly memoryBudgetBytes?: number;
  readonly maximumWorkers?: number;
}

/** Admits one physical one-stem Worker and always terminates it before settling. */
export class FlacWorkerPool {
  readonly #admission: BoundedStemAdmission;
  readonly #createWorker: () => FlacWorkerLike;

  constructor(options: FlacWorkerPoolOptions = {}) {
    const navigatorHints = typeof navigator === "undefined"
      ? undefined
      : navigator as Navigator & { readonly deviceMemory?: number };
    const hardwareConcurrency = options.hardwareConcurrency ?? navigatorHints?.hardwareConcurrency;
    this.#admission = options.admission ?? new BoundedStemAdmission(flacAdmissionWidth({
      ...(hardwareConcurrency === undefined ? {} : { hardwareConcurrency }),
      memoryBudgetBytes: options.memoryBudgetBytes ?? defaultFlacMemoryBudgetBytes(options.deviceMemory ?? navigatorHints?.deviceMemory),
      ...(options.maximumWorkers === undefined ? {} : { maximum: options.maximumWorkers }),
    }));
    this.#createWorker = options.createWorker ?? (() => createFlacWorker(options.assets) as unknown as FlacWorkerLike);
  }

  get stats(): Readonly<{ active: number; queued: number; limit: number }> { return this.#admission.stats; }

  async run<T>(options: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: StemProgress) => void;
    readonly work: (worker: FlacWorkerLike) => Promise<T>;
  }): Promise<T> {
    if (this.stats.active >= this.stats.limit) {
      options.onProgress?.({
        stage: "queued",
        workersActive: this.stats.active,
        workersQueued: this.stats.queued + 1,
        workerLimit: this.stats.limit,
      });
    }
    const lease = await this.#admission.acquire(options.signal);
    let worker: FlacWorkerLike | undefined;
    try {
      options.signal?.throwIfAborted();
      worker = this.#createWorker();
      return await options.work(worker);
    } finally {
      try { worker?.terminate(); } finally { lease.release(); }
    }
  }
}
