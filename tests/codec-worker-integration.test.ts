import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import test from "node:test";

import { loadFlacDecoderModule } from "../src/stems/native-flac-decoder.js";
import { FlacInputSlotProducer, FLAC_INPUT_SLOT_BYTES } from "../src/stems/flac-input-slot.js";
import { parseNativeFlacStreamInfo } from "../src/stems/native-flac-metadata.js";
import type { FlacWorkerRequest, FlacWorkerResponse } from "../src/stems/flac-worker-protocol.js";

test("the adapter Worker decodes through the public codec with bounded input and output credits", async () => {
  const flac = new Uint8Array(await readFile("tests/fixtures/native-multiblock-stereo24.flac"));
  const wasm = new Uint8Array(await readFile("node_modules/@misofm/codec/wasm/flac-decoder.wasm"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(wasm.slice(), { headers: { "Content-Type": "application/wasm" } });
  const module = await loadFlacDecoderModule({ url: "https://asset.invalid/codec.wasm", signal: new AbortController().signal });
  globalThis.fetch = originalFetch;
  const parsed = parseNativeFlacStreamInfo(flac.subarray(0, 42), {
    sampleRateHz: 48_000, channels: 2, bitDepth: 24, frames: 72_000, canonicalBytes: 432_000,
  });
  let audioOffset = 42;
  if ((flac[4]! & 0x80) === 0) {
    for (;;) {
      const header = flac[audioOffset]!;
      const length = (flac[audioOffset + 1]! << 16) | (flac[audioOffset + 2]! << 8) | flac[audioOffset + 3]!;
      audioOffset += 4 + length;
      if ((header & 0x80) !== 0) break;
    }
  }
  const audio = flac.subarray(audioOffset);
  const producer = new FlacInputSlotProducer();
  const worker = new Worker(new URL("./codec-worker-runner.js", import.meta.url));
  let offset = 0;
  const pcm: Uint8Array[] = [];
  const messages: FlacWorkerResponse[] = [];
  const result = new Promise<Extract<FlacWorkerResponse, { type: "complete" }>>((resolve, reject) => {
    worker.on("error", reject);
    worker.on("message", (message: FlacWorkerResponse | { readonly type: "runner-ready" }) => {
      if (message.type === "runner-ready") {
        const start: FlacWorkerRequest = {
          type: "start", requestId: 1, identity: `sha256:${"a".repeat(64)}`,
          decoderWasmUrl: "https://asset.invalid/codec.wasm", decoderModule: module,
          inputSlot: producer.buffers, verifyPcm: true,
        };
        worker.postMessage(start);
        return;
      }
      messages.push(message);
      if (message.type === "ready") {
        worker.postMessage({ type: "initialize", requestId: 1, streamInfo: parsed.streamInfo,
          expectedFrames: 72_000, totalPcmBytes: 432_000 });
      } else if (message.type === "input-credit") {
        const next = audio.subarray(offset, Math.min(audio.byteLength, offset + Math.min(message.maximumBytes, FLAC_INPUT_SLOT_BYTES)));
        offset += next.byteLength;
        producer.publish(next, offset === audio.byteLength);
      } else if (message.type === "pcm") {
        pcm.push(new Uint8Array(message.bytes));
        worker.postMessage({ type: "output-credit", requestId: 1 });
      } else if (message.type === "error") {
        reject(Object.assign(new Error(message.error.message), { code: message.error.code, details: message.error.details }));
      } else if (message.type === "complete") {
        resolve(message);
      }
    });
  });
  try {
    const complete = await result;
    const bytes = new Uint8Array(pcm.reduce((total, chunk) => total + chunk.byteLength, 0));
    let cursor = 0;
    for (const chunk of pcm) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
    assert.equal(complete.pcmBytes, 432_000);
    assert.equal(complete.frames, 72_000);
    assert.equal(complete.reset, true);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), "4b5bc724ea7d855b3b5518b7a5e4da7222a41b9d0c98ca42880ca37e7458654d");
    assert.equal(messages.filter((message) => message.type === "pcm").length, pcm.length);
  } finally {
    producer.abort();
    await worker.terminate();
  }
});
