import { EngineWebAdapterError } from "../errors.js";
import { assertStemIdentity } from "./identity.js";
import type { ResolvedStem, StemIdentity, StemResolver } from "./types.js";

/** Small transport-free resolver useful for tests and already-decoded PCM. */
export class MemoryStemResolver implements StemResolver {
  readonly requests: StemIdentity[] = [];
  readonly #stems: ReadonlyMap<string, Uint8Array>;
  readonly #chunkBytes: number;

  constructor(
    stems: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>,
    options: { readonly chunkBytes?: number } = {},
  ) {
    const entries = stems instanceof Map ? stems.entries() : Object.entries(stems);
    this.#stems = new Map(
      Array.from(entries, ([identity, bytes]) => [identity, bytes.slice()]),
    );
    this.#chunkBytes = options.chunkBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(this.#chunkBytes) || this.#chunkBytes <= 0) {
      throw new RangeError("chunkBytes must be a positive safe integer");
    }
  }

  async resolve(
    identity: StemIdentity,
    options: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: import("./types.js").StemProgress) => void;
    } = {},
  ): Promise<ResolvedStem & { readonly canonicalBytes: number }> {
    assertStemIdentity(identity);
    options.signal?.throwIfAborted();
    this.requests.push(identity);
    const bytes = this.#stems.get(identity);
    if (bytes === undefined) {
      throw new EngineWebAdapterError(
        "stem.not_found",
        `No canonical PCM is available for ${identity}`,
        { identity },
      );
    }

    let offset = 0;
    const chunkBytes = this.#chunkBytes;
    return {
      canonicalBytes: bytes.byteLength,
      stream: new ReadableStream<Uint8Array>({
        pull(controller) {
          options.signal?.throwIfAborted();
          if (offset === bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(offset + chunkBytes, bytes.byteLength);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
          options.onProgress?.({
            stage: "resolving",
            identity,
            bytes: offset,
            totalBytes: bytes.byteLength,
          });
        },
      }),
    };
  }
}
