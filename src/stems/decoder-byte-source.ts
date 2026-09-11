import { Effect, Schema } from "effect";

import { EngineWebAdapterError } from "../errors.js";
import {
  NativeFlacMetadataScanner,
  NATIVE_FLAC_STREAMINFO_PROBE_BYTES,
  parseNativeFlacStreamInfo,
  type NativeFlacStreamInfo,
} from "./native-flac-metadata.js";
import { FLAC_INPUT_SLOT_BYTES } from "./flac-input-slot.js";
import type { CanonicalPcmExpectation, StemIdentity } from "./types.js";

/** The source's expected failure channel; it never exposes an arbitrary throw. */
export class DecoderByteSourceError extends Schema.TaggedError<DecoderByteSourceError>()("DecoderByteSourceError", {
  operation: Schema.Literals(["prepare", "read", "finish"]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

export interface DecoderByteSource {
  readonly prepare: Effect.Effect<{
    readonly streamInfo: NativeFlacStreamInfo;
    readonly expectedFrames: number;
    readonly totalPcmBytes: number;
  }, DecoderByteSourceError>;
  readonly read: (maximumBytes: number) => Effect.Effect<{
    readonly bytes: Uint8Array;
    readonly end: boolean;
    readonly release: () => void;
  }, DecoderByteSourceError>;
  readonly finish: Effect.Effect<void, DecoderByteSourceError>;
}

export interface DecoderByteSourceOptions {
  readonly identity: StemIdentity;
  readonly expected?: CanonicalPcmExpectation;
  readonly range: (phase: "probe" | "metadata" | "audio", start: number, end: number) => Effect.Effect<{
    readonly bytes: Uint8Array;
    readonly totalBytes: number;
    readonly release: () => void;
    /** Internal handoff marker used to quarantine a borrowed range on interruption. */
    readonly handoff?: () => void;
  }, EngineWebAdapterError>;
}

function sourceFailure(operation: DecoderByteSourceError["operation"], cause: unknown): DecoderByteSourceError {
  if (cause instanceof DecoderByteSourceError) return cause;
  const message = cause instanceof Error ? cause.message : `${operation} failed`;
  return new DecoderByteSourceError({ operation, message, cause });
}

/**
 * Construct the private cursor that turns exact delivery ranges into one
 * sequential encoded-byte source. The caller owns the surrounding Effect
 * scope; every borrowed range is copied and released before the next command.
 */
export function makeDecoderByteSource(options: DecoderByteSourceOptions): DecoderByteSource {
  let prepared = false;
  let finished = false;
  let offset = 0;
  let totalBytes: number | undefined;
  let streamInfo: NativeFlacStreamInfo | undefined;
  let expectedFrames = 0;
  let totalPcmBytes = 0;
  const range = (phase: "probe" | "metadata" | "audio", start: number, end: number, operation: DecoderByteSourceError["operation"]) =>
    options.range(phase, start, end).pipe(Effect.mapError(cause => sourceFailure(operation, cause)));

  const prepare = Effect.fn("DecoderByteSource.prepare")(function*() {
    if (prepared) return yield* new DecoderByteSourceError({ operation: "prepare", message: "FLAC decoder source was prepared twice" });
    if (finished) return yield* new DecoderByteSourceError({ operation: "prepare", message: "FLAC decoder source was finished" });
    const probe = yield* range("probe", 0, NATIVE_FLAC_STREAMINFO_PROBE_BYTES - 1, "prepare");
    probe.handoff?.();
    let parsed: Readonly<{ streamInfo: NativeFlacStreamInfo; streamInfoIsFinal: boolean }>;
    try {
      totalBytes = probe.totalBytes;
      parsed = parseNativeFlacStreamInfo(probe.bytes, options.expected);
    } catch (cause) {
      probe.release();
      return yield* Effect.fail(sourceFailure("prepare", cause));
    }
    probe.release();
    const scanner = new NativeFlacMetadataScanner(parsed.streamInfoIsFinal);
    offset = NATIVE_FLAC_STREAMINFO_PROBE_BYTES;
    while (!scanner.complete) {
      const result = yield* range("metadata", scanner.nextHeaderOffset, scanner.nextHeaderOffset + 3, "prepare");
      result.handoff?.();
      let header: number;
      try { header = scanner.acceptHeader(result.bytes, result.totalBytes).nextOffset; }
      catch (cause) {
        result.release();
        return yield* Effect.fail(sourceFailure("prepare", cause));
      }
      result.release();
      offset = header;
    }
    if (totalBytes === undefined || offset >= totalBytes) {
      return yield* new DecoderByteSourceError({ operation: "prepare", message: "FLAC has no compressed audio suffix" });
    }
    expectedFrames = options.expected?.frames ?? parsed.streamInfo.totalSamples;
    if (expectedFrames === 0) {
      return yield* new DecoderByteSourceError({
        operation: "prepare",
        message: "Unknown FLAC total samples require a compiled source declaration",
      });
    }
    totalPcmBytes = options.expected?.canonicalBytes ??
      expectedFrames * parsed.streamInfo.channels * (parsed.streamInfo.bitDepth / 8);
    streamInfo = parsed.streamInfo;
    prepared = true;
    return { streamInfo, expectedFrames, totalPcmBytes };
  })();

  const read = (maximumBytes: number) => Effect.fn("DecoderByteSource.read")(function*() {
    if (!prepared || streamInfo === undefined || totalBytes === undefined) {
      return yield* new DecoderByteSourceError({ operation: "read", message: "FLAC decoder source was read before prepare" });
    }
    if (finished) return yield* new DecoderByteSourceError({ operation: "read", message: "FLAC decoder source was read after finish" });
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > FLAC_INPUT_SLOT_BYTES) {
      return yield* new DecoderByteSourceError({ operation: "read", message: "FLAC Worker requested invalid input credit" });
    }
    if (offset >= totalBytes) {
      return yield* new DecoderByteSourceError({ operation: "read", message: "FLAC Worker requested input outside the audio suffix" });
    }
    const length = Math.min(maximumBytes, totalBytes - offset);
    const result = yield* range("audio", offset, offset + length - 1, "read");
    result.handoff?.();
    try {
      if (result.bytes.byteLength < 1 || result.bytes.byteLength > maximumBytes || result.bytes.byteLength !== length) {
        result.release();
        return yield* new DecoderByteSourceError({ operation: "read", message: "FLAC delivery returned bytes outside the input credit" });
      }
      const bytes = result.bytes;
      const end = offset + bytes.byteLength === totalBytes;
      offset += bytes.byteLength;
      return { bytes, end, release: result.release };
    } catch (cause) {
      result.release();
      return yield* Effect.fail(sourceFailure("read", cause));
    }
  })();

  const finish = Effect.fn("DecoderByteSource.finish")(function*() {
    if (!prepared) return yield* new DecoderByteSourceError({ operation: "finish", message: "FLAC decoder source was finished before prepare" });
    if (finished) return;
    finished = true;
  })();

  return { prepare, read, finish };
}
