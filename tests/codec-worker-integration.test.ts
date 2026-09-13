import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import test from "node:test";

import { loadFlacDecoderModule } from "../src/stems/native-flac-decoder.js";
import { FlacInputSlotProducer, FLAC_INPUT_SLOT_BYTES } from "../src/stems/flac-input-slot.js";
import { parseNativeFlacStreamInfo } from "../src/stems/native-flac-metadata.js";
import type { FlacWorkerRequest, FlacWorkerResponse } from "../src/stems/flac-worker-protocol.js";

interface DecodeCase {
  readonly fixture: string;
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly bitsPerSample: 16 | 24;
  readonly frames: number;
  readonly chunkBytes?: number;
  readonly delayMs?: number;
  readonly mutate?: (flac: Uint8Array) => Uint8Array;
  readonly cancelAfterPcm?: number;
}

interface DecodeResult {
  readonly messages: readonly FlacWorkerResponse[];
  readonly pcmBlocks: number;
  readonly pcmBytes: number;
  readonly pcmFrames: number;
  readonly digest: string;
  readonly complete?: Extract<FlacWorkerResponse, { type: "complete" }>;
}

const decoderModule = await (async () => {
  const wasm = new Uint8Array(await readFile("node_modules/@misofm/codec/wasm/flac-decoder.wasm"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(wasm.slice(), { headers: { "Content-Type": "application/wasm" } });
  try {
    return await loadFlacDecoderModule({ url: "https://asset.invalid/codec.wasm" });
  } finally {
    globalThis.fetch = originalFetch;
  }
})();

async function createWorker(): Promise<Worker> {
  const worker = new Worker(new URL("./codec-worker-runner.js", import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("codec worker runner did not become ready")), 5_000);
    const onError = (error: Error) => { clearTimeout(timeout); reject(error); };
    const onMessage = (message: unknown) => {
      if ((message as { readonly type?: string }).type !== "runner-ready") return;
      clearTimeout(timeout);
      worker.removeListener("error", onError);
      worker.removeListener("message", onMessage);
      resolve();
    };
    worker.on("error", onError);
    worker.on("message", onMessage);
  });
  return worker;
}

function audioPayload(flac: Uint8Array): Uint8Array {
  let offset = 42;
  if ((flac[4]! & 0x80) !== 0) return flac.subarray(offset);
  for (;;) {
    if (offset + 4 > flac.byteLength) throw new Error("FLAC metadata header is truncated");
    const header = flac[offset]!;
    const length = (flac[offset + 1]! << 16) | (flac[offset + 2]! << 8) | flac[offset + 3]!;
    offset += 4;
    if (offset + length > flac.byteLength) throw new Error("FLAC metadata payload is truncated");
    offset += length;
    if ((header & 0x80) !== 0) return flac.subarray(offset);
  }
}

async function runDecode(worker: Worker, options: DecodeCase, requestId: number): Promise<DecodeResult> {
  const original = new Uint8Array(await readFile(`tests/fixtures/${options.fixture}.flac`));
  const flac = options.mutate === undefined ? original : options.mutate(original.slice());
  const bytesPerFrame = options.channels * (options.bitsPerSample / 8);
  const parsed = parseNativeFlacStreamInfo(flac.subarray(0, 42), {
    sampleRateHz: options.sampleRate,
    channels: options.channels,
    bitDepth: options.bitsPerSample,
    frames: options.frames,
    canonicalBytes: options.frames * bytesPerFrame,
  });
  const audio = audioPayload(flac);
  const producer = new FlacInputSlotProducer();
  const messages: FlacWorkerResponse[] = [];
  const pcm: Uint8Array[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let offset = 0;
  let pcmFrames = 0;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveResult: (result: DecodeResult) => void = () => undefined;
  let rejectResult: (error: unknown) => void = () => undefined;
  const result = new Promise<DecodeResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const settle = (value: DecodeResult | unknown, failure = false): void => {
    if (settled) return;
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    for (const timer of timers) clearTimeout(timer);
    if (failure) rejectResult(value);
    else resolveResult(value as DecodeResult);
  };
  const finish = (complete?: Extract<FlacWorkerResponse, { type: "complete" }>): void => {
    const all = new Uint8Array(pcm.reduce((sum, part) => sum + part.byteLength, 0));
    let cursor = 0;
    for (const part of pcm) { all.set(part, cursor); cursor += part.byteLength; }
    settle({
      messages, pcmBlocks: pcm.length, pcmBytes: all.byteLength, pcmFrames,
      digest: createHash("sha256").update(all).digest("hex"),
      ...(complete === undefined ? {} : { complete }),
    });
  };
  const onError = (error: Error) => settle(error, true);
  const onMessage = (message: FlacWorkerResponse | { readonly type: "closed" }): void => {
    if (message.type === "closed") {
      if (options.cancelAfterPcm !== undefined || messages.some((item) => item.type === "error")) finish();
      else settle(new Error("codec worker closed before completion"), true);
      return;
    }
    messages.push(message);
    if (message.type === "ready") {
      worker.postMessage({ type: "initialize", requestId, streamInfo: parsed.streamInfo,
        expectedFrames: options.frames, totalPcmBytes: options.frames * bytesPerFrame });
      return;
    }
    if (message.type === "input-credit") {
      if (offset >= audio.byteLength) {
        settle(new Error("codec worker requested input after EOF"), true);
        return;
      }
      const chunkSize = Math.min(options.chunkBytes ?? FLAC_INPUT_SLOT_BYTES, message.maximumBytes, FLAC_INPUT_SLOT_BYTES);
      const next = audio.subarray(offset, Math.min(audio.byteLength, offset + chunkSize));
      offset += next.byteLength;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const publish = () => {
        if (timer !== undefined) timers.delete(timer);
        producer.publish(next, offset === audio.byteLength);
      };
      if ((options.delayMs ?? 0) > 0) {
        timer = setTimeout(publish, options.delayMs);
        timers.add(timer);
      } else {
        publish();
      }
      return;
    }
    if (message.type === "pcm") {
      pcm.push(new Uint8Array(message.bytes));
      pcmFrames += message.frames;
      if (options.cancelAfterPcm !== undefined && pcm.length >= options.cancelAfterPcm) {
        let cancelTimer: ReturnType<typeof setTimeout>;
        cancelTimer = setTimeout(() => {
          timers.delete(cancelTimer);
          producer.abort();
          worker.postMessage({ type: "cancel", requestId });
        }, 50);
        timers.add(cancelTimer);
      } else if (options.cancelAfterPcm === undefined) {
        worker.postMessage({ type: "output-credit", requestId });
      }
      return;
    }
    if (message.type === "complete") finish(message);
  };
  worker.on("error", onError);
  worker.on("message", onMessage);
  timeout = setTimeout(() => settle(new Error(`codec worker case timed out: ${options.fixture}`), true), 15_000);
  worker.postMessage({
    type: "start", requestId, identity: `sha256:${requestId.toString(16).padStart(64, "0")}`,
    decoderWasmUrl: "https://asset.invalid/codec.wasm", decoderModule, inputSlot: producer.buffers, verifyPcm: true,
  } satisfies FlacWorkerRequest);
  try {
    return await result;
  } finally {
    worker.removeListener("error", onError);
    worker.removeListener("message", onMessage);
    for (const timer of timers) clearTimeout(timer);
    producer.abort();
  }
}

test("actual worker preserves bounded refill, metadata, and sequential reuse boundaries", async () => {
  const worker = await createWorker();
  try {
    const exact = await runDecode(worker, {
      fixture: "native-multiblock-stereo24", sampleRate: 48_000, channels: 2, bitsPerSample: 24, frames: 72_000,
    }, 101);
    assert.equal(exact.complete?.reset, true);
    assert.equal(exact.pcmBytes, 432_000);
    assert.equal(exact.pcmFrames, 72_000);
    assert.equal(exact.digest, "4b5bc724ea7d855b3b5518b7a5e4da7222a41b9d0c98ca42880ca37e7458654d");

    const unknownTotal = await runDecode(worker, {
      fixture: "native-multiblock-stereo24", sampleRate: 48_000, channels: 2, bitsPerSample: 24, frames: 72_000,
      mutate: (flac) => { flac[21] = flac[21]! & 0xf0; flac.fill(0, 22, 26); return flac; },
    }, 102);
    assert.equal(unknownTotal.complete?.reset, true);
    assert.equal(unknownTotal.pcmFrames, 72_000);
    assert.equal(unknownTotal.digest, exact.digest);

    const variable = await runDecode(worker, {
      fixture: "native-variable-stereo24", sampleRate: 48_000, channels: 2, bitsPerSample: 24, frames: 41_024,
    }, 103);
    assert.equal(variable.complete?.reset, true);
    assert.equal(variable.pcmBytes, 246_144);
    assert.equal(variable.pcmFrames, 41_024);
    assert.equal(variable.digest, "1c56647d30a67bd892fd802860925f85eed692a706151dd1738235e0dc62889f");

    const delayed = await runDecode(worker, {
      fixture: "native-silence", sampleRate: 48_000, channels: 1, bitsPerSample: 16, frames: 2_048,
      chunkBytes: 1, delayMs: 1,
    }, 104);
    assert.equal(delayed.complete?.reset, true);
    assert.equal(delayed.pcmBytes, 4_096);
    assert.equal(delayed.pcmFrames, 2_048);
    assert.equal(delayed.digest, "ad7facb2586fc6e966c004d7d1d16b024f5805ff7cb47c7a85dabd8b48892ca7");
    assert.ok(delayed.messages.filter((message) => message.type === "input-credit").length > 10);
  } finally {
    await worker.terminate();
  }
});

test("actual worker rejects truncation, CRC, MD5, and trailing-byte failures", async () => {
  const cases: readonly DecodeCase[] = [
    {
      fixture: "native-multiblock-stereo24", sampleRate: 48_000, channels: 2, bitsPerSample: 24, frames: 72_000,
      mutate: (flac) => flac.subarray(0, flac.byteLength - 1),
    },
    {
      fixture: "native-multiblock-stereo24", sampleRate: 48_000, channels: 2, bitsPerSample: 24, frames: 72_000,
      mutate: (flac) => { flac[flac.byteLength - 1] = flac[flac.byteLength - 1]! ^ 1; return flac; },
    },
    {
      fixture: "native-multiblock-stereo24", sampleRate: 48_000, channels: 2, bitsPerSample: 24, frames: 72_000,
      mutate: (flac) => { flac[26] = flac[26]! ^ 1; return flac; },
    },
    {
      fixture: "native-multiblock-stereo24", sampleRate: 48_000, channels: 2, bitsPerSample: 24, frames: 72_000,
      mutate: (flac) => Uint8Array.from([...flac, 0]),
    },
  ];
  for (const [index, options] of cases.entries()) {
    const worker = await createWorker();
    try {
      const result = await runDecode(worker, options, 200 + index);
      const failure = result.messages.find((message): message is Extract<FlacWorkerResponse, { type: "error" }> => message.type === "error");
      assert.ok(failure, `failure case ${index} must report an error`);
      assert.equal(failure.error.code, "stem.decode.flac");
      assert.equal(result.complete, undefined);
      assert.equal(result.messages.some((message) => message.type === "complete"), false);
    } finally {
      await worker.terminate();
    }
  }
});

test("actual worker output stall cancellation preserves two credits and emits no completion or reset", async () => {
  const worker = await createWorker();
  try {
    const result = await runDecode(worker, {
      fixture: "native-multiblock-stereo24", sampleRate: 48_000, channels: 2, bitsPerSample: 24, frames: 72_000,
      cancelAfterPcm: 2,
    }, 301);
    assert.equal(result.pcmBlocks, 2);
    assert.equal(result.messages.some((message) => message.type === "complete"), false);
    assert.equal(result.messages.some((message) => message.type === "error"), false);
    assert.equal(result.messages.some((message) => message.type === "complete" && message.reset === true), false);
  } finally {
    await worker.terminate();
  }
});
