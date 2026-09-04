import type { StemProgress, StemRequirement, StemResolver, StemSessionLease, StemStore } from "./types.js";

/** Serialized verified-store gate. It never reports ready before openSession resolves. */
export class StemSessionGate {
  readonly #store: StemStore;
  readonly #resolver: StemResolver;
  #opening: AbortController | undefined;
  #lease: StemSessionLease | undefined;
  #state: "idle" | "loading" | "ready" | "refused" = "idle";

  constructor(store: StemStore, resolver: StemResolver) { this.#store = store; this.#resolver = resolver; }
  get state(): "idle" | "loading" | "ready" | "refused" { return this.#state; }

  async open(options: {
    readonly leaseId: string;
    readonly stems: readonly StemRequirement[];
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: StemProgress) => void;
  }): Promise<StemSessionLease> {
    this.#opening?.abort(new DOMException("Superseded by another stem gate open", "AbortError"));
    const opening = new AbortController();
    this.#opening = opening;
    const detach = forwardAbort(options.signal, opening);
    this.#state = "loading";
    options.onProgress?.({ stage: "loading", sourcesTotal: options.stems.length });
    let lease: StemSessionLease | undefined;
    try {
      lease = await this.#store.openSession({
        leaseId: options.leaseId, stems: options.stems, resolver: this.#resolver,
        signal: opening.signal,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      });
      if (this.#opening !== opening) {
        await lease.close();
        throw new DOMException("Superseded by another stem gate open", "AbortError");
      }
      await this.#lease?.close();
      this.#lease = lease;
      this.#state = "ready";
      return lease;
    } catch (error) {
      await lease?.close().catch(() => undefined);
      if (this.#opening === opening) this.#state = "refused";
      throw error;
    } finally {
      detach();
      if (this.#opening === opening) this.#opening = undefined;
    }
  }

  async close(): Promise<void> {
    this.#opening?.abort(new DOMException("Stem gate closed", "AbortError"));
    this.#opening = undefined;
    await this.#lease?.close();
    this.#lease = undefined;
    this.#state = "idle";
  }
}

function forwardAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (parent === undefined) return () => undefined;
  const abort = () => child.abort(parent.reason);
  if (parent.aborted) abort(); else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}
