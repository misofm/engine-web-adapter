import type { IngestDiagnostics } from "./stems/ingest-diagnostics.js";
import type { CommandReport, ConsoleEdits, LaneEdit, SessionShape, SourceSpec } from "@misofm/engine";
import type {
  AudioContextLike,
  BrowserBootPolicy,
  BrowserEngine,
  Msb1RingCounters,
  PcmSourceChunk,
  ObservationSubscriptionLimits,
  SpectrumCollection,
  SpectrumQuery,
  SpectrumSubscriptionLimits,
  TrackResponseSubscriptionLimits,
} from "@misofm/engine/browser";
import type {
  MasterMeter as SdkMasterMeter,
  MeterUpdate as SdkMeterUpdate,
  TrackMeter as SdkTrackMeter,
  TelemetryUpdate as SdkTelemetryUpdate,
} from "@misofm/engine/browser";

import type { AdapterAssetOverrides } from "./assets.js";
import type { EngineWebAdapterError } from "./errors.js";
import type { WebCapabilityScope } from "./capabilities.js";
import type { AudioWorkletNodeLike, EngineFeed } from "./feed.js";
import type { PcmPumpSource, SparsePcmPumpSource } from "./stems/pump.js";
import type {
  DeclaredStemSource,
  FlacDeliveryOptions,
  StemProgress,
  StemResolver,
  StemStore,
} from "./stems/index.js";
import type {
  SparsePcmExpectation,
  SparsePcmSessionLease,
  SparsePcmSessionOptions,
  VerifiedSparsePcmStore,
} from "./stems/sparse-store.js";

export type EngineSessionDocument = Uint8Array | string | { toJson(): string };
export type EngineWebSessionState = "opening" | "ready" | "playing" | "paused" | "closed";

export interface EngineAudioContext extends AudioContextLike {
  readonly destination: AudioNode;
  resume(): Promise<void>;
  suspend(): Promise<void>;
}

export interface PumpAllocation {
  /** Requested per-window frame bound; local reads round down to whole render quanta. */
  readonly windowFrames: number;
  /** Current plus next/pending canonical windows; excludes rings, JS objects and browser caches. */
  readonly maximumWindowBytes: number;
  /** Sparse active-read scratch bound; omitted by legacy dense pump implementors. */
  readonly maximumReadScratchBytes?: number;
}

/** Source PCM is borrowed until the callback returns; only frames samples are valid. */
export interface SourceObservation {
  readonly sampleRateHz: number;
  readonly channels: number;
  pull(consume: (chunk: PcmSourceChunk) => void, maximumChunks?: number): number;
  close(): void;
}

/** Buffer facts only; excludes JS objects/browser heap and is not a multiword atomic snapshot. */
export interface FeedDiagnostics {
  readonly sources: readonly (Msb1RingCounters & { readonly sourceId: string })[];
  readonly allocation: {
    readonly sources: number;
    readonly ringBytes: number;
    readonly engineMemoryBytes: number;
    readonly observationBytes: number;
    readonly pump: PumpAllocation | null;
  };
}

export interface EnginePump {
  readonly allocation?: PumpAllocation;
  /** Fulfills once after unexpected terminal failure; never rejects or fires for explicit close. */
  readonly failure?: Promise<unknown>;
  seekFrames(frame: number | bigint): Promise<bigint>;
  close(): Promise<void> | void;
}

/** One track's decimated meter reading, already folded to what a meter draws. */
export type TrackMeter = SdkTrackMeter & {
  /** The greater of the two lanes: what a single meter bar shows. */
  readonly peak: number;
};

/** The master meter with the legacy single-bar peak projection. */
export type MasterMeter = SdkMasterMeter & {
  /** The greater of the two lanes: what a single meter bar shows. */
  readonly peak: number;
};

/** One decimated meter window, addressed by track id rather than by ordinal. */
export type MeterUpdate = Omit<SdkMeterUpdate, "tracks" | "master"> & {
  /** Every track in the compiled session, keyed by its id. */
  readonly tracks: ReadonlyMap<string, TrackMeter>;
  readonly master: MasterMeter;
};

/** One windowed render-telemetry reading. */
export type TelemetryUpdate = SdkTelemetryUpdate;

/**
 * The session's live console.
 *
 * `edit` is the Engine's own catalog-derived builder, bound to this session's
 * compiled map. `submit` returns the SDK's strict whole-batch CommandReport;
 * the host owns transport request identifiers and admission scheduling.
 */
export interface EngineWebConsole {
  readonly edit: ConsoleEdits;
  /**
   * Submit one validated transaction and return its exact admission report.
   * Semantic refusals resolve with `ok: false`; transport failures reject.
   */
  submit(...edits: readonly LaneEdit[]): Promise<CommandReport>;
}

export interface EngineWebSessionCommonOptions {
  readonly ingestDiagnostics?: IngestDiagnostics;
  /** The Session V1 document, or the SDK builder session that produced it. */
  readonly document: EngineSessionDocument;
  /**
   * Stem declarations.
   *
   * Optional: the adapter derives them from the canonical session document,
   * which already declares every source's id, digest, channels, bit depth and
   * frame count. Supply them to assert the declaration a second time.
   */
  readonly sources?: readonly DeclaredStemSource[];
  /** Optional store pin name. Generated per open when absent. */
  readonly leaseId?: string;
  /**
   * Opt out of the live console.
   *
   * The adapter attaches the Engine's published default console. Pass `false`
   * for a playback-only session; `session.console`, `session.meters` and
   * `session.telemetry` then refuse with `console.not_attached` rather than
   * letting an ordinary command look like an unknown command kind. It writes no
   * console words at all, so it also overrides any `policy.console` sizes.
   */
  readonly console?: false;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: StemProgress) => void;
  /** Terminal post-open playback failure, after session cleanup. Open failures reject open instead. */
  readonly onError?: (error: EngineWebAdapterError) => void;
  /** Boot policy. Explicit `console` sizes override the adapter's defaults field by field. */
  readonly policy?: BrowserBootPolicy;
  /** One SDK-prepared spectrum boundary forwarded to the session's Engine. */
  readonly spectrum?: SpectrumQuery;
  /** Several SDK-prepared spectrum boundaries owned by one managed selection. */
  readonly spectrumCollection?: SpectrumCollection;
  /** SDK bounds for resident observation subscriptions. */
  readonly observationSubscriptionLimits?: ObservationSubscriptionLimits;
  /** SDK bounds for managed live track-response subscriptions. */
  readonly responseSubscriptionLimits?: TrackResponseSubscriptionLimits;
  /** SDK bounds for managed spectrum subscriptions. */
  readonly spectrumSubscriptionLimits?: SpectrumSubscriptionLimits;
  readonly assets?: AdapterAssetOverrides;
  readonly capabilityScope?: WebCapabilityScope;
  readonly store?: StemStore;
  readonly createContext?: (options: {
    readonly sampleRate: number;
    readonly renderSizeHint: number;
  }) => EngineAudioContext;
  readonly scratchBoot?: (request: {
    readonly document: Uint8Array;
    readonly options: import("@misofm/engine").BootOptions;
  }) => Promise<SessionShape>;
  readonly createHost?: import("@misofm/engine/browser").CreateEngineOptions["createHost"];
  readonly createAttachNode?: (
    context: BaseAudioContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ) => AudioWorkletNodeLike;
  readonly createPump?: (options: {
    readonly lease: import("./stems/index.js").StemSessionLease;
    readonly sources: readonly PcmPumpSource[];
    readonly signal: AbortSignal;
  }) => Promise<EnginePump>;
  readonly createOutput?: (options: {
    readonly context: AudioContextLike;
    readonly engineNode: AudioNode;
  }) => AudioNode;
}

export type EngineWebSessionOptions = EngineWebSessionCommonOptions & (
  | { readonly flac: FlacDeliveryOptions; readonly resolver?: never }
  | {
      /** Advanced escape hatch: already-decoded canonical PCM. */
      readonly resolver: StemResolver;
      readonly flac?: never;
  }
);

export type SparseEngineWebSessionOptions = Omit<
  EngineWebSessionCommonOptions,
  "store" | "createPump" | "ingestDiagnostics"
> & {
  readonly store?: Pick<VerifiedSparsePcmStore, "openSession">;
  readonly resolver?: SparsePcmSessionOptions["resolve"];
  readonly maximumMetadataBytes?: number;
  readonly createPump?: (options: {
    readonly lease: SparsePcmSessionLease;
    readonly sources: readonly SparsePcmPumpSource[];
    readonly signal: AbortSignal;
  }) => Promise<EnginePump>;
};

export interface EngineWebSession {
  readonly shape: SessionShape;
  readonly context: EngineAudioContext;
  /**
   * The same SDK Engine that owns this session's host, controls and analyses.
   * This view is borrowed: aggregate session close owns the Engine close.
   */
  readonly engine: SessionEngine;
  /**
   * The raw Engine worklet host. Its host implementation allocates request
   * identifiers for every payload-only call, including calls made here.
   * Prefer `console`, `meters` and `telemetry` when their typed projections fit.
   */
  readonly host: BrowserEngine["host"];
  /** Refuses with `console.not_attached` when the session opted out of a console. */
  readonly console: EngineWebConsole;
  readonly output: AudioNode;
  readonly state: EngineWebSessionState;
  /** Subscribe to the decimated meter feed. Resolves to an unsubscribe function. */
  meters(listener: (update: MeterUpdate) => void): Promise<() => void>;
  /** Subscribe to the render-telemetry feed. Resolves to an unsubscribe function. */
  telemetry(listener: (update: TelemetryUpdate) => void): Promise<() => void>;
  observeSource(sourceId: string): SourceObservation;
  feedDiagnostics(): FeedDiagnostics;
  /** Call from a user gesture. Rejects session.busy without resuming while any seek is pending. */
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Resolves after consumer preparation and target-generation prefill. Running contexts
   * suspend during preparation and resume afterward; suspended contexts stay suspended.
   * Await this before play(); preparation or context-transition failure closes the session. */
  seekFrames(frame: number | bigint): Promise<void>;
  close(): Promise<void>;
}

/** Compile-time assertion that declarations use the Engine package's SourceSpec. */
export type EngineSourceSpec = SourceSpec;

/** The session's SDK Engine with aggregate close retained by `EngineWebSession`. */
export type SessionEngine = Omit<BrowserEngine<EngineAudioContext>, "close">;
