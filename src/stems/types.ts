import type { SourceSpec } from "@misofm/engine";

export type StemIdentity = `sha256:${string}`;

export interface DeclaredStemSource {
  readonly id: string;
  readonly spec: SourceSpec;
}

export type StemProgressStage =
  | "loading"
  | "resolving"
  | "ingesting"
  | "verifying"
  | "ready"
  | "prefilling";

export interface StemProgress {
  readonly stage: StemProgressStage;
  readonly sourceId?: string;
  readonly identity?: StemIdentity;
  readonly bytes?: number;
  readonly totalBytes?: number;
  readonly sourcesReady?: number;
  readonly sourcesTotal?: number;
}

/** A fresh canonical, headerless, interleaved PCM byte stream. */
export interface ResolvedStem {
  readonly stream: ReadableStream<Uint8Array>;
  /** Optional early size hint. Verification never trusts this value. */
  readonly canonicalBytes?: number;
}

/** Caller-owned transport and decode boundary. */
export interface StemResolver {
  resolve(
    identity: StemIdentity,
    options?: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: StemProgress) => void;
    },
  ): Promise<ResolvedStem>;
}

export interface StemRequirement {
  readonly sourceId: string;
  readonly identity: StemIdentity;
  readonly bytes: number;
}

export interface StemSessionLease {
  readonly leaseId: string;
  readonly stems: readonly StemRequirement[];
  read(identity: StemIdentity): Promise<Blob>;
  close(): Promise<void>;
}

/** Injectable verified-store contract used by session open. */
export interface StemStore {
  open(): Promise<StemStore>;
  openSession(options: {
    readonly leaseId: string;
    readonly stems: readonly StemRequirement[];
    readonly resolver: StemResolver;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: StemProgress) => void;
  }): Promise<StemSessionLease>;
}
