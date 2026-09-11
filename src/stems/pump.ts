import { EngineWebAdapterError } from "../errors.js";
import type { StemIdentity, StemSessionLease } from "./types.js";
import { Msb1RingWriter, msb1RingBytes } from "./ring.js";
import { readSparsePcmWindow, validateSparsePcmIndex } from "./sparse-pcm.js";
import type { SparsePcmIndex } from "./sparse-pcm.js";
import type { SparsePcmDescriptor } from "./sparse-store.js";

export interface PcmPumpSource {
  readonly sourceId: string;
  readonly identity: StemIdentity;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frames: number;
  readonly ring: SharedArrayBuffer;
}

export interface SparsePcmPumpSource extends PcmPumpSource {
  readonly sampleRateHz: number;
}

export interface SparsePcmPumpOptions {
  readonly assets: readonly SparsePcmDescriptor[];
  readonly sources: readonly SparsePcmPumpSource[];
  readonly windowFrames?: number;
  readonly generation?: bigint;
}

interface PcmWindow { readonly bytes: Uint8Array; readonly start: number; }
interface SourceState extends PcmPumpSource {
  readonly writer: Msb1RingWriter;
  readonly sparse: SparseReadable | undefined;
  cursor: number;
  blob: Blob | undefined;
  window: PcmWindow | undefined;
  next: PcmWindow | undefined;
  reading: Promise<void> | undefined;
  finished: boolean;
}

interface SparseReadable {
  readonly data: Blob;
  readonly index: SparsePcmIndex;
}

export interface PcmPumpOutcome {
  readonly chunks: number;
  readonly frames: number;
  readonly finished: boolean;
}

export const PCM_WINDOW_FRAMES = 8192;
const MAXIMUM_READS = 4;
const READ_DEADLINE_MS = 5_000;
export const PCM_DRIVE_PASSES = 8;

/** Bounded current/next windows and a shared four-read local I/O scheduler. */
export class CanonicalPcmPump {
  readonly #lease: Pick<StemSessionLease, "read"> | undefined;
  readonly #states: SourceState[];
  readonly #windowFrames: number;
  readonly #reads = new Set<Promise<void>>();
  readonly #readTimers = new Set<ReturnType<typeof setTimeout>>();
  #generation: bigint;
  #stopped = false;
  #roundRobin = 0;
  #failure: unknown;

  readonly maximumWindowBytes: number;
  readonly maximumReadScratchBytes: number;
  readonly ringBytes: number;

  constructor(options: {
    readonly lease: Pick<StemSessionLease, "read">;
    readonly sources: readonly PcmPumpSource[];
    readonly windowFrames?: number;
    readonly generation?: bigint;
  });
  constructor(options: SparsePcmPumpOptions);
  constructor(options: {
    readonly lease?: Pick<StemSessionLease, "read">;
    readonly sources: readonly PcmPumpSource[];
    readonly assets?: readonly SparsePcmDescriptor[];
    readonly windowFrames?: number;
    readonly generation?: bigint;
  }) {
    const sparseAssets = options.assets;
    const sparse = sparseAssets !== undefined;
    if (!sparse && options.lease === undefined) throw new TypeError("Dense PCM pump needs a verified lease");
    if (!sparse && typeof options.lease?.read !== "function") throw new TypeError("PCM pump needs a verified lease");
    this.#lease = options.lease;
    this.#windowFrames = positive(options.windowFrames ?? PCM_WINDOW_FRAMES, "windowFrames");
    if (sparse && this.#windowFrames > PCM_WINDOW_FRAMES) throw new RangeError("Sparse PCM windowFrames cannot exceed 8192");
    this.#generation = options.generation ?? 1n;
    if (typeof this.#generation !== "bigint" || this.#generation < 0n) throw new RangeError("generation must be a nonnegative bigint");
    const sparseMap = sparse ? admitSparseAssets(sparseAssets!) : undefined;
    const sourceIds = new Set<string>();
    this.#states = options.sources.map((source) => {
      if (sourceIds.has(source.sourceId)) throw new RangeError("PCM pump source IDs must be unique");
      sourceIds.add(source.sourceId);
      if (typeof source.sourceId !== "string" || source.sourceId.length === 0) throw new RangeError("PCM pump source IDs must be nonempty");
      if (!positive(source.frames, "frames") || source.channels < 1 || source.channels > 2 ||
          (source.bitDepth !== 16 && source.bitDepth !== 24)) throw new RangeError("Invalid PCM pump source shape");
      const sparseReadable = sparseMap === undefined ? undefined : sparseMap.get(source.identity);
      if (sparse && sparseReadable === undefined) throw new EngineWebAdapterError("session.declaration_mismatch", "Sparse PCM asset is missing for a source");
      if (sparseReadable !== undefined) {
        const sampleRateHz = (source as SparsePcmPumpSource).sampleRateHz;
        if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz !== sparseReadable.index.sampleRateHz || source.channels !== sparseReadable.index.channels ||
            source.bitDepth !== sparseReadable.index.bitDepth || source.frames !== sparseReadable.index.frames ||
            source.identity !== sparseReadable.index.identity) {
          throw new EngineWebAdapterError("session.declaration_mismatch", "Sparse PCM source shape disagrees with its asset");
        }
      }
      const writer = new Msb1RingWriter(source.ring);
      if (writer.channels !== source.channels) throw new RangeError("PCM source channels do not match its ring");
      if (this.#windowFrames < writer.frameCapacity) throw new RangeError("windowFrames must cover one render quantum");
      return { ...source, writer, sparse: sparseReadable, cursor: 0, blob: undefined, window: undefined, next: undefined, reading: undefined, finished: false };
    });
    if (sparseMap !== undefined && sparseMap.size !== new Set(this.#states.map((state) => state.identity)).size) {
      throw new EngineWebAdapterError("session.declaration_mismatch", "Sparse PCM assets contain an unreferenced descriptor");
    }
    // A pending read owns its destination slot even across seek; that source
    // cannot start another read until the old operation physically settles.
    this.maximumWindowBytes = safeByteSum(
      this.#states.map((state) => 2 * this.#windowFrames * state.channels * (state.bitDepth / 8)),
      "PCM window bound",
    );
    const scratchBounds = this.#states
      .map((state) => this.#windowFrames * state.channels * (state.bitDepth / 8))
      .sort((left, right) => right - left);
    this.maximumReadScratchBytes = sparse ? safeByteSum(scratchBounds.slice(0, 4), "Sparse PCM read scratch bound") : 0;
    this.ringBytes = safeByteSum(
      this.#states.map((state) => msb1RingBytes(state.channels, state.writer.frameCapacity, state.writer.capacity)),
      "PCM ring bound",
    );
    safeByteSum([this.maximumWindowBytes, this.maximumReadScratchBytes], "PCM allocation bound");
    for (const state of this.#states) state.writer.engage(this.#generation);
  }

  static createSparse(options: SparsePcmPumpOptions): CanonicalPcmPump {
    return new CanonicalPcmPump(options);
  }

  get finished(): boolean { return this.#states.every((state) => state.finished); }
  get stopped(): boolean { return this.#stopped; }

  /** One fair round; available sources are never blocked by another source's I/O. */
  async pumpPass(waitForReads = true): Promise<PcmPumpOutcome> {
    this.#throwIfFailed();
    if (this.#stopped || this.#states.length === 0) return { chunks: 0, frames: 0, finished: this.finished };
    this.#scheduleReads();
    // Manual drain callers may wait for progress. Worker ticks never await
    // storage and always yield, so seek/stop can invalidate outstanding reads.
    if (waitForReads && !this.#states.some((state) => this.#canWrite(state)) && this.#needsWindow()) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      this.#throwIfFailed();
      if (this.#stopped) return { chunks: 0, frames: 0, finished: this.finished };
    }
    let chunks = 0;
    let frames = 0;
    for (let step = 0; step < this.#states.length; step += 1) {
      const index = (this.#roundRobin + step) % this.#states.length;
      const written = this.#writeOne(this.#states[index]!);
      if (written > 0) { chunks += 1; frames += written; }
    }
    this.#roundRobin = (this.#roundRobin + 1) % this.#states.length;
    this.#scheduleReads();
    return { chunks, frames, finished: this.finished };
  }

  /** Manual callers drain all available slots; worker callers use finite ticks. */
  async pumpUntilBlocked(maximumPasses = Number.MAX_SAFE_INTEGER, waitForReads = true): Promise<PcmPumpOutcome> {
    positive(maximumPasses, "maximumPasses");
    let chunks = 0;
    let frames = 0;
    for (let passIndex = 0; passIndex < maximumPasses && !this.#stopped; passIndex += 1) {
      const pass = await this.pumpPass(waitForReads);
      chunks += pass.chunks; frames += pass.frames;
      if (pass.finished || (pass.chunks === 0 && (!waitForReads || !this.#needsWindow()))) break;
    }
    return { chunks, frames, finished: this.finished };
  }

  async seekFrames(frame: number | bigint): Promise<bigint> {
    if (this.#stopped) throw new EngineWebAdapterError("session.closed", "PCM pump is closed");
    const target = typeof frame === "bigint" ? frame : BigInt(frame);
    if (target < 0n || target > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("seek frame is out of range");
    this.#generation += 1n;
    for (const state of this.#states) {
      state.cursor = Math.min(Number(target), state.frames);
      state.window = undefined; state.next = undefined;
      state.finished = state.cursor === state.frames;
      state.writer.seek(this.#generation, BigInt(state.cursor));
    }
    return this.#generation;
  }

  close(reason: unknown = new DOMException("PCM pump closed", "AbortError")): void {
    if (this.#stopped) return;
    this.#stopped = true;
    void reason;
    for (const timer of this.#readTimers) clearTimeout(timer);
    this.#readTimers.clear();
    for (const state of this.#states) {
      state.writer.release(); state.window = undefined; state.next = undefined; state.blob = undefined;
    }
  }

  #end(state: SourceState, window: PcmWindow): number {
    return window.start + window.bytes.byteLength / (state.channels * (state.bitDepth / 8));
  }

  #canWrite(state: SourceState): boolean {
    if (state.finished || state.writer.occupancy >= state.writer.capacity) return false;
    if (state.window !== undefined && state.cursor >= this.#end(state, state.window)) {
      state.window = state.next; state.next = undefined;
    }
    return state.window !== undefined;
  }

  #needsWindow(): boolean {
    return this.#states.some((state) => !state.finished && state.writer.occupancy < state.writer.capacity && !this.#canWrite(state));
  }

  #scheduleReads(): void {
    if (this.#stopped || this.#failure !== undefined) return;
    const ordered = Array.from({ length: this.#states.length }, (_, step) => this.#states[(this.#roundRobin + step) % this.#states.length]!);
    // Current windows take precedence over speculative next windows. Within
    // each class, shortest shared runway is served first; ties remain fair.
    ordered.sort((a, b) => Number(a.window !== undefined) - Number(b.window !== undefined) || a.writer.occupancy - b.writer.occupancy);
    for (const state of ordered) {
      if (this.#reads.size >= MAXIMUM_READS) break;
      if (state.finished || state.reading !== undefined) continue;
      this.#canWrite(state);
      let start = state.cursor;
      if (state.window !== undefined) {
        start = this.#end(state, state.window);
        if (state.next !== undefined || start >= state.frames || state.cursor - state.window.start < this.#windowFrames / 2) continue;
      }
      const generation = this.#generation;
      const read = this.#readWindow(state, start, generation);
      state.reading = read;
      this.#reads.add(read);
      void read.finally(() => {
        this.#reads.delete(read);
        if (state.reading === read) state.reading = undefined;
        this.#scheduleReads();
      });
    }
  }

  async #readWindow(state: SourceState, start: number, generation: bigint): Promise<void> {
    const timer = setTimeout(() => {
      if (!this.#stopped) this.#failure ??= new EngineWebAdapterError("stem.read_deadline", "PCM playback window read timed out");
    }, READ_DEADLINE_MS);
    this.#readTimers.add(timer);
    try {
      if (this.#stopped || generation !== this.#generation) return;
      const frameBytes = state.channels * (state.bitDepth / 8);
      const alignedFrames = Math.floor(this.#windowFrames / state.writer.frameCapacity) * state.writer.frameCapacity;
      const count = Math.min(alignedFrames, state.frames - start) * frameBytes;
      let bytes: Uint8Array;
      if (state.sparse === undefined) {
        const lease = this.#lease;
        if (lease === undefined) throw new TypeError("Dense PCM pump has no verified lease");
        const blob = state.blob ?? await lease.read(state.identity);
        if (this.#stopped || generation !== this.#generation) return;
        state.blob = blob;
        bytes = new Uint8Array(await blob.slice(start * frameBytes, start * frameBytes + count).arrayBuffer());
      } else {
        bytes = await readSparsePcmWindow(state.sparse.index, state.sparse.data, start, count / frameBytes);
      }
      if (this.#stopped || generation !== this.#generation) return;
      if (bytes.byteLength !== count) throw new Error("PCM playback window has an invalid byte count");
      const window = { bytes, start };
      if (state.window === undefined) state.window = window;
      else state.next = window;
    } catch (error) {
      if (!this.#stopped && generation === this.#generation) this.#failure ??= error ?? new Error("PCM playback window read failed without a reason");
    } finally { clearTimeout(timer); this.#readTimers.delete(timer); }
  }

  #throwIfFailed(): void { if (this.#failure !== undefined) throw this.#failure; }

  #writeOne(state: SourceState): number {
    if (!this.#canWrite(state)) return 0;
    const frames = Math.min(state.writer.frameCapacity, state.frames - state.cursor);
    const window = state.window!;
    if (state.cursor + frames > this.#end(state, window)) throw new Error("PCM window must end on a render boundary or source tail");
    const planes = state.writer.reserve(frames);
    if (planes === null) return 0;
    deinterleaveCanonicalPcm(window.bytes, state.cursor - window.start, frames, state.channels, state.bitDepth, planes);
    const startFrame = state.cursor;
    state.cursor += frames;
    state.finished = state.cursor === state.frames;
    state.writer.commit({ generation: this.#generation, startFrame: BigInt(startFrame), frames, endOfRegion: state.finished });
    return frames;
  }
}

export class SelfDrivingPcmPump {
  readonly #pump: CanonicalPcmPump;
  readonly #idleMs: number;
  #token: object | undefined;
  #wake: (() => void) | undefined;
  #tail: Promise<void> = Promise.resolve();
  readonly #onError: ((error: unknown) => void) | undefined;
  constructor(pump: CanonicalPcmPump, idleMs = 4, onError?: (error: unknown) => void) {
    this.#pump = pump;
    this.#idleMs = nonnegative(idleMs, "idleMs");
    this.#onError = onError;
  }
  start(): void {
    if (this.#token !== undefined || this.#pump.stopped) return;
    const token = {};
    this.#token = token;
    void this.#drive(token).catch((error: unknown) => {
      this.close();
      this.#onError?.(error);
    });
  }
  async seekFrames(frame: number | bigint): Promise<bigint> {
    const generation = await this.#enqueue(() => this.#pump.seekFrames(frame));
    this.#wake?.(); this.start();
    return generation;
  }
  close(): void {
    this.#token = undefined; this.#wake?.(); this.#pump.close();
  }
  async #drive(token: object): Promise<void> {
    try {
      while (this.#token === token) {
        const outcome = await this.#enqueue(() => this.#token === token
          ? this.#pump.pumpUntilBlocked(PCM_DRIVE_PASSES, false)
          : { chunks: 0, frames: 0, finished: this.#pump.finished });
        if (outcome.finished || this.#token !== token) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, outcome.chunks === 0 ? this.#idleMs : 0);
          const previous = this.#wake;
          const self = this;
          function finish() { clearTimeout(timer); if (self.#wake === finish) self.#wake = previous; resolve(); }
          this.#wake = finish;
        });
      }
    } finally {
      if (this.#token === token) this.#token = undefined;
    }
  }
  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const queued = this.#tail.then(operation);
    this.#tail = queued.then(() => undefined, () => undefined);
    return queued;
  }
}

export function deinterleaveCanonicalPcm(
  bytes: Uint8Array,
  firstFrame: number,
  frames: number,
  channels: 1 | 2,
  bitDepth: 16 | 24,
  planes: readonly Float32Array[],
): void {
  if (planes.length !== channels || planes.some((plane) => plane.length < frames)) throw new RangeError("PCM plane shape mismatch");
  const bytesPerSample = bitDepth / 8;
  const frameBytes = channels * bytesPerSample;
  if ((firstFrame + frames) * frameBytes > bytes.byteLength) throw new RangeError("PCM window is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = (firstFrame + frame) * frameBytes + channel * bytesPerSample;
      let sample: number;
      if (bitDepth === 16) sample = view.getInt16(offset, true) / 32_768;
      else {
        sample = bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
        if ((sample & 0x80_0000) !== 0) sample |= 0xff00_0000;
        sample /= 8_388_608;
      }
      planes[channel]![frame] = sample;
    }
  }
}

function admitSparseAssets(assets: readonly SparsePcmDescriptor[]): Map<StemIdentity, SparseReadable> {
  const admitted = new Map<StemIdentity, SparseReadable>();
  for (const asset of assets) {
    if (asset.kind !== "sparse-pcm" || !(asset.data instanceof Blob)) {
      throw new EngineWebAdapterError("session.declaration_mismatch", "Sparse PCM asset descriptor is invalid");
    }
    const index = validateSparsePcmIndex(asset.index, asset.data);
    if (admitted.has(index.identity)) throw new EngineWebAdapterError("session.declaration_mismatch", "Sparse PCM assets contain a duplicate identity");
    admitted.set(index.identity, { data: asset.data, index });
  }
  return admitted;
}

function positive(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be positive`); return value; }
function nonnegative(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be nonnegative`); return value; }
function safeByteSum(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) throw new RangeError(`${label} is unsafe`);
    total += value;
  }
  return total;
}
