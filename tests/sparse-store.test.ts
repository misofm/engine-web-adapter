import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MemoryStemStorageBackend,
  VerifiedSparsePcmStore,
  validateSparsePcmIndex,
  type SparsePcmExpectation,
} from "../src/stems/index.js";

function expectation(bytes: Uint8Array, frames: number, shape: { readonly channels?: 1 | 2; readonly bitDepth?: 16 | 24 } = {}): SparsePcmExpectation {
  const channels = shape.channels ?? 1;
  const bitDepth = shape.bitDepth ?? 16;
  return {
    identity: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    sampleRateHz: 48_000,
    channels,
    bitDepth,
    frames,
    canonicalBytes: frames * channels * (bitDepth / 8),
  };
}

function spans(...items: readonly { readonly startFrame: number; readonly bytes: Uint8Array }[]): AsyncIterable<{ readonly startFrame: number; readonly bytes: Uint8Array }> {
  return (async function*() { for (const item of items) yield item; })();
}

describe("VerifiedSparsePcmStore", () => {
  it("commits all-silent and all-active canonical sources, then opens warm without resolving", async () => {
    const silentBytes = new Uint8Array(12);
    const silentExpected = expectation(silentBytes, 6);
    const silentBackend = new MemoryStemStorageBackend();
    const silentStore = new VerifiedSparsePcmStore({ backend: silentBackend, instanceId: "silent" });
    let silentResolve = 0;
    const silent = await silentStore.installSource(silentExpected, {
      resolve: async () => { silentResolve += 1; return { spans: spans() }; },
    });
    assert.equal(silent.data.size, 0);
    assert.equal(silent.index.activeBytes, 0);
    await silentStore.installSource(silentExpected, {
      resolve: async () => { throw new Error("warm resolver called"); },
    });
    assert.equal(silentResolve, 1);

    const activeBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const activeExpected = expectation(activeBytes, 4);
    const activeBackend = new MemoryStemStorageBackend();
    const activeStore = new VerifiedSparsePcmStore({ backend: activeBackend, instanceId: "active" });
    const active = await activeStore.installSource(activeExpected, {
      resolve: async () => ({ spans: spans({ startFrame: 0, bytes: activeBytes.slice(0, 4) }, { startFrame: 2, bytes: activeBytes.slice(4) }) }),
    });
    assert.equal(active.data.size, activeExpected.canonicalBytes);
    assert.deepEqual(active.index.intervals, [{ startFrame: 0, frames: 4, byteOffset: 0 }]);
    assert.equal((await activeStore.openSource(activeExpected))?.data.size, 8);
  });

  it("hashes implicit leading/interior/trailing zeros and rejects tampered committed bytes", async () => {
    const canonical = new Uint8Array(20);
    canonical.set([1, 2, 3, 4], 4);
    canonical.set([5, 6, 7, 8], 16);
    const expected = expectation(canonical, 10);
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "gaps" });
    const descriptor = await store.installSource(expected, {
      resolve: async () => ({ spans: spans(
        { startFrame: 2, bytes: canonical.slice(4, 8) },
        { startFrame: 8, bytes: canonical.slice(16, 20) },
      ) }),
    });
    assert.equal(descriptor.data.size, 8);
    assert.deepEqual(descriptor.index.intervals, [
      { startFrame: 2, frames: 2, byteOffset: 0 },
      { startFrame: 8, frames: 2, byteOffset: 4 },
    ]);
    const payload = [...backend.files.keys()].find((name) => name.startsWith("sparse-pcm-v1-data-"));
    assert.ok(payload);
    const changed = backend.files.get(payload)!.slice();
    changed[0] = (changed[0] ?? 0) ^ 1;
    backend.files.set(payload, changed);
    await assert.rejects(store.openSource(expected), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "stem.corrupt");
  });

  it("rejects malformed spans and an upfront index that disagrees before publication", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const expected = expectation(bytes, 2);
    const backend = new MemoryStemStorageBackend();
    const store = new VerifiedSparsePcmStore({ backend, instanceId: "bounds" });
    await assert.rejects(store.installSource(expected, {
      resolve: async () => ({ spans: spans({ startFrame: 0, bytes: new Uint8Array([1]) }) }),
    }));
    assert.equal((await backend.list()).length, 0);
    const asserted = validateSparsePcmIndex({
      format: "miso_sparse_pcm_v1",
      identity: expected.identity,
      sampleRateHz: expected.sampleRateHz,
      channels: expected.channels,
      bitDepth: expected.bitDepth,
      frames: expected.frames,
      intervals: [{ startFrame: 0, frames: 1, byteOffset: 0 }],
    }, 2);
    await assert.rejects(store.installSource(expected, {
      resolve: async () => ({ index: asserted, spans: spans({ startFrame: 0, bytes }) }),
    }));
    assert.equal((await backend.list()).length, 0);
  });

  it("shares the historical same-backend lock and invokes one cold resolver", async () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const expected = expectation(bytes, 2);
    const backend = new MemoryStemStorageBackend();
    const first = new VerifiedSparsePcmStore({ backend, instanceId: "one" });
    const second = new VerifiedSparsePcmStore({ backend, instanceId: "two" });
    let resolves = 0;
    const resolve = async () => {
      resolves += 1;
      await new Promise((done) => setTimeout(done, 5));
      return { spans: spans({ startFrame: 0, bytes }) };
    };
    const [left, right] = await Promise.all([
      first.installSource(expected, { resolve }),
      second.installSource(expected, { resolve }),
    ]);
    assert.equal(resolves, 1);
    assert.equal(left.data.size, right.data.size);
    assert.equal((await backend.list()).filter((name) => name.startsWith("sparse-pcm-v1-commit-")).length, 1);
  });
});
