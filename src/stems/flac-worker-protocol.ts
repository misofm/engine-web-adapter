import type { CanonicalPcmExpectation, StemIdentity } from "./types.js";
import type { FlacInputSlotBuffers } from "./flac-input-slot.js";
import type { NativeFlacStreamInfo } from "./native-flac-metadata.js";

export const FLAC_DECODE_OUTPUT_CREDITS = 2;

export type FlacWorkerRequest =
  | {
      readonly type: "start";
      readonly requestId: number;
      readonly identity: StemIdentity;
      readonly decoderWasmUrl: string;
      readonly inputSlot: FlacInputSlotBuffers;
      readonly expected?: CanonicalPcmExpectation;
    }
  | {
      readonly type: "initialize";
      readonly requestId: number;
      readonly streamInfo: NativeFlacStreamInfo;
      readonly expectedFrames: number;
      readonly totalPcmBytes: number;
    }
  | { readonly type: "output-credit"; readonly requestId: number }
  | { readonly type: "cancel"; readonly requestId: number };

export type FlacWorkerResponse =
  | { readonly type: "ready"; readonly requestId: number }
  | {
      readonly type: "input-credit";
      readonly requestId: number;
      readonly maximumBytes: number;
      readonly phase: "probe" | "metadata" | "audio";
      readonly phaseBytesRemaining: number;
    }
  | {
      readonly type: "pcm";
      readonly requestId: number;
      readonly bytes: ArrayBuffer;
      readonly frames: number;
      readonly totalPcmBytes: number;
    }
  | { readonly type: "complete"; readonly requestId: number; readonly pcmBytes: number; readonly frames: number }
  | {
      readonly type: "error";
      readonly requestId: number;
      readonly error: { readonly name: string; readonly message: string; readonly code?: string; readonly details?: Readonly<Record<string, unknown>> };
    };

export interface FlacWorkerLike {
  postMessage(message: FlacWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void;
}
