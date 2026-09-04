import { runFlacIngest } from "../stems/flac-ingest.js";
import { FLAC_DECODE_OUTPUT_CREDITS, type FlacWorkerRequest, type FlacWorkerResponse } from "../stems/flac-worker-protocol.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<FlacWorkerRequest>) => void) | null;
  postMessage(message: FlacWorkerResponse, transfer?: Transferable[]): void;
  close?: () => void;
}

type Input = { readonly bytes: Uint8Array; readonly totalFlacBytes: number } | null;
const scope = ((globalThis as unknown as { readonly self?: WorkerScope }).self ?? globalThis) as unknown as WorkerScope;
let active = 0;
let cancelled = false;
let inputs: Input[] = [];
let inputWake: ((input: Input) => void) | undefined;
let outputCredits = 0;
let creditWake: (() => void) | undefined;

function giveInput(input: Input): void {
  const wake = inputWake;
  inputWake = undefined;
  if (wake !== undefined) wake(input);
  else inputs.push(input);
}

function nextInput(): Promise<Input> {
  const input = inputs.shift();
  if (input !== undefined) return Promise.resolve(input);
  return new Promise((resolve) => { inputWake = resolve; });
}

async function takeOutputCredit(): Promise<void> {
  while (!cancelled && outputCredits === 0) await new Promise<void>((resolve) => { creditWake = resolve; });
  if (!cancelled) outputCredits -= 1;
}

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
    cancelled = false;
    inputs = [];
    outputCredits = FLAC_DECODE_OUTPUT_CREDITS;
    void runFlacIngest({
      requestId: active,
      ...(message.expected === undefined ? {} : { expected: message.expected }),
      post: (reply, transfer) => scope.postMessage(reply, transfer),
      nextInput,
      nextOutputCredit: takeOutputCredit,
      cancelled: () => cancelled,
    }).catch((error: unknown) => {
      if (!cancelled) scope.postMessage({ type: "error", requestId: active, error: serialize(error) });
    }).finally(() => scope.close?.());
    return;
  }
  if (message.requestId !== active) return;
  if (message.type === "input") giveInput({ bytes: new Uint8Array(message.bytes), totalFlacBytes: message.totalFlacBytes });
  else if (message.type === "finish") giveInput(null);
  else if (message.type === "output-credit") {
    outputCredits += 1;
    const wake = creditWake;
    creditWake = undefined;
    wake?.();
  } else {
    cancelled = true;
    giveInput(null);
    const wake = creditWake;
    creditWake = undefined;
    wake?.();
  }
};
