import { Cause, Effect, Layer, Stream } from "effect";
import {
  decodeFlac,
  FlacDecoder,
  PcmFormat,
  type FlacDecodeComplete,
  type FlacDecodeEvent,
} from "@misofm/codec";

import { IncrementalSha256 } from "../stems/sha256.js";
import { EngineWebAdapterError } from "../errors.js";
import { FlacInputSlotConsumer, FLAC_INPUT_SLOT_BYTES, type FlacInputReadResult, type FlacInputSlotBuffers } from "../stems/flac-input-slot.js";
import { FlacOutputCredits } from "../stems/flac-output-credits.js";
import { loadFlacDecoderModule, mapFlacDecodeError } from "../stems/native-flac-decoder.js";
import type { NativeFlacStreamInfo } from "../stems/native-flac-metadata.js";
import type { FlacWorkerRequest, FlacWorkerResponse } from "../stems/flac-worker-protocol.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<FlacWorkerRequest>) => void) | null;
  postMessage(message: FlacWorkerResponse, transfer?: Transferable[]): void;
  close?: () => void;
}

const scope = ((globalThis as unknown as { readonly self?: WorkerScope }).self ?? globalThis) as unknown as WorkerScope;
let active = 0;
let credits: FlacOutputCredits | undefined;
let hash: IncrementalSha256 | undefined;
let decoderModule: WebAssembly.Module | undefined;
let inputSlot: FlacInputSlotBuffers | undefined;
let loadController: AbortController | undefined;
let decodingStarted = false;
let runnable: Int32Array | undefined;
let processing = false;
let runnableMask = 0;
let inputWaitStart = 0;
let inputWaitMs = 0;

function setRunnable(value: boolean): void {
  if (runnable === undefined || processing === value) { processing = value; return; }
  processing = value;
  if (!value) { Atomics.and(runnable, 0, ~runnableMask); return; }
  let bits = (Atomics.or(runnable, 0, runnableMask) | runnableMask) >>> 0;
  let count = 0;
  while (bits !== 0) { count += 1; bits = (bits & (bits - 1)) >>> 0; }
  let peak = Atomics.load(runnable, 1);
  while (count > peak) {
    const observed = Atomics.compareExchange(runnable, 1, peak, count);
    if (observed === peak) break;
    peak = observed;
  }
}

function clearJobState(): void {
  setRunnable(false);
  active = 0;
  credits = undefined;
  hash = undefined;
  decoderModule = undefined;
  inputSlot = undefined;
  loadController = undefined;
  decodingStarted = false;
  runnable = undefined;
  runnableMask = 0;
  processing = false;
  inputWaitStart = 0;
  inputWaitMs = 0;
}

function serialize(error: unknown): Extract<FlacWorkerResponse, { type: "error" }>['error'] {
  if (error instanceof Error) {
    const record = error as Error & { readonly code?: unknown; readonly details?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      ...(typeof record.details === "object" && record.details !== null ? { details: record.details as Readonly<Record<string, unknown>> } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function fail(error: unknown): void {
  const requestId = active;
  if (requestId === 0) return;
  setRunnable(false);
  try {
    if (!credits?.cancelled) {
      try { scope.postMessage({ type: "error", requestId, error: serialize(mapFlacDecodeError(error)) }); }
      catch { /* a reply clone failure still poisons this realm */ }
    }
  } finally {
    clearJobState();
    scope.close?.();
  }
}

function inputStream(streamInfo: NativeFlacStreamInfo, consumer: FlacInputSlotConsumer): Stream.Stream<Uint8Array, EngineWebAdapterError> {
  let descriptionPending = true;
  // The public codec consumes a Uint8Array source element asynchronously. It
  // copies each element into its fixed Wasm memory before requesting another;
  // retain one reusable bounded bridge buffer instead of allocating per pull.
  const target = new Uint8Array(FLAC_INPUT_SLOT_BYTES);
  const pull: Effect.Effect<readonly [Uint8Array], EngineWebAdapterError | Cause.Done<void>> = Effect.suspend(() => {
    if (descriptionPending) {
      descriptionPending = false;
      return Effect.succeed([streamInfo.decoderDescription] as readonly [Uint8Array]);
    }
    const read: Effect.Effect<FlacInputReadResult, EngineWebAdapterError> = Effect.try({
      try: () => consumer.read(target),
      catch: (cause) => new EngineWebAdapterError("stem.decode.worker", "FLAC input slot read failed", { phase: "frame" }, cause),
    });
    return read.pipe(Effect.flatMap((result): Effect.Effect<readonly [Uint8Array], EngineWebAdapterError | Cause.Done<void>> => {
      if (result.type === "aborted") {
        return Effect.fail(new EngineWebAdapterError("stem.cancelled", "FLAC input slot was aborted"));
      }
      if (result.type === "eof") return Cause.done();
      // The slot is fixed and reused by the host. The codec has consumed this
      // view before the next source pull mutates the bridge buffer.
      return Effect.succeed([target.subarray(0, result.bytes)] as readonly [Uint8Array]);
    }));
  });
  return Stream.fromPull(Effect.succeed(pull));
}

function decodeJob(options: {
  readonly module: WebAssembly.Module;
  readonly inputSlot: FlacInputSlotBuffers;
  readonly streamInfo: NativeFlacStreamInfo;
  readonly expectedFrames: number;
  readonly totalPcmBytes: number;
  readonly requestId: number;
}): Promise<Readonly<{ pcmBytes: number; frames: number; digest?: string; metrics: { readonly decodeMs: number; readonly hashMs: number; readonly inputWaitMs: number; readonly outputWaitMs: number; readonly blocks: number } }>> {
  const consumer = new FlacInputSlotConsumer(options.inputSlot, () => {
    scope.postMessage({
      type: "input-credit",
      requestId: options.requestId,
      maximumBytes: FLAC_INPUT_SLOT_BYTES,
      phase: "audio",
      phaseBytesRemaining: 0,
    });
  }, (waiting) => {
    if (waiting) {
      inputWaitStart = performance.now();
      setRunnable(false);
    } else {
      inputWaitMs += Math.max(0, performance.now() - inputWaitStart);
      setRunnable(true);
    }
  });

  let decodedBytes = 0;
  let decodedFrames = 0;
  let metadataSeen = false;
  let completed: FlacDecodeComplete | undefined;
  let decodeMs = 0;
  let hashMs = 0;
  let outputWaitMs = 0;
  let blocks = 0;
  const expectedFormat = new PcmFormat({
    sampleRate: options.streamInfo.sampleRateHz,
    channels: options.streamInfo.channels,
    bitsPerSample: options.streamInfo.bitDepth,
  });
  const source = inputStream(options.streamInfo, consumer);
  const consume = (event: FlacDecodeEvent) => Effect.gen(function* () {
    if (event._tag === "Metadata") {
      metadataSeen = true;
      if (event.format.sampleRate !== expectedFormat.sampleRate || event.format.channels !== expectedFormat.channels ||
          event.format.bitsPerSample !== expectedFormat.bitsPerSample ||
          (event.totalFrames !== undefined && event.totalFrames !== BigInt(options.expectedFrames))) {
        return yield* Effect.fail(new EngineWebAdapterError("stem.decode.flac", "Codec metadata disagrees with host STREAMINFO", { phase: "metadata" }));
      }
      setRunnable(true);
      return;
    }
    if (event._tag === "Pcm") {
      if (!metadataSeen || event.format.sampleRate !== expectedFormat.sampleRate || event.format.channels !== expectedFormat.channels ||
          event.format.bitsPerSample !== expectedFormat.bitsPerSample || event.bytes.byteLength < 1 ||
          event.bytes.byteLength > 384 * 1024 || event.frames < 1 ||
          event.bytes.byteLength !== event.frames * expectedFormat.channels * (expectedFormat.bitsPerSample / 8)) {
        return yield* Effect.fail(new EngineWebAdapterError("stem.decode.output", "Codec produced an invalid canonical PCM block", { phase: "frame" }));
      }
      setRunnable(false);
      const waitStart = performance.now();
      const granted = yield* Effect.tryPromise({
        try: () => credits?.take() ?? Promise.resolve(false),
        catch: (cause) => new EngineWebAdapterError("stem.cancelled", "FLAC output credits were cancelled", {}, cause),
      });
      outputWaitMs += Math.max(0, performance.now() - waitStart);
      if (!granted) return yield* Effect.fail(new EngineWebAdapterError("stem.cancelled", "FLAC output credits were cancelled"));
      const hashStart = performance.now();
      hash?.update(event.bytes);
      hashMs += Math.max(0, performance.now() - hashStart);
      const output = event.bytes.byteOffset === 0 && event.bytes.byteLength === event.bytes.buffer.byteLength
        ? event.bytes.buffer as ArrayBuffer : event.bytes.slice().buffer;
      decodedBytes += event.bytes.byteLength;
      decodedFrames += event.frames;
      blocks += 1;
      scope.postMessage({
        type: "pcm",
        requestId: options.requestId,
        bytes: output,
        frames: event.frames,
        totalPcmBytes: options.totalPcmBytes,
        metrics: { decodeMs, hashMs, inputWaitMs, outputWaitMs, blocks: 1 },
      }, [output]);
      inputWaitMs = 0;
      outputWaitMs = 0;
      hashMs = 0;
      decodeMs = 0;
      setRunnable(true);
      return;
    }
    completed = event;
    setRunnable(false);
  });

  const decoded = decodeFlac(source, {
      expectedFormat,
      expectedFrames: BigInt(options.expectedFrames),
      maxInputChunkBytes: FLAC_INPUT_SLOT_BYTES,
      maxMetadataBytes: 42,
    });
  const measured = Stream.transformPull(decoded, (pull) => Effect.succeed(Effect.gen(function* () {
      const started = performance.now();
      const priorInputWait = inputWaitMs;
      setRunnable(true);
      const event = yield* pull;
      decodeMs += Math.max(0, performance.now() - started - (inputWaitMs - priorInputWait));
      return event;
    })));
  const program = Effect.scoped(measured.pipe(Stream.runForEach(consume)))
    .pipe(Effect.provide(Layer.succeed(FlacDecoder, { module: options.module })));

  return Effect.runPromise(program).then(() => {
    const result = completed;
    if (result === undefined || result.frames !== BigInt(decodedFrames) || result.bytes !== BigInt(decodedBytes) ||
        decodedBytes !== options.totalPcmBytes || decodedFrames !== options.expectedFrames) {
      throw new EngineWebAdapterError("stem.decode.flac", "Codec completion counters do not verify canonical PCM", { phase: "finish" });
    }
    return {
      pcmBytes: decodedBytes,
      frames: decodedFrames,
      ...(hash === undefined ? {} : { digest: hash.digestHex() }),
      // Per-PCM messages carry blocks: 1. The terminal message intentionally
      // carries zero so diagnostics do not double-count the same blocks.
      metrics: { decodeMs, hashMs, inputWaitMs, outputWaitMs, blocks: 0 },
    };
  });
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "start") {
    if (active !== 0) return;
    active = message.requestId;
    credits = new FlacOutputCredits();
    hash = message.verifyPcm ? new IncrementalSha256() : undefined;
    inputSlot = message.inputSlot;
    runnable = message.runnable === undefined ? undefined : new Int32Array(message.runnable);
    runnableMask = message.runnableMask ?? 0;
    const requestId = message.requestId;
    if (message.decoderModule !== undefined) {
      decoderModule = message.decoderModule;
      scope.postMessage({ type: "ready", requestId });
    } else {
      loadController = new AbortController();
      void loadFlacDecoderModule({ url: message.decoderWasmUrl, signal: loadController.signal }).then((loaded) => {
        if (active !== requestId || credits?.cancelled) return;
        decoderModule = loaded;
        scope.postMessage({ type: "ready", requestId });
      }, fail);
    }
    return;
  }
  if (message.requestId !== active || credits === undefined) return;
  if (message.type === "output-credit") { credits.give(); return; }
  if (message.type === "cancel") {
    credits.cancel();
    loadController?.abort(new DOMException("FLAC decoder load cancelled", "AbortError"));
    clearJobState();
    scope.close?.();
    return;
  }
  if (message.type === "initialize") {
    // The module is retained from the start message so structured cloning does
    // not require another asset fetch. The lookup is explicit and immutable.
    if (decodingStarted) {
      fail(new EngineWebAdapterError("stem.decode.worker", "FLAC decoder was initialized more than once"));
      return;
    }
    if (decoderModule === undefined || inputSlot === undefined) {
      fail(new EngineWebAdapterError("stem.decode.asset", "FLAC decoder module was not supplied"));
      return;
    }
    decodingStarted = true;
    setRunnable(true);
    void decodeJob({
      module: decoderModule,
      inputSlot,
      streamInfo: message.streamInfo,
      expectedFrames: message.expectedFrames,
      totalPcmBytes: message.totalPcmBytes,
      requestId: message.requestId,
    }).then((result) => {
      if (active !== message.requestId || credits?.cancelled) return;
      const complete: Extract<FlacWorkerResponse, { type: "complete" }> = {
        type: "complete", requestId: message.requestId, pcmBytes: result.pcmBytes, frames: result.frames,
        ...(result.digest === undefined ? {} : { digest: result.digest }),
        metrics: result.metrics,
        reset: true,
      };
      // decodeJob resolves only after decodeFlac's scope has finalized. A
      // finalizer failure rejects the promise and poisons this realm instead.
      clearJobState();
      try { scope.postMessage(complete); }
      catch { scope.close?.(); }
    }, fail);
  }
};
