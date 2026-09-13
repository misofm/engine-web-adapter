import assert from "node:assert/strict";
import test from "node:test";
import { Msb1RingObserver } from "@misofm/engine/browser";
import { CanonicalPcmPump } from "../src/stems/pump.js";
import { createMsb1Ring, MSB1_CONTROL } from "../src/stems/ring.js";
import type { StemIdentity } from "../src/stems/types.js";

test("64 sources share four physical reads and one stalled source does not block other runways", async () => {
  const io = controlledReads();
  const sources = Array.from({ length: 64 }, (_, index) => source(index, 100));
  const pump = new CanonicalPcmPump({ sources, lease: { read: async (identity) => io.blob(identity) }, windowFrames: 8 });
  await pump.pumpUntilBlocked(8, false);
  assert.equal(io.active, 4);
  const held = io.pending[0]!;
  for (let wave = 0; wave < 100 && wrote(sources[63]!.ring) < 4; wave++) {
    for (const read of io.pending.splice(0)) if (read === held) io.pending.push(read); else read.finish();
    await tick();
    await pump.pumpUntilBlocked(8, false);
  }
  assert.equal(wrote(sources[0]!.ring), 0, "the intentionally held source still has no PCM");
  assert.equal(wrote(sources[63]!.ring), 4, "later sources fill while the first source waits");
  assert.equal(io.peak, 4);
  assert.equal(pump.maximumWindowBytes, 64 * 2 * 8 * 2);
  held.finish();
  for (const read of io.pending.splice(0)) read.finish();
  pump.close();
  await tick();
  assert.equal(io.active, 0);
  for (const item of sources) assert.equal(Atomics.load(new Int32Array(item.ring), MSB1_CONTROL.WRITER_STATE), 0);
});

test("next-window I/O starts while the current PCM window can still feed audio", async () => {
  const io = controlledReads();
  const item = source(0, 32, 2);
  const pump = new CanonicalPcmPump({ sources: [item], lease: { read: async () => io.blob(item.identity) }, windowFrames: 8 });
  await pump.pumpPass(false);
  io.pending.shift()!.finish(); await tick();
  assert.equal((await pump.pumpPass(false)).chunks, 1);
  await tick();
  assert.equal(io.pending.length, 1, "prefetch begins after half the current window is consumed");
  assert.equal((await pump.pumpPass(false)).chunks, 1, "an unresolved prefetch does not block the remaining current quantum");
  assert.equal(wrote(item.ring), 2);
  const snapshot = wrote(item.ring);
  pump.close(); io.pending.shift()!.finish(); await tick();
  assert.equal(wrote(item.ring), snapshot, "closing with I/O pending cannot publish more PCM");
  assert.equal(io.active, 0);
});

test("seek invalidates pending reads without releasing their physical admission or relabelling old PCM", async () => {
  const io = controlledReads();
  const item = source(0, 100);
  const pump = new CanonicalPcmPump({ sources: [item], lease: { read: async () => io.blob(item.identity) }, windowFrames: 8 });
  await pump.pumpPass(false); await tick();
  const old = io.pending.shift()!;
  assert.equal(await pump.seekFrames(5), 2n);
  assert.equal(await pump.seekFrames(10), 3n);
  await pump.pumpUntilBlocked(8, false);
  assert.equal(io.active, 1);
  assert.equal(io.pending.length, 0, "old physical read retains its source slot across repeated seeks");
  old.finish(); await tick();
  assert.equal(wrote(item.ring), 0);
  const current = io.pending.shift()!;
  assert.equal(current.start, 20);
  current.finish(); await tick();
  await pump.pumpPass(false);
  const observer = new Msb1RingObserver(item.ring);
  assert.equal(observer.pull((chunk) => {
    assert.equal(chunk.generation, 3n); assert.equal(chunk.startFrame, 10n);
    assert.equal(chunk.planes[0]![0], 10 / 32768);
  }), 1);
  pump.close(); observer.close();
  for (const read of io.pending.splice(0)) read.finish();
  await tick(); assert.equal(io.active, 0);
});

test("rapid 64-source seeks cannot multiply the global physical read cap", async () => {
  const io = controlledReads();
  const sources = Array.from({ length: 64 }, (_, index) => source(index, 100));
  const pump = new CanonicalPcmPump({ sources, lease: { read: async (identity) => io.blob(identity) }, windowFrames: 8 });
  await pump.pumpPass(false); await tick();
  assert.equal(io.active, 4);
  for (const frame of [10, 20, 30]) {
    await pump.seekFrames(frame); await pump.pumpUntilBlocked(8, false);
    assert.equal(io.active, 4); assert.equal(io.pending.length, 4);
  }
  io.pending.shift()!.finish(); await tick();
  assert.equal(io.active, 4, "exactly one replacement can start after one old read physically settles");
  assert.equal(io.peak, 4);
  assert.ok(sources.every((item) => wrote(item.ring) === 0));
  pump.close(); for (const read of io.pending.splice(0)) read.finish();
  await tick(); assert.equal(io.active, 0);
});

test("finite ticks stay bounded and arbitrary window sizes preserve exact PCM24 tails", async () => {
  const ring = createMsb1Ring({ sourceId: "stereo", channels: 2, frameCapacity: 4, capacity: 64 });
  const expected = Array.from({ length: 19 }, (_, frame) => [frame * 1000 - 9000, 9000 - frame * 500]);
  const bytes = new Uint8Array(expected.length * 6);
  expected.forEach((samples, frame) => samples.forEach((sample, channel) => {
    const offset = frame * 6 + channel * 3;
    bytes[offset] = sample; bytes[offset + 1] = sample >> 8; bytes[offset + 2] = sample >> 16;
  }));
  const pump = new CanonicalPcmPump({ lease: { read: async () => new Blob([bytes]) }, windowFrames: 9,
    sources: [{ sourceId: "stereo", identity: `blake3:${"1".repeat(64)}`, channels: 2, bitDepth: 24, frames: 19, ring }] });
  const first = await pump.pumpUntilBlocked(2);
  assert.ok(first.chunks <= 2, "a finite tick cannot exceed its pass budget");
  await pump.pumpUntilBlocked();
  const observer = new Msb1RingObserver(ring);
  let frame = 0;
  observer.pull((chunk) => {
    assert.equal(chunk.startFrame, BigInt(frame));
    for (let offset = 0; offset < chunk.frames; offset++) {
      for (let channel = 0; channel < 2; channel++) assert.equal(chunk.planes[channel]![offset], expected[frame]![channel]! / 8388608);
      frame++;
    }
    assert.equal(chunk.endOfRegion, frame === 19);
  });
  assert.equal(frame, 19); observer.close(); pump.close();
});

test("a truncated playback window fails instead of substituting silence or publishing a partial quantum", async () => {
  const item = source(0, 32);
  const pump = new CanonicalPcmPump({ sources: [item], lease: { read: async () => new Blob([new Uint8Array(3)]) }, windowFrames: 8 });
  await assert.rejects(pump.pumpUntilBlocked(), /invalid byte count/u);
  assert.equal(wrote(item.ring), 0);
  pump.close();
});

test("rejected playback reads fail closed even when a custom lease rejects without an Error", async () => {
  for (const reason of [new Error("OPFS unavailable"), undefined]) {
    const item = source(0, 32);
    const pump = new CanonicalPcmPump({ sources: [item], lease: { read: async () => { throw reason; } }, windowFrames: 8 });
    await assert.rejects(pump.pumpUntilBlocked(), reason === undefined ? /without a reason/u : /OPFS unavailable/u);
    assert.equal(wrote(item.ring), 0);
    pump.close();
  }
});

function source(index: number, frames: number, capacity = 4) {
  const sourceId = `s${index}`;
  return { sourceId, identity: `blake3:${index.toString(16).padStart(64, "0")}` as StemIdentity,
    channels: 1 as const, bitDepth: 16 as const, frames,
    ring: createMsb1Ring({ sourceId, channels: 1, frameCapacity: 4, capacity }) };
}

function controlledReads() {
  let active = 0; let peak = 0;
  const pending: Array<{ readonly start: number; finish(): void }> = [];
  return {
    pending, get active() { return active; }, get peak() { return peak; },
    blob(_identity: StemIdentity): Blob {
      return { slice(start: number, end: number) { return { arrayBuffer() {
        active++; peak = Math.max(peak, active);
        assert.ok(end - start <= 16);
        return new Promise<ArrayBuffer>((resolve) => {
          let finished = false;
          pending.push({ start, finish() {
            if (finished) return; finished = true; active--;
            const bytes = new Uint8Array(end - start); const view = new DataView(bytes.buffer);
            for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, (start + offset) / 2, true);
            resolve(bytes.buffer);
          } });
        });
      } }; } } as unknown as Blob;
    },
  };
}

function wrote(ring: SharedArrayBuffer) { return Atomics.load(new Int32Array(ring), MSB1_CONTROL.WROTE); }
async function tick() { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
