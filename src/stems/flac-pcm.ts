import { EngineWebAdapterError } from "../errors.js";

export const MAXIMUM_CANONICAL_OUTPUT_BYTES = 384 * 1024;

export type WebCodecsAudioFormat =
  | "s16"
  | "s16-planar"
  | "s32"
  | "s32-planar"
  | "f32"
  | "f32-planar";

export interface WebCodecsAudioDataLike {
  readonly format: WebCodecsAudioFormat | null;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  allocationSize(options: { readonly planeIndex: number; readonly format?: WebCodecsAudioFormat }): number;
  copyTo(
    destination: AllowSharedBufferSource,
    options: { readonly planeIndex: number; readonly format?: WebCodecsAudioFormat },
  ): void;
  close(): void;
}

function outputFailure(message: string, details: Readonly<Record<string, unknown>> = {}): EngineWebAdapterError {
  return new EngineWebAdapterError("stem.decode.output", message, details);
}

function sampleInteger(
  format: WebCodecsAudioFormat,
  bytes: Uint8Array,
  sampleIndex: number,
  bitDepth: 16 | 24,
): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format.startsWith("s16")) {
    if (bitDepth !== 16) throw outputFailure("s16 AudioData cannot preserve 24-bit source PCM");
    return view.getInt16(sampleIndex * 2, true);
  }
  if (format.startsWith("s32")) {
    const value = view.getInt32(sampleIndex * 4, true);
    const paddingBits = bitDepth === 24 ? 8 : 16;
    const paddingMask = paddingBits === 8 ? 0xff : 0xffff;
    if ((value & paddingMask) !== 0) throw outputFailure("s32 AudioData has nonzero source-depth padding bits");
    return value >> paddingBits;
  }
  const value = view.getFloat32(sampleIndex * 4, true);
  const scale = 2 ** (bitDepth - 1);
  const integer = value * scale;
  if (!Number.isFinite(value) || !Number.isInteger(integer) || integer < -scale || integer > scale - 1) {
    throw outputFailure("f32 AudioData is not exact source-depth PCM");
  }
  return integer;
}

function writeSignedLittleEndian(output: Uint8Array, offset: number, value: number, bytes: 2 | 3): void {
  for (let index = 0; index < bytes; index += 1) output[offset + index] = (value >> (index * 8)) & 0xff;
}

/** Copies and always closes one AudioData, returning source-depth interleaved LE PCM. */
export function audioDataToCanonicalPcm(
  audio: WebCodecsAudioDataLike,
  expected: {
    readonly sampleRateHz: number;
    readonly channels: 1 | 2;
    readonly bitDepth: 16 | 24;
    readonly frameSamples?: number;
  },
): Uint8Array {
  try {
    if (
      audio.sampleRate !== expected.sampleRateHz ||
      audio.numberOfChannels !== expected.channels ||
      !Number.isSafeInteger(audio.numberOfFrames) ||
      audio.numberOfFrames <= 0 ||
      (expected.frameSamples !== undefined && audio.numberOfFrames !== expected.frameSamples)
    ) {
      throw outputFailure("Decoded AudioData shape is not exact");
    }
    const format = audio.format;
    if (
      format === null ||
      !(<readonly (WebCodecsAudioFormat)[]>[
        "s16",
        "s16-planar",
        "s32",
        "s32-planar",
        "f32",
        "f32-planar",
      ]).includes(format)
    ) {
      throw outputFailure(`Unsupported AudioData format ${String(format)}`);
    }

    const bytesPerCanonicalSample: 2 | 3 = expected.bitDepth === 16 ? 2 : 3;
    const outputBytes = audio.numberOfFrames * expected.channels * bytesPerCanonicalSample;
    if (outputBytes > MAXIMUM_CANONICAL_OUTPUT_BYTES) {
      throw new EngineWebAdapterError("stem.flac.resource_limit", "Decoded output block exceeds the package limit", {
        bytes: outputBytes,
        limit: MAXIMUM_CANONICAL_OUTPUT_BYTES,
      });
    }

    const planar = format.endsWith("-planar");
    const storedBytesPerSample = format.startsWith("s16") ? 2 : 4;
    const planeCount = planar ? expected.channels : 1;
    const expectedPlaneBytes = audio.numberOfFrames * (planar ? 1 : expected.channels) * storedBytesPerSample;
    const planes: Uint8Array[] = [];
    for (let planeIndex = 0; planeIndex < planeCount; planeIndex += 1) {
      const size = audio.allocationSize({ planeIndex, format });
      if (size !== expectedPlaneBytes) {
        throw outputFailure("AudioData plane allocation size is not exact", {
          planeIndex,
          size,
          expectedPlaneBytes,
        });
      }
      const plane = new Uint8Array(size);
      audio.copyTo(plane, { planeIndex, format });
      planes.push(plane);
    }

    const output = new Uint8Array(outputBytes);
    for (let frame = 0; frame < audio.numberOfFrames; frame += 1) {
      for (let channel = 0; channel < expected.channels; channel += 1) {
        const plane = planar ? planes[channel]! : planes[0]!;
        const sampleIndex = planar ? frame : frame * expected.channels + channel;
        const value = sampleInteger(format, plane, sampleIndex, expected.bitDepth);
        writeSignedLittleEndian(
          output,
          (frame * expected.channels + channel) * bytesPerCanonicalSample,
          value,
          bytesPerCanonicalSample,
        );
      }
    }
    return output;
  } finally {
    audio.close();
  }
}
