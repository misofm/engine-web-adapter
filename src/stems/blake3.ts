import { createBLAKE3, type IHasher } from "hash-wasm";

import { BLAKE3_WASM_BYTES } from "./blake3-wasm.js";
import { deadline } from "./sha256.js";

type Blake3Input = Parameters<IHasher["update"]>[0];
/** One operation-owned incremental BLAKE3-256 state. Never share concurrently. */
export type IncrementalBlake3 = {
  init: () => IncrementalBlake3;
  update: (input: Blake3Input) => IncrementalBlake3;
  digest: IHasher["digest"];
};

type BackendMode = "auto" | "scalar" | "wasm";

type WasmBlake3Exports = {
  readonly memory: WebAssembly.Memory;
  readonly blake3_finalize: () => number;
  readonly blake3_init: () => void;
  readonly blake3_input_capacity: () => number;
  readonly blake3_input_ptr: () => number;
  readonly blake3_output_len: () => number;
  readonly blake3_output_ptr: () => number;
  readonly blake3_update: (length: number) => number;
};

const INPUT_BYTES = 16 * 1024;
const OUTPUT_BYTES = 32;
const MEMORY_BYTES = 128 * 1024;
const HEX = "0123456789abcdef";

let backendMode: BackendMode = "auto";
let wasmSupport: boolean | undefined;
let wasmModulePromise: Promise<WebAssembly.Module> | undefined;

function asBytes(input: Blake3Input): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("BLAKE3 input must be a string or typed array");
}

function moduleSupportsSimd(): boolean {
  if (backendMode === "scalar") return false;
  if (typeof WebAssembly === "undefined") {
    if (backendMode === "wasm") throw new Error("WebAssembly is not supported");
    return false;
  }
  if (wasmSupport !== undefined) return wasmSupport;
  try {
    wasmSupport = WebAssembly.validate(BLAKE3_WASM_BYTES);
  } catch (error) {
    // Validation exceptions indicate a broken host/module boundary. They are
    // deliberately not treated as ordinary SIMD incompatibility.
    throw error;
  }
  if (backendMode === "wasm" && !wasmSupport) {
    throw new Error("BLAKE3 SIMD Wasm is not supported by this host");
  }
  return wasmSupport;
}

async function loadWasmModule(): Promise<WebAssembly.Module | undefined> {
  if (!moduleSupportsSimd()) return undefined;
  if (wasmModulePromise === undefined) {
    const pending = Promise.resolve()
      .then(() => WebAssembly.compile(BLAKE3_WASM_BYTES))
      .catch((error: unknown) => {
        if (wasmModulePromise === pending) wasmModulePromise = undefined;
        throw error;
      });
    wasmModulePromise = pending;
  }
  return wasmModulePromise;
}

function assertFixedMemory(memory: WebAssembly.Memory): void {
  if (memory.buffer.byteLength !== MEMORY_BYTES) {
    throw new Error("BLAKE3 Wasm memory is not the fixed 128 KiB reservation");
  }
}

function getWasmExports(instance: WebAssembly.Instance): WasmBlake3Exports {
  const exports = instance.exports as unknown as Partial<WasmBlake3Exports>;
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    typeof exports.blake3_finalize !== "function" ||
    typeof exports.blake3_init !== "function" ||
    typeof exports.blake3_input_capacity !== "function" ||
    typeof exports.blake3_input_ptr !== "function" ||
    typeof exports.blake3_output_len !== "function" ||
    typeof exports.blake3_output_ptr !== "function" ||
    typeof exports.blake3_update !== "function"
  ) {
    throw new Error("BLAKE3 Wasm exports are incomplete");
  }
  assertFixedMemory(exports.memory);
  const inputPtr = exports.blake3_input_ptr();
  const outputPtr = exports.blake3_output_ptr();
  if (
    exports.blake3_input_capacity() !== INPUT_BYTES ||
    exports.blake3_output_len() !== OUTPUT_BYTES ||
    !Number.isInteger(inputPtr) ||
    !Number.isInteger(outputPtr) ||
    inputPtr < 0 ||
    outputPtr < 0 ||
    inputPtr % 16 !== 0 ||
    outputPtr % 16 !== 0 ||
    inputPtr + INPUT_BYTES > MEMORY_BYTES ||
    outputPtr + OUTPUT_BYTES > MEMORY_BYTES ||
    (inputPtr + INPUT_BYTES > outputPtr && outputPtr + OUTPUT_BYTES > inputPtr)
  ) {
    throw new Error("BLAKE3 Wasm buffer layout is outside the fixed ABI");
  }
  return exports as WasmBlake3Exports;
}

class WasmIncrementalBlake3 {
  readonly #exports: WasmBlake3Exports;
  readonly #input: Uint8Array;
  readonly #output: Uint8Array;
  #initialized = false;
  #finished = false;

  constructor(module: WebAssembly.Module) {
    this.#exports = getWasmExports(new WebAssembly.Instance(module));
    this.#input = new Uint8Array(
      this.#exports.memory.buffer,
      this.#exports.blake3_input_ptr(),
      INPUT_BYTES,
    );
    this.#output = new Uint8Array(
      this.#exports.memory.buffer,
      this.#exports.blake3_output_ptr(),
      OUTPUT_BYTES,
    );
    this.init();
  }

  init(): this {
    this.#exports.blake3_init();
    this.#initialized = true;
    this.#finished = false;
    return this;
  }

  update(input: Blake3Input): this {
    if (!this.#initialized || this.#finished) {
      throw new Error("BLAKE3 update called before init or after digest");
    }
    const bytes = asBytes(input);
    if (bytes.byteLength === 0) {
      this.assertUpdate(this.#exports.blake3_update(0));
      return this;
    }
    for (let offset = 0; offset < bytes.byteLength; ) {
      const length = Math.min(INPUT_BYTES, bytes.byteLength - offset);
      this.#input.set(bytes.subarray(offset, offset + length));
      this.assertUpdate(this.#exports.blake3_update(length));
      offset += length;
    }
    return this;
  }

  digest(outputType?: "hex"): string;
  digest(outputType: "binary"): Uint8Array;
  digest(outputType: "hex" | "binary" = "hex"): string | Uint8Array {
    if (!this.#initialized || this.#finished) {
      throw new Error("BLAKE3 digest called before init or after digest");
    }
    this.#finished = true;
    this.assertFinalize(this.#exports.blake3_finalize());
    const output = this.#output.slice();
    if (outputType === "binary") return output;
    let hex = "";
    for (const byte of output) {
      hex += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
    }
    return hex;
  }

  private assertUpdate(status: number): void {
    if (status !== 0) throw new Error(`BLAKE3 Wasm update failed (${status})`);
  }

  private assertFinalize(status: number): void {
    if (status !== 0) throw new Error(`BLAKE3 Wasm finalize failed (${status})`);
  }
}

/** Internal test control; backend selection is not part of the package API. */
export function setBlake3BackendForTests(mode: BackendMode): () => void {
  const previousMode = backendMode;
  const previousSupport = wasmSupport;
  const previousPromise = wasmModulePromise;
  backendMode = mode;
  wasmSupport = undefined;
  wasmModulePromise = undefined;
  return () => {
    backendMode = previousMode;
    wasmSupport = previousSupport;
    wasmModulePromise = previousPromise;
  };
}

/**
 * Create a fresh, initialized BLAKE3-256 state. SIMD compatibility is decided
 * before input is consumed; unsupported hosts use the pinned scalar hash-wasm
 * implementation. Every successful factory call owns a distinct Wasm state.
 */
export async function createIncrementalBlake3(): Promise<IncrementalBlake3> {
  const module = await loadWasmModule();
  if (module !== undefined) return new WasmIncrementalBlake3(module);
  const hash = await createBLAKE3(256);
  if (hash.digestSize !== 32) throw new Error("BLAKE3 digest size is not 256 bits");
  return hash;
}

export async function blake3Stream(
  stream: ReadableStream<Uint8Array>,
  options: {
    readonly signal?: AbortSignal;
    readonly readDeadlineMs?: number;
    readonly onChunk?: (bytes: number) => void;
  } = {},
): Promise<{ readonly bytes: number; readonly hex: string }> {
  const hash = await createIncrementalBlake3();
  options.signal?.throwIfAborted();
  const reader = stream.getReader();
  let bytes = 0;
  try {
    while (true) {
      options.signal?.throwIfAborted();
      const result = await deadline(reader.read(), options.readDeadlineMs ?? 30_000, options.signal);
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw new TypeError("PCM stream chunks must be Uint8Array");
      hash.update(result.value);
      bytes += result.value.byteLength;
      if (!Number.isSafeInteger(bytes)) throw new RangeError("PCM byte count exceeds safe range");
      options.onChunk?.(bytes);
    }
  } finally {
    if (options.signal?.aborted) void reader.cancel(options.signal.reason).catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A timed-out read may remain pending. */ }
  }
  return { bytes, hex: hash.digest("hex") };
}
