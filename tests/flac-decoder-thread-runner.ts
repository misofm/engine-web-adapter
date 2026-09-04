import { parentPort } from "node:worker_threads";

import { NativeFlacDecoder } from "../src/stems/native-flac-decoder.js";
import type { FlacInputSlotBuffers } from "../src/stems/flac-input-slot.js";
import type { NativeFlacStreamInfo } from "../src/stems/native-flac-metadata.js";

interface Request {
  readonly wasm: Uint8Array;
  readonly inputSlot: FlacInputSlotBuffers;
  readonly streamInfo: NativeFlacStreamInfo;
  readonly expectedFrames: number;
}

parentPort!.once("message", (request: Request) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(request.wasm.slice().buffer as ArrayBuffer, {
    headers: { "Content-Type": "application/wasm" },
  });
  void NativeFlacDecoder.load({
    url: "https://asset.invalid/decoder.wasm",
    inputSlot: request.inputSlot,
    requestRefill: () => parentPort!.postMessage({ type: "credit" }),
  }).then((decoder) => {
    decoder.initialize(request.streamInfo, request.expectedFrames);
    let bytes = 0;
    let frames = 0;
    for (;;) {
      const result = decoder.processSingle();
      if (result === "eof") break;
      if (result !== null) { bytes += result.bytes.byteLength; frames += result.frames; }
    }
    decoder.finish();
    decoder.destroy();
    parentPort!.postMessage({ type: "complete", bytes, frames });
  }).catch((error: unknown) => {
    parentPort!.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
  }).finally(() => { globalThis.fetch = originalFetch; });
});
