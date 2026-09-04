import { EngineWebAdapterError } from "../errors.js";

export const MAXIMUM_DELIVERY_CHUNK_BYTES = 256 * 1024;
export const MAXIMUM_FLAC_METADATA_BYTES = 1024 * 1024;
export const MAXIMUM_FLAC_FRAME_BYTES = 524_320;
export const MAXIMUM_DENSE_SEEK_POINTS = 65_536;

const FLAC_MAGIC = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);
const SUPPORTED_SAMPLE_RATES = new Set([44_100, 48_000, 88_200, 96_000]);

export type DenseFlacSeekTable = Readonly<{
  sampleNumbers: Float64Array;
  byteOffsets: Float64Array;
  frameSamples: Uint16Array;
  length: number;
}>;

export type DenseFlacMetadata = Readonly<{
  sampleRateHz: number;
  channels: 1 | 2;
  bitDepth: 16 | 24;
  totalSamples: number;
  blockSamples: number;
  minimumFrameBytes: number;
  maximumFrameBytes: number;
  streamMd5: Uint8Array;
  decoderDescription: Uint8Array;
  audioDataStart: number;
  seekTable: DenseFlacSeekTable;
}>;

export type DenseFlacMetadataResult = Readonly<{
  metadata: DenseFlacMetadata;
  audioRemainder: Uint8Array;
}>;

function flacFailure(
  code: "stem.flac.invalid" | "stem.flac.resource_limit" | "stem.flac.shape",
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): EngineWebAdapterError {
  return new EngineWebAdapterError(code, message, details);
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!;
}

function u64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(bytes[offset + index]!);
  return value;
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw flacFailure("stem.flac.resource_limit", `${label} exceeds the safe integer range`);
  }
  return Number(value);
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}

function assertMagicPrefix(bytes: Uint8Array): void {
  const length = Math.min(bytes.byteLength, FLAC_MAGIC.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (bytes[index] !== FLAC_MAGIC[index]) throw flacFailure("stem.flac.invalid", "FLAC magic is invalid");
  }
}

function parseStreamInfo(streamInfo: Uint8Array): Omit<DenseFlacMetadata, "audioDataStart" | "seekTable"> {
  const minimumBlockSamples = u16(streamInfo, 0);
  const maximumBlockSamples = u16(streamInfo, 2);
  if (minimumBlockSamples === 0 || minimumBlockSamples !== maximumBlockSamples) {
    throw flacFailure("stem.flac.shape", "STREAMINFO must declare one fixed, nonzero block size", {
      minimumBlockSamples,
      maximumBlockSamples,
    });
  }

  const minimumFrameBytes = u24(streamInfo, 4);
  const maximumFrameBytes = u24(streamInfo, 7);
  if (minimumFrameBytes === 0 || maximumFrameBytes === 0 || minimumFrameBytes > maximumFrameBytes) {
    throw flacFailure("stem.flac.shape", "STREAMINFO has invalid compressed-frame byte bounds", {
      minimumFrameBytes,
      maximumFrameBytes,
    });
  }
  if (maximumFrameBytes > MAXIMUM_FLAC_FRAME_BYTES) {
    throw flacFailure("stem.flac.resource_limit", "STREAMINFO frame bound exceeds the package limit", {
      maximumFrameBytes,
      limit: MAXIMUM_FLAC_FRAME_BYTES,
    });
  }

  const packed = u64(streamInfo, 10);
  const sampleRateHz = Number((packed >> 44n) & 0xfffffn);
  const channelCount = Number((packed >> 41n) & 0x7n) + 1;
  const depth = Number((packed >> 36n) & 0x1fn) + 1;
  const totalSamples = safeNumber(packed & 0xfffffffffn, "total sample count");
  if (!SUPPORTED_SAMPLE_RATES.has(sampleRateHz)) {
    throw flacFailure("stem.flac.shape", `Unsupported FLAC sample rate ${sampleRateHz}`, { sampleRateHz });
  }
  if (channelCount !== 1 && channelCount !== 2) {
    throw flacFailure("stem.flac.shape", `Unsupported FLAC channel count ${channelCount}`, {
      channels: channelCount,
    });
  }
  if (depth !== 16 && depth !== 24) {
    throw flacFailure("stem.flac.shape", `Unsupported FLAC bit depth ${depth}`, { bitDepth: depth });
  }
  if (totalSamples === 0) throw flacFailure("stem.flac.shape", "Empty FLAC streams are not accepted");

  const streamMd5 = streamInfo.slice(18, 34);
  if (streamMd5.every((byte) => byte === 0)) {
    throw flacFailure("stem.flac.invalid", "STREAMINFO must carry a decoded-audio MD5");
  }

  const decoderDescription = new Uint8Array(42);
  decoderDescription.set(FLAC_MAGIC);
  decoderDescription.set([0x80, 0, 0, 34], 4);
  decoderDescription.set(streamInfo, 8);
  return {
    sampleRateHz,
    channels: channelCount as 1 | 2,
    bitDepth: depth as 16 | 24,
    totalSamples,
    blockSamples: minimumBlockSamples,
    minimumFrameBytes,
    maximumFrameBytes,
    streamMd5,
    decoderDescription,
  };
}

function parseDenseSeekTable(
  bytes: Uint8Array,
  stream: ReturnType<typeof parseStreamInfo>,
): DenseFlacSeekTable {
  if (bytes.byteLength === 0 || bytes.byteLength % 18 !== 0) {
    throw flacFailure("stem.flac.invalid", "SEEKTABLE must be a nonempty sequence of seek points");
  }
  const pointCount = bytes.byteLength / 18;
  const expectedPointCount = Math.ceil(stream.totalSamples / stream.blockSamples);
  if (pointCount > MAXIMUM_DENSE_SEEK_POINTS) {
    throw flacFailure("stem.flac.resource_limit", "SEEKTABLE exceeds the seek-point limit", {
      pointCount,
      limit: MAXIMUM_DENSE_SEEK_POINTS,
    });
  }
  if (pointCount !== expectedPointCount) {
    throw flacFailure("stem.flac.invalid", "SEEKTABLE does not contain exactly one point per FLAC frame", {
      pointCount,
      expectedPointCount,
    });
  }

  const sampleNumbers = new Float64Array(pointCount);
  const byteOffsets = new Float64Array(pointCount);
  const frameSamplesByPoint = new Uint16Array(pointCount);
  let priorOffset = -1;
  for (let index = 0; index < pointCount; index += 1) {
    const offset = index * 18;
    const rawSample = u64(bytes, offset);
    if (rawSample === 0xffffffffffffffffn) {
      throw flacFailure("stem.flac.invalid", "Placeholder SEEKTABLE points are forbidden");
    }
    const sampleNumber = safeNumber(rawSample, "seek sample number");
    const byteOffset = safeNumber(u64(bytes, offset + 8), "seek byte offset");
    const frameSamples = u16(bytes, offset + 16);
    const expectedSample = index * stream.blockSamples;
    const expectedFrameSamples = Math.min(stream.blockSamples, stream.totalSamples - expectedSample);
    if (sampleNumber !== expectedSample || frameSamples !== expectedFrameSamples) {
      throw flacFailure("stem.flac.invalid", "SEEKTABLE does not cover every frame in exact sample order", {
        index,
        sampleNumber,
        frameSamples,
        expectedSample,
        expectedFrameSamples,
      });
    }
    if (index === 0 ? byteOffset !== 0 : byteOffset <= priorOffset) {
      throw flacFailure("stem.flac.invalid", "SEEKTABLE byte offsets must increase strictly from zero", {
        index,
        byteOffset,
      });
    }
    if (index > 0) {
      const frameBytes = byteOffset - priorOffset;
      if (
        frameBytes < stream.minimumFrameBytes ||
        frameBytes > stream.maximumFrameBytes ||
        frameBytes > MAXIMUM_FLAC_FRAME_BYTES
      ) {
        throw flacFailure("stem.flac.invalid", "A compressed FLAC frame violates declared byte bounds", {
          index: index - 1,
          frameBytes,
          minimumFrameBytes: stream.minimumFrameBytes,
          maximumFrameBytes: stream.maximumFrameBytes,
        });
      }
    }
    sampleNumbers[index] = sampleNumber;
    byteOffsets[index] = byteOffset;
    frameSamplesByPoint[index] = frameSamples;
    priorOffset = byteOffset;
  }
  return Object.freeze({ sampleNumbers, byteOffsets, frameSamples: frameSamplesByPoint, length: pointCount });
}

/** Incrementally scans bounded legal metadata and locates one dense SEEKTABLE. */
export class DenseFlacMetadataParser {
  #pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  #pendingOffset = 0;
  #nextHeader = 4;
  #blockCount = 0;
  #streamInfo: ReturnType<typeof parseStreamInfo> | undefined;
  #seekTable: DenseFlacSeekTable | undefined;
  #sawSeekTable = false;
  #complete = false;

  /** Bytes retained from incomplete input; processed comments/art are discarded. */
  get bufferedBytes(): number { return this.#pending.byteLength; }

  get maximumBytes(): number {
    if (this.#complete) return MAXIMUM_DELIVERY_CHUNK_BYTES;
    const pendingEnd = this.#pendingOffset + this.#pending.byteLength;
    if (pendingEnd < 4) return 4 - pendingEnd;
    if (pendingEnd < this.#nextHeader + 4) {
      return this.#nextHeader + 4 - pendingEnd;
    }
    const headerOffset = this.#nextHeader - this.#pendingOffset;
    const end = this.#nextHeader + 4 + u24(this.#pending, headerOffset + 1);
    return Math.min(end - pendingEnd, MAXIMUM_DELIVERY_CHUNK_BYTES);
  }

  get phase(): "probe" | "metadata" | "audio" {
    if (this.#complete) return "audio";
    return this.#streamInfo === undefined ? "probe" : "metadata";
  }

  get phaseBytesRemaining(): number {
    if (this.#complete) return 0;
    const pendingEnd = this.#pendingOffset + this.#pending.byteLength;
    if (pendingEnd < 4) return 4 - pendingEnd;
    if (pendingEnd < this.#nextHeader + 4) {
      return this.#nextHeader + 4 - pendingEnd;
    }
    const headerOffset = this.#nextHeader - this.#pendingOffset;
    return this.#nextHeader + 4 + u24(this.#pending, headerOffset + 1) - pendingEnd;
  }

  push(chunk: Uint8Array): DenseFlacMetadataResult | null {
    if (this.#complete) throw flacFailure("stem.flac.invalid", "Metadata parser is already complete");
    if (chunk.byteLength > MAXIMUM_DELIVERY_CHUNK_BYTES) {
      throw flacFailure("stem.flac.resource_limit", "Delivery chunk exceeds the package limit", {
        bytes: chunk.byteLength,
        limit: MAXIMUM_DELIVERY_CHUNK_BYTES,
      });
    }
    this.#pending = append(this.#pending, chunk);
    if (this.#pendingOffset === 0) assertMagicPrefix(this.#pending);
    if (this.#pendingOffset + this.#pending.byteLength < 4) return null;

    while (this.#pendingOffset + this.#pending.byteLength >= this.#nextHeader + 4) {
      const headerOffset = this.#nextHeader - this.#pendingOffset;
      const header = this.#pending[headerOffset]!;
      const isLast = (header & 0x80) !== 0;
      const type = header & 0x7f;
      const length = u24(this.#pending, headerOffset + 1);
      const blockEnd = this.#nextHeader + 4 + length;
      if (blockEnd > MAXIMUM_FLAC_METADATA_BYTES) {
        throw flacFailure("stem.flac.resource_limit", "FLAC metadata exceeds the package limit", {
          bytes: blockEnd,
          limit: MAXIMUM_FLAC_METADATA_BYTES,
        });
      }
      if (type > 6) throw flacFailure("stem.flac.invalid", `Reserved FLAC metadata block type ${type} is not legal`);
      if (this.#pendingOffset + this.#pending.byteLength < blockEnd) return null;

      const relativeEnd = blockEnd - this.#pendingOffset;
      const payload = this.#pending.subarray(headerOffset + 4, relativeEnd);
      if (this.#blockCount === 0 && (type !== 0 || length !== 34)) {
        throw flacFailure("stem.flac.invalid", "The first metadata block must be 34-byte STREAMINFO");
      }
      if (type === 0) {
        if (this.#streamInfo !== undefined || this.#blockCount !== 0 || length !== 34) {
          throw flacFailure("stem.flac.invalid", "FLAC must contain exactly one first 34-byte STREAMINFO");
        }
        this.#streamInfo = parseStreamInfo(payload);
      } else if (type === 3) {
        if (this.#sawSeekTable) {
          throw flacFailure("stem.flac.invalid", "FLAC must contain exactly one SEEKTABLE");
        }
        this.#sawSeekTable = true;
        this.#seekTable = parseDenseSeekTable(payload, this.#streamInfo!);
      }
      this.#blockCount += 1;
      this.#nextHeader = blockEnd;
      this.#pending = this.#pending.slice(relativeEnd);
      this.#pendingOffset = blockEnd;
      if (!isLast) continue;
      if (this.#streamInfo === undefined || this.#seekTable === undefined) {
        throw flacFailure("stem.flac.invalid", "FLAC metadata must contain STREAMINFO and one dense SEEKTABLE");
      }
      const result = {
        metadata: Object.freeze({ ...this.#streamInfo, audioDataStart: blockEnd, seekTable: this.#seekTable }),
        audioRemainder: this.#pending.slice(),
      } satisfies DenseFlacMetadataResult;
      this.#pending = new Uint8Array();
      this.#complete = true;
      return result;
    }
    return null;
  }

  finish(): never {
    throw flacFailure("stem.flac.invalid", "Delivery ended before complete FLAC metadata");
  }
}
