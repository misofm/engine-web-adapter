import { parentPort } from "node:worker_threads";

import type { FlacWorkerRequest, FlacWorkerResponse } from "../src/stems/flac-worker-protocol.js";

interface TestWorkerScope {
  onmessage: ((event: MessageEvent<FlacWorkerRequest>) => void) | null;
  postMessage(message: FlacWorkerResponse): void;
  close(): void;
}

const scope: TestWorkerScope = {
  onmessage: null,
  postMessage(message) { parentPort!.postMessage(message); },
  close() { parentPort!.postMessage({ type: "closed" }); },
};
Object.defineProperty(globalThis, "self", { value: scope });
globalThis.fetch = async () => new Response(new Uint8Array([0]), { headers: { "Content-Type": "application/wasm" } });
WebAssembly.compileStreaming = async () => ({} as WebAssembly.Module);
const memory = new WebAssembly.Memory({ initial: 32, maximum: 32 });
WebAssembly.instantiate = (async () => ({ exports: {
  memory,
  miso_flac_decoder_abi_version: () => 2,
  miso_flac_decoder_description_ptr: () => 0,
  miso_flac_decoder_description_capacity: () => 42,
  miso_flac_decoder_output_ptr: () => 0,
  miso_flac_decoder_output_length: () => 0,
  miso_flac_decoder_output_frames: () => 0,
  miso_flac_decoder_callback_error: () => 0,
  miso_flac_decoder_state: () => 0,
  miso_flac_decoder_initialize: () => 0,
  miso_flac_decoder_process_single: () => 2,
  miso_flac_decoder_release_output: () => undefined,
  miso_flac_decoder_finish: () => 0,
  miso_flac_decoder_destroy: () => { throw new Error("destroy trap"); },
  miso_flac_allocator_live_bytes: () => 0,
  miso_flac_allocator_peak_live_bytes: () => 0,
  miso_flac_allocator_peak_heap_bytes: () => 0,
  miso_flac_allocator_free_calls: () => 0,
  miso_flac_allocator_realloc_calls: () => 0,
} }) as unknown) as typeof WebAssembly.instantiate;

await import("../src/internal/engine-web-flac-worker.js");
parentPort!.on("message", (message: FlacWorkerRequest) => scope.onmessage?.({ data: message } as MessageEvent<FlacWorkerRequest>));
parentPort!.postMessage({ type: "booted" });
