import { createBLAKE3, type IHasher } from "hash-wasm";

import { deadline } from "./sha256.js";

/** One operation-owned incremental BLAKE3-256 state. Never share concurrently. */
export type IncrementalBlake3 = Pick<IHasher, "update" | "digest">;

/**
 * Create a fresh, initialized BLAKE3-256 state.
 *
 * hash-wasm caches compilation internally, but each call owns a distinct Wasm
 * instance and mutable state. Callers must await this before consuming input.
 */
export async function createIncrementalBlake3(): Promise<IncrementalBlake3> {
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
