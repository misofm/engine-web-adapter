import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { createBLAKE3 } from "hash-wasm";

import { EngineWebAdapterError } from "../src/errors.js";
import { serializeSparseStemIndex, MemoryStemStorageBackend, VerifiedSparsePcmStore, createSparseStemResolver } from "../src/stems/index.js";
import { sparseProgressReporter } from "../src/stems/progress.js";
import { BoundedStemAdmission } from "../src/stems/flac-admission.js";
import { sparseResolverScheduling } from "../src/stems/sparse-scheduling.js";
import type { FlacWorkerLike, FlacWorkerRequest, FlacWorkerResponse } from "../src/stems/flac-worker-protocol.js";
import type { SparsePcmExpectation } from "../src/stems/sparse-store.js";
import type { StemProgress } from "../src/stems/types.js";

const identityHasher = await createBLAKE3(256);
const identity = (bytes: Uint8Array) => `blake3:${identityHasher.init().update(bytes).digest("hex")}` as const;
const ZERO_IDENTITY = identity(new Uint8Array(4096));

function expectation(bytes: Uint8Array, frames: number): SparsePcmExpectation {
  return { identity: identity(bytes), sampleRateHz: 48_000, channels: 1, bitDepth: 16, frames, canonicalBytes: bytes.byteLength };
}

function spans(...items: readonly { readonly startFrame: number; readonly bytes: Uint8Array }[]): AsyncIterable<{ readonly startFrame: number; readonly bytes: Uint8Array }> {
  return (async function*() { for (const item of items) yield item; })();
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("native mixed fixture timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function responseBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function responseWithByobTerminal(
  result: ReadableStreamReadResult<Uint8Array>,
): Response {
  const response = new Response(null, { status: 200 });
  let reads = 0;
  const body = {
    locked: false,
    getReader(options?: { readonly mode?: "byob" }) {
      if (options?.mode !== "byob") throw new TypeError("BYOB reader required");
      return {
        async read(_view: Uint8Array) { reads += 1; return reads === 1 ? result : { done: true, value: new Uint8Array() }; },
        async cancel() {},
        releaseLock() {},
      };
    },
  };
  Object.defineProperty(response, "body", { value: body });
  return response;
}

class DecodeWorker implements FlacWorkerLike {
  readonly posted: FlacWorkerRequest[] = [];
  terminated = false;
  #slot: Extract<FlacWorkerRequest, { type: "start" }>['inputSlot'] | undefined;
  #listeners = new Set<(event: { readonly data: FlacWorkerResponse }) => void>();
  #pendingOutputs: readonly { readonly bytes: ArrayBuffer; readonly frames: number }[] = [];
  #outputCredits = 0;
  #completeRequestId: number | undefined;
  #completePcmBytes = 0;
  #completeFrames = 0;

  constructor(private pcm?: Uint8Array) {}

  reset(pcm?: Uint8Array): void { this.pcm = pcm; }

  postMessage(message: FlacWorkerRequest): void {
    if (this.terminated) return;
    this.posted.push(message);
    if (message.type === "start") {
      this.#slot = message.inputSlot;
      setTimeout(() => this.emit({ type: "ready", requestId: message.requestId }), 0);
    } else if (message.type === "initialize") {
      setTimeout(() => this.emit({ type: "input-credit", requestId: message.requestId, maximumBytes: 256 * 1024, phase: "audio", phaseBytesRemaining: 0 }), 0);
      setTimeout(() => this.poll(message.requestId, message.expectedFrames, message.totalPcmBytes), 0);
    } else if (message.type === "output-credit") {
      this.#outputCredits += 1;
      this.flushOutputs();
    }
  }

  terminate(): void { this.terminated = true; }
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    if (type === "message") this.#listeners.add(listener);
  }
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void {
    if (type === "message") this.#listeners.delete(listener);
  }
  emit(message: FlacWorkerResponse): void { for (const listener of this.#listeners) listener({ data: message }); }
  private poll(requestId: number, frames: number, pcmBytes: number): void {
    if (this.terminated || this.#slot === undefined) return;
    const control = new Int32Array(this.#slot.control);
    if (Atomics.load(control, 0) !== 1) {
      setTimeout(() => this.poll(requestId, frames, pcmBytes), 0);
      return;
    }
    const final = Atomics.load(control, 3) === 1;
    Atomics.store(control, 0, 0);
    if (!final) {
      setTimeout(() => this.emit({ type: "input-credit", requestId, maximumBytes: 256 * 1024, phase: "audio", phaseBytesRemaining: 0 }), 0);
      setTimeout(() => this.poll(requestId, frames, pcmBytes), 0);
      return;
    }
    if (this.pcm !== undefined && this.pcm.byteLength === pcmBytes && pcmBytes > 384 * 1024) {
      const firstFrames = Math.floor(frames / 3);
      const frameBytes = pcmBytes / frames;
      const firstBytes = firstFrames * frameBytes;
      const secondBytes = firstBytes * 2;
      (this.#pendingOutputs as { bytes: ArrayBuffer; frames: number }[]).push(
        { bytes: this.pcm.slice(0, firstBytes).buffer, frames: firstFrames },
        { bytes: this.pcm.slice(firstBytes, secondBytes).buffer, frames: firstFrames },
        { bytes: this.pcm.slice(secondBytes).buffer, frames: frames - firstFrames * 2 },
      );
    } else {
      (this.#pendingOutputs as { bytes: ArrayBuffer; frames: number }[]).push({
        bytes: this.pcm?.slice().buffer ?? new ArrayBuffer(pcmBytes), frames,
      });
    }
    this.#outputCredits = 2;
    this.#completeRequestId = requestId;
    this.#completePcmBytes = pcmBytes;
    this.#completeFrames = frames;
    this.flushOutputs();
  }

  private flushOutputs(): void {
    if (this.terminated || this.#completeRequestId === undefined) return;
    while (this.#outputCredits > 0 && this.#pendingOutputs.length > 0) {
      const output = this.#pendingOutputs[0]!;
      (this.#pendingOutputs as { readonly bytes: ArrayBuffer; readonly frames: number }[]).shift();
      this.#outputCredits -= 1;
      this.emit({ type: "pcm", requestId: this.#completeRequestId, bytes: output.bytes, frames: output.frames, totalPcmBytes: this.#completePcmBytes });
    }
    if (this.#pendingOutputs.length === 0) {
      const requestId = this.#completeRequestId;
      this.#completeRequestId = undefined;
      this.emit({ type: "complete", requestId, pcmBytes: this.#completePcmBytes, frames: this.#completeFrames, reset: true });
    }
  }
}

/** A private Worker boundary fixture that keeps the real native resolver path. */
class MixedNativeWorker {
  static pcmByIdentity = new Map<string, Uint8Array>();
  static warmStarts = 0;
  static warmCompletions = 0;
  static decodeStarts = 0;
  static decodeCompletions = 0;
  static warmConstructed = 0;
  static warmTerminated = 0;
  static warmLive = 0;
  static warmPeak = 0;
  static coldConstructed = 0;
  static coldTerminated = 0;
  static coldLive = 0;
  static coldPeak = 0;
  static firstDecodeHeld = false;
  static secondWarmHeld = false;
  static firstDecode: MixedNativeWorker | undefined;
  static secondWarm: MixedNativeWorker | undefined;

  readonly #sparse: boolean;
  readonly #listeners = new Set<(event: any) => void>();
  #decode: DecodeWorker | undefined;
  #heldEvents: any[] = [];
  #warmCompletion: any | undefined;
  #released = false;
  #terminated = false;
  #resetAcknowledged = false;
  #busy = false;
  #activeIdentity: string | undefined;
  #idleIdentity: string | undefined;

  constructor(url: string | URL) {
    this.#sparse = String(url).includes("sparse-verify");
    if (this.#sparse) {
      MixedNativeWorker.warmConstructed += 1;
      MixedNativeWorker.warmLive += 1;
      MixedNativeWorker.warmPeak = Math.max(MixedNativeWorker.warmPeak, MixedNativeWorker.warmLive);
    } else {
      MixedNativeWorker.coldConstructed += 1;
      MixedNativeWorker.coldLive += 1;
      MixedNativeWorker.coldPeak = Math.max(MixedNativeWorker.coldPeak, MixedNativeWorker.coldLive);
      MixedNativeWorker.decodeStarts += 1;
      if (MixedNativeWorker.decodeStarts === 1) {
        MixedNativeWorker.firstDecodeHeld = true;
        MixedNativeWorker.firstDecode = this;
      }
    }
  }

  postMessage(message: any): void {
    if (this.#sparse) {
      if (message.type === "ack") return;
      if (message.type !== "start") return;
      this.#warmCompletion = message;
      MixedNativeWorker.warmStarts += 1;
      if (MixedNativeWorker.warmStarts === 2) {
        MixedNativeWorker.secondWarm = this;
        MixedNativeWorker.secondWarmHeld = true;
      }
      const intervals = new Float64Array(message.intervals);
      const readCalls = Array.from({ length: message.intervalCount }, (_, index) => Math.ceil((intervals[index * 3 + 1]! * message.frameBytes) / (512 * 1024))).reduce((sum, count) => sum + count, 0);
      const zeroUpdates = Array.from({ length: message.intervalCount }, (_, index) => {
        const start = intervals[index * 3]!;
        const previous = index === 0 ? 0 : intervals[(index - 1) * 3]! + intervals[(index - 1) * 3 + 1]!;
        return Math.ceil(((start - previous) * message.frameBytes) / (64 * 1024));
      }).reduce((sum, count) => sum + count, Math.ceil(((message.frames - (message.intervalCount === 0 ? 0 : intervals[(message.intervalCount - 1) * 3]! + intervals[(message.intervalCount - 1) * 3 + 1]!)) * message.frameBytes) / (64 * 1024)));
      queueMicrotask(() => {
        this.emit({ type: "progress", version: 1, jobId: message.jobId, generation: message.generation, bytes: message.canonicalBytes });
        if (this === MixedNativeWorker.secondWarm && MixedNativeWorker.secondWarmHeld) return;
        MixedNativeWorker.warmCompletions += 1;
        this.emit({
          type: "complete", version: 1, jobId: message.jobId, generation: message.generation,
          identity: message.identity, digest: message.identity.slice(7), progressBytes: message.canonicalBytes,
          canonicalBytes: message.canonicalBytes, readCalls, readBytes: message.activeBytes,
          hashedBytes: message.canonicalBytes, hashUpdates: readCalls + zeroUpdates, zeroUpdates,
          elapsedMs: 1, readWaitMs: 1, hashMs: 1,
        });
      });
      return;
    }
    if (message.type === "start") {
      this.#activeIdentity = message.identity;
      this.#idleIdentity = undefined;
      this.#resetAcknowledged = false;
      this.#busy = true;
      const pcm = MixedNativeWorker.pcmByIdentity.get(message.identity);
      if (this.#decode === undefined) {
        this.#decode = new DecodeWorker(pcm);
        this.#decode.addEventListener("message", (event) => {
          if (event.data.type === "complete") MixedNativeWorker.decodeCompletions += 1;
          if (event.data.type === "complete" && event.data.reset === true) {
            this.#resetAcknowledged = true;
            this.#busy = false;
            this.#idleIdentity = this.#activeIdentity;
          }
          if (MixedNativeWorker.firstDecode === this && MixedNativeWorker.firstDecodeHeld && !this.#released) this.#heldEvents.push(event);
          else this.emit(event.data);
        });
      } else {
        this.#decode.reset(pcm);
      }
    }
    this.#decode?.postMessage(message);
  }

  terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#decode?.terminate();
    if (this.#sparse) {
      MixedNativeWorker.warmTerminated += 1;
      MixedNativeWorker.warmLive -= 1;
    } else {
      MixedNativeWorker.coldTerminated += 1;
      MixedNativeWorker.coldLive -= 1;
    }
  }
  isAliveAndIdle(identity: string): boolean {
    return !this.#terminated && !this.#busy && this.#resetAcknowledged && this.#idleIdentity === identity;
  }
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void { if (type === "message") this.#listeners.add(listener); }
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void { if (type === "message") this.#listeners.delete(listener); }

  release(): void {
    this.#released = true;
    const held = this.#heldEvents.splice(0);
    for (const event of held) this.emit(event.data);
  }

  emit(message: any): void { for (const listener of this.#listeners) listener({ data: message }); }
  static releaseFirstDecode(): void { MixedNativeWorker.firstDecode?.release(); MixedNativeWorker.firstDecodeHeld = false; }
  static releaseSecondWarm(): void {
    if (!MixedNativeWorker.secondWarmHeld) return;
    MixedNativeWorker.secondWarmHeld = false;
    MixedNativeWorker.warmCompletions += 1;
    const worker = MixedNativeWorker.secondWarm;
    if (worker === undefined) return;
    const start = worker.#warmCompletion;
    worker.emit({
      type: "complete", version: 1, jobId: start?.jobId, generation: start?.generation,
      identity: start?.identity, digest: start?.identity?.slice(7), progressBytes: start?.canonicalBytes,
      canonicalBytes: start?.canonicalBytes, readCalls: 1, readBytes: start?.activeBytes,
      hashedBytes: start?.canonicalBytes, hashUpdates: 1, zeroUpdates: 0,
      elapsedMs: 1, readWaitMs: 1, hashMs: 1,
    });
  }
}

function packageBody(flac: Uint8Array, options: {
  readonly expected?: SparsePcmExpectation;
  readonly pcm?: Uint8Array;
  readonly packedFrames?: number;
  readonly intervals?: readonly { readonly startFrame: number; readonly frames: number; readonly packedFrameOffset: number }[];
} = {}): { readonly body: Uint8Array; readonly expected: SparsePcmExpectation } {
  const expected = options.expected ?? {
    identity: ZERO_IDENTITY,
    sampleRateHz: 48_000,
    channels: 1 as const,
    bitDepth: 16 as const,
    frames: 2_048,
    canonicalBytes: 4_096,
  };
  const pcm = options.pcm ?? new Uint8Array(expected.canonicalBytes);
  const packedFrames = options.packedFrames ?? expected.frames;
  const intervals = options.intervals ?? [{ startFrame: 0, frames: expected.frames, packedFrameOffset: 0 }];
  assert.equal(pcm.byteLength, packedFrames * expected.channels * (expected.bitDepth / 8));
  const manifest = {
    format: "miso_sparse_stem_v1" as const,
    identity: expected.identity,
    sampleRateHz: expected.sampleRateHz,
    channels: expected.channels,
    bitDepth: expected.bitDepth,
    frames: expected.frames,
    intervals,
    chunks: [{
      offset: 0,
      bytes: flac.byteLength,
      frames: packedFrames,
      packedStartFrame: 0,
      flacSha256: createHash("sha256").update(flac).digest("hex"),
      pcmSha256: createHash("sha256").update(pcm).digest("hex"),
    }],
  };
  const encoded = serializeSparseStemIndex(manifest);
  const header = new Uint8Array(16);
  header.set(new TextEncoder().encode("MISOSTM1"));
  new DataView(header.buffer).setUint32(8, encoded.byteLength, true);
  return { body: new Uint8Array([...header, ...encoded, ...flac]), expected };
}

function padSilenceFlac(flac: Uint8Array, extraPaddingBytes: number): Uint8Array {
  const paddingHeaderOffset = 118;
  const paddingBytes = new DataView(flac.buffer, flac.byteOffset, flac.byteLength).getUint8(paddingHeaderOffset + 1) * 0x1_00_00 +
    new DataView(flac.buffer, flac.byteOffset, flac.byteLength).getUint8(paddingHeaderOffset + 2) * 0x100 +
    new DataView(flac.buffer, flac.byteOffset, flac.byteLength).getUint8(paddingHeaderOffset + 3);
  const audioOffset = paddingHeaderOffset + 4 + paddingBytes;
  const padded = new Uint8Array(flac.byteLength + extraPaddingBytes);
  padded.set(flac.subarray(0, paddingHeaderOffset));
  padded.set(flac.subarray(paddingHeaderOffset, paddingHeaderOffset + 4), paddingHeaderOffset);
  padded[paddingHeaderOffset + 1] = (paddingBytes + extraPaddingBytes) >>> 16;
  padded[paddingHeaderOffset + 2] = (paddingBytes + extraPaddingBytes) >>> 8;
  padded[paddingHeaderOffset + 3] = paddingBytes + extraPaddingBytes;
  padded.set(flac.subarray(audioOffset), audioOffset + extraPaddingBytes);
  return padded;
}

function multiblockPcm(frames: number): Uint8Array {
  const output = new Uint8Array(frames * 6);
  const view = new DataView(output.buffer);
  for (let frame = 0; frame < frames; frame += 1) {
    const left = (frame * 7_919) % 16_000_001 - 8_000_000;
    const right = -Math.trunc(left / 2);
    for (const [channel, value] of [[0, left], [1, right]] as const) {
      const unsigned = value < 0 ? value + 0x1_00_00_00 : value;
      const offset = (frame * 2 + channel) * 3;
      view.setUint8(offset, unsigned & 0xff);
      view.setUint8(offset + 1, (unsigned >>> 8) & 0xff);
      view.setUint8(offset + 2, (unsigned >>> 16) & 0xff);
    }
  }
  return output;
}

class DeferredFirstWriteBackend extends MemoryStemStorageBackend {
  writes = 0;
  #releaseWrite!: () => void;
  readonly #firstWrite = new Promise<void>(resolve => { this.#releaseWrite = resolve; });

  releaseFirstWrite(): void { this.#releaseWrite(); }

  override async createWriter(name: string, signal?: AbortSignal) {
    const writer = await super.createWriter(name, signal);
    let deferred = true;
    return {
      write: async (chunk: Uint8Array | string) => {
        this.writes += 1;
        if (deferred) {
          deferred = false;
          await this.#firstWrite;
        }
        await writer.write(chunk);
      },
      close: () => writer.close(),
      abort: (reason?: unknown) => writer.abort(reason),
    };
  }
}

function emptySilentPackage(): { readonly body: Uint8Array; readonly expected: SparsePcmExpectation } {
  const expected = {
    identity: ZERO_IDENTITY,
    sampleRateHz: 48_000,
    channels: 1 as const,
    bitDepth: 16 as const,
    frames: 2_048,
    canonicalBytes: 4_096,
  };
  const encoded = serializeSparseStemIndex({
    format: "miso_sparse_stem_v1" as const,
    identity: expected.identity,
    sampleRateHz: expected.sampleRateHz,
    channels: expected.channels,
    bitDepth: expected.bitDepth,
    frames: expected.frames,
    intervals: [],
    chunks: [],
  });
  const header = new Uint8Array(16);
  header.set(new TextEncoder().encode("MISOSTM1"));
  new DataView(header.buffer).setUint32(8, encoded.byteLength, true);
  return { body: new Uint8Array([...header, ...encoded]), expected };
}

async function expectFullResponseFailure(
  packed: { readonly body: Uint8Array; readonly expected: SparsePcmExpectation },
  response: () => Response,
  code: string,
  createWorker: () => FlacWorkerLike = () => { throw new Error("malformed all-silent source must not create a decoder worker"); },
): Promise<void> {
  let fetches = 0;
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/indexed",
    fetch: async () => { fetches += 1; return response(); },
    createWorker,
  });
  const resolved = await resolver(packed.expected, new AbortController().signal);
  const iterator = resolved.spans[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), (error: unknown) => error instanceof Error && "code" in error &&
    (error as { readonly code?: unknown }).code === code);
  assert.equal(fetches, 1);
}

test("full-response admission rejects malformed sections, headers, status and trailing bytes", async () => {
  const packed = emptySilentPackage();
  const manifestBytes = new DataView(packed.body.buffer, packed.body.byteOffset, packed.body.byteLength).getUint32(8, true);
  const cases: readonly { readonly response: () => Response; readonly code: string }[] = [
    { response: () => new Response(responseBytes(packed.body.slice(0, 8)), { status: 200 }), code: "stem.delivery.range" },
    { response: () => new Response(responseBytes(packed.body.slice(0, 16 + Math.floor(manifestBytes / 2))), { status: 200 }), code: "stem.delivery.range" },
    { response: () => new Response(responseBytes(packed.body), { status: 200, headers: { "Content-Length": "1" } }), code: "stem.delivery.http" },
    { response: () => new Response(responseBytes(packed.body), { status: 200, headers: { "Content-Length": "invalid" } }), code: "stem.delivery.http" },
    { response: () => new Response(responseBytes(packed.body), { status: 206 }), code: "stem.delivery.http" },
    { response: () => new Response(responseBytes(packed.body), { status: 200, headers: { "Content-Encoding": "gzip" } }), code: "stem.delivery.http" },
    { response: () => new Response(responseBytes(new Uint8Array([...packed.body, 0])), { status: 200 }), code: "stem.delivery.range" },
  ];
  for (const item of cases) await expectFullResponseFailure(packed, item.response, item.code);
});

test("factory validates locator and decoder deadlines before the first request", () => {
  const options = { locate: () => "https://fixture.invalid/indexed" };
  assert.throws(() => createSparseStemResolver({ ...options, locate: null as never }), TypeError);
  assert.throws(() => createSparseStemResolver({ ...options, readDeadlineMs: 0 }), RangeError);
  assert.throws(() => createSparseStemResolver({ ...options, decodeNoProgressMs: 0 }), RangeError);
});

test("native sparse scheduling funds only unused headroom and keeps wrapped/custom paths baseline", async () => {
  const options = {
    locate: () => "https://fixture.invalid/indexed",
    hardwareConcurrency: 4,
    maximumWorkers: 2,
    memoryBudgetBytes: 20 * 1024 * 1024,
  } as const;
  const resolver = createSparseStemResolver(options);
  const scheduling = sparseResolverScheduling(resolver);
  assert.ok(scheduling);
  assert.equal(scheduling.concurrency, 2);
  const claim = scheduling.tryClaimWarmPreparation?.();
  assert.ok(claim);
  assert.equal(claim.width, 2);
  assert.equal(scheduling.tryClaimWarmPreparation?.(), undefined, "one resolver preparation owns the warm reservation");
  await claim.release();
  const retry = scheduling.tryClaimWarmPreparation?.();
  assert.equal(retry?.width, 2);
  await retry?.release();

  const zeroHeadroom = createSparseStemResolver({ ...options, memoryBudgetBytes: 16 * 1024 * 1024 });
  assert.equal(sparseResolverScheduling(zeroHeadroom)?.tryClaimWarmPreparation?.(), undefined);
  const custom = createSparseStemResolver({ ...options, createWorker: () => { throw new Error("custom decoder"); } });
  assert.equal(sparseResolverScheduling(custom)?.tryClaimWarmPreparation?.(), undefined);
  const wrapped = ((value: typeof resolver) => (expected: SparsePcmExpectation, signal: AbortSignal) => value(expected, signal))(resolver);
  assert.equal(sparseResolverScheduling(wrapped), undefined);
});

test("keeps warm eligibility and source width stable across bounded policy inputs", async () => {
  const base = { locate: () => "https://fixture.invalid/policy", hardwareConcurrency: 4, maximumWorkers: 2 } as const;
  const fundedOne = sparseResolverScheduling(createSparseStemResolver({ ...base, memoryBudgetBytes: 18 * 1024 * 1024 }));
  const claim = fundedOne?.tryClaimWarmPreparation?.();
  assert.equal(claim?.width, 1, "one funded warm slot is selected from residual headroom");
  await claim?.release();
  const callerOwned = sparseResolverScheduling(createSparseStemResolver({ ...base, admission: new BoundedStemAdmission(2), memoryBudgetBytes: 20 * 1024 * 1024 }));
  assert.equal(callerOwned?.tryClaimWarmPreparation?.(), undefined, "caller-owned admission stays conservative");
  const explicitAssets = sparseResolverScheduling(createSparseStemResolver({ ...base, assets: { flacWorkerUrl: "https://fixture.invalid/flac-worker.js" }, memoryBudgetBytes: 20 * 1024 * 1024 }));
  assert.equal(explicitAssets?.tryClaimWarmPreparation?.(), undefined, "explicit assets stay conservative");

  const preferences = [1, 2, 4, 8, 16];
  for (const preference of preferences) {
    const hardwareConcurrency = Math.max(2, preference + 1);
    const shipped = sparseResolverScheduling(createSparseStemResolver({ locate: base.locate, hardwareConcurrency, maximumWorkers: preference, memoryBudgetBytes: preference * 8 * 1024 * 1024 }));
    const appBudget = sparseResolverScheduling(createSparseStemResolver({ locate: base.locate, hardwareConcurrency, maximumWorkers: preference, memoryBudgetBytes: preference * 8 * 1024 * 1024 + 4 * 1024 * 1024 }));
    assert.equal(shipped?.concurrency, appBudget?.concurrency, `+4 MiB app budget preserves source width at preference ${preference}`);
  }

  const previousWorker = (globalThis as unknown as { Worker?: unknown }).Worker;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let fallbackStore: VerifiedSparsePcmStore | undefined;
  let fallbackLease: import("../src/stems/sparse-store.js").SparsePcmSessionLease | undefined;
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { deviceMemory: 2, hardwareConcurrency: 4 } });
    assert.equal(
      sparseResolverScheduling(createSparseStemResolver({ locate: base.locate, maximumWorkers: 2 }))?.concurrency,
      sparseResolverScheduling(createSparseStemResolver({ ...base, memoryBudgetBytes: 16 * 1024 * 1024 }))?.concurrency,
      "navigator device-memory default and explicit budget preserve source width",
    );
    (globalThis as unknown as { Worker?: unknown }).Worker = undefined;
    const noWorker = sparseResolverScheduling(createSparseStemResolver({ ...base, memoryBudgetBytes: 20 * 1024 * 1024 }));
    assert.equal(noWorker?.concurrency, 2, "missing Worker capability preserves the cold source width");
    const bytes = new Uint8Array([4, 5]);
    const expected = expectation(bytes, 1);
    fallbackStore = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "policy-missing-worker" });
    await fallbackStore.installSource(expected, { resolve: async () => ({ spans: spans({ startFrame: 0, bytes }) }) });
    const fallbackEvents: StemProgress[] = [];
    fallbackLease = await fallbackStore.openSession({
      leaseId: "policy-missing-worker",
      sources: [{ ...expected, sourceId: "source" }],
      resolve: createSparseStemResolver({ ...base, memoryBudgetBytes: 20 * 1024 * 1024 }),
      onProgress: (event) => fallbackEvents.push(event),
    });
    assert.equal(fallbackEvents.some((event) => event.verificationTiming !== undefined), true, "missing Worker capability takes the local verifier");
    assert.equal(fallbackEvents.filter((event) => event.stage === "ready").length, 1);
  } finally {
    await fallbackLease?.close().catch(() => undefined);
    await fallbackStore?.close().catch(() => undefined);
    (globalThis as unknown as { Worker?: unknown }).Worker = previousWorker;
    if (previousNavigator === undefined) Reflect.deleteProperty(globalThis, "navigator");
    else Object.defineProperty(globalThis, "navigator", previousNavigator);
  }
});

test("native resolver admits two warm and two cold sources with overlapping preparation", async () => {
  const previousWorker = (globalThis as unknown as { Worker?: unknown }).Worker;
  const previousFetch = globalThis.fetch;
  let store: VerifiedSparsePcmStore | undefined;
  let firstLease: Awaited<ReturnType<VerifiedSparsePcmStore["openSession"]>> | undefined;
  let secondLease: Awaited<ReturnType<VerifiedSparsePcmStore["openSession"]>> | undefined;
  MixedNativeWorker.pcmByIdentity.clear();
  MixedNativeWorker.warmStarts = 0;
  MixedNativeWorker.warmCompletions = 0;
  MixedNativeWorker.decodeStarts = 0;
  MixedNativeWorker.decodeCompletions = 0;
  MixedNativeWorker.warmConstructed = 0;
  MixedNativeWorker.warmTerminated = 0;
  MixedNativeWorker.warmLive = 0;
  MixedNativeWorker.warmPeak = 0;
  MixedNativeWorker.coldConstructed = 0;
  MixedNativeWorker.coldTerminated = 0;
  MixedNativeWorker.coldLive = 0;
  MixedNativeWorker.coldPeak = 0;
  MixedNativeWorker.firstDecodeHeld = false;
  MixedNativeWorker.secondWarmHeld = false;
  const WorkerBoundary = class {
    readonly #worker: MixedNativeWorker;
    constructor(url: string | URL) { this.#worker = new MixedNativeWorker(url); }
    postMessage(message: unknown, transfer?: Transferable[]): void { this.#worker.postMessage(message); void transfer; }
    terminate(): void { this.#worker.terminate(); }
    addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void { this.#worker.addEventListener(type, listener); }
    removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void { this.#worker.removeEventListener(type, listener); }
  };
  (globalThis as unknown as { Worker: typeof WorkerBoundary }).Worker = WorkerBoundary;
  const wasm = new Uint8Array(readFileSync("node_modules/@misofm/codec/wasm/flac-decoder.wasm"));
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("engine-web-flac-decoder.wasm")) return new Response(responseBytes(wasm), { status: 200, headers: { "Content-Type": "application/wasm" } });
    return previousFetch(input, init);
  }) as typeof globalThis.fetch;
  let holdColdB = false;
  let releaseHeldColdB: (() => void) | undefined;
  const releaseColdB = () => {
    holdColdB = false;
    const release = releaseHeldColdB;
    releaseHeldColdB = undefined;
    release?.();
  };
  try {
    const flac = new Uint8Array(readFileSync("tests/fixtures/native-multiblock-stereo24.flac"));
    const pcmA = multiblockPcm(72_000);
    const pcmB = pcmA.slice();
    pcmB[0] = (pcmB[0] ?? 0) ^ 1;
    const coldA: SparsePcmExpectation = { identity: identity(pcmA), sampleRateHz: 48_000, channels: 2, bitDepth: 24, frames: 72_000, canonicalBytes: pcmA.byteLength };
    const coldB: SparsePcmExpectation = { identity: identity(pcmB), sampleRateHz: 48_000, channels: 2, bitDepth: 24, frames: 72_000, canonicalBytes: pcmB.byteLength };
    MixedNativeWorker.pcmByIdentity.set(coldA.identity, pcmA);
    MixedNativeWorker.pcmByIdentity.set(coldB.identity, pcmB);
    const packages = new Map([
      ["cold-a", packageBody(flac, { expected: coldA, pcm: pcmA, packedFrames: coldA.frames }).body],
      ["cold-b", packageBody(flac, { expected: coldB, pcm: pcmB, packedFrames: coldB.frames }).body],
    ]);
    const warmABytes = new Uint8Array([1, 2]);
    const warmBBytes = new Uint8Array([3, 4]);
    const warmCBytes = new Uint8Array([5, 6]);
    const warmA = expectation(warmABytes, 1);
    const warmB = expectation(warmBBytes, 1);
    const warmC = expectation(warmCBytes, 1);
    const measuredIdentities = new Set<string>([coldA.identity, warmA.identity, warmB.identity, coldB.identity]);
    const activeSourceLocks = new Set<string>();
    let peakAdmittedSources = 0;
    holdColdB = true;
    const locks = {
      request: async <T>(name: string, _options: { readonly mode: "exclusive"; readonly signal?: AbortSignal }, callback: () => Promise<T>): Promise<T> => {
        const identityHex = name.startsWith("miso:engine-web:v1:stem:") ? name.slice("miso:engine-web:v1:stem:".length) : undefined;
        const identity = identityHex === undefined ? undefined : `blake3:${identityHex}`;
        if (identity !== undefined && measuredIdentities.has(identity)) {
          activeSourceLocks.add(identity);
          peakAdmittedSources = Math.max(peakAdmittedSources, activeSourceLocks.size);
        }
        if (identity === coldB.identity && holdColdB) {
          await new Promise<void>((resolve) => { releaseHeldColdB = resolve; });
        }
        try { return await callback(); }
        finally { if (identity !== undefined) activeSourceLocks.delete(identity); }
      },
    };
    store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), locks, instanceId: "native-mixed-admission" });
    await store.installSource(warmA, { resolve: async () => ({ spans: spans({ startFrame: 0, bytes: warmABytes }) }) });
    await store.installSource(warmB, { resolve: async () => ({ spans: spans({ startFrame: 0, bytes: warmBBytes }) }) });
    await store.installSource(warmC, { resolve: async () => ({ spans: spans({ startFrame: 0, bytes: warmCBytes }) }) });
    const resolver = createSparseStemResolver({
      locate: (sourceIdentity) => `https://fixture.invalid/${sourceIdentity === coldA.identity ? "cold-a" : "cold-b"}`,
      fetch: async (input) => {
        const body = packages.get(new URL(String(input)).pathname.slice(1));
        assert.ok(body);
        return new Response(responseBytes(body), { status: 200, headers: { "Content-Length": String(body?.byteLength ?? 0) } });
      },
      hardwareConcurrency: 4,
      maximumWorkers: 2,
      memoryBudgetBytes: 20 * 1024 * 1024,
    });
    assert.equal(sparseResolverScheduling(resolver)?.concurrency, 2);
    const firstEvents: StemProgress[] = [];
    const firstOpening = store.openSession({
      leaseId: "native-mixed-first",
      sources: [
        { ...coldA, sourceId: "cold-a" },
        { ...warmA, sourceId: "warm-a" },
        { ...warmB, sourceId: "warm-b" },
        { ...coldB, sourceId: "cold-b" },
      ],
      resolve: resolver,
      onProgress: (event) => firstEvents.push(event),
    });
    await waitFor(() => MixedNativeWorker.decodeStarts >= 1, 2_000);
    await waitFor(() => MixedNativeWorker.warmStarts >= 1, 2_000);
    const secondEvents: StemProgress[] = [];
    const secondOpening = store.openSession({
      leaseId: "native-mixed-overlap",
      sources: [{ ...warmC, sourceId: "warm-c" }],
      resolve: resolver,
      onProgress: (event) => secondEvents.push(event),
    });
    secondLease = await secondOpening;
    assert.ok(secondEvents.some((event) => event.stage === "verifying"), "the overlapping preparation uses local verification");
    await waitFor(() => MixedNativeWorker.warmStarts >= 2, 2_000);
    assert.equal(MixedNativeWorker.firstDecodeHeld, true, `one native cold decoder remains held across warm admission (decoders=${MixedNativeWorker.decodeStarts}, warms=${MixedNativeWorker.warmStarts})`);
    assert.equal(MixedNativeWorker.warmStarts, 2, "the overlapping preparation does not create another warm pool");
    MixedNativeWorker.releaseFirstDecode();
    await waitFor(() => releaseHeldColdB !== undefined, 2_000);
    await waitFor(() => firstEvents.some((event) => event.stage === "source-ready" && event.identity === coldA.identity), 2_000);
    assert.equal(MixedNativeWorker.firstDecode?.isAliveAndIdle(coldA.identity), true, "the completed cold-a decoder remains alive and idle while retained");
    assert.equal(MixedNativeWorker.warmCompletions, 1, "the second warm job is held until the first cold source preparation finishes");
    MixedNativeWorker.releaseSecondWarm();
    releaseColdB();
    firstLease = await firstOpening;
    const sourceWidth = sparseResolverScheduling(resolver)?.concurrency ?? 0;
    const policyProbe = sparseResolverScheduling(createSparseStemResolver({ locate: () => "https://fixture.invalid/native-mixed-policy", hardwareConcurrency: 4, maximumWorkers: 2, memoryBudgetBytes: 20 * 1024 * 1024 }));
    const probeClaim = policyProbe?.tryClaimWarmPreparation?.();
    const warmWidth = probeClaim?.width ?? 0;
    await probeClaim?.release();
    assert.equal(peakAdmittedSources, sourceWidth, "the first preparation reaches its observed native source-task bound");
    assert.equal(peakAdmittedSources <= sourceWidth, true, "observed source tasks stay within C");
    assert.equal(MixedNativeWorker.coldPeak <= sourceWidth, true, "observed cold physical workers stay within C");
    assert.equal(MixedNativeWorker.warmPeak <= warmWidth, true, "observed warm physical workers stay within K");
    assert.equal(MixedNativeWorker.warmConstructed, MixedNativeWorker.warmTerminated, "every warm Worker construction is terminated");
    assert.equal(MixedNativeWorker.coldConstructed, MixedNativeWorker.coldTerminated, "every cold Worker construction is terminated");
    assert.equal(MixedNativeWorker.coldPeak * 8 * 1024 * 1024 + MixedNativeWorker.warmPeak * 2 * 1024 * 1024 <= 20 * 1024 * 1024, true, "observed reservations fit the budget");
    assert.equal(firstEvents.filter((event) => event.stage === "ready").length, 1);
    assert.equal(secondEvents.filter((event) => event.stage === "ready").length, 1);
  } finally {
    releaseColdB();
    await firstLease?.close().catch(() => undefined);
    await secondLease?.close().catch(() => undefined);
    await store?.close().catch(() => undefined);
    (globalThis as unknown as { Worker?: unknown }).Worker = previousWorker;
    globalThis.fetch = previousFetch;
  }
});

test("successful sparse progress flushes its latest coalesced boundary before close", () => {
  const identity = `blake3:${"c".repeat(64)}` as const;
  const observed: Array<StemProgress & { readonly bytes: number }> = [];
  const reporter = sparseProgressReporter((event) => {
    if ("bytes" in event) observed.push(event);
  }, identity);
  const event = (bytes: number): StemProgress => ({
    stage: "decoding", identity, bytes, totalBytes: 100_000, byteKind: "pcm",
  });
  reporter.emit(event(10_000));
  reporter.emit(event(20_000));
  reporter.emit(event(21_000));
  assert.deepEqual(observed.map((progress) => progress.bytes), [10_000, 20_000]);
  reporter.flush();
  assert.deepEqual(observed.map((progress) => progress.bytes), [10_000, 20_000, 21_000]);
  reporter.close();
  reporter.emit(event(22_000));
  reporter.flush();
  assert.deepEqual(observed.map((progress) => progress.bytes), [10_000, 20_000, 21_000]);
});

test("successful sparse progress forces a boundary through an outer coalescer", () => {
  const identity = `blake3:${"d".repeat(64)}` as const;
  const observed: number[] = [];
  const outer = sparseProgressReporter((event) => {
    if (event.stage === "decoding" && "bytes" in event) observed.push(event.bytes);
  });
  const inner = sparseProgressReporter(outer.emit, identity);
  const event = (bytes: number): StemProgress => ({
    stage: "decoding", identity, bytes, totalBytes: 100_000, byteKind: "pcm",
  });
  const clock = [0, 10, 20, 30, 70, 70.1];
  let clockIndex = 0;
  Object.defineProperty(performance, "now", {
    configurable: true,
    value: () => clock[Math.min(clockIndex++, clock.length - 1)],
  });
  try {
    inner.emit(event(10_000));
    inner.emit(event(20_000));
    // The inner reporter delivers this after its 50 ms boundary, while the
    // outer reporter coalesces it at its own clock position.
    inner.emit(event(21_000));
    inner.emitForced(event(21_000));
    assert.deepEqual(observed, [10_000, 20_000, 21_000]);
    inner.close();
    outer.close();
  } finally {
    Reflect.deleteProperty(performance, "now");
  }
});

test("native decoder asset loading is bounded by the decoder progress deadline", async () => {
  const pcm = new Uint8Array([1, 2]);
  const expected: SparsePcmExpectation = {
    identity: identity(pcm),
    sampleRateHz: 48_000,
    channels: 1,
    bitDepth: 16,
    frames: 1,
    canonicalBytes: pcm.byteLength,
  };
  const packed = packageBody(new Uint8Array([0]), { expected, pcm, packedFrames: 1 });
  const originalFetch = globalThis.fetch;
  let moduleFetches = 0;
  globalThis.fetch = (async () => {
    moduleFetches += 1;
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  try {
    const resolver = createSparseStemResolver({
      locate: () => "https://fixture.invalid/module-timeout",
      fetch: async () => new Response(responseBytes(packed.body), {
        status: 200,
        headers: { "Content-Length": String(packed.body.byteLength) },
      }),
      decodeNoProgressMs: 10,
    });
    const resolved = await resolver(expected, new AbortController().signal);
    const iterator = resolved.spans[Symbol.asyncIterator]();
    let settled = false;
    const next = iterator.next().finally(() => { settled = true; });
    const outcome = await Promise.race([
      next.then(() => "settled" as const, () => "settled" as const),
      new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 100)),
    ]);
    assert.equal(outcome, "settled", "module acquisition must not outrun the decoder watchdog");
    assert.equal(settled, true);
    await assert.rejects(next, (error: unknown) => {
      if (!(error instanceof EngineWebAdapterError)) return false;
      assert.equal(error.code, "stem.decode.stall");
      assert.equal(error.details.phase, "decoder-load");
      assert.equal(error.details.milliseconds, 10);
      return true;
    });
    assert.equal(moduleFetches, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("operation abort reaches an executing full fetch and waits for its physical settlement", async () => {
  const packed = emptySilentPackage();
  let started!: () => void;
  let settle!: (response: Response) => void;
  let fetchSignal: AbortSignal | undefined;
  const fetchStarted = new Promise<void>(resolve => { started = resolve; });
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/pending",
    fetch: async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      started();
      return new Promise<Response>(resolve => { settle = resolve; });
    },
    createWorker: () => { throw new Error("pending header must not create a decoder worker"); },
  });
  const operation = new AbortController();
  const iterator = (await resolver(packed.expected, operation.signal)).spans[Symbol.asyncIterator]();
  let nextSettled = false;
  const next = iterator.next().finally(() => { nextSettled = true; });
  await fetchStarted;
  operation.abort(new Error("caller operation stopped"));
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  assert.equal(fetchSignal?.aborted, true);
  assert.equal(nextSettled, false);
  settle(new Response(responseBytes(packed.body), { status: 200 }));
  await assert.rejects(next, (error: unknown) => error instanceof Error && "code" in error &&
    (error as { readonly code?: unknown }).code === "stem.cancelled");
});

test("operation abort reaches a pending locator and waits for its settlement", async () => {
  const packed = emptySilentPackage();
  let locateSignal: AbortSignal | undefined;
  let started!: () => void;
  let settle!: (location: string) => void;
  const locatorStarted = new Promise<void>(resolve => { started = resolve; });
  const resolver = createSparseStemResolver({
    locate: (_identity, { signal }) => {
      locateSignal = signal;
      started();
      return new Promise<string>(resolve => { settle = resolve; });
    },
    fetch: async () => { throw new Error("locator should be settled before fetch"); },
    createWorker: () => { throw new Error("pending locator must not create a decoder worker"); },
  });
  const operation = new AbortController();
  const iterator = (await resolver(packed.expected, operation.signal)).spans[Symbol.asyncIterator]();
  let nextSettled = false;
  const next = iterator.next().finally(() => { nextSettled = true; });
  await locatorStarted;
  operation.abort(new Error("caller operation stopped before location"));
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  assert.equal(locateSignal?.aborted, true);
  assert.equal(nextSettled, false);
  settle("https://fixture.invalid/settled");
  await assert.rejects(next, (error: unknown) => error instanceof Error && "code" in error &&
    (error as { readonly code?: unknown }).code === "stem.cancelled");
});

test("return during a pending full fetch retains admission and cancels a late response body", async () => {
  const packed = emptySilentPackage();
  let started!: () => void;
  let settle!: (response: Response) => void;
  let cancelled = 0;
  const fetchStarted = new Promise<void>(resolve => { started = resolve; });
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/late",
    fetch: async () => {
      started();
      return new Promise<Response>(resolve => { settle = resolve; });
    },
    createWorker: () => { throw new Error("pending header must not create a decoder worker"); },
  });
  const iterator = (await resolver(packed.expected, new AbortController().signal)).spans[Symbol.asyncIterator]();
  const next = iterator.next().catch(() => ({ done: true as const, value: undefined }));
  await fetchStarted;
  let returned = false;
  const returning = iterator.return!().then(() => { returned = true; });
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  assert.equal(returned, false);
  settle(new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(packed.body); },
    cancel() { cancelled += 1; },
  }), { status: 200 }));
  await returning;
  await next;
  assert.equal(cancelled, 1);
});

test("status refusal owns and cancels the response body before releasing admission", async () => {
  const packed = emptySilentPackage();
  let cancelled = 0;
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/refused",
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(packed.body); },
      cancel() { cancelled += 1; },
    }), { status: 206 }),
    createWorker: () => { throw new Error("status-refused source must not create a decoder worker"); },
  });
  const iterator = (await resolver(packed.expected, new AbortController().signal)).spans[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), (error: unknown) => error instanceof Error && "code" in error &&
    (error as { readonly code?: unknown }).code === "stem.delivery.http");
  assert.equal(cancelled, 1);
});

test("asset URL and worker hook are snapshotted together at resolver construction", async () => {
  const flac = new Uint8Array(readFileSync("tests/fixtures/native-silence.flac"));
  const packed = packageBody(flac);
  let seenUrl = "";
  const mutableAssets = {
    flacWorkerUrl: "https://fixture.invalid/original-worker",
    createWorker: (url: string | URL) => {
      seenUrl = String(url);
      return new DecodeWorker() as unknown as Worker;
    },
  };
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/snapshot",
    fetch: async () => new Response(responseBytes(packed.body), { status: 200 }),
    assets: mutableAssets,
  });
  mutableAssets.flacWorkerUrl = "https://fixture.invalid/mutated-worker";
  mutableAssets.createWorker = () => { throw new Error("mutated worker hook was used"); };
  const result = await resolver(packed.expected, new AbortController().signal);
  assert.equal((await result.spans[Symbol.asyncIterator]().next()).done, false);
  assert.equal(seenUrl, "https://fixture.invalid/original-worker");
});

test("resolver option accessors are read once into the validated snapshot", async () => {
  const packed = emptySilentPackage();
  let locateReads = 0;
  let deadlineReads = 0;
  let selectedLocate: (() => string) = () => "https://fixture.invalid/accessor";
  let selectedDeadline = 1000;
  const options = {
    get locate() { locateReads += 1; return selectedLocate; },
    get readDeadlineMs() { deadlineReads += 1; return selectedDeadline; },
    fetch: async () => new Response(responseBytes(packed.body), { status: 200 }),
    createWorker: () => { throw new Error("accessor source must remain all-silent"); },
  };
  const resolver = createSparseStemResolver(options);
  selectedLocate = () => { throw new Error("mutated locator was used"); };
  selectedDeadline = 0;
  assert.equal(locateReads, 1);
  assert.equal(deadlineReads, 1);
  const result = await resolver(packed.expected, new AbortController().signal);
  assert.equal((await result.spans[Symbol.asyncIterator]().next()).done, true);
});

test("physical cleanup remains the public primary while the operation cause stays referenced", async () => {
  const packed = emptySilentPackage();
  const cleanup = new EngineWebAdapterError("stem.delivery.stall", "physical cleanup sentinel", { cleanup: true, retryable: false });
  let cancels = 0;
  const malformed = packed.body.slice();
  malformed[0] = 0;
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/cleanup",
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(malformed); },
      cancel() { cancels += 1; throw cleanup; },
    }), { status: 200 }),
    createWorker: () => { throw new Error("malformed source must not create a decoder worker"); },
  });
  const iterator = (await resolver(packed.expected, new AbortController().signal)).spans[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), (error: unknown) => {
    if (!(error instanceof EngineWebAdapterError)) return false;
    assert.equal(error.code, cleanup.code);
    assert.deepEqual(error.details, cleanup.details);
    assert.equal(error.cause instanceof AggregateError, true);
    return true;
  });
  assert.equal(cancels, 1);
});

test("finite FLAC metadata truncation refuses before the private chunk completes", async () => {
  const flac = new Uint8Array(readFileSync("tests/fixtures/native-silence.flac"));
  const packed = packageBody(flac);
  const manifestBytes = new DataView(packed.body.buffer, packed.body.byteOffset, packed.body.byteLength).getUint32(8, true);
  const metadataOnly = packed.body.slice(0, 16 + manifestBytes + 42);
  await expectFullResponseFailure(packed, () => new Response(metadataOnly, { status: 200 }), "stem.delivery.range", () => new DecodeWorker());
});

test("finite encoded extent and host digest remain mandatory after PCM output", async () => {
  const flac = new Uint8Array(readFileSync("tests/fixtures/native-silence.flac"));
  const packed = packageBody(flac);
  const mutated = packed.body.slice();
  mutated[mutated.length - 1]! ^= 1;
  let fetches = 0;
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/indexed",
    fetch: async () => { fetches += 1; return new Response(responseBytes(mutated), { status: 200 }); },
    createWorker: () => new DecodeWorker(),
  });
  const resolved = await resolver(packed.expected, new AbortController().signal);
  const iterator = resolved.spans[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  await assert.rejects(iterator.next(), (error: unknown) => error instanceof Error && "code" in error &&
    (error as { readonly code?: unknown }).code === "stem.decode.worker");
  assert.equal(fetches, 1);
});

test("a missing Content-Length and a default reader with a large backing remain valid", async () => {
  const packed = emptySilentPackage();
  let fetches = 0;
  const backing = new Uint8Array(2 * 1024 * 1024);
  backing.set(packed.body);
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/indexed",
    fetch: async () => {
      fetches += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(backing.buffer, 0, packed.body.byteLength));
          controller.close();
        },
      }), { status: 200 });
    },
    createWorker: () => { throw new Error("all-silent source must not create a decoder worker"); },
  });
  const resolved = await resolver(packed.expected, new AbortController().signal);
  const result = await resolved.spans[Symbol.asyncIterator]().next();
  assert.equal(result.done, true);
  assert.equal(fetches, 1);
});

test("a later BYOB read failure is terminal and never retries with a default reader", async () => {
  const packed = emptySilentPackage();
  let pulls = 0;
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/indexed",
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      type: "bytes",
      pull(controller) {
        pulls += 1;
        controller.error(new Error("BYOB read sentinel"));
      },
    }), { status: 200 }),
    createWorker: () => { throw new Error("failed source must not create a decoder worker"); },
  });
  const resolved = await resolver(packed.expected, new AbortController().signal);
  await assert.rejects(resolved.spans[Symbol.asyncIterator]().next(), (error: unknown) => error instanceof Error && "code" in error &&
    (error as { readonly code?: unknown }).code === "stem.delivery.http");
  assert.equal(pulls, 1);
});

test("BYOB terminal nonempty views are consumed, while undefined termination refuses", async () => {
  const packed = emptySilentPackage();
  const nonemptyResolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/indexed",
    fetch: async () => responseWithByobTerminal({ done: true, value: new Uint8Array(packed.body) }),
    createWorker: () => { throw new Error("all-silent source must not create a decoder worker"); },
  });
  const resolved = await nonemptyResolver(packed.expected, new AbortController().signal);
  assert.equal((await resolved.spans[Symbol.asyncIterator]().next()).done, true);

  const undefinedResolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/indexed",
    fetch: async () => responseWithByobTerminal({ done: true, value: undefined }),
    createWorker: () => { throw new Error("undefined BYOB termination must not create a decoder worker"); },
  });
  const undefinedResolved = await undefinedResolver(packed.expected, new AbortController().signal);
  await assert.rejects(undefinedResolved.spans[Symbol.asyncIterator]().next(), (error: unknown) => error instanceof Error && "code" in error &&
    (error as { readonly code?: unknown }).code === "stem.delivery.range");
});

test("a real byte response can install an all-silent sparse source without a decoder worker", async () => {
  const packed = emptySilentPackage();
  const backend = new MemoryStemStorageBackend();
  const store = new VerifiedSparsePcmStore({ backend, instanceId: "sparse-byte-eof" });
  let requests = 0;
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/silent",
    fetch: async () => {
      requests += 1;
      return new Response(packed.body.buffer as ArrayBuffer, { status: 200, headers: { "Content-Length": String(packed.body.byteLength) } });
    },
    createWorker: () => { throw new Error("all-silent source must not create a decoder worker"); },
  });
  const result = await store.installSource(packed.expected, { resolve: signal => resolver(packed.expected, signal) });
  assert.equal(requests, 1);
  assert.equal(result.data.size, 0);
  assert.equal(result.index.activeBytes, 0);
  assert.equal(result.index.canonicalBytes, packed.expected.canonicalBytes);
  await store.close();
});

test("sparse full GET installs an actual FLAC payload cold and resolves warm without transport or workers", async () => {
  const flac = new Uint8Array(readFileSync("tests/fixtures/native-silence.flac"));
  const packed = packageBody(flac);
  const backend = new MemoryStemStorageBackend();
  const store = new VerifiedSparsePcmStore({ backend, instanceId: "sparse-full-get" });
  let fetches = 0;
  let workers = 0;
  let locates = 0;
  const resolver = createSparseStemResolver({
    locate(identity, { signal }) {
      locates += 1;
      assert.equal(identity, packed.expected.identity);
      assert.equal(signal.aborted, false);
      return new Request("https://caller.invalid/full-stem", {
        headers: { Authorization: "Bearer caller", Range: "bytes=wrong", "If-Range": "wrong" },
      });
    },
    fetch: async (_input, init) => {
      fetches += 1;
      assert.equal(new Headers(init?.headers).get("Range"), null);
      assert.equal(new Headers(init?.headers).get("If-Range"), null);
      const pieces = [packed.body.slice(0, 7), packed.body.slice(7, 53), packed.body.slice(53)];
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const piece = pieces.shift();
          if (piece === undefined) controller.close(); else controller.enqueue(piece);
        },
      }), { status: 200, headers: { "Content-Length": String(packed.body.byteLength) } });
    },
    createWorker: () => { workers += 1; return new DecodeWorker(); },
    hardwareConcurrency: 2,
  });
  const progress: import("../src/stems/types.js").StemProgress[] = [];
  const cold = await store.installSource(packed.expected, {
    resolve: (signal, context) => resolver(packed.expected, signal, context),
    onProgress: (event) => progress.push(event),
  });
  assert.equal(cold.data.size, packed.expected.canonicalBytes);
  assert.equal(cold.index.activeBytes, packed.expected.canonicalBytes);
  assert.equal(fetches, 1);
  assert.equal(locates, 1);
  assert.equal(workers, 1);
  const probing = progress.filter((event): event is StemProgress & { readonly stage: "probing" } => event.stage === "probing");
  const fetching = progress.filter((event): event is StemProgress & { readonly stage: "fetching" } => event.stage === "fetching");
  assert.ok(probing.length > 0);
  assert.ok(fetching.length > 0);
  const finalFetching = fetching.at(-1);
  assert.equal(finalFetching?.byteKind, "flac");
  assert.equal(finalFetching?.bytes, packed.body.byteLength);
  assert.equal(finalFetching?.totalBytes, packed.body.byteLength);
  const decoding = progress.filter((event): event is StemProgress & { readonly stage: "decoding" } => event.stage === "decoding");
  assert.ok(decoding.length > 0);
  assert.equal(decoding.at(-1)?.bytes, packed.expected.canonicalBytes);
  assert.equal(decoding.at(-1)?.totalBytes, packed.expected.canonicalBytes);

  let warmResolverCalls = 0;
  const warm = await store.installSource(packed.expected, {
    resolve: async () => { warmResolverCalls += 1; throw new Error("warm sparse resolver must not run"); },
  });
  assert.equal(warmResolverCalls, 0);
  assert.equal(warm.data.size, packed.expected.canonicalBytes);
  assert.equal(fetches, 1);
  assert.equal(locates, 1);
  assert.equal(workers, 1);
  await store.close();
});

test("sparse decoding flushes the final active PCM boundary below the canonical total", async () => {
  const flac = new Uint8Array(readFileSync("tests/fixtures/native-silence.flac"));
  const paddedFlac = padSilenceFlac(flac, 17);
  const activeFrames = 2_048;
  const canonicalFrames = 50_000;
  const frameBytes = 2;
  const activePcm = new Uint8Array(activeFrames * frameBytes);
  const canonicalPcm = new Uint8Array(canonicalFrames * frameBytes);
  const expected: SparsePcmExpectation = {
    identity: identity(canonicalPcm),
    sampleRateHz: 48_000,
    channels: 1,
    bitDepth: 16,
    frames: canonicalFrames,
    canonicalBytes: canonicalPcm.byteLength,
  };
  const chunks = [flac, paddedFlac];
  let offset = 0;
  const manifest = {
    format: "miso_sparse_stem_v1" as const,
    identity: expected.identity,
    sampleRateHz: expected.sampleRateHz,
    channels: expected.channels,
    bitDepth: expected.bitDepth,
    frames: expected.frames,
    intervals: [
      { startFrame: 0, frames: activeFrames, packedFrameOffset: 0 },
      { startFrame: 40_000, frames: activeFrames, packedFrameOffset: activeFrames },
    ],
    chunks: chunks.map((chunk, index) => {
      const chunkOffset = offset;
      offset += chunk.byteLength;
      return {
        offset: chunkOffset,
        bytes: chunk.byteLength,
        frames: activeFrames,
        packedStartFrame: index * activeFrames,
        flacSha256: createHash("sha256").update(chunk).digest("hex"),
        pcmSha256: createHash("sha256").update(activePcm).digest("hex"),
      };
    }),
  };
  const encoded = serializeSparseStemIndex(manifest);
  const header = new Uint8Array(16);
  header.set(new TextEncoder().encode("MISOSTM1"));
  new DataView(header.buffer).setUint32(8, encoded.byteLength, true);
  const body = new Uint8Array([...header, ...encoded, ...chunks.flatMap((chunk) => [...chunk])]);
  const events: StemProgress[] = [];
  const store = new VerifiedSparsePcmStore({ backend: new MemoryStemStorageBackend(), instanceId: "decode-final-boundary" });
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/decode-final-boundary",
    fetch: async () => new Response(responseBytes(body), { status: 200, headers: { "Content-Length": String(body.byteLength) } }),
    createWorker: () => new DecodeWorker(),
  });
  await store.installSource(expected, {
    resolve: (signal, context) => resolver(expected, signal, context),
    onProgress: (event) => events.push(event),
  });
  const decoding = events.filter((event): event is StemProgress & { readonly stage: "decoding" } => event.stage === "decoding");
  assert.ok(decoding.length > 0);
  assert.equal(decoding.at(-1)?.bytes, activePcm.byteLength * chunks.length);
  assert.equal(decoding.at(-1)?.totalBytes, expected.canonicalBytes);
  assert.ok(decoding.every((event, index) => index === 0 || event.bytes > decoding[index - 1]!.bytes));
  await store.close();
});

test("a real stereo24 block stays borrowed across mapper slices and an indexed gap while store write is deferred", async () => {
  const flac = new Uint8Array(readFileSync("tests/fixtures/native-multiblock-stereo24.flac"));
  const packedFrames = 72_000;
  const timelineFrames = 81_600;
  const packed = multiblockPcm(packedFrames);
  assert.equal(createHash("sha256").update(packed).digest("hex"), "4b5bc724ea7d855b3b5518b7a5e4da7222a41b9d0c98ca42880ca37e7458654d");
  const canonical = new Uint8Array(timelineFrames * 6);
  canonical.set(packed.subarray(0, 86_400), 0);
  canonical.set(packed.subarray(86_400), 24_000 * 6);
  const expected: SparsePcmExpectation = {
    identity: identity(canonical),
    sampleRateHz: 48_000,
    channels: 2,
    bitDepth: 24,
    frames: timelineFrames,
    canonicalBytes: canonical.byteLength,
  };
  const packageBytes = packageBody(flac, {
    expected,
    pcm: packed,
    packedFrames,
    intervals: [
      { startFrame: 0, frames: 14_400, packedFrameOffset: 0 },
      { startFrame: 24_000, frames: packedFrames - 14_400, packedFrameOffset: 14_400 },
    ],
  });
  const backend = new DeferredFirstWriteBackend();
  const store = new VerifiedSparsePcmStore({ backend, instanceId: "sparse-deferred-multiblock" });
  const workers: DecodeWorker[] = [];
  let requests = 0;
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/multiblock",
    fetch: async () => {
      requests += 1;
      return new Response(responseBytes(packageBytes.body), { status: 200, headers: { "Content-Length": String(packageBytes.body.byteLength) } });
    },
    decodeNoProgressMs: 5,
    createWorker: () => {
      const worker = new DecodeWorker(packed);
      workers.push(worker);
      return worker;
    },
  });
  const installing = store.installSource(expected, { resolve: signal => resolver(expected, signal) });
  let completed = false;
  void installing.then(() => { completed = true; }, () => { completed = true; });
  for (let attempt = 0; attempt < 200 && backend.writes === 0; attempt += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  if (backend.writes === 0) await installing;
  assert.equal(backend.writes, 1);
  assert.deepEqual(await backend.list(), []);
  assert.equal(workers.length, 1);
  assert.equal(workers[0]!.posted.filter(message => message.type === "output-credit").length, 0);
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.equal(completed, false);

  backend.releaseFirstWrite();
  const result = await installing;
  assert.equal(requests, 1);
  assert.equal(result.index.activeBytes, packed.byteLength);
  assert.equal(result.index.canonicalBytes, canonical.byteLength);
  assert.deepEqual(new Uint8Array(await result.data.arrayBuffer()), packed);
  assert.equal(workers[0]!.posted.filter(message => message.type === "output-credit").length, 1);
  await store.close();
});

test("store cancellation settles a pending BYOB read before cleanup", async () => {
  const packed = emptySilentPackage();
  const backend = new MemoryStemStorageBackend();
  const store = new VerifiedSparsePcmStore({ backend, instanceId: "sparse-byob-cancel" });
  let started!: () => void;
  let resolveRead!: (result: ReadableStreamReadResult<Uint8Array>) => void;
  let cancelled = 0;
  const readStarted = new Promise<void>(resolve => { started = resolve; });
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/pending-byob",
    fetch: async () => {
      const response = new Response(null, { status: 200 });
      const body = {
        locked: false,
        getReader: () => ({
          read: () => {
            started();
            return new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => { resolveRead = resolve; });
          },
          cancel: async () => {
            cancelled += 1;
            resolveRead({ done: true, value: new Uint8Array() });
          },
          releaseLock: () => {},
        }),
      };
      Object.defineProperty(response, "body", { value: body });
      return response;
    },
    createWorker: () => { throw new Error("pending body must not create a decoder worker"); },
  });
  const operation = new AbortController();
  const installing = store.installSource(packed.expected, { signal: operation.signal, resolve: signal => resolver(packed.expected, signal) });
  await readStarted;
  operation.abort(new Error("store cancellation"));
  await assert.rejects(installing, (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.cancelled");
  assert.equal(cancelled, 1);
  assert.deepEqual(await backend.list(), []);
  await store.close();
});

test("quota failure leaves a prior cache intact and the same resolver safely reuses admission", async () => {
  const oldBytes = new Uint8Array([1, 2, 3, 4]);
  const oldExpected: SparsePcmExpectation = {
    identity: identity(oldBytes),
    sampleRateHz: 48_000,
    channels: 1,
    bitDepth: 16,
    frames: 2,
    canonicalBytes: oldBytes.byteLength,
  };
  const backend = new MemoryStemStorageBackend();
  const store = new VerifiedSparsePcmStore({ backend, instanceId: "sparse-quota-reuse" });
  await store.installSource(oldExpected, {
    resolve: async () => ({ spans: (async function* () { yield { startFrame: 0, bytes: oldBytes }; })() }),
  });
  const prior = new Map([...backend.files].map(([name, bytes]) => [name, bytes.slice()]));
  const packed = emptySilentPackage();
  let fetches = 0;
  const resolver = createSparseStemResolver({
    locate: () => "https://fixture.invalid/quota",
    fetch: async () => {
      fetches += 1;
      return new Response(responseBytes(packed.body), { status: 200, headers: { "Content-Length": String(packed.body.byteLength) } });
    },
    createWorker: () => { throw new Error("all-silent quota source must not create a decoder worker"); },
  });
  backend.quotaBytes = (await backend.estimate()).usage;
  await assert.rejects(
    store.installSource(packed.expected, { resolve: signal => resolver(packed.expected, signal) }),
    (error: unknown) => error instanceof EngineWebAdapterError && error.code === "stem.quota",
  );
  assert.deepEqual([...backend.files], [...prior]);

  backend.quotaBytes = undefined;
  const recovered = await store.installSource(packed.expected, { resolve: signal => resolver(packed.expected, signal) });
  assert.equal(fetches, 2);
  assert.equal(recovered.index.activeBytes, 0);
  for (const [name, bytes] of prior) assert.deepEqual(backend.files.get(name), bytes);
  await store.close();
});

test("a locator Request abort composes with the resolver signal during the one full response", async () => {
  const flac = new Uint8Array(readFileSync("tests/fixtures/native-silence.flac"));
  const packed = packageBody(flac);
  const requestAbort = new AbortController();
  let fetchSignal: AbortSignal | undefined;
  let workers = 0;
  const resolver = createSparseStemResolver({
    locate: () => new Request("https://caller.invalid/full-stem", { signal: requestAbort.signal }),
    fetch: async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      let cancelled = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              if (!cancelled) { controller.enqueue(packed.body); controller.close(); }
              resolve();
            }, 100);
          });
        },
        cancel() { cancelled = true; },
      }), { status: 200 });
    },
    createWorker: () => { workers += 1; return new DecodeWorker(); },
    hardwareConcurrency: 2,
  });
  const resolved = await resolver(packed.expected, new AbortController().signal);
  const next = resolved.spans[Symbol.asyncIterator]().next();
  setTimeout(() => requestAbort.abort(new Error("caller stopped")), 5);
  await assert.rejects(next, (error: unknown) => error instanceof Error && "code" in error && (error as { readonly code?: unknown }).code === "stem.cancelled");
  assert.equal(workers, 0);
  assert.equal(fetchSignal?.aborted, true);
});
