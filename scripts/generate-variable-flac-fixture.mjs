import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const blocks = [576, 1_152, 2_304, ...Array.from({ length: 9 }, () => 4_096), 128];
const frames = blocks.reduce((sum, value) => sum + value, 0);
const temporary = await mkdtemp(join(tmpdir(), "engine-flac-variable-"));
const raw = new Uint8Array(frames * 2 * 3);
let cursor = 0;
for (let sample = 0; sample < frames; sample += 1) {
  const left = (sample * 7_919) % 16_000_001 - 8_000_000;
  const right = -Math.trunc(left / 2);
  for (const value of [left, right]) {
    raw[cursor++] = value;
    raw[cursor++] = value >> 8;
    raw[cursor++] = value >> 16;
  }
}

const encodedFrames = [];
const sourceFrames = [];
let rawOffset = 0;
let samplePosition = 0;
for (const block of blocks) {
  const chunkRaw = join(temporary, `block-${block}.raw`);
  const chunkFlac = join(temporary, `block-${block}.flac`);
  await writeFile(chunkRaw, raw.subarray(rawOffset, rawOffset + block * 6));
  execFileSync("flac", ["--force", "--silent", "--force-raw-format", "--endian=little", "--sign=signed",
    "--channels=2", "--bps=24", "--sample-rate=48000", `--blocksize=${block}`, "-o", chunkFlac, chunkRaw]);
  const encoded = new Uint8Array(await readFile(chunkFlac));
  const audioOffset = metadataEnd(encoded);
  const sourceFrame = encoded.subarray(audioOffset);
  sourceFrames.push(sourceFrame);
  encodedFrames.push(toVariableFrame(sourceFrame, samplePosition));
  rawOffset += block * 6;
  samplePosition += block;
}

const streamInfo = new Uint8Array(42);
streamInfo.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
putU16(streamInfo, 8, Math.min(...blocks.slice(0, -1)));
putU16(streamInfo, 10, Math.max(...blocks));
putU24(streamInfo, 12, Math.min(...encodedFrames.map((frame) => frame.byteLength)));
putU24(streamInfo, 15, Math.max(...encodedFrames.map((frame) => frame.byteLength)));
putU64(streamInfo, 18, (48_000n << 44n) | (1n << 41n) | (23n << 36n) | BigInt(frames));
streamInfo.set(createHash("md5").update(raw).digest(), 26);
const fixture = assemble(streamInfo, encodedFrames);
await writeFile("tests/fixtures/native-variable-stereo24.flac", fixture);
execFileSync("flac", ["--silent", "--test", "tests/fixtures/native-variable-stereo24.flac"]);
samplePosition = 0;
const reorderedFrames = sourceFrames.map((frame, index) => {
  const result = toVariableFrame(frame, samplePosition + (index === 1 ? 1 : 0));
  samplePosition += blocks[index];
  return result;
});
await writeFile("tests/fixtures/native-reordered-stereo24.flac", assemble(streamInfo, reorderedFrames));
console.log(JSON.stringify({ frames, blocks, flacBytes: fixture.byteLength, pcmBytes: raw.byteLength,
  pcmSha256: createHash("sha256").update(raw).digest("hex") }));

function assemble(description, audioFrames) {
  const result = new Uint8Array(description.byteLength + audioFrames.reduce((sum, frame) => sum + frame.byteLength, 0));
  result.set(description);
  let offset = description.byteLength;
  for (const frame of audioFrames) { result.set(frame, offset); offset += frame.byteLength; }
  return result;
}

function metadataEnd(bytes) {
  assert.deepEqual([...bytes.subarray(0, 4)], [0x66, 0x4c, 0x61, 0x43]);
  let offset = 4;
  for (;;) {
    const final = (bytes[offset] & 0x80) !== 0;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 4 + length;
    if (final) return offset;
  }
}

function toVariableFrame(frame, sample) {
  assert.equal(frame[0], 0xff);
  const numberLength = utf8Length(frame[4]);
  let headerEnd = 4 + numberLength;
  const blockCode = frame[2] >> 4;
  const rateCode = frame[2] & 15;
  if (blockCode === 6) headerEnd += 1;
  else if (blockCode === 7) headerEnd += 2;
  if (rateCode === 12) headerEnd += 1;
  else if (rateCode === 13 || rateCode === 14) headerEnd += 2;
  const number = utf8Number(sample);
  const result = new Uint8Array(4 + number.byteLength + (headerEnd - 4 - numberLength) + 1 + (frame.byteLength - headerEnd - 1));
  result.set(frame.subarray(0, 4));
  result[1] |= 1;
  let offset = 4;
  result.set(number, offset); offset += number.byteLength;
  result.set(frame.subarray(4 + numberLength, headerEnd), offset); offset += headerEnd - 4 - numberLength;
  result[offset] = crc8(result.subarray(0, offset));
  offset += 1;
  result.set(frame.subarray(headerEnd + 1, frame.byteLength - 2), offset);
  const footer = crc16(result.subarray(0, result.byteLength - 2));
  result[result.byteLength - 2] = footer >> 8;
  result[result.byteLength - 1] = footer;
  return result;
}

function utf8Length(first) {
  if ((first & 0x80) === 0) return 1;
  let mask = 0x80;
  let length = 0;
  while ((first & mask) !== 0) { length += 1; mask >>= 1; }
  return length;
}

function utf8Number(value) {
  if (value < 0x80) return new Uint8Array([value]);
  if (value < 0x800) return new Uint8Array([0xc0 | (value >> 6), 0x80 | (value & 0x3f)]);
  if (value < 0x10000) return new Uint8Array([0xe0 | (value >> 12), 0x80 | ((value >> 6) & 0x3f), 0x80 | (value & 0x3f)]);
  throw new RangeError("fixture sample position exceeded generator's bounded UTF-8 form");
}

function crc8(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function putU16(bytes, offset, value) { bytes[offset] = value >> 8; bytes[offset + 1] = value; }
function putU24(bytes, offset, value) { bytes[offset] = value >> 16; bytes[offset + 1] = value >> 8; bytes[offset + 2] = value; }
function putU64(bytes, offset, input) {
  let value = input;
  for (let index = 7; index >= 0; index -= 1) { bytes[offset + index] = Number(value & 0xffn); value >>= 8n; }
}
