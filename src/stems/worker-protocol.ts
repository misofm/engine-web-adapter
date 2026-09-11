import type { PcmPumpOutcome, PcmPumpSource, SparsePcmPumpSource } from "./pump.js";
import type { SparsePcmDescriptor } from "./sparse-store.js";

export type PumpWorkerRequest =
  | {
      readonly type: "initialize";
      readonly requestId: number;
      readonly sources: readonly (PcmPumpSource & { readonly blob: Blob })[];
      readonly windowFrames: number;
      readonly generation: bigint;
      readonly idleMs: number;
    }
  | {
      readonly type: "initialize-sparse";
      readonly requestId: number;
      readonly sources: readonly SparsePcmPumpSource[];
      readonly assets: readonly SparsePcmDescriptor[];
      readonly windowFrames: number;
      readonly generation: bigint;
      readonly idleMs: number;
    }
  | { readonly type: "seek"; readonly requestId: number; readonly frame: bigint }
  | { readonly type: "stop"; readonly requestId: number };

export type PumpWorkerResponse =
  | { readonly type: "initialized"; readonly requestId: number; readonly bounds: { readonly windowBytes: number; readonly ringBytes: number; readonly maximumReadScratchBytes?: number } }
  | { readonly type: "sought"; readonly requestId: number; readonly generation: bigint }
  | { readonly type: "stopped"; readonly requestId: number }
  | { readonly type: "pump-error"; readonly requestId?: number; readonly error: { readonly name: string; readonly message: string; readonly code?: string } }
  | ({ readonly type: "progress" } & PcmPumpOutcome);
