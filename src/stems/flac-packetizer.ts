import { EngineWebAdapterError } from "../errors.js";
import {
  MAXIMUM_DELIVERY_CHUNK_BYTES,
  MAXIMUM_FLAC_FRAME_BYTES,
  type DenseFlacMetadata,
} from "./flac-metadata.js";

export type FlacFramePacket = Readonly<{
  sampleNumber: number;
  frameSamples: number;
  bytes: Uint8Array;
}>;

function invalid(message: string, details: Readonly<Record<string, unknown>> = {}): EngineWebAdapterError {
  return new EngineWebAdapterError("stem.flac.invalid", message, details);
}

/** Splits audio bytes solely at validated dense SEEKTABLE offsets. */
export class DenseFlacFramePacketizer {
  readonly #metadata: DenseFlacMetadata;
  readonly #expectedAudioBytes: number | undefined;
  #pending = new Uint8Array();
  #pendingOffset = 0;
  #received = 0;
  #nextFrame = 0;
  #finished = false;

  constructor(metadata: DenseFlacMetadata, options: { readonly expectedAudioBytes?: number } = {}) {
    this.#metadata = metadata;
    this.#expectedAudioBytes = options.expectedAudioBytes;
    if (
      options.expectedAudioBytes !== undefined &&
      (!Number.isSafeInteger(options.expectedAudioBytes) || options.expectedAudioBytes <= 0)
    ) {
      throw invalid("Expected FLAC audio length is invalid");
    }
  }

  push(chunk: Uint8Array): FlacFramePacket[] {
    if (this.#finished) throw invalid("Frame packetizer is already complete");
    if (chunk.byteLength > MAXIMUM_DELIVERY_CHUNK_BYTES) {
      throw new EngineWebAdapterError("stem.flac.resource_limit", "Delivery chunk exceeds the package limit", {
        bytes: chunk.byteLength,
        limit: MAXIMUM_DELIVERY_CHUNK_BYTES,
      });
    }
    if (chunk.byteLength === 0) return [];
    if (this.#expectedAudioBytes !== undefined && this.#received + chunk.byteLength > this.#expectedAudioBytes) {
      throw invalid("Delivered FLAC audio exceeds its declared length");
    }

    this.#received += chunk.byteLength;
    const finalOffset = this.#metadata.seekPoints.at(-1)!.byteOffset;
    if (this.#received - finalOffset > Math.min(this.#metadata.maximumFrameBytes, MAXIMUM_FLAC_FRAME_BYTES)) {
      throw invalid("Final compressed FLAC frame exceeds its byte bound");
    }
    const joined = new Uint8Array(this.#pending.byteLength + chunk.byteLength);
    joined.set(this.#pending);
    joined.set(chunk, this.#pending.byteLength);
    this.#pending = joined;

    const packets: FlacFramePacket[] = [];
    while (this.#nextFrame + 1 < this.#metadata.seekPoints.length) {
      const point = this.#metadata.seekPoints[this.#nextFrame]!;
      const boundary = this.#metadata.seekPoints[this.#nextFrame + 1]!.byteOffset;
      if (this.#received < boundary) break;
      const length = boundary - point.byteOffset;
      if (point.byteOffset !== this.#pendingOffset || length > this.#pending.byteLength) {
        throw invalid("Delivered FLAC bytes disagree with dense seek offsets");
      }
      packets.push({
        sampleNumber: point.sampleNumber,
        frameSamples: point.frameSamples,
        bytes: this.#pending.slice(0, length),
      });
      this.#pending = this.#pending.slice(length);
      this.#pendingOffset = boundary;
      this.#nextFrame += 1;
    }
    return packets;
  }

  finish(): FlacFramePacket[] {
    if (this.#finished) throw invalid("Frame packetizer is already complete");
    this.#finished = true;
    if (this.#expectedAudioBytes !== undefined && this.#received !== this.#expectedAudioBytes) {
      throw invalid("Delivered FLAC audio length is not exact", {
        expectedBytes: this.#expectedAudioBytes,
        actualBytes: this.#received,
      });
    }
    const point = this.#metadata.seekPoints[this.#nextFrame];
    if (
      point === undefined ||
      this.#nextFrame !== this.#metadata.seekPoints.length - 1 ||
      point.byteOffset !== this.#pendingOffset ||
      this.#pending.byteLength < this.#metadata.minimumFrameBytes ||
      this.#pending.byteLength > this.#metadata.maximumFrameBytes ||
      this.#pending.byteLength > MAXIMUM_FLAC_FRAME_BYTES
    ) {
      throw invalid("Delivery ended without exactly one valid final FLAC frame");
    }
    return [{ sampleNumber: point.sampleNumber, frameSamples: point.frameSamples, bytes: this.#pending.slice() }];
  }
}
