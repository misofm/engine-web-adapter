import type { EngineConsole, SessionShape, SourceSpec } from "@misofm/engine";
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

export interface EngineWebSessionOptions {
  readonly document: EngineSessionDocument;
  readonly leaseId: string;
  readonly sources: readonly DeclaredStemSource[];
  readonly resolver: StemResolver;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: StemProgress) => void;
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

export interface EngineWebSession {
  readonly shape: SessionShape;
  readonly context: EngineAudioContext;
  readonly host: BrowserEngine["host"];
  readonly console: EngineConsole;
  readonly output: AudioNode;
  readonly state: EngineWebSessionState;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekFrames(frame: number | bigint): Promise<void>;
  close(): Promise<void>;
}

/** Compile-time assertion that declarations use the Engine package's SourceSpec. */
export type EngineSourceSpec = SourceSpec;
