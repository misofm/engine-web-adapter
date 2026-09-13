import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import test from "node:test";

import { FlacInputSlotProducer, FLAC_INPUT_SLOT_BYTES } from "../src/stems/flac-input-slot.js";
import { parseNativeFlacStreamInfo } from "../src/stems/native-flac-metadata.js";
import type { FlacWorkerRequest, FlacWorkerResponse } from "../src/stems/flac-worker-protocol.js";

function readUnsigned(bytes: Uint8Array, cursor: { value: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[cursor.value++];
    if (byte === undefined) throw new Error("truncated Wasm integer");
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
}

/** Keep the public ABI valid, but make codec cleanup trap after a real decode. */
function decoderWithDeleteTrap(input: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(input);
  const exportName = "codec_decoder_delete";
  let cursor = { value: 8 };
  let deleteFunctionIndex: number | undefined;
  let importedFunctions = 0;
  while (cursor.value < bytes.byteLength) {
    const section = bytes[cursor.value++];
    if (section === undefined) throw new Error("truncated Wasm section");
    const size = readUnsigned(bytes, cursor);
    const end = cursor.value + size;
    if (section === 2) {
      const count = readUnsigned(bytes, cursor);
      for (let index = 0; index < count; index += 1) {
        const moduleLength = readUnsigned(bytes, cursor);
        cursor.value += moduleLength;
        const nameLength = readUnsigned(bytes, cursor);
        cursor.value += nameLength;
        const kind = bytes[cursor.value++];
        if (kind === 0) {
          readUnsigned(bytes, cursor);
          importedFunctions += 1;
        } else if (kind === 1) {
          cursor.value += 1;
          readUnsigned(bytes, cursor);
          readUnsigned(bytes, cursor);
        } else if (kind === 2) {
          readUnsigned(bytes, cursor);
          readUnsigned(bytes, cursor);
        } else if (kind === 3) {
          cursor.value += 2;
        } else {
          throw new Error("unknown Wasm import kind");
        }
      }
    } else if (section === 7) {
      const count = readUnsigned(bytes, cursor);
      for (let index = 0; index < count; index += 1) {
        const length = readUnsigned(bytes, cursor);
        const name = new TextDecoder().decode(bytes.subarray(cursor.value, cursor.value + length));
        cursor.value += length;
        const kind = bytes[cursor.value++];
        const functionIndex = readUnsigned(bytes, cursor);
        if (kind === 0 && name === exportName) deleteFunctionIndex = functionIndex;
      }
    }
    cursor.value = end;
  }
  if (deleteFunctionIndex === undefined) throw new Error("decoder delete export was not found");
  const target = deleteFunctionIndex - importedFunctions;
  cursor = { value: 8 };
  while (cursor.value < bytes.byteLength) {
    const section = bytes[cursor.value++];
    if (section === undefined) throw new Error("truncated Wasm section");
    const size = readUnsigned(bytes, cursor);
    const end = cursor.value + size;
    if (section === 10) {
      const count = readUnsigned(bytes, cursor);
      for (let index = 0; index < count; index += 1) {
        const bodySize = readUnsigned(bytes, cursor);
        const bodyStart = cursor.value;
        const bodyEnd = bodyStart + bodySize;
        if (index === target) {
          const localsStart = cursor.value;
          const locals = readUnsigned(bytes, cursor);
          for (let local = 0; local < locals; local += 1) {
            readUnsigned(bytes, cursor);
            cursor.value += 1;
          }
          const localsBytes = bytes.slice(localsStart, cursor.value);
          const replacement = new Uint8Array(bodySize);
          replacement.set(localsBytes);
          replacement[localsBytes.byteLength] = 0x00; // unreachable
          replacement.fill(0x01, localsBytes.byteLength + 1, bodySize - 1); // nop padding
          replacement[bodySize - 1] = 0x0b; // end
          bytes.set(replacement, bodyStart);
          return bytes;
        }
        cursor.value = bodyEnd;
      }
    }
    cursor.value = end;
  }
  throw new Error("decoder delete body was not found");
}

test("a public codec cleanup trap poisons the worker after decode and blocks reset/reuse", async () => {
  const flac = new Uint8Array(await readFile("tests/fixtures/native-multiblock-stereo24.flac"));
  const wasm = new Uint8Array(await readFile("node_modules/@misofm/codec/wasm/flac-decoder.wasm"));
  const trapBytes = decoderWithDeleteTrap(wasm);
  const decoderModule = await WebAssembly.compile(trapBytes.buffer as ArrayBuffer);
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
  const messages: FlacWorkerResponse[] = [];
  let offset = 0;
  let pcmBytes = 0;
  let pcmFrames = 0;
  let timeout: NodeJS.Timeout | undefined;
  const outcome = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("finalizer trap worker did not settle")), 10_000);
    worker.on("error", reject);
    worker.on("message", (message: FlacWorkerResponse | { readonly type: "runner-ready" } | { readonly type: "closed" }) => {
      if (message.type === "runner-ready") {
        const start: FlacWorkerRequest = {
          type: "start", requestId: 91, identity: `blake3:${"b".repeat(64)}`,
          decoderWasmUrl: "https://asset.invalid/trap.wasm", decoderModule, inputSlot: producer.buffers,
        };
        worker.postMessage(start);
      } else if (message.type === "closed") {
        if (timeout !== undefined) clearTimeout(timeout);
        resolve();
      } else {
        const workerMessage = message as FlacWorkerResponse;
        messages.push(workerMessage);
        if (workerMessage.type === "ready") {
          worker.postMessage({ type: "initialize", requestId: 91, streamInfo: parsed.streamInfo,
            expectedFrames: 72_000, totalPcmBytes: 432_000 });
        } else if (workerMessage.type === "input-credit") {
          const next = audio.subarray(offset, Math.min(audio.byteLength, offset + Math.min(workerMessage.maximumBytes, FLAC_INPUT_SLOT_BYTES)));
          offset += next.byteLength;
          producer.publish(next, offset === audio.byteLength);
        } else if (workerMessage.type === "pcm") {
          pcmBytes += workerMessage.bytes.byteLength;
          pcmFrames += workerMessage.frames;
          worker.postMessage({ type: "output-credit", requestId: 91 });
        }
      }
    });
  });
  try {
    await outcome;
    assert.equal(pcmBytes, 432_000, "the trap must occur after the complete PCM payload was emitted");
    assert.equal(pcmFrames, 72_000, "the trap must occur after all decoded frames were emitted");
    assert.equal(messages.some((message) => message.type === "complete"), false);
    assert.equal(messages.some((message) => message.type === "complete" && message.reset === true), false);
    const failure = messages.find((message): message is Extract<FlacWorkerResponse, { type: "error" }> => message.type === "error");
    assert.equal(failure?.error.code, "stem.decode.asset");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    producer.abort();
    await worker.terminate();
  }
});
