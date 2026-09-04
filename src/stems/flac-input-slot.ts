export const FLAC_INPUT_SLOT_BYTES = 256 * 1024;
export const MAXIMUM_DELIVERY_CHUNK_BYTES = FLAC_INPUT_SLOT_BYTES;
export const FLAC_INPUT_CONTROL_BYTES = 4 * Int32Array.BYTES_PER_ELEMENT;

const STATE = 0;
const LENGTH = 1;
const OFFSET = 2;
const FINAL = 3;
const EMPTY = 0;
const FULL = 1;
const EOF = 2;
const ABORTED = 3;

export interface FlacInputSlotBuffers {
  readonly control: SharedArrayBuffer;
  readonly bytes: SharedArrayBuffer;
}

export function createFlacInputSlotBuffers(): FlacInputSlotBuffers {
  return {
    control: new SharedArrayBuffer(FLAC_INPUT_CONTROL_BYTES),
    bytes: new SharedArrayBuffer(FLAC_INPUT_SLOT_BYTES),
  };
}

function views(buffers: FlacInputSlotBuffers): Readonly<{ control: Int32Array; bytes: Uint8Array }> {
  if (buffers.control.byteLength !== FLAC_INPUT_CONTROL_BYTES || buffers.bytes.byteLength !== FLAC_INPUT_SLOT_BYTES) {
    throw new RangeError("FLAC input slot buffers have the wrong fixed size");
  }
  return { control: new Int32Array(buffers.control), bytes: new Uint8Array(buffers.bytes) };
}

/** Main-thread half. Publish is legal only in response to one Worker credit. */
export class FlacInputSlotProducer {
  readonly buffers: FlacInputSlotBuffers;
  readonly #control: Int32Array;
  readonly #bytes: Uint8Array;

  constructor(buffers = createFlacInputSlotBuffers()) {
    this.buffers = buffers;
    ({ control: this.#control, bytes: this.#bytes } = views(buffers));
  }

  publish(chunk: Uint8Array, final: boolean): void {
    if (chunk.byteLength < 1 || chunk.byteLength > FLAC_INPUT_SLOT_BYTES) throw new RangeError("FLAC input refill has an invalid size");
    if (Atomics.load(this.#control, STATE) !== EMPTY) throw new Error("FLAC input slot is not empty");
    this.#bytes.set(chunk);
    Atomics.store(this.#control, OFFSET, 0);
    Atomics.store(this.#control, LENGTH, chunk.byteLength);
    Atomics.store(this.#control, FINAL, final ? 1 : 0);
    Atomics.store(this.#control, STATE, FULL);
    Atomics.notify(this.#control, STATE);
  }

  abort(): void {
    Atomics.store(this.#control, STATE, ABORTED);
    Atomics.notify(this.#control, STATE);
  }
}

export type FlacInputReadResult =
  | { readonly type: "bytes"; readonly bytes: number }
  | { readonly type: "eof" }
  | { readonly type: "aborted" };

/** Decoder-Worker half, suitable for a synchronous libFLAC read import. */
export class FlacInputSlotConsumer {
  readonly #control: Int32Array;
  readonly #bytes: Uint8Array;
  readonly #requestRefill: () => void;
  #refillRequested = false;

  constructor(buffers: FlacInputSlotBuffers, requestRefill: () => void) {
    ({ control: this.#control, bytes: this.#bytes } = views(buffers));
    this.#requestRefill = requestRefill;
  }

  read(target: Uint8Array): FlacInputReadResult {
    if (target.byteLength < 1) throw new RangeError("libFLAC read target must be nonempty");
    for (;;) {
      const state = Atomics.load(this.#control, STATE);
      if (state === ABORTED) return { type: "aborted" };
      if (state === EOF) return { type: "eof" };
      if (state === EMPTY) {
        if (!this.#refillRequested) {
          this.#refillRequested = true;
          this.#requestRefill();
        }
        Atomics.wait(this.#control, STATE, EMPTY);
        continue;
      }
      if (state !== FULL) throw new Error("FLAC input slot has an invalid state");
      this.#refillRequested = false;
      const length = Atomics.load(this.#control, LENGTH);
      const offset = Atomics.load(this.#control, OFFSET);
      if (length < 1 || length > FLAC_INPUT_SLOT_BYTES || offset < 0 || offset >= length) {
        throw new Error("FLAC input slot bounds are corrupt");
      }
      const copied = Math.min(target.byteLength, length - offset);
      target.set(this.#bytes.subarray(offset, offset + copied));
      const next = offset + copied;
      if (next === length) {
        const final = Atomics.load(this.#control, FINAL) === 1;
        Atomics.store(this.#control, OFFSET, 0);
        Atomics.store(this.#control, LENGTH, 0);
        Atomics.store(this.#control, FINAL, 0);
        Atomics.store(this.#control, STATE, final ? EOF : EMPTY);
        return { type: "bytes", bytes: copied };
      }
      Atomics.store(this.#control, OFFSET, next);
      return { type: "bytes", bytes: copied };
    }
  }

}
