import { EngineWebAdapterError } from "../errors.js";
import type { StemIdentity, StemSessionLease } from "./types.js";
import { Msb1RingWriter, msb1RingBytes } from "./ring.js";

export interface PcmPumpSource {
  readonly sourceId: string;
  readonly identity: StemIdentity;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frames: number;
  readonly ring: SharedArrayBuffer;
}

interface SourceState extends PcmPumpSource {
  readonly writer: Msb1RingWriter;
  cursor: number;
  blob: Blob | undefined;
  window: Uint8Array | undefined;
  windowStart: number;
  finished: boolean;
}

export interface PcmPumpOutcome {
  readonly chunks: number;
  readonly frames: number;
  readonly finished: boolean;
}

/** Bounded-window, fair PCM producer intended to live in a dedicated Worker. */
export class CanonicalPcmPump {
  readonly #lease: Pick<StemSessionLease, "read">;
  readonly #states: SourceState[];
  readonly #windowFrames: number;
  readonly #abort = new AbortController();
  #generation: bigint;
  #stopped = false;
  #roundRobin = 0;

  readonly maximumWindowBytes: number;
  readonly ringBytes: number;

  constructor(options: {
    readonly lease: Pick<StemSessionLease, "read">;
    readonly sources: readonly PcmPumpSource[];
    readonly windowFrames?: number;
    readonly generation?: bigint;
  }) {
    if (typeof options.lease?.read !== "function") throw new TypeError("PCM pump needs a verified lease");
    this.#lease = options.lease;
    this.#windowFrames = positive(options.windowFrames ?? 4096, "windowFrames");
    this.#generation = options.generation ?? 1n;
    this.#states = options.sources.map((source) => {
      if (!positive(source.frames, "frames") || source.channels < 1 || source.channels > 2 ||
          (source.bitDepth !== 16 && source.bitDepth !== 24)) throw new RangeError("Invalid PCM pump source shape");
      const writer = new Msb1RingWriter(source.ring);
      if (writer.channels !== source.channels) throw new RangeError("PCM source channels do not match its ring");
      if (this.#windowFrames < writer.frameCapacity) throw new RangeError("windowFrames must cover one render quantum");
      return { ...source, writer, cursor: 0, blob: undefined, window: undefined, windowStart: -1, finished: false };
    });
    this.maximumWindowBytes = this.#states.reduce(
      (sum, state) => sum + this.#windowFrames * state.channels * (state.bitDepth / 8), 0,
    );
    this.ringBytes = this.#states.reduce(
      (sum, state) => sum + msb1RingBytes(state.channels, state.writer.frameCapacity, state.writer.capacity), 0,
    );
    for (const state of this.#states) state.writer.engage(this.#generation);
  }

  get finished(): boolean { return this.#states.every((state) => state.finished); }
  get stopped(): boolean { return this.#stopped; }

  /** One fair round: at most one quantum per source. */
  async pumpPass(): Promise<PcmPumpOutcome> {
    if (this.#stopped || this.#states.length === 0) return { chunks: 0, frames: 0, finished: this.finished };
    let chunks = 0;
    let frames = 0;
    for (let step = 0; step < this.#states.length; step += 1) {
      const index = (this.#roundRobin + step) % this.#states.length;
      const written = await this.#writeOne(this.#states[index]!);
      if (written > 0) { chunks += 1; frames += written; }
      if (this.#stopped) break;
    }
    this.#roundRobin = (this.#roundRobin + 1) % this.#states.length;
    return { chunks, frames, finished: this.finished };
  }

  /** Fill available bounded slots while preserving round-robin service. */
  async pumpUntilBlocked(): Promise<PcmPumpOutcome> {
    let chunks = 0;
    let frames = 0;
    while (!this.#stopped) {
      const pass = await this.pumpPass();
      chunks += pass.chunks; frames += pass.frames;
      if (pass.chunks === 0 || pass.finished) break;
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
      state.window = undefined; state.windowStart = -1;
      state.finished = state.cursor === state.frames;
      state.writer.seek(this.#generation, BigInt(state.cursor));
    }
    return this.#generation;
  }

  close(reason: unknown = new DOMException("PCM pump closed", "AbortError")): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#abort.abort(reason);
    for (const state of this.#states) {
      state.writer.release(); state.window = undefined; state.blob = undefined;
    }
  }

  async #writeOne(state: SourceState): Promise<number> {
    this.#abort.signal.throwIfAborted();
    if (state.finished || state.cursor >= state.frames) { state.finished = true; return 0; }
    if (state.writer.occupancy >= state.writer.capacity) return 0;
    const frames = Math.min(state.writer.frameCapacity, state.frames - state.cursor);
    const planes = state.writer.reserve(frames);
    if (planes === null) return 0;
    const frameBytes = state.channels * (state.bitDepth / 8);
    const windowEnd = state.windowStart + (state.window?.byteLength ?? 0) / frameBytes;
    if (state.window === undefined || state.cursor < state.windowStart || state.cursor + frames > windowEnd) {
      state.blob ??= await this.#lease.read(state.identity);
      this.#abort.signal.throwIfAborted();
      const firstByte = state.cursor * frameBytes;
      const finalByte = Math.min(state.frames, state.cursor + this.#windowFrames) * frameBytes;
      state.window = new Uint8Array(await state.blob.slice(firstByte, finalByte).arrayBuffer());
      this.#abort.signal.throwIfAborted();
      state.windowStart = state.cursor;
      if (state.window.byteLength > this.#windowFrames * frameBytes) throw new Error("PCM window exceeded its bound");
    }
    deinterleaveCanonicalPcm(
      state.window,
      state.cursor - state.windowStart,
      frames,
      state.channels,
      state.bitDepth,
      planes,
    );
    const startFrame = state.cursor;
    state.cursor += frames;
    state.finished = state.cursor === state.frames;
    state.writer.commit({
      generation: this.#generation,
      startFrame: BigInt(startFrame),
      frames,
      endOfRegion: state.finished,
    });
    return frames;
  }
}

export class SelfDrivingPcmPump {
  readonly #pump: CanonicalPcmPump;
  readonly #idleMs: number;
  #token: object | undefined;
  #wake: (() => void) | undefined;
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
    const generation = await this.#pump.seekFrames(frame);
    this.#wake?.(); this.start();
    return generation;
  }
  close(): void {
    this.#token = undefined; this.#wake?.(); this.#pump.close();
  }
  async #drive(token: object): Promise<void> {
    try {
      while (this.#token === token) {
        const outcome = await this.#pump.pumpUntilBlocked();
        if (outcome.finished || this.#token !== token) break;
        if (outcome.chunks === 0) await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, this.#idleMs);
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

function positive(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be positive`); return value; }
function nonnegative(value: number, label: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be nonnegative`); return value; }
