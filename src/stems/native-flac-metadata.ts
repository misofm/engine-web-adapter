import { EngineWebAdapterError } from "../errors.js";
import type { CanonicalPcmExpectation } from "./types.js";

export const NATIVE_FLAC_STREAMINFO_PROBE_BYTES = 42;
export const MAXIMUM_FLAC_METADATA_BLOCKS = 128;

export interface NativeFlacStreamInfo {
  readonly sampleRateHz: number;
  readonly channels: 1 | 2;
  readonly bitDepth: 16 | 24;
  /** Zero is the standards-defined unknown count. */
  readonly totalSamples: number;
  readonly minimumBlockSamples: number;
  readonly maximumBlockSamples: number;
  readonly minimumFrameBytes: number;
  readonly maximumFrameBytes: number;
  readonly streamMd5: Uint8Array;
  readonly decoderDescription: Uint8Array;
}

export interface NativeFlacMetadataHeader {
  readonly type: number;
  readonly length: number;
  readonly final: boolean;
  readonly offset: number;
  readonly nextOffset: number;
}

function invalid(message: string, details: Readonly<Record<string, unknown>> = {}): EngineWebAdapterError {
  return new EngineWebAdapterError("stem.flac.invalid", message, details);
}

function shape(message: string, details: Readonly<Record<string, unknown>> = {}): EngineWebAdapterError {
  return new EngineWebAdapterError("stem.flac.shape", message, details);
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

/** Parse exactly `fLaC`, the first metadata header, and its STREAMINFO payload. */
export function parseNativeFlacStreamInfo(
  probe: Uint8Array,
  expected?: CanonicalPcmExpectation,
): Readonly<{ streamInfo: NativeFlacStreamInfo; streamInfoIsFinal: boolean }> {
  if (probe.byteLength !== NATIVE_FLAC_STREAMINFO_PROBE_BYTES) {
    throw invalid("Native FLAC STREAMINFO probe must be exactly 42 bytes", { bytes: probe.byteLength });
  }
  if (probe[0] !== 0x66 || probe[1] !== 0x4c || probe[2] !== 0x61 || probe[3] !== 0x43) {
    throw invalid("FLAC magic is invalid");
  }
  const first = probe[4]!;
  if ((first & 0x7f) !== 0 || u24(probe, 5) !== 34) {
    throw invalid("The first FLAC metadata block must be exactly one 34-byte STREAMINFO");
  }
  const minimumBlockSamples = u16(probe, 8);
  const maximumBlockSamples = u16(probe, 10);
  if (minimumBlockSamples < 16 || maximumBlockSamples < minimumBlockSamples) {
    throw shape("STREAMINFO block-size bounds are invalid", { minimumBlockSamples, maximumBlockSamples });
  }
  const minimumFrameBytes = u24(probe, 12);
  const maximumFrameBytes = u24(probe, 15);
  if (minimumFrameBytes !== 0 && maximumFrameBytes !== 0 && minimumFrameBytes > maximumFrameBytes) {
    throw shape("STREAMINFO frame-size bounds are invalid", { minimumFrameBytes, maximumFrameBytes });
  }
  const packed = u64(probe, 18);
  const sampleRateHz = Number((packed >> 44n) & 0xfffffn);
  const channels = Number((packed >> 41n) & 0x7n) + 1;
  const bitDepth = Number((packed >> 36n) & 0x1fn) + 1;
  const totalSamples = Number(packed & 0xfffffffffn);
  if (![44_100, 48_000, 88_200, 96_000].includes(sampleRateHz)) {
    throw shape(`Unsupported FLAC sample rate ${sampleRateHz}`, { sampleRateHz });
  }
  if (channels !== 1 && channels !== 2) throw shape(`Unsupported FLAC channel count ${channels}`, { channels });
  if (bitDepth !== 16 && bitDepth !== 24) throw shape(`Unsupported FLAC bit depth ${bitDepth}`, { bitDepth });
  if (expected !== undefined) {
    const knownBytes = totalSamples * channels * (bitDepth / 8);
    if (
      sampleRateHz !== expected.sampleRateHz || channels !== expected.channels || bitDepth !== expected.bitDepth ||
      (totalSamples !== 0 && (totalSamples !== expected.frames || knownBytes !== expected.canonicalBytes))
    ) {
      throw shape("FLAC STREAMINFO disagrees with the compiled source declaration", {
        expected,
        actual: { sampleRateHz, channels, bitDepth, totalSamples, canonicalBytes: totalSamples === 0 ? undefined : knownBytes },
      });
    }
  }
  const decoderDescription = probe.slice();
  decoderDescription[4] = 0x80;
  const streamInfo = Object.freeze({
    sampleRateHz, channels: channels as 1 | 2, bitDepth: bitDepth as 16 | 24, totalSamples,
    minimumBlockSamples, maximumBlockSamples, minimumFrameBytes, maximumFrameBytes,
    streamMd5: probe.slice(26, 42), decoderDescription,
  });
  return Object.freeze({ streamInfo, streamInfoIsFinal: (first & 0x80) !== 0 });
}

/** Constant-memory walker: callers request only each returned four-byte header. */
export class NativeFlacMetadataScanner {
  #nextOffset = NATIVE_FLAC_STREAMINFO_PROBE_BYTES;
  #blockCount = 1;
  #complete = false;

  constructor(streamInfoIsFinal: boolean) {
    this.#complete = streamInfoIsFinal;
  }

  get complete(): boolean { return this.#complete; }
  get nextHeaderOffset(): number {
    if (this.#complete) throw invalid("FLAC metadata scan is already complete");
    return this.#nextOffset;
  }

  acceptHeader(header: Uint8Array, totalObjectBytes: number): NativeFlacMetadataHeader {
    if (this.#complete) throw invalid("FLAC metadata scan is already complete");
    if (header.byteLength !== 4) throw invalid("FLAC metadata header probe must be exactly four bytes", { bytes: header.byteLength });
    if (!Number.isSafeInteger(totalObjectBytes) || totalObjectBytes <= 0) throw invalid("FLAC object size is invalid");
    if (this.#blockCount >= MAXIMUM_FLAC_METADATA_BLOCKS) {
      throw new EngineWebAdapterError("stem.flac.resource_limit", "FLAC metadata block count exceeds the package limit", {
        limit: MAXIMUM_FLAC_METADATA_BLOCKS,
      });
    }
    const rawType = header[0]!;
    const type = rawType & 0x7f;
    if (type === 0) throw invalid("FLAC contains more than one STREAMINFO block");
    if (type > 6) throw invalid(`Reserved FLAC metadata block type ${type} is not legal`);
    const length = u24(header, 1);
    const nextOffset = this.#nextOffset + 4 + length;
    if (!Number.isSafeInteger(nextOffset) || nextOffset >= totalObjectBytes) {
      throw invalid("FLAC metadata extends beyond the stable object size", {
        offset: this.#nextOffset, length, totalObjectBytes,
      });
    }
    const result = Object.freeze({
      type, length, final: (rawType & 0x80) !== 0, offset: this.#nextOffset, nextOffset,
    });
    this.#blockCount += 1;
    this.#nextOffset = nextOffset;
    this.#complete = result.final;
    return result;
  }
}
