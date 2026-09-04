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
}

function decoderError(code: "stem.decode.asset" | "stem.decode.flac" | "stem.decode.output", message: string, details: Readonly<Record<string, unknown>> = {}, cause?: unknown): EngineWebAdapterError {
  return new EngineWebAdapterError(code, message, { retryable: false, ...details }, cause);
}

export class NativeFlacDecoder {
  readonly #exports: DecoderExports;
  #destroyed = false;

  private constructor(exports: DecoderExports) { this.#exports = exports; }

  static async load(options: {
    readonly url: string;
    readonly inputSlot: FlacInputSlotBuffers;
    readonly requestRefill: () => void;
  }): Promise<NativeFlacDecoder> {
    let response: Response;
    try { response = await fetch(options.url); }
    catch (error) { throw decoderError("stem.decode.asset", "FLAC decoder asset could not be loaded", { phase: "decoder-load" }, error); }
    if (!response.ok) throw decoderError("stem.decode.asset", `FLAC decoder asset returned HTTP ${response.status}`, { phase: "decoder-load", status: response.status });
    const mime = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (mime !== "application/wasm") throw decoderError("stem.decode.asset", "FLAC decoder asset has the wrong MIME type", { phase: "decoder-load", mime });
    const consumer = new FlacInputSlotConsumer(options.inputSlot, options.requestRefill);
    let instance: WebAssembly.Instance | undefined;
    let module: WebAssembly.Module;
    try { module = await WebAssembly.compileStreaming(Promise.resolve(response)); }
    catch (error) { throw decoderError("stem.decode.asset", "FLAC decoder asset could not be compiled", { phase: "decoder-load" }, error); }
    try {
      instance = await WebAssembly.instantiate(module, {
        env: {
          miso_flac_read(pointer: number, maximumBytes: number): number {
            const memory = (instance!.exports as unknown as DecoderExports).memory.buffer;
            const result = consumer.read(new Uint8Array(memory, pointer, maximumBytes));
            return result.type === "bytes" ? result.bytes : result.type === "eof" ? 0 : -1;
          },
        },
      });
    } catch (error) { throw decoderError("stem.decode.asset", "FLAC decoder asset could not be instantiated", { phase: "decoder-load" }, error); }
    const exports = instance.exports as unknown as DecoderExports;
    const required = [
      "miso_flac_decoder_abi_version", "miso_flac_decoder_description_ptr", "miso_flac_decoder_description_capacity",
      "miso_flac_decoder_output_ptr", "miso_flac_decoder_output_length", "miso_flac_decoder_output_frames",
      "miso_flac_decoder_callback_error", "miso_flac_decoder_state", "miso_flac_decoder_initialize",
      "miso_flac_decoder_process_single", "miso_flac_decoder_release_output", "miso_flac_decoder_finish",
      "miso_flac_decoder_destroy",
    ] as const;
    if (!(exports.memory instanceof WebAssembly.Memory) || exports.memory.buffer.byteLength !== FLAC_DECODER_MEMORY_BYTES ||
      required.some((name) => typeof exports[name] !== "function") || exports.miso_flac_decoder_abi_version() !== 1) {
      throw decoderError("stem.decode.asset", "FLAC decoder asset has an incompatible ABI or memory", { phase: "decoder-load" });
    }
    return new NativeFlacDecoder(exports);
  }

  initialize(stream: NativeFlacStreamInfo, expectedFrames: number): void {
    const pointer = this.#exports.miso_flac_decoder_description_ptr();
    if (this.#exports.miso_flac_decoder_description_capacity() !== stream.decoderDescription.byteLength) {
      throw decoderError("stem.decode.asset", "FLAC decoder STREAMINFO arena is incompatible", { phase: "metadata" });
    }
    new Uint8Array(this.#exports.memory.buffer, pointer, stream.decoderDescription.byteLength).set(stream.decoderDescription);
    const result = this.#exports.miso_flac_decoder_initialize(
      stream.decoderDescription.byteLength, stream.sampleRateHz, stream.channels, stream.bitDepth,
      expectedFrames >>> 0, Math.floor(expectedFrames / 0x1_0000_0000) >>> 0,
    );
    if (result !== 0) throw this.#flacFailure("libFLAC initialization failed", "metadata", { result });
  }

  processSingle(): Readonly<{ bytes: Uint8Array; frames: number }> | null | "eof" {
    let result: number;
    try { result = this.#exports.miso_flac_decoder_process_single(); }
    catch (error) { throw this.#flacFailure("libFLAC trapped while decoding", "frame", {}, error); }
    if (result < 0) throw this.#flacFailure("libFLAC rejected the compressed stream", "frame", { result });
    if (result === 2) return "eof";
    if (result === 0) return null;
    const length = this.#exports.miso_flac_decoder_output_length();
    const frames = this.#exports.miso_flac_decoder_output_frames();
    const pointer = this.#exports.miso_flac_decoder_output_ptr();
    if (length < 1 || length > MAXIMUM_CANONICAL_OUTPUT_BYTES || frames < 1 || pointer + length > FLAC_DECODER_MEMORY_BYTES) {
      throw decoderError("stem.decode.output", "libFLAC produced an invalid canonical output block", { phase: "frame", length, frames });
    }
    const bytes = new Uint8Array(this.#exports.memory.buffer, pointer, length).slice();
    this.#exports.miso_flac_decoder_release_output();
    return { bytes, frames };
  }

  finish(): void {
    const result = this.#exports.miso_flac_decoder_finish();
    if (result !== 0) throw this.#flacFailure("libFLAC final count or MD5 verification failed", "finish", { result });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#exports.miso_flac_decoder_destroy();
  }

  #flacFailure(message: string, phase: string, details: Readonly<Record<string, unknown>>, cause?: unknown): EngineWebAdapterError {
    return decoderError("stem.decode.flac", message, {
      phase, decoderState: this.#exports.miso_flac_decoder_state(), callbackError: this.#exports.miso_flac_decoder_callback_error(), ...details,
    }, cause);
  }
}
