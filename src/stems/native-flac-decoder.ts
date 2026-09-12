import { EngineWebAdapterError } from "../errors.js";
import { FlacInputSlotConsumer, type FlacInputSlotBuffers } from "./flac-input-slot.js";
import type { NativeFlacStreamInfo } from "./native-flac-metadata.js";

export const FLAC_DECODER_MEMORY_BYTES = 32 * 64 * 1024;
export const MAXIMUM_CANONICAL_OUTPUT_BYTES = 384 * 1024;

interface DecoderExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly miso_flac_decoder_abi_version: () => number;
  readonly miso_flac_decoder_description_ptr: () => number;
  readonly miso_flac_decoder_description_capacity: () => number;
  readonly miso_flac_decoder_output_ptr: () => number;
  readonly miso_flac_decoder_output_length: () => number;
  readonly miso_flac_decoder_output_frames: () => number;
  readonly miso_flac_decoder_callback_error: () => number;
  readonly miso_flac_decoder_state: () => number;
  readonly miso_flac_decoder_initialize: (...arguments_: number[]) => number;
  readonly miso_flac_decoder_process_single: () => number;
  readonly miso_flac_decoder_release_output: () => void;
  readonly miso_flac_decoder_finish: () => number;
  readonly miso_flac_decoder_destroy: () => void;
  readonly miso_flac_allocator_live_bytes: () => number;
  readonly miso_flac_allocator_peak_live_bytes: () => number;
  readonly miso_flac_allocator_peak_heap_bytes: () => number;
  readonly miso_flac_allocator_free_calls: () => number;
  readonly miso_flac_allocator_realloc_calls: () => number;
}

const REQUIRED_DECODER_EXPORTS = [
  "miso_flac_decoder_abi_version", "miso_flac_decoder_description_ptr", "miso_flac_decoder_description_capacity",
  "miso_flac_decoder_output_ptr", "miso_flac_decoder_output_length", "miso_flac_decoder_output_frames",
  "miso_flac_decoder_callback_error", "miso_flac_decoder_state", "miso_flac_decoder_initialize",
  "miso_flac_decoder_process_single", "miso_flac_decoder_release_output", "miso_flac_decoder_finish",
  "miso_flac_decoder_destroy", "miso_flac_allocator_live_bytes", "miso_flac_allocator_peak_live_bytes",
  "miso_flac_allocator_peak_heap_bytes", "miso_flac_allocator_free_calls", "miso_flac_allocator_realloc_calls",
] as const;

function decoderError(code: "stem.decode.asset" | "stem.decode.flac" | "stem.decode.output", message: string, details: Readonly<Record<string, unknown>> = {}, cause?: unknown): EngineWebAdapterError {
  return new EngineWebAdapterError(code, message, { retryable: false, ...details }, cause);
}

export interface NativeFlacDecoderModuleOptions {
  readonly url: string;
  readonly signal?: AbortSignal;
}

/** Compile and validate one immutable decoder module for a fixed asset URL. */
export async function loadNativeFlacDecoderModule(options: NativeFlacDecoderModuleOptions): Promise<WebAssembly.Module> {
  const module = await compileNativeFlacDecoderModule(options);
  await validateNativeFlacDecoderModule(module);
  return module;
}

/** Compile without probing an instance; the decoder load path validates its own instance. */
async function compileNativeFlacDecoderModule(options: NativeFlacDecoderModuleOptions): Promise<WebAssembly.Module> {
  let response: Response;
  try {
    response = await fetch(options.url, options.signal === undefined ? undefined : { signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new EngineWebAdapterError("stem.cancelled", "FLAC decoder asset loading was cancelled", {}, error);
    }
    throw decoderError("stem.decode.asset", "FLAC decoder asset could not be loaded", { phase: "decoder-load" }, error);
  }
  if (options.signal?.aborted) {
    throw new EngineWebAdapterError("stem.cancelled", "FLAC decoder asset loading was cancelled", {}, options.signal.reason);
  }
  if (!response.ok) throw decoderError("stem.decode.asset", `FLAC decoder asset returned HTTP ${response.status}`, { phase: "decoder-load", status: response.status });
  const mime = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (mime !== "application/wasm") throw decoderError("stem.decode.asset", "FLAC decoder asset has the wrong MIME type", { phase: "decoder-load", mime });
  let module: WebAssembly.Module;
  try { module = await WebAssembly.compileStreaming(Promise.resolve(response)); }
  catch (error) {
    if (options.signal?.aborted) {
      throw new EngineWebAdapterError("stem.cancelled", "FLAC decoder asset compilation was cancelled", {}, error);
    }
    throw decoderError("stem.decode.asset", "FLAC decoder asset could not be compiled", { phase: "decoder-load" }, error);
  }
  if (options.signal?.aborted) {
    throw new EngineWebAdapterError("stem.cancelled", "FLAC decoder asset compilation was cancelled", {}, options.signal.reason);
  }
  return module;
}

/** Validate exports and fixed non-shared memory without retaining an instance. */
async function validateNativeFlacDecoderModule(module: WebAssembly.Module): Promise<void> {
  let instance: WebAssembly.Instance;
  try {
    const instantiated = await WebAssembly.instantiate(module, { env: { miso_flac_read: () => -1 } });
    instance = ("instance" in instantiated ? instantiated.instance : instantiated) as WebAssembly.Instance;
  } catch (error) {
    if (error instanceof EngineWebAdapterError) throw error;
    throw decoderError("stem.decode.asset", "FLAC decoder asset could not be instantiated", { phase: "decoder-load" }, error);
  }
  try {
    validateDecoderExports(instance.exports as unknown as DecoderExports);
  } finally {
    try { (instance.exports as unknown as Partial<DecoderExports>).miso_flac_decoder_destroy?.(); }
    catch (error) { throw decoderError("stem.decode.asset", "FLAC decoder asset validation destroy trapped", { phase: "decoder-load" }, error); }
  }
}

function validateDecoderExports(exports: DecoderExports): void {
  let fixedNonSharedMemory = false;
  if (exports.memory instanceof WebAssembly.Memory && exports.memory.buffer instanceof ArrayBuffer &&
    exports.memory.buffer.byteLength === FLAC_DECODER_MEMORY_BYTES) {
    try { exports.memory.grow(1); }
    catch (error) { fixedNonSharedMemory = error instanceof RangeError; }
  }
  let valid = fixedNonSharedMemory && REQUIRED_DECODER_EXPORTS.every((name) => typeof exports[name] === "function");
  try { valid = valid && exports.miso_flac_decoder_abi_version() === 2; }
  catch (error) { throw decoderError("stem.decode.asset", "FLAC decoder ABI validation trapped", { phase: "decoder-load" }, error); }
  if (!valid) throw decoderError("stem.decode.asset", "FLAC decoder asset has an incompatible ABI or memory", { phase: "decoder-load" });
}

export class NativeFlacDecoder {
  readonly #exports: DecoderExports;
  #destroyed = false;

  private constructor(exports: DecoderExports) { this.#exports = exports; }

  static async load(options: {
    readonly url: string;
    readonly inputSlot: FlacInputSlotBuffers;
    readonly requestRefill: () => void;
    readonly onInputWait?: (waiting: boolean) => void;
    readonly module?: WebAssembly.Module;
    readonly signal?: AbortSignal;
  }): Promise<NativeFlacDecoder> {
    const consumer = new FlacInputSlotConsumer(options.inputSlot, options.requestRefill, options.onInputWait);
    const module = options.module ?? await compileNativeFlacDecoderModule({
      url: options.url,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (options.signal?.aborted) {
      throw new EngineWebAdapterError("stem.cancelled", "FLAC decoder instantiation was cancelled", {}, options.signal.reason);
    }
    let instance: WebAssembly.Instance | undefined;
    try {
      const instantiated = await WebAssembly.instantiate(module, {
        env: {
          miso_flac_read(pointer: number, maximumBytes: number): number {
            const memory = (instance!.exports as unknown as DecoderExports).memory.buffer;
            const result = consumer.read(new Uint8Array(memory, pointer, maximumBytes));
            return result.type === "bytes" ? result.bytes : result.type === "eof" ? 0 : -1;
          },
        },
      });
      instance = ("instance" in instantiated ? instantiated.instance : instantiated) as WebAssembly.Instance;
    } catch (error) { throw decoderError("stem.decode.asset", "FLAC decoder asset could not be instantiated", { phase: "decoder-load" }, error); }
    const exports = instance.exports as unknown as DecoderExports;
    validateDecoderExports(exports);
    return new NativeFlacDecoder(exports);
  }

  initialize(stream: NativeFlacStreamInfo, expectedFrames: number): void {
    let pointer: number;
    let capacity: number;
    try {
      pointer = this.#exports.miso_flac_decoder_description_ptr();
      capacity = this.#exports.miso_flac_decoder_description_capacity();
    } catch (error) {
      throw decoderError("stem.decode.asset", "FLAC decoder STREAMINFO ABI trapped", { phase: "metadata" }, error);
    }
    if (!Number.isInteger(pointer) || pointer < 0 || capacity !== stream.decoderDescription.byteLength ||
      pointer > FLAC_DECODER_MEMORY_BYTES - stream.decoderDescription.byteLength) {
      throw decoderError("stem.decode.asset", "FLAC decoder STREAMINFO arena is incompatible", { phase: "metadata" });
    }
    let result: number;
    try {
      new Uint8Array(this.#exports.memory.buffer, pointer, capacity).set(stream.decoderDescription);
      result = this.#exports.miso_flac_decoder_initialize(
        stream.decoderDescription.byteLength, stream.sampleRateHz, stream.channels, stream.bitDepth,
        stream.minimumBlockSamples, stream.maximumBlockSamples,
        expectedFrames >>> 0, Math.floor(expectedFrames / 0x1_0000_0000) >>> 0,
      );
    } catch (error) {
      throw decoderError("stem.decode.asset", "FLAC decoder initialization ABI trapped", { phase: "metadata" }, error);
    }
    if (result !== 0) throw this.#flacFailure("libFLAC initialization failed", "metadata", { result });
  }

  processSingle(): Readonly<{ bytes: Uint8Array; frames: number }> | null | "eof" {
    let result: number;
    try { result = this.#exports.miso_flac_decoder_process_single(); }
    catch (error) { throw decoderError("stem.decode.asset", "FLAC decoder process ABI trapped", { phase: "frame" }, error); }
    if (result < 0) throw this.#flacFailure("libFLAC rejected the compressed stream", "frame", { result });
    if (result === 2) return "eof";
    if (result === 0) return null;
    let length: number;
    let frames: number;
    let pointer: number;
    try {
      length = this.#exports.miso_flac_decoder_output_length();
      frames = this.#exports.miso_flac_decoder_output_frames();
      pointer = this.#exports.miso_flac_decoder_output_ptr();
    } catch (error) {
      throw decoderError("stem.decode.asset", "FLAC decoder output ABI trapped", { phase: "frame" }, error);
    }
    if (!Number.isInteger(pointer) || pointer < 0 || !Number.isInteger(length) || length < 0 ||
      length > FLAC_DECODER_MEMORY_BYTES || pointer > FLAC_DECODER_MEMORY_BYTES - length) {
      throw decoderError("stem.decode.asset", "FLAC decoder output arena is incompatible", { phase: "frame", pointer, length });
    }
    if (length < 1 || length > MAXIMUM_CANONICAL_OUTPUT_BYTES || !Number.isInteger(frames) || frames < 1) {
      throw decoderError("stem.decode.output", "libFLAC produced an invalid canonical output block", { phase: "frame", length, frames });
    }
    const bytes = new Uint8Array(this.#exports.memory.buffer, pointer, length).slice();
    try { this.#exports.miso_flac_decoder_release_output(); }
    catch (error) { throw decoderError("stem.decode.asset", "FLAC decoder output-release ABI trapped", { phase: "frame" }, error); }
    return { bytes, frames };
  }

  finish(): void {
    let result: number;
    try { result = this.#exports.miso_flac_decoder_finish(); }
    catch (error) { throw decoderError("stem.decode.asset", "FLAC decoder finish ABI trapped", { phase: "finish" }, error); }
    if (result !== 0) throw this.#flacFailure("libFLAC final count or MD5 verification failed", "finish", { result });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    try { this.#exports.miso_flac_decoder_destroy(); }
    catch (error) { throw decoderError("stem.decode.asset", "FLAC decoder destroy ABI trapped", { phase: "finish" }, error); }
  }

  allocatorStats(): Readonly<{
    liveBytes: number; peakLiveBytes: number; peakHeapBytes: number; freeCalls: number; reallocCalls: number;
  }> {
    try {
      return Object.freeze({
        liveBytes: this.#exports.miso_flac_allocator_live_bytes(),
        peakLiveBytes: this.#exports.miso_flac_allocator_peak_live_bytes(),
        peakHeapBytes: this.#exports.miso_flac_allocator_peak_heap_bytes(),
        freeCalls: this.#exports.miso_flac_allocator_free_calls(),
        reallocCalls: this.#exports.miso_flac_allocator_realloc_calls(),
      });
    } catch (error) {
      throw decoderError("stem.decode.asset", "FLAC decoder allocator ABI trapped", { phase: "frame" }, error);
    }
  }

  #flacFailure(message: string, phase: string, details: Readonly<Record<string, unknown>>, cause?: unknown): EngineWebAdapterError {
    let decoderState: number | undefined;
    let callbackError: number | undefined;
    try {
      decoderState = this.#exports.miso_flac_decoder_state();
      callbackError = this.#exports.miso_flac_decoder_callback_error();
    } catch (error) {
      return decoderError("stem.decode.asset", "FLAC decoder diagnostic ABI trapped", { phase }, error);
    }
    return decoderError("stem.decode.flac", message, { phase, decoderState, callbackError, ...details }, cause);
  }
}
