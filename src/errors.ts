export type EngineWebAdapterErrorCode =
  | "capability.audio_worklet"
  | "capability.cross_origin_isolation"
  | "capability.module_worker"
  | "capability.opfs"
  | "capability.shared_array_buffer"
  | "capability.simd128"
  | "capability.webcodecs_audio"
  | "capability.web_locks"
  | "session.closed"
  | "session.declaration_mismatch"
  | "session.open"
  | "stem.cancelled"
  | "stem.corrupt"
  | "stem.decode.output"
  | "stem.flac.invalid"
  | "stem.flac.resource_limit"
  | "stem.flac.shape"
  | "stem.invalid_declaration"
  | "stem.not_found"
  | "stem.quota"
  | "stem.read_deadline";

/** A stable, machine-readable adapter failure. */
export class EngineWebAdapterError extends Error {
  readonly code: EngineWebAdapterErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: EngineWebAdapterErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EngineWebAdapterError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
