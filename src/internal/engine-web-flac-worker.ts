import { EngineWebAdapterError } from "../errors.js";
import { NativeFlacDecoder } from "../stems/native-flac-decoder.js";
import { FlacWorkerMailbox } from "../stems/flac-worker-mailbox.js";
import type { FlacWorkerRequest, FlacWorkerResponse } from "../stems/flac-worker-protocol.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<FlacWorkerRequest>) => void) | null;
  postMessage(message: FlacWorkerResponse, transfer?: Transferable[]): void;
  close?: () => void;
}

const scope = ((globalThis as unknown as { readonly self?: WorkerScope }).self ?? globalThis) as unknown as WorkerScope;
let active = 0;
let mailbox: FlacWorkerMailbox | undefined;
let decoder: NativeFlacDecoder | undefined;

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
  if (!mailbox?.cancelled) scope.postMessage({ type: "error", requestId: active, error: serialize(error) });
  decoder?.destroy();
  scope.close?.();
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "start") {
    if (active !== 0) return;
    active = message.requestId;
    mailbox = new FlacWorkerMailbox();
    void NativeFlacDecoder.load({
      url: message.decoderWasmUrl,
      inputSlot: message.inputSlot,
      requestRefill: () => scope.postMessage({
        type: "input-credit", requestId: active, maximumBytes: 256 * 1024,
        phase: "audio", phaseBytesRemaining: 0,
      }),
    }).then((loaded) => {
      decoder = loaded;
      scope.postMessage({ type: "ready", requestId: active });
    }, fail);
    return;
  }
  if (message.requestId !== active || mailbox === undefined) return;
  if (message.type === "output-credit") { mailbox.giveOutputCredit(); return; }
  if (message.type === "cancel") {
    mailbox.cancel(new DOMException("FLAC Worker job was cancelled", "AbortError"));
    decoder?.destroy();
    scope.close?.();
    return;
  }
  if (message.type === "initialize") {
    if (decoder === undefined) { fail(new EngineWebAdapterError("stem.decode.worker", "FLAC decoder initialized before asset readiness")); return; }
    try { decoder.initialize(message.streamInfo, message.expectedFrames); }
    catch (error) { fail(error); return; }
    const current = decoder;
    const job = mailbox;
    void (async () => {
      let frames = 0;
      let bytes = 0;
      for (;;) {
        await job.takeOutputCredit();
        if (job.cancelled) return;
        let result;
        do { result = current.processSingle(); } while (result === null);
        if (result === "eof") break;
        frames += result.frames;
        bytes += result.bytes.byteLength;
        const output = result.bytes.buffer as ArrayBuffer;
        scope.postMessage({ type: "pcm", requestId: active, bytes: output, frames: result.frames, totalPcmBytes: message.totalPcmBytes }, [output]);
      }
      current.finish();
      scope.postMessage({ type: "complete", requestId: active, pcmBytes: bytes, frames });
      current.destroy();
      scope.close?.();
    })().catch(fail);
  }
};
