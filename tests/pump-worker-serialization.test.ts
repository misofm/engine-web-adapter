import assert from "node:assert/strict";
import test from "node:test";

import { MSB1_CONTROL, MSB1_CONTROL_BYTES, MSB1_HEADER_OFFSET, MSB1_SLOT_HEADER_BYTES, createMsb1Ring } from "../src/stems/ring.js";
import type { PumpWorkerRequest, PumpWorkerResponse } from "../src/stems/worker-protocol.js";

test("Worker orders a delayed Blob tick before a later seek generation", async () => {
  const originalSelf = (globalThis as { self?: unknown }).self;
  const scope = new LocalWorkerScope();
  (globalThis as { self?: unknown }).self = scope;
  try {
    const specifier = `../src/internal/engine-web-pcm-pump-worker.js?serialization=${Date.now()}`;
    await import(specifier);
    const entered = deferred<void>();
    const release = deferred<void>();
    const bytes = new Uint8Array(32);
    const delayedBlob = {
      slice(first: number, last: number) {
        return { async arrayBuffer() { entered.resolve(); await release.promise; return bytes.slice(first, last).buffer; } };
      },
    } as unknown as Blob;
    const ring = createMsb1Ring({ sourceId: "source", channels: 1, frameCapacity: 4, capacity: 4 });
    scope.send({
      type: "initialize", requestId: 1, windowFrames: 4, generation: 1n, idleMs: 1,
      sources: [{ sourceId: "source", identity: `sha256:${"0".repeat(64)}`, channels: 1, bitDepth: 16, frames: 16, ring, blob: delayedBlob }],
    });
    await scope.waitFor("initialized");
    await entered.promise;
    scope.send({ type: "seek", requestId: 2, frame: 5n });
    release.resolve();
    await scope.waitFor("sought");

    const control = new Int32Array(ring, 0, MSB1_CONTROL_BYTES / 4);
    const headersI64 = new BigInt64Array(ring, MSB1_HEADER_OFFSET, 4 * MSB1_SLOT_HEADER_BYTES / 8);
    assert.ok(Atomics.load(control, MSB1_CONTROL.WROTE) > 0);
    // If seek interleaved with the delayed read, this slot would be generation 2 at old frame 0.
    assert.equal(headersI64[2], 1n);
    assert.equal(headersI64[3], 0n);
    scope.send({ type: "stop", requestId: 3 });
    await scope.waitFor("stopped");
  } finally {
    if (originalSelf === undefined) delete (globalThis as { self?: unknown }).self;
    else (globalThis as { self?: unknown }).self = originalSelf;
  }
});

class LocalWorkerScope {
  onmessage: ((event: MessageEvent<PumpWorkerRequest>) => void) | null = null;
  readonly replies: PumpWorkerResponse[] = [];
  readonly #waiters: Array<() => void> = [];
  postMessage(message: PumpWorkerResponse) { this.replies.push(message); for (const wake of this.#waiters.splice(0)) wake(); }
  close() { /* local harness */ }
  send(message: PumpWorkerRequest) { this.onmessage?.({ data: message } as MessageEvent<PumpWorkerRequest>); }
  async waitFor(type: PumpWorkerResponse["type"]): Promise<PumpWorkerResponse> {
    for (;;) {
      const reply = this.replies.find((candidate) => candidate.type === type);
      if (reply !== undefined) return reply;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
