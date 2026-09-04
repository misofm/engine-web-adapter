import { EngineWebAdapterError } from "../errors.js";
import { DenseFlacMetadataParser, MAXIMUM_DELIVERY_CHUNK_BYTES, type DenseFlacMetadata } from "./flac-metadata.js";
import { DenseFlacFramePacketizer, type FlacFramePacket } from "./flac-packetizer.js";
import { audioDataToCanonicalPcm, type WebCodecsAudioDataLike } from "./flac-pcm.js";
import {
  MAXIMUM_FLAC_DECODER_SUBMISSIONS,
  type FlacWorkerResponse,
} from "./flac-worker-protocol.js";
import type { CanonicalPcmExpectation } from "./types.js";

type Decoder = AudioDecoder;
type DecoderGlobals = typeof globalThis & {
  AudioDecoder?: typeof AudioDecoder;
  EncodedAudioChunk?: typeof EncodedAudioChunk;
};

interface FlacInput {
  readonly bytes: Uint8Array;
  readonly totalFlacBytes: number;
}

function validateDeclaration(metadata: DenseFlacMetadata, expected: CanonicalPcmExpectation | undefined): void {
  if (expected === undefined) return;
  const canonicalBytes = metadata.totalSamples * metadata.channels * (metadata.bitDepth / 8);
  if (
    metadata.sampleRateHz !== expected.sampleRateHz ||
    metadata.channels !== expected.channels ||
    metadata.bitDepth !== expected.bitDepth ||
    metadata.totalSamples !== expected.frames ||
    canonicalBytes !== expected.canonicalBytes
  ) {
    throw new EngineWebAdapterError("stem.flac.shape", "FLAC STREAMINFO disagrees with the compiled source declaration", {
      expected,
      actual: {
        sampleRateHz: metadata.sampleRateHz,
        channels: metadata.channels,
        bitDepth: metadata.bitDepth,
        frames: metadata.totalSamples,
        canonicalBytes,
      },
    });
  }
}

/** Worker-testable, credit-driven WebCodecs FLAC ingestion core. */
export async function runFlacIngest(options: {
  readonly requestId: number;
  readonly expected?: CanonicalPcmExpectation;
  readonly post: (reply: FlacWorkerResponse, transfer?: Transferable[]) => void;
  readonly nextInput: () => Promise<FlacInput | null>;
  readonly nextOutputCredit: () => Promise<void>;
  readonly cancelled: () => boolean;
  readonly globals?: DecoderGlobals;
}): Promise<void> {
  const globals = options.globals ?? (globalThis as DecoderGlobals);
  const AudioDecoderConstructor = globals.AudioDecoder;
  const EncodedChunk = globals.EncodedAudioChunk;
  if (AudioDecoderConstructor === undefined || EncodedChunk === undefined) {
    throw new EngineWebAdapterError(
      "capability.webcodecs_audio",
      "This browser does not expose WebCodecs audio decoding in a Worker",
    );
  }

  const parser = new DenseFlacMetadataParser();
  let metadata: DenseFlacMetadata | undefined;
  let packetizer: DenseFlacFramePacketizer | undefined;
  let decoder: Decoder | undefined;
  let totalFlacBytes: number | undefined;
  let submitted = 0;
  let emittedFrames = 0;
  let emittedPcmBytes = 0;
  let decoderFailure: unknown;
  let wakeDecoder: (() => void) | undefined;

  const wake = () => {
    const current = wakeDecoder;
    wakeDecoder = undefined;
    current?.();
  };
  const awaitDecoder = async () => {
    if (decoderFailure !== undefined) throw decoderFailure;
    if (submitted === 0) return;
    await new Promise<void>((resolve) => { wakeDecoder = resolve; });
    if (decoderFailure !== undefined) throw decoderFailure;
  };
  const submit = async (packet: FlacFramePacket) => {
    if (options.cancelled()) return;
    while (submitted >= MAXIMUM_FLAC_DECODER_SUBMISSIONS) await awaitDecoder();
    await options.nextOutputCredit();
    if (options.cancelled()) return;
    const current = metadata!;
    const chunk = new EncodedChunk({
      type: "key",
      timestamp: Math.round(packet.sampleNumber * 1_000_000 / current.sampleRateHz),
      duration: Math.round(packet.frameSamples * 1_000_000 / current.sampleRateHz),
      data: packet.bytes,
    });
    submitted += 1;
    try { decoder!.decode(chunk); } catch (error) { submitted -= 1; throw error; }
  };

  options.post({ type: "ready", requestId: options.requestId });
  try {
    for (;;) {
      if (options.cancelled()) return;
      options.post({
        type: "input-credit",
        requestId: options.requestId,
        maximumBytes: metadata === undefined ? parser.maximumBytes : MAXIMUM_DELIVERY_CHUNK_BYTES,
        phase: metadata === undefined ? parser.phase : "audio",
        phaseBytesRemaining: metadata === undefined ? parser.phaseBytesRemaining : 0,
      });
      const input = await options.nextInput();
      if (input === null) break;
      if (input.bytes.byteLength > MAXIMUM_DELIVERY_CHUNK_BYTES) {
        throw new EngineWebAdapterError("stem.flac.resource_limit", "Worker input exceeds the delivery chunk limit");
      }
      if (totalFlacBytes === undefined) totalFlacBytes = input.totalFlacBytes;
      else if (input.totalFlacBytes !== totalFlacBytes) {
        throw new EngineWebAdapterError("stem.delivery.range", "FLAC total size changed during delivery");
      }

      if (metadata === undefined) {
        const parsed = parser.push(input.bytes);
        if (parsed === null) continue;
        metadata = parsed.metadata;
        validateDeclaration(metadata, options.expected);
        if (totalFlacBytes <= metadata.audioDataStart) {
          throw new EngineWebAdapterError("stem.flac.invalid", "FLAC has no compressed audio suffix");
        }
        packetizer = new DenseFlacFramePacketizer(metadata, {
          expectedAudioBytes: totalFlacBytes - metadata.audioDataStart,
        });
        const config: AudioDecoderConfig = {
          codec: "flac",
          sampleRate: metadata.sampleRateHz,
          numberOfChannels: metadata.channels,
          description: metadata.decoderDescription,
        };
        const supported = await AudioDecoderConstructor.isConfigSupported(config);
        if (supported.supported !== true) {
          throw new EngineWebAdapterError("stem.decode.flac_unsupported", "WebCodecs does not support FLAC decoding");
        }
        const expectedMetadata = metadata;
        decoder = new AudioDecoderConstructor({
          output(audio) {
            try {
              const expectedFrameSamples = expectedMetadata.seekTable.frameSamples[emittedFrames];
              if (expectedFrameSamples === undefined) {
                audio.close();
                throw new EngineWebAdapterError("stem.decode.output", "Decoder emitted an extra AudioData block");
              }
              const pcm = audioDataToCanonicalPcm(audio as unknown as WebCodecsAudioDataLike, {
                sampleRateHz: expectedMetadata.sampleRateHz,
                channels: expectedMetadata.channels,
                bitDepth: expectedMetadata.bitDepth,
                frameSamples: expectedFrameSamples,
              });
              emittedFrames += 1;
              emittedPcmBytes += pcm.byteLength;
              submitted -= 1;
              const bytes = pcm.buffer as ArrayBuffer;
              options.post({
                type: "pcm",
                requestId: options.requestId,
                bytes,
                frames: expectedFrameSamples,
                totalPcmBytes: expectedMetadata.totalSamples * expectedMetadata.channels * (expectedMetadata.bitDepth / 8),
              }, [bytes]);
              wake();
            } catch (error) { decoderFailure = error; wake(); }
          },
          error(error) { decoderFailure = error; wake(); },
        });
        decoder.configure(supported.config ?? config);
        await packetizer.pushTo(parsed.audioRemainder, submit);
      } else {
        await packetizer!.pushTo(input.bytes, submit);
      }
    }

    if (metadata === undefined || packetizer === undefined || decoder === undefined) parser.finish();
    await packetizer!.finishTo(submit);
    while (submitted > 0) await awaitDecoder();
    await decoder!.flush();
    if (decoderFailure !== undefined) throw decoderFailure;
    if (emittedFrames !== metadata!.seekTable.length) {
      throw new EngineWebAdapterError("stem.decode.output", "Decoder output frame count is not exact");
    }
    if (!options.cancelled()) {
      options.post({ type: "complete", requestId: options.requestId, pcmBytes: emittedPcmBytes, frames: metadata!.totalSamples });
    }
  } finally {
    decoder?.close();
  }
}
