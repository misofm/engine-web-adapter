import { IncrementalSha256 } from "../stems/sha256.js";
import { EngineWebAdapterError } from "../errors.js";
import { NativeFlacDecoder } from "../stems/native-flac-decoder.js";
import { FlacOutputCredits } from "../stems/flac-output-credits.js";
import type { FlacWorkerRequest, FlacWorkerResponse } from "../stems/flac-worker-protocol.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<FlacWorkerRequest>) => void) | null;
  postMessage(message: FlacWorkerResponse, transfer?: Transferable[]): void;
  close?: () => void;
}

const scope = ((globalThis as unknown as { readonly self?: WorkerScope }).self ?? globalThis) as unknown as WorkerScope;
let active = 0;
let credits: FlacOutputCredits | undefined;
let decoder: NativeFlacDecoder | undefined;
let hash: IncrementalSha256 | undefined;
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
  decoder = undefined;
  hash = undefined;
  runnable = undefined;
  runnableMask = 0;
  processing = false;
  inputWaitStart = 0;
  inputWaitMs = 0;
}

function serialize(error: unknown): Extract<FlacWorkerResponse, { type: "error" }>["error"] {
  if (error instanceof Error) {
    const record = error as Error & { readonly code?: unknown; readonly details?: unknown };
    return {
      name: error.name, message: error.message,
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
      try { scope.postMessage({ type: "error", requestId, error: serialize(error) }); }
      catch { /* a reply clone failure still poisons this realm */ }
    }
  } finally {
    try { decoder?.destroy(); } catch { /* the first typed failure remains authoritative */ }
    clearJobState();
    scope.close?.();
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "start") {
    if (active !== 0) return;
    active = message.requestId;
    credits = new FlacOutputCredits();
    hash = message.verifyPcm ? new IncrementalSha256() : undefined;
    runnable = message.runnable === undefined ? undefined : new Int32Array(message.runnable);
    runnableMask = message.runnableMask ?? 0;
    const requestId = message.requestId;
    void NativeFlacDecoder.load({
      url: message.decoderWasmUrl,
      inputSlot: message.inputSlot,
      ...(message.decoderModule === undefined ? {} : { module: message.decoderModule }),
      onInputWait: waiting => {
        if (waiting) { inputWaitStart = performance.now(); setRunnable(false); }
        else { inputWaitMs += performance.now() - inputWaitStart; setRunnable(true); }
      },
      requestRefill: () => scope.postMessage({
        type: "input-credit", requestId, maximumBytes: 256 * 1024,
        phase: "audio", phaseBytesRemaining: 0,
      }),
    }).then((loaded) => {
      if (active !== requestId || credits?.cancelled) {
        try { loaded.destroy(); } catch { /* cancellation already owns the failure */ }
        return;
      }
      decoder = loaded;
      scope.postMessage({ type: "ready", requestId });
    }, fail);
    return;
  }
  if (message.requestId !== active || credits === undefined) return;
  if (message.type === "output-credit") { credits.give(); return; }
  if (message.type === "cancel") {
    credits.cancel();
    try { decoder?.destroy(); } catch { /* physical Worker close is authoritative */ }
    clearJobState();
    scope.close?.();
    return;
  }
  if (message.type === "initialize") {
    if (decoder === undefined) { fail(new EngineWebAdapterError("stem.decode.worker", "FLAC decoder initialized before asset readiness")); return; }
    const requestId = message.requestId;
    try { decoder.initialize(message.streamInfo, message.expectedFrames); }
    catch (error) { fail(error); return; }
    const current = decoder;
    const outputCredits = credits;
    void (async () => {
      let frames = 0;
      let bytes = 0;
      let outputWaitMs = 0;
      let decodeMs = 0;
      for (;;) {
        const waitStart = performance.now();
        if (!await outputCredits.take()) return;
        outputWaitMs += performance.now() - waitStart;
        const processStart = performance.now();
        const priorInputWait = inputWaitMs;
        setRunnable(true);
        let result;
        do { result = current.processSingle(); } while (result === null);
        decodeMs += Math.max(0, performance.now() - processStart - (inputWaitMs - priorInputWait));
        if (result === "eof") { setRunnable(false); break; }
        const hashStart = performance.now();
        hash?.update(result.bytes);
        const hashMs = hash === undefined ? 0 : performance.now() - hashStart;
        setRunnable(false);
        frames += result.frames;
        bytes += result.bytes.byteLength;
        const output = result.bytes.buffer as ArrayBuffer;
        scope.postMessage({ type: "pcm", requestId, bytes: output, frames: result.frames,
          totalPcmBytes: message.totalPcmBytes,
          metrics: { decodeMs, hashMs, inputWaitMs, outputWaitMs, blocks: 1 },
        }, [output]);
        decodeMs = 0; inputWaitMs = 0; outputWaitMs = 0;
      }
      current.finish();
      current.destroy();
      const digest = hash?.digestHex();
      const complete = { type: "complete" as const, requestId, pcmBytes: bytes, frames,
        ...(digest === undefined ? {} : { digest }),
        metrics: { decodeMs, hashMs: 0, inputWaitMs, outputWaitMs, blocks: 0 }, reset: true,
      };
      // Reset all mutable job state before acknowledging completion. The host
      // may only lease this realm again after observing this acknowledgement.
      clearJobState();
      try { scope.postMessage(complete); }
      catch { /* a completion clone failure leaves this realm unusable */ scope.close?.(); }
    })().catch(fail);
  }
};
