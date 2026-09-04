export type EngineWebAdapterErrorCode =
  | "capability.audio_worklet"
  | "capability.cross_origin_isolation"
  | "capability.module_worker"
  | "capability.opfs"
  | "capability.shared_array_buffer"
  | "capability.simd128"
  | "capability.web_locks"
  | "session.closed"
  | "session.declaration_mismatch"
  | "session.input_path"
  | "session.open"
  | "stem.cancelled"
  | "stem.corrupt"
  | "stem.decode.asset"
  | "stem.decode.flac"
  | "stem.decode.output"
  | "stem.decode.stall"
  | "stem.decode.worker"
  | "stem.delivery.address"
  | "stem.delivery.http"
  | "stem.delivery.range"
  | "stem.delivery.retry_exhausted"
  | "stem.delivery.stall"
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
