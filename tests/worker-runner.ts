import { parentPort } from "node:worker_threads";

if (parentPort === null) throw new Error("pump worker runner requires a parent port");

const port = parentPort;
Object.assign(globalThis, {
  self: {
    onmessage: null,
    postMessage(message: unknown) { port.postMessage(message); },
    close() { port.close(); },
  },
});
await import("../src/internal/engine-web-pcm-pump-worker.js");
port.on("message", (data) => {
  const scope = (globalThis as unknown as { self: { onmessage: ((event: MessageEvent) => void) | null } }).self;
  scope.onmessage?.({ data } as MessageEvent);
});
port.postMessage({ type: "runner-ready" });
