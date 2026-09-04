import { EngineWebAdapterError } from "./errors.js";
import {
  MSB1_CONTROL,
  MSB1_CONTROL_BYTES,
  createMsb1Ring,
} from "./stems/ring.js";

export const ENGINE_FEED_ATTACH_PROCESSOR = "miso-sab-feed-attach";
export const DEFAULT_RING_CAPACITY_CHUNKS = 64;

export interface AudioWorkletNodeLike {
  readonly port: { postMessage(message: unknown): void };
  disconnect(): void;
}

export interface EngineFeed {
  readonly rings: readonly SharedArrayBuffer[];
  readonly state: "pending" | "active" | "closed";
  ready(options?: { readonly timeoutMs?: number; readonly now?: () => number; readonly wait?: (ms: number) => Promise<void> }): Promise<void>;
  close(): void;
}

export async function prepareEngineFeed(
  context: { readonly audioWorklet: { addModule(url: string): Promise<void> } },
  moduleUrl: string | URL,
): Promise<void> {
  try {
    await context.audioWorklet.addModule(String(moduleUrl));
  } catch (error) {
    throw new EngineWebAdapterError("capability.audio_worklet", "Engine feed worklet prelude could not load", {}, error);
  }
}

export function attachEngineFeed(options: {
  readonly context: BaseAudioContext;
  readonly sources: readonly { readonly sourceId: string; readonly channels: 1 | 2 }[];
  readonly quantumFrames: number;
  readonly capacityChunks?: number;
  readonly createNode?: (context: BaseAudioContext, name: string, options: AudioWorkletNodeOptions) => AudioWorkletNodeLike;
}): EngineFeed {
  const capacity = options.capacityChunks ?? DEFAULT_RING_CAPACITY_CHUNKS;
  const rings = options.sources.map((source) => createMsb1Ring({
    sourceId: source.sourceId,
    channels: source.channels,
    frameCapacity: options.quantumFrames,
    capacity,
  }));
  let node: AudioWorkletNodeLike;
  try {
    node = options.createNode?.(
      options.context,
      ENGINE_FEED_ATTACH_PROCESSOR,
      { numberOfInputs: 0, numberOfOutputs: 1 },
    ) ?? new AudioWorkletNode(options.context, ENGINE_FEED_ATTACH_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
    });
  } catch (error) {
    throw new EngineWebAdapterError("session.open", "Engine feed attach processor is unavailable", {}, error);
  }
  node.port.postMessage({ op: "attach", rings });
  let state: "pending" | "active" | "closed" = rings.length === 0 ? "active" : "pending";
  return {
    rings,
    get state() { return state; },
    async ready(settings = {}) {
      if (state === "closed") throw new EngineWebAdapterError("session.closed", "Engine feed is closed");
      if (state === "active") return;
      const now = settings.now ?? (() => performance.now());
      const wait = settings.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
      const deadline = now() + (settings.timeoutMs ?? 2_000);
      while (state === "pending") {
        if (rings.every(attached)) { state = "active"; return; }
        if (now() >= deadline) {
          close();
          throw new EngineWebAdapterError("session.open", "Engine feed attach confirmation timed out");
        }
        await wait(0);
      }
    },
    close,
  };

  function close(): void {
    if (state === "closed") return;
    state = "closed";
    for (const ring of rings) Atomics.store(control(ring), MSB1_CONTROL.WRITER_STATE, 0);
    try { node.port.postMessage({ op: "detach" }); } catch { /* context already closed */ }
    try { node.disconnect(); } catch { /* never connected */ }
  }
}

function control(ring: SharedArrayBuffer): Int32Array {
  return new Int32Array(ring, 0, MSB1_CONTROL_BYTES / 4);
}
function attached(ring: SharedArrayBuffer): boolean {
  return Atomics.load(control(ring), MSB1_CONTROL.ATTACHED) === 1;
}
