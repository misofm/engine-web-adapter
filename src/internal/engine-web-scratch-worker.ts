import { scratchBootInWorker } from "@misofm/engine/browser";

import type { ScratchBootReply, ScratchBootRequest } from "../scratch.js";

interface Scope {
  onmessage: ((event: MessageEvent<ScratchBootRequest>) => void) | null;
  postMessage(message: ScratchBootReply): void;
}
const scope = ((globalThis as unknown as { readonly self?: Scope }).self ?? globalThis) as unknown as Scope;

scope.onmessage = (event) => {
  const request = event.data;
  void run(request).then((reply) => scope.postMessage(reply));
};

async function run(request: ScratchBootRequest): Promise<ScratchBootReply> {
  try {
    const response = await fetch(request.moduleUrl);
    if (!response.ok) throw new Error(`Engine Wasm fetch failed with HTTP ${response.status}`);
    const shape = await scratchBootInWorker({
      moduleBytes: new Uint8Array(await response.arrayBuffer()),
      document: request.document,
      options: request.options,
    });
    return { type: "scratch-result", requestId: request.requestId, ok: true, shape };
  } catch (error) {
    return {
      type: "scratch-result", requestId: request.requestId, ok: false,
      error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) },
    };
  }
}
