export const MSB1_MAGIC = 0x4d534231;
export const MSB1_VERSION = 1;
export const MSB1_WRAP = 1 << 30;
export const MSB1_CONTROL_BYTES = 128;
export const MSB1_CONTROL_I64_OFFSET = 112;
export const MSB1_ID_OFFSET = 128;
export const MSB1_ID_CAPACITY = 128;
export const MSB1_HEADER_OFFSET = 256;
export const MSB1_SLOT_HEADER_BYTES = 32;
export const MSB1_FLAG_END_OF_REGION = 1;

export const MSB1_CONTROL = Object.freeze({
  MAGIC: 0, VERSION: 1, CAPACITY: 2, CHANNELS: 3, FRAME_CAPACITY: 4,
  HEADER_OFFSET: 5, PCM_OFFSET: 6, ID_LENGTH: 7, WRITE_INDEX: 8, READ_INDEX: 9,
  GENERATION_TAG: 10, SEEK_EPOCH: 11, WRITER_STATE: 12, ATTACHED: 13, WROTE: 14,
  OVERFLOW: 15, SUBMITTED: 16, STALE: 17, REFUSED: 18, LAST_RESULT: 19,
  UNDERRUNS: 20, DRAIN_BLOCKS: 21, SEEKS_APPLIED: 22, DEPTH: 23, TORN: 24,
  FINISHED: 25, ERRORS: 26, SUBMITTED_GENERATION_TAG: 27,
} as const);

const SLOT = Object.freeze({ SEQUENCE: 0, GENERATION_TAG: 1, FRAMES: 2, FLAGS: 3 });
const SLOT_I64 = Object.freeze({ GENERATION: 2, START_FRAME: 3 });

export interface Msb1RingLayout {
  readonly sourceId: string;
  readonly channels: number;
  readonly frameCapacity: number;
  readonly capacity: number;
}

export interface Msb1RingCounters {
  readonly wrote: number;
  readonly overflow: number;
  readonly submitted: number;
  readonly stale: number;
  readonly refused: number;
  readonly lastResult: number;
  readonly seeksApplied: number;
  readonly torn: number;
  readonly errors: number;
  readonly occupancy: number;
  readonly generationTag: number;
  readonly submittedGenerationTag: number;
}

export function msb1RingBytes(channels: number, frameCapacity: number, capacity: number): number {
  return MSB1_HEADER_OFFSET + capacity * MSB1_SLOT_HEADER_BYTES + capacity * channels * frameCapacity * 4;
}

export function createMsb1Ring(layout: Msb1RingLayout): SharedArrayBuffer {
  if (!powerOfTwo(layout.capacity)) throw new RangeError("MSB1 capacity must be a power of two");
  if (!positive(layout.channels) || !positive(layout.frameCapacity)) throw new RangeError("MSB1 shape must be positive");
  const id = new TextEncoder().encode(layout.sourceId);
  if (id.byteLength === 0 || id.byteLength > MSB1_ID_CAPACITY) throw new RangeError("sourceId does not fit MSB1");
  const pcmOffset = MSB1_HEADER_OFFSET + layout.capacity * MSB1_SLOT_HEADER_BYTES;
  const shared = new SharedArrayBuffer(msb1RingBytes(layout.channels, layout.frameCapacity, layout.capacity));
  const control = new Int32Array(shared, 0, MSB1_CONTROL_BYTES / 4);
  control[MSB1_CONTROL.VERSION] = MSB1_VERSION;
  control[MSB1_CONTROL.CAPACITY] = layout.capacity;
  control[MSB1_CONTROL.CHANNELS] = layout.channels;
  control[MSB1_CONTROL.FRAME_CAPACITY] = layout.frameCapacity;
  control[MSB1_CONTROL.HEADER_OFFSET] = MSB1_HEADER_OFFSET;
  control[MSB1_CONTROL.PCM_OFFSET] = pcmOffset;
  control[MSB1_CONTROL.ID_LENGTH] = id.byteLength;
  control[MSB1_CONTROL.GENERATION_TAG] = 1;
  new Uint8Array(shared, MSB1_ID_OFFSET, id.byteLength).set(id);
  Atomics.store(control, MSB1_CONTROL.MAGIC, MSB1_MAGIC);
  return shared;
}

export class Msb1RingWriter {
  readonly capacity: number;
  readonly channels: number;
  readonly frameCapacity: number;
  readonly #control: Int32Array;
  readonly #controlI64: BigInt64Array;
  readonly #headers: Int32Array;
  readonly #headersI64: BigInt64Array;
  readonly #planes: readonly (readonly Float32Array[])[];
  #reserved = -1;

  constructor(shared: SharedArrayBuffer) {
    const views = bind(shared);
    this.capacity = views.capacity; this.channels = views.channels; this.frameCapacity = views.frameCapacity;
    this.#control = views.control; this.#controlI64 = views.controlI64;
    this.#headers = views.headers; this.#headersI64 = views.headersI64; this.#planes = views.planes;
  }
  get occupancy(): number { return occupancy(this.#control); }
  engage(generation: bigint): void {
    Atomics.store(this.#control, MSB1_CONTROL.GENERATION_TAG, Number(BigInt.asIntN(32, generation)));
    Atomics.store(this.#control, MSB1_CONTROL.WRITER_STATE, 1);
  }
  reserve(frames: number): readonly Float32Array[] | null {
    if (!positive(frames) || frames > this.frameCapacity) throw new RangeError("PCM chunk does not fit MSB1");
    if (this.occupancy >= this.capacity) { Atomics.add(this.#control, MSB1_CONTROL.OVERFLOW, 1); return null; }
    const index = Atomics.load(this.#control, MSB1_CONTROL.WRITE_INDEX);
    this.#reserved = index;
    const planes = this.#planes[index & (this.capacity - 1)]!;
    for (const plane of planes) plane.fill(0);
    return planes;
  }
  commit(chunk: { readonly generation: bigint; readonly startFrame: bigint; readonly frames: number; readonly endOfRegion: boolean }): void {
    if (this.#reserved < 0) throw new Error("MSB1 commit without reservation");
    const index = this.#reserved; this.#reserved = -1;
    const slot = index & (this.capacity - 1);
    const word = slot * (MSB1_SLOT_HEADER_BYTES / 4);
    const word64 = slot * (MSB1_SLOT_HEADER_BYTES / 8);
    this.#headers[word + SLOT.SEQUENCE] = index;
    this.#headers[word + SLOT.GENERATION_TAG] = Number(BigInt.asIntN(32, chunk.generation));
    this.#headers[word + SLOT.FRAMES] = chunk.frames;
    this.#headers[word + SLOT.FLAGS] = chunk.endOfRegion ? MSB1_FLAG_END_OF_REGION : 0;
    this.#headersI64[word64 + SLOT_I64.GENERATION] = chunk.generation;
    this.#headersI64[word64 + SLOT_I64.START_FRAME] = chunk.startFrame;
    Atomics.add(this.#control, MSB1_CONTROL.WROTE, 1);
    Atomics.store(this.#control, MSB1_CONTROL.WRITE_INDEX, (index + 1) & (MSB1_WRAP - 1));
  }
  seek(generation: bigint, frame: bigint): void {
    this.#controlI64[0] = generation; this.#controlI64[1] = frame;
    Atomics.store(this.#control, MSB1_CONTROL.GENERATION_TAG, Number(BigInt.asIntN(32, generation)));
    Atomics.add(this.#control, MSB1_CONTROL.SEEK_EPOCH, 1);
  }
  release(): void { Atomics.store(this.#control, MSB1_CONTROL.WRITER_STATE, 0); }
}

export interface EngineSourceSink {
  seekSource(request: { readonly sourceId: string; readonly generation: bigint; readonly sourceFrame: bigint }):
    { readonly result: number } | Promise<{ readonly result: number }>;
  submitSource(request: {
    readonly sourceId: string; readonly generation: bigint; readonly startFrame: bigint;
    readonly planes: readonly Float32Array[]; readonly frames: number; readonly endOfRegion: boolean;
  }): { readonly result: number } | Promise<{ readonly result: number }>;
}

/** Test/composition reader mirroring the allocation-free worklet drain. */
export class Msb1RingReader {
  readonly sourceId: string;
  readonly #views: ReturnType<typeof bind>;
  #seenEpoch: number;
  constructor(readonly shared: SharedArrayBuffer) {
    this.#views = bind(shared);
    this.#seenEpoch = Atomics.load(this.#views.control, MSB1_CONTROL.SEEK_EPOCH);
    const length = this.#views.control[MSB1_CONTROL.ID_LENGTH]!;
    this.sourceId = new TextDecoder().decode(new Uint8Array(shared, MSB1_ID_OFFSET, length));
    Atomics.store(this.#views.control, MSB1_CONTROL.ATTACHED, 1);
  }
  get counters(): Msb1RingCounters {
    const c = this.#views.control;
    return {
      wrote: Atomics.load(c, MSB1_CONTROL.WROTE), overflow: Atomics.load(c, MSB1_CONTROL.OVERFLOW),
      submitted: Atomics.load(c, MSB1_CONTROL.SUBMITTED), stale: Atomics.load(c, MSB1_CONTROL.STALE),
      refused: Atomics.load(c, MSB1_CONTROL.REFUSED), lastResult: Atomics.load(c, MSB1_CONTROL.LAST_RESULT),
      seeksApplied: Atomics.load(c, MSB1_CONTROL.SEEKS_APPLIED), torn: Atomics.load(c, MSB1_CONTROL.TORN),
      errors: Atomics.load(c, MSB1_CONTROL.ERRORS), occupancy: occupancy(c),
      generationTag: Atomics.load(c, MSB1_CONTROL.GENERATION_TAG),
      submittedGenerationTag: Atomics.load(c, MSB1_CONTROL.SUBMITTED_GENERATION_TAG),
    };
  }
  async drain(sink: EngineSourceSink): Promise<void> {
    const { control, controlI64, headers, headersI64, planes, capacity, frameCapacity } = this.#views;
    const epoch = Atomics.load(control, MSB1_CONTROL.SEEK_EPOCH);
    if (epoch !== this.#seenEpoch) {
      const result = await sink.seekSource({ sourceId: this.sourceId, generation: controlI64[0]!, sourceFrame: controlI64[1]! });
      if (result.result === 6) return;
      this.#seenEpoch = epoch;
      Atomics.add(control, MSB1_CONTROL.SEEKS_APPLIED, 1);
      if (result.result !== 0) { Atomics.add(control, MSB1_CONTROL.REFUSED, 1); Atomics.store(control, MSB1_CONTROL.LAST_RESULT, result.result); return; }
    }
    const generationTag = Atomics.load(control, MSB1_CONTROL.GENERATION_TAG);
    const write = Atomics.load(control, MSB1_CONTROL.WRITE_INDEX);
    let read = Atomics.load(control, MSB1_CONTROL.READ_INDEX);
    while (read !== write) {
      const slot = read & (capacity - 1);
      const word = slot * (MSB1_SLOT_HEADER_BYTES / 4);
      const word64 = slot * (MSB1_SLOT_HEADER_BYTES / 8);
      if (headers[word + SLOT.SEQUENCE] !== read) { Atomics.add(control, MSB1_CONTROL.TORN, 1); break; }
      if (headers[word + SLOT.GENERATION_TAG] !== generationTag) { read = next(read); Atomics.add(control, MSB1_CONTROL.STALE, 1); continue; }
      const frames = headers[word + SLOT.FRAMES]!;
      if (!positive(frames) || frames > frameCapacity) { read = next(read); Atomics.add(control, MSB1_CONTROL.ERRORS, 1); continue; }
      const result = await sink.submitSource({
        sourceId: this.sourceId,
        generation: headersI64[word64 + SLOT_I64.GENERATION]!,
        startFrame: headersI64[word64 + SLOT_I64.START_FRAME]!,
        planes: planes[slot]!,
        frames,
        endOfRegion: (headers[word + SLOT.FLAGS]! & MSB1_FLAG_END_OF_REGION) !== 0,
      });
      if (result.result === 6) break; // Ordinary flow control: retain the slot, do not count refusal.
      read = next(read);
      if (result.result === 0) {
        Atomics.add(control, MSB1_CONTROL.SUBMITTED, 1);
        Atomics.store(control, MSB1_CONTROL.SUBMITTED_GENERATION_TAG, generationTag);
      } else {
        Atomics.add(control, MSB1_CONTROL.REFUSED, 1);
        Atomics.store(control, MSB1_CONTROL.LAST_RESULT, result.result);
      }
    }
    Atomics.store(control, MSB1_CONTROL.READ_INDEX, read);
  }
  detach(): void { Atomics.store(this.#views.control, MSB1_CONTROL.ATTACHED, 0); }
}

function bind(shared: SharedArrayBuffer) {
  if (!(shared instanceof SharedArrayBuffer)) throw new TypeError("MSB1 requires SharedArrayBuffer");
  const control = new Int32Array(shared, 0, MSB1_CONTROL_BYTES / 4);
  if (Atomics.load(control, MSB1_CONTROL.MAGIC) !== MSB1_MAGIC || control[MSB1_CONTROL.VERSION] !== MSB1_VERSION) {
    throw new TypeError("Shared buffer is not MSB1");
  }
  const capacity = control[MSB1_CONTROL.CAPACITY]!;
  const channels = control[MSB1_CONTROL.CHANNELS]!;
  const frameCapacity = control[MSB1_CONTROL.FRAME_CAPACITY]!;
  if (!powerOfTwo(capacity) || !positive(channels) || !positive(frameCapacity)) throw new TypeError("MSB1 header is invalid");
  const headerOffset = control[MSB1_CONTROL.HEADER_OFFSET]!;
  const pcmOffset = control[MSB1_CONTROL.PCM_OFFSET]!;
  const headers = new Int32Array(shared, headerOffset, capacity * MSB1_SLOT_HEADER_BYTES / 4);
  const planes = Array.from({ length: capacity }, (_, slot) => Array.from({ length: channels }, (_, channel) =>
    new Float32Array(shared, pcmOffset + (slot * channels + channel) * frameCapacity * 4, frameCapacity)));
  return { control, controlI64: new BigInt64Array(shared, MSB1_CONTROL_I64_OFFSET, 2), headers,
    headersI64: new BigInt64Array(shared, headerOffset, capacity * MSB1_SLOT_HEADER_BYTES / 8),
    planes, capacity, channels, frameCapacity };
}
function occupancy(control: Int32Array): number { return (Atomics.load(control, MSB1_CONTROL.WRITE_INDEX) - Atomics.load(control, MSB1_CONTROL.READ_INDEX)) & (MSB1_WRAP - 1); }
function next(index: number): number { return (index + 1) & (MSB1_WRAP - 1); }
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function powerOfTwo(value: number): boolean { return positive(value) && (value & (value - 1)) === 0; }
