import type { SourceSpec } from "@misofm/engine";

import { EngineWebAdapterError } from "../errors.js";
import type { StemIdentity } from "./types.js";

const STEM_IDENTITY = /^sha256:[0-9a-f]{64}$/u;

export function assertStemIdentity(value: string): asserts value is StemIdentity {
  if (!STEM_IDENTITY.test(value)) {
    throw new EngineWebAdapterError(
      "stem.invalid_declaration",
      "Stem content must be sha256: followed by 64 lowercase hexadecimal digits",
      { content: value },
    );
  }
}

/** Exact canonical PCM byte count declared by one Engine source. */
export function canonicalPcmBytes(spec: SourceSpec): number {
  if (spec.bitDepth === "32f") {
    throw new EngineWebAdapterError(
      "stem.invalid_declaration",
      "The browser adapter supports canonical 16-bit and 24-bit integer PCM only",
      { bitDepth: spec.bitDepth },
    );
  }

  const frames = typeof spec.frames === "bigint" ? spec.frames : BigInt(spec.frames);
  if (frames <= 0n) {
    throw new EngineWebAdapterError(
      "stem.invalid_declaration",
      "Stem frames must be positive",
      { frames: spec.frames },
    );
  }
  assertStemIdentity(spec.content);
  const bytes = frames * BigInt(spec.channels) * BigInt(spec.bitDepth / 8);
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EngineWebAdapterError(
      "stem.invalid_declaration",
      "Canonical stem byte count exceeds the browser adapter's safe integer range",
      { bytes: bytes.toString() },
    );
  }
  return Number(bytes);
}
