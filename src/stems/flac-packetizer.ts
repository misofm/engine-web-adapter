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
    this.#append(chunk);
    const packets: FlacFramePacket[] = [];
    for (;;) {
      const packet = this.#takeReady();
      if (packet === undefined) return packets;
      packets.push(packet);
    }
  }

  /** Worker path: consume ready packets one at a time without an object queue. */
  async pushTo(chunk: Uint8Array, consume: (packet: FlacFramePacket) => Promise<void>): Promise<void> {
    this.#append(chunk);
    for (;;) {
      const packet = this.#takeReady();
      if (packet === undefined) return;
      await consume(packet);
    }
  }

  #append(chunk: Uint8Array): void {
    if (this.#finished) throw invalid("Frame packetizer is already complete");
    if (chunk.byteLength > MAXIMUM_DELIVERY_CHUNK_BYTES) {
      throw new EngineWebAdapterError("stem.flac.resource_limit", "Delivery chunk exceeds the package limit", {
        bytes: chunk.byteLength,
        limit: MAXIMUM_DELIVERY_CHUNK_BYTES,
      });
    }
    if (chunk.byteLength === 0) return;
    if (this.#expectedAudioBytes !== undefined && this.#received + chunk.byteLength > this.#expectedAudioBytes) {
      throw invalid("Delivered FLAC audio exceeds its declared length");
    }

    this.#received += chunk.byteLength;
    const table = this.#metadata.seekTable;
    const finalOffset = table.byteOffsets[table.length - 1]!;
    if (this.#received - finalOffset > Math.min(this.#metadata.maximumFrameBytes, MAXIMUM_FLAC_FRAME_BYTES)) {
      throw invalid("Final compressed FLAC frame exceeds its byte bound");
    }
    const joined = new Uint8Array(this.#pending.byteLength + chunk.byteLength);
    joined.set(this.#pending);
    joined.set(chunk, this.#pending.byteLength);
    this.#pending = joined;

  }

  #takeReady(): FlacFramePacket | undefined {
    const table = this.#metadata.seekTable;
    if (this.#nextFrame + 1 >= table.length) return undefined;
    const pointOffset = table.byteOffsets[this.#nextFrame]!;
    const boundary = table.byteOffsets[this.#nextFrame + 1]!;
    if (this.#received < boundary) return undefined;
    const length = boundary - pointOffset;
    if (pointOffset !== this.#pendingOffset || length > this.#pending.byteLength) {
      throw invalid("Delivered FLAC bytes disagree with dense seek offsets");
    }
    const packet = {
      sampleNumber: table.sampleNumbers[this.#nextFrame]!,
      frameSamples: table.frameSamples[this.#nextFrame]!,
      bytes: this.#pending.slice(0, length),
    };
    this.#pending = this.#pending.subarray(length);
    this.#pendingOffset = boundary;
    this.#nextFrame += 1;
    return packet;
  }

  finish(): FlacFramePacket[] {
    return [this.#takeFinal()];
  }

  async finishTo(consume: (packet: FlacFramePacket) => Promise<void>): Promise<void> {
    await consume(this.#takeFinal());
  }

  #takeFinal(): FlacFramePacket {
    if (this.#finished) throw invalid("Frame packetizer is already complete");
    this.#finished = true;
    if (this.#expectedAudioBytes !== undefined && this.#received !== this.#expectedAudioBytes) {
      throw invalid("Delivered FLAC audio length is not exact", {
        expectedBytes: this.#expectedAudioBytes,
        actualBytes: this.#received,
      });
    }
    const table = this.#metadata.seekTable;
    const pointOffset = table.byteOffsets[this.#nextFrame];
    if (
      pointOffset === undefined ||
      this.#nextFrame !== table.length - 1 ||
      pointOffset !== this.#pendingOffset ||
      this.#pending.byteLength < this.#metadata.minimumFrameBytes ||
      this.#pending.byteLength > this.#metadata.maximumFrameBytes ||
      this.#pending.byteLength > MAXIMUM_FLAC_FRAME_BYTES
    ) {
      throw invalid("Delivery ended without exactly one valid final FLAC frame");
    }
    return {
      sampleNumber: table.sampleNumbers[this.#nextFrame]!,
      frameSamples: table.frameSamples[this.#nextFrame]!,
      bytes: this.#pending.slice(),
    };
  }
}
