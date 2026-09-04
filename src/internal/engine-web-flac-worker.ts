import { runFlacIngest } from "../stems/flac-ingest.js";
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

function serialize(error: unknown): Extract<FlacWorkerResponse, { type: "error" }>["error"] {
  if (error instanceof Error) {
    const record = error as Error & { readonly code?: unknown; readonly details?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      ...(typeof record.details === "object" && record.details !== null
        ? { details: record.details as Readonly<Record<string, unknown>> }
        : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "start") {
    if (active !== 0) return;
    active = message.requestId;
    mailbox = new FlacWorkerMailbox();
    const job = mailbox;
    void runFlacIngest({
      requestId: active,
      ...(message.expected === undefined ? {} : { expected: message.expected }),
      post: (reply, transfer) => scope.postMessage(reply, transfer),
      nextInput: () => job.nextInput(),
      nextOutputCredit: () => job.takeOutputCredit(),
      cancelled: () => job.cancelled,
      cancellation: job.cancellation,
      cancellationReason: () => job.cancellationReason,
    }).catch((error: unknown) => {
      if (!job.cancelled) scope.postMessage({ type: "error", requestId: active, error: serialize(error) });
    }).finally(() => scope.close?.());
    return;
  }
  if (message.requestId !== active) return;
  if (message.type === "input") mailbox?.giveInput({ bytes: new Uint8Array(message.bytes), totalFlacBytes: message.totalFlacBytes });
  else if (message.type === "finish") mailbox?.giveInput(null);
  else if (message.type === "output-credit") mailbox?.giveOutputCredit();
  else mailbox?.cancel(new DOMException("FLAC Worker job was cancelled", "AbortError"));
};
