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
import { IncrementalSha256 } from "./sha256.js";

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
  /** Operation-local owner for a borrowed range. */
  readonly borrow?: {
    readonly adopt: (release: () => void) => void;
    readonly release: () => void;
  };
  /** Legacy ranged delivery callback. Finite private sources omit it. */
  readonly range?: (phase: "probe" | "metadata" | "audio", start: number, end: number) => Effect.Effect<{
    readonly bytes: Uint8Array;
    readonly totalBytes: number;
    readonly release: () => void;
  }, EngineWebAdapterError>;
}

/** Source-factory boundary for finite packed chunks; no ranged callback is required. */
export type FiniteDecoderByteSourceOptions = Omit<DecoderByteSourceOptions, "range">;
export type FiniteDecoderByteSourceFactory = (options: FiniteDecoderByteSourceOptions) => DecoderByteSource;

export interface FiniteDecoderByteRead {
  readonly bytes: Uint8Array;
  readonly end: boolean;
  readonly release: () => void;
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
    (options.range === undefined
      ? Effect.fail(new DecoderByteSourceError({ operation, message: "FLAC decoder source has no ranged delivery" }))
      : options.range(phase, start, end).pipe(Effect.mapError(cause => sourceFailure(operation, cause))));
  const release = (borrowed: { readonly release: () => void }) => {
    if (options.borrow === undefined) borrowed.release();
    else options.borrow.release();
  };

  const prepare = Effect.fn("DecoderByteSource.prepare")(function*() {
    if (prepared) return yield* new DecoderByteSourceError({ operation: "prepare", message: "FLAC decoder source was prepared twice" });
    if (finished) return yield* new DecoderByteSourceError({ operation: "prepare", message: "FLAC decoder source was finished" });
    const probe = yield* range("probe", 0, NATIVE_FLAC_STREAMINFO_PROBE_BYTES - 1, "prepare");
    let parsed: Readonly<{ streamInfo: NativeFlacStreamInfo; streamInfoIsFinal: boolean }>;
    try {
      totalBytes = probe.totalBytes;
      parsed = parseNativeFlacStreamInfo(probe.bytes, options.expected);
    } catch (cause) {
      release(probe);
      return yield* Effect.fail(sourceFailure("prepare", cause));
    }
    release(probe);
    const scanner = new NativeFlacMetadataScanner(parsed.streamInfoIsFinal);
    offset = NATIVE_FLAC_STREAMINFO_PROBE_BYTES;
    while (!scanner.complete) {
      const result = yield* range("metadata", scanner.nextHeaderOffset, scanner.nextHeaderOffset + 3, "prepare");
      let header: number;
      try { header = scanner.acceptHeader(result.bytes, result.totalBytes).nextOffset; }
      catch (cause) {
        release(result);
        return yield* Effect.fail(sourceFailure("prepare", cause));
      }
      release(result);
      offset = header;
    }
    if (totalBytes === undefined || offset >= totalBytes) {
      const cause = new EngineWebAdapterError("stem.flac.invalid", "FLAC has no compressed audio suffix", { identity: options.identity });
      return yield* new DecoderByteSourceError({ operation: "prepare", message: cause.message, cause });
    }
    expectedFrames = options.expected?.frames ?? parsed.streamInfo.totalSamples;
    if (expectedFrames === 0) {
      const cause = new EngineWebAdapterError("stem.flac.shape", "Unknown FLAC total samples require a compiled source declaration", { identity: options.identity });
      return yield* new DecoderByteSourceError({ operation: "prepare", message: cause.message, cause });
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
    try {
      if (result.bytes.byteLength < 1 || result.bytes.byteLength > maximumBytes || result.bytes.byteLength !== length) {
        release(result);
        return yield* new DecoderByteSourceError({ operation: "read", message: "FLAC delivery returned bytes outside the input credit" });
      }
      const bytes = result.bytes;
      const end = offset + bytes.byteLength === totalBytes;
      offset += bytes.byteLength;
      return { bytes, end, release: () => release(result) };
    } catch (cause) {
      release(result);
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

/**
 * Construct a sequential source for one declared encoded extent. Unlike the
 * legacy source this never asks for a range: metadata payloads are consumed
 * and hashed in order, and finish drains any suffix without worker credits.
 */
export function makeFiniteDecoderByteSource(
  options: FiniteDecoderByteSourceOptions,
  readBytes: (maximumBytes: number) => Effect.Effect<FiniteDecoderByteRead, DecoderByteSourceError | EngineWebAdapterError>,
  totalBytes: number,
  flacSha256: string,
): DecoderByteSource {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) throw new RangeError("finite FLAC extent must be a positive safe integer");
  if (!/^[a-f0-9]{64}$/u.test(flacSha256)) throw new RangeError("finite FLAC digest must be lowercase SHA-256");
  let offset = 0;
  let prepared = false;
  let finished = false;
  let sourceDone = false;
  let seenBytes = 0;
  let streamInfo: NativeFlacStreamInfo | undefined;
  let expectedFrames = 0;
  let totalPcmBytes = 0;
  const hash = new IncrementalSha256();

  const pull = (maximumBytes: number): Effect.Effect<FiniteDecoderByteRead, DecoderByteSourceError> =>
    Effect.gen(function*() {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > FLAC_INPUT_SLOT_BYTES) {
        return yield* new DecoderByteSourceError({ operation: "read", message: "FLAC Worker requested invalid finite input credit" });
      }
      const remaining = totalBytes - offset;
      if (remaining < 1) return yield* new DecoderByteSourceError({ operation: "read", message: "FLAC finite source was read past its extent" });
      const result = yield* readBytes(Math.min(maximumBytes, remaining)).pipe(
        Effect.mapError(cause => cause instanceof DecoderByteSourceError ? cause : new DecoderByteSourceError({ operation: "read", message: cause.message, cause })),
      );
      if (!(result.bytes instanceof Uint8Array) || result.bytes.byteLength < 1 || result.bytes.byteLength > maximumBytes || result.bytes.byteLength > remaining) {
        return yield* new DecoderByteSourceError({ operation: "read", message: "Finite FLAC delivery returned bytes outside its input credit" });
      }
      options.borrow?.adopt(result.release);
      hash.update(result.bytes);
      offset += result.bytes.byteLength;
      seenBytes += result.bytes.byteLength;
      sourceDone = result.end || offset === totalBytes;
      if (sourceDone && offset !== totalBytes) return yield* new DecoderByteSourceError({ operation: "read", message: "Finite FLAC source ended before its declared extent" });
      return { bytes: result.bytes, end: sourceDone, release: result.release };
    });

  const readExact = (length: number, operation: DecoderByteSourceError["operation"]): Effect.Effect<Uint8Array, DecoderByteSourceError> =>
    Effect.gen(function*() {
      const output = new Uint8Array(length);
      let written = 0;
      while (written < length) {
        const result = yield* pull(Math.min(FLAC_INPUT_SLOT_BYTES, length - written));
        output.set(result.bytes, written);
        written += result.bytes.byteLength;
        result.release();
      }
      if (written !== length) return yield* new DecoderByteSourceError({ operation, message: "Finite FLAC source returned a short section" });
      return output;
    });

  const prepare = Effect.gen(function*() {
    if (prepared) return yield* new DecoderByteSourceError({ operation: "prepare", message: "Finite FLAC source was prepared twice" });
    if (finished) return yield* new DecoderByteSourceError({ operation: "prepare", message: "Finite FLAC source was finished" });
    try {
      const probe = yield* readExact(NATIVE_FLAC_STREAMINFO_PROBE_BYTES, "prepare");
      const parsed = parseNativeFlacStreamInfo(probe, options.expected);
      streamInfo = parsed.streamInfo;
      const scanner = new NativeFlacMetadataScanner(parsed.streamInfoIsFinal);
      while (!scanner.complete) {
        const headerOffset = offset;
        const header = yield* readExact(4, "prepare");
        const metadata = scanner.acceptHeader(header, totalBytes);
        if (metadata.offset !== headerOffset) return yield* new DecoderByteSourceError({ operation: "prepare", message: "Finite FLAC metadata cursor lost alignment" });
        let skipped = metadata.nextOffset - offset;
        while (skipped > 0) {
          const result = yield* pull(Math.min(FLAC_INPUT_SLOT_BYTES, skipped));
          skipped -= result.bytes.byteLength;
          result.release();
        }
      }
      if (offset >= totalBytes) return yield* new DecoderByteSourceError({ operation: "prepare", message: "FLAC has no compressed audio suffix" });
      expectedFrames = options.expected?.frames ?? parsed.streamInfo.totalSamples;
      if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 1) return yield* new DecoderByteSourceError({ operation: "prepare", message: "Unknown FLAC total samples require a compiled source declaration" });
      totalPcmBytes = options.expected?.canonicalBytes ?? expectedFrames * parsed.streamInfo.channels * (parsed.streamInfo.bitDepth / 8);
      if (!Number.isSafeInteger(totalPcmBytes) || totalPcmBytes < 1) return yield* new DecoderByteSourceError({ operation: "prepare", message: "Finite FLAC PCM shape is unsafe" });
      prepared = true;
      return { streamInfo: parsed.streamInfo, expectedFrames, totalPcmBytes };
    } catch (cause) {
      if (cause instanceof DecoderByteSourceError) return yield* cause;
      return yield* new DecoderByteSourceError({ operation: "prepare", message: cause instanceof Error ? cause.message : "Finite FLAC preparation failed", cause });
    }
  });

  const read = (maximumBytes: number) => Effect.gen(function*() {
    if (!prepared || streamInfo === undefined) return yield* new DecoderByteSourceError({ operation: "read", message: "Finite FLAC source was read before prepare" });
    if (finished || sourceDone) return yield* new DecoderByteSourceError({ operation: "read", message: "Finite FLAC source was read after its extent" });
    return yield* pull(maximumBytes);
  });

  const finish = Effect.gen(function*() {
    if (!prepared) return yield* new DecoderByteSourceError({ operation: "finish", message: "Finite FLAC source was finished before prepare" });
    if (finished) return;
    while (!sourceDone) {
      const result = yield* pull(FLAC_INPUT_SLOT_BYTES);
      result.release();
    }
    finished = true;
    if (seenBytes !== totalBytes || offset !== totalBytes || hash.digestHex() !== flacSha256) {
      return yield* new DecoderByteSourceError({ operation: "finish", message: "Finite FLAC extent or digest did not verify" });
    }
  });

  return { prepare, read, finish };
}
