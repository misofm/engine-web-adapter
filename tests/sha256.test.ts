import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import {
  IncrementalSha256,
  setSha256BackendForTests,
} from "../src/stems/sha256.js";

function trustedDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = (index * 29 + 17) & 0xff;
  }
  return bytes;
}

function digestInPartitions(
  bytes: Uint8Array,
  backend: "js" | "wasm",
): string {
  const restore = setSha256BackendForTests(backend);
  try {
    const hash = new IncrementalSha256();
    let offset = 0;
    for (const width of [1, 7, 55, 64, 257, 4097, 16384]) {
      if (offset >= bytes.byteLength) break;
      const next = Math.min(bytes.byteLength, offset + width);
      hash.update(bytes.subarray(offset, next));
      offset = next;
    }
    if (offset < bytes.byteLength) hash.update(bytes.subarray(offset));
    return hash.digestHex();
  } finally {
    restore();
  }
}

test("scalar and Wasm SHA backends agree at padding and batch boundaries", () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 16383, 16384, 16385, 32768]) {
    const bytes = pattern(length);
    const expected = trustedDigest(bytes);
    assert.equal(digestInPartitions(bytes, "js"), expected);
    assert.equal(digestInPartitions(bytes, "wasm"), expected);
  }
});

test("Wasm backend accepts nonzero-offset views and independent interleaved state", () => {
  const first = pattern(16_385);
  const second = pattern(257);
  const backing = new Uint8Array(first.byteLength + 11);
  backing.set(first, 5);
  const restore = setSha256BackendForTests("wasm");
  try {
    const firstHash = new IncrementalSha256();
    const secondHash = new IncrementalSha256();
    firstHash.update(new DataView(backing.buffer, 5, 8_192));
    secondHash.update(second.subarray(0, 3));
    firstHash.update(new DataView(backing.buffer, 5 + 8_192, first.byteLength - 8_192));
    secondHash.update(second.subarray(3));
    assert.equal(firstHash.digestHex(), trustedDigest(first));
    assert.equal(secondHash.digestHex(), trustedDigest(second));
  } finally {
    restore();
  }
});

test("synchronous update owns its bytes and finalization remains one-shot", () => {
  const bytes = pattern(257);
  const expected = trustedDigest(bytes);
  const restore = setSha256BackendForTests("wasm");
  try {
    const hash = new IncrementalSha256();
    hash.update(bytes);
    bytes.fill(0);
    assert.equal(hash.digestHex(), expected);
    assert.throws(() => hash.digest(), /already finalized/u);
    assert.throws(() => hash.update(new Uint8Array()), /already finalized/u);
  } finally {
    restore();
  }
});
