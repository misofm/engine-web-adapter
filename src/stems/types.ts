import type { SourceSpec } from "@misofm/engine";
import type { BoundedStemAdmission } from "./flac-admission.js";

export type StemIdentity = `sha256:${string}`;

export interface DeclaredStemSource {
  readonly id: string;
  readonly spec: SourceSpec;
}

interface StemProgressContext {
  readonly sourceId?: string;
  readonly identity?: StemIdentity;
}

export type StemProgress = StemProgressContext & (
  | { readonly stage: "loading"; readonly sourcesTotal: number }
  | {
      readonly stage: "queued";
      readonly workersActive: number;
      readonly workersQueued: number;
      readonly workerLimit: number;
    }
  | {
      readonly stage: "probing" | "fetching" | "decoding" | "ingesting" | "verifying";
      readonly bytes: number;
      readonly totalBytes: number;
      readonly byteKind: "flac" | "pcm";
      readonly attempt?: number;
    }
  | { readonly stage: "ready"; readonly sourcesReady: number; readonly sourcesTotal: number }
  | { readonly stage: "prefilling"; readonly sourcesTotal: number }
);

export type StemProgressStage = StemProgress["stage"];

/** A fresh canonical, headerless, interleaved PCM byte stream. */
export interface ResolvedStem {
  readonly stream: ReadableStream<Uint8Array>;
  /** Optional early size hint. Verification never trusts this value. */
  readonly canonicalBytes?: number;
}

/** Advanced caller-owned boundary for already-decoded canonical PCM. */
export interface StemResolver {
  resolve(
    identity: StemIdentity,
    options?: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: StemProgress) => void;
      readonly expected?: CanonicalPcmExpectation;
    },
  ): Promise<ResolvedStem>;
}

export interface CanonicalPcmExpectation {
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  readonly frames: number;
  readonly canonicalBytes: number;
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
    readonly admission?: BoundedStemAdmission;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: StemProgress) => void;
  }): Promise<StemSessionLease>;
}
