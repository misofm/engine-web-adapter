import { Context, Effect, Layer } from "effect";
import {
  FlacDecodeError,
  FlacDecoder,
  makeFlacDecoderLayer,
} from "@misofm/codec";

import { EngineWebAdapterError } from "../errors.js";

/** The codec-owned decoder's fixed linear memory bound. */
export const FLAC_DECODER_MEMORY_BYTES = 2 * 1024 * 1024;
/** The codec-owned maximum packed PCM block. */
export const MAXIMUM_CANONICAL_OUTPUT_BYTES = 384 * 1024;

export interface FlacDecoderModuleOptions {
  readonly url: string;
  readonly signal?: AbortSignal;
}

function decoderAssetError(message: string, details: Readonly<Record<string, unknown>> = {}, cause?: unknown): EngineWebAdapterError {
  return new EngineWebAdapterError("stem.decode.asset", message, { retryable: false, ...details }, cause);
}

function cancelled(signal: AbortSignal, message: string): EngineWebAdapterError {
  return new EngineWebAdapterError("stem.cancelled", message, {}, signal.reason);
}

async function readDecoderAsset(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new Error("FLAC decoder asset has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > 256 * 1024) throw new Error("FLAC decoder asset exceeds the codec asset bound");
      chunks.push(chunk);
    }
    completed = true;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Fetch and validate the public codec asset, returning its immutable compiled
 * module. `makeFlacDecoderLayer` owns the hash and public ABI checks; this
 * adapter only owns URL, MIME and cancellation policy.
 */
export async function loadFlacDecoderModule(options: FlacDecoderModuleOptions): Promise<WebAssembly.Module> {
  let response: Response;
  try {
    response = await fetch(options.url, options.signal === undefined ? undefined : { signal: options.signal });
  } catch (cause) {
    if (options.signal?.aborted) throw cancelled(options.signal, "FLAC decoder asset loading was cancelled");
    throw decoderAssetError("FLAC decoder asset could not be loaded", { phase: "decoder-load" }, cause);
  }
  if (options.signal?.aborted) throw cancelled(options.signal, "FLAC decoder asset loading was cancelled");
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw decoderAssetError(`FLAC decoder asset returned HTTP ${response.status}`, {
      phase: "decoder-load", status: response.status,
    });
  }
  const mime = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (mime !== "application/wasm") {
    await response.body?.cancel().catch(() => undefined);
    throw decoderAssetError("FLAC decoder asset has the wrong MIME type", { phase: "decoder-load", mime });
  }
  let bytes: Uint8Array;
  try {
    bytes = await readDecoderAsset(response);
  } catch (cause) {
    if (options.signal?.aborted) throw cancelled(options.signal, "FLAC decoder asset loading was cancelled");
    throw decoderAssetError("FLAC decoder asset could not be read", { phase: "decoder-load" }, cause);
  }
  if (options.signal?.aborted) throw cancelled(options.signal, "FLAC decoder asset loading was cancelled");
  try {
    const context = await Effect.runPromise(Effect.scoped(Layer.build(makeFlacDecoderLayer(bytes))));
    if (options.signal?.aborted) throw cancelled(options.signal, "FLAC decoder asset compilation was cancelled");
    return Context.get(context, FlacDecoder).module;
  } catch (cause) {
    if (cause instanceof EngineWebAdapterError) throw cause;
    if (cause instanceof FlacDecodeError) {
      throw decoderAssetError("FLAC decoder asset failed public codec validation", {
        phase: "decoder-load", reason: cause.reason, detail: cause.detail,
      }, cause);
    }
    throw decoderAssetError("FLAC decoder asset could not be compiled", { phase: "decoder-load" }, cause);
  }
}

/** Map the public codec's typed failures at the adapter's worker boundary. */
export function mapFlacDecodeError(error: unknown): EngineWebAdapterError {
  if (error instanceof EngineWebAdapterError) return error;
  if (error instanceof FlacDecodeError) {
    const asset = error.reason === "wasm-compile" || error.reason === "wasm-abi" ||
      error.reason === "wasm-instantiate" || error.reason === "wasm-trap" ||
      error.reason === "allocation-failed";
    return new EngineWebAdapterError(
      asset ? "stem.decode.asset" : "stem.decode.flac",
      error.detail,
      { phase: error.phase, reason: error.reason, ...(error.nativeState === undefined ? {} : { nativeState: error.nativeState }), ...(error.callbackError === undefined ? {} : { callbackError: error.callbackError }) },
      error,
    );
  }
  return new EngineWebAdapterError("stem.decode.worker", "FLAC codec operation failed", {}, error);
}

/** Layer helper for workers that already received a compiled module. */
export function flacDecoderLayer(module: WebAssembly.Module): Layer.Layer<FlacDecoder> {
  return Layer.succeed(FlacDecoder, { module });
}
