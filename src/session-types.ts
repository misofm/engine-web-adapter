import type { CommandReport, ConsoleEdits, LaneEdit, SessionShape, SourceSpec } from "@misofm/engine";
import type {
  AudioContextLike,
  BrowserBootPolicy,
  BrowserEngine,
} from "@misofm/engine/browser";

import type { AdapterAssetOverrides } from "./assets.js";
import type { WebCapabilityScope } from "./capabilities.js";
import type { AudioWorkletNodeLike, EngineFeed } from "./feed.js";
import type { PcmPumpSource } from "./stems/pump.js";
import type {
  DeclaredStemSource,
  FlacDeliveryOptions,
  StemProgress,
  StemResolver,
  StemStore,
} from "./stems/index.js";

export type EngineSessionDocument = Uint8Array | string | { toJson(): string };
export type EngineWebSessionState = "opening" | "ready" | "playing" | "paused" | "closed";

export interface EngineAudioContext extends AudioContextLike {
  readonly destination: AudioNode;
  resume(): Promise<void>;
  suspend(): Promise<void>;
}

export interface EnginePump {
  seekFrames(frame: number | bigint): Promise<bigint>;
  close(): Promise<void> | void;
}

/** One track's decimated meter reading, already folded to what a meter draws. */
export interface TrackMeter {
  readonly peakLeft: number;
  readonly peakRight: number;
  /** The greater of the two lanes: what a single meter bar shows. */
  readonly peak: number;
  /** Non-negative gain reduction in decibels; `0` when nothing is observed. */
  readonly gainReductionDb: number;
}

/** One decimated meter window, addressed by track id rather than by ordinal. */
export interface MeterUpdate {
  readonly sequence: bigint;
  /** Complete windows folded into this update; normally `1`. */
  readonly windows: number;
  readonly firstSample: bigint;
  readonly endSample: bigint;
  /** Every track in the compiled session, keyed by its id. */
  readonly tracks: ReadonlyMap<string, TrackMeter>;
  readonly master: TrackMeter;
}

/** One windowed render-telemetry reading. */
export interface TelemetryUpdate {
  readonly sequence: bigint;
  readonly blocks: number;
  /** Render time as a percentage of the block budget over the window. */
  readonly cpuPercent: number;
  readonly peakBlockMs: number;
  readonly meanBlockMs: number;
  readonly budgetMs: number;
  readonly deadlineMisses: number;
  readonly resolutionMs: number;
  /** `true` when the window measured exactly zero: the clock could not see the work. */
  readonly belowResolution: boolean;
}

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
  /** Boot policy. Explicit `console` sizes override the adapter's defaults field by field. */
  readonly policy?: BrowserBootPolicy;
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

export interface EngineWebSession {
  readonly shape: SessionShape;
  readonly context: EngineAudioContext;
  /**
   * The raw Engine worklet host.
   *
   * An escape hatch, and the one place the adapter's request-identifier ledger
   * does not reach: a call made here allocates its own identifier and can
   * collide with the console's. Prefer `console`, `meters` and `telemetry`.
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
  play(): Promise<void>;
  pause(): Promise<void>;
  seekFrames(frame: number | bigint): Promise<void>;
  close(): Promise<void>;
}

/** Compile-time assertion that declarations use the Engine package's SourceSpec. */
export type EngineSourceSpec = SourceSpec;
