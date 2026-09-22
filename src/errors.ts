export type EngineWebAdapterErrorCode =
  | "capability.audio_worklet"
  | "capability.cross_origin_isolation"
  | "capability.module_worker"
  | "capability.opfs"
  | "capability.shared_array_buffer"
  | "capability.simd128"
  | "capability.web_locks"
  | "console.lease_refused"
  | "console.not_attached"
  | "console.refused"
  | "session.closed"
  | "session.busy"
  | "session.seek"
  | "session.declaration_mismatch"
  | "session.input_path"
  | "session.open"
  | "session.playback"
  | "storage.io"
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

/**
 * Where the adapter was when it refused.
 *
 * The phase is what a code alone cannot say quickly: `stem.delivery.http` and
 * `capability.opfs` are both "this session did not open", but only one of them
 * is worth retrying against a different URL.
 */
export type EngineWebAdapterErrorPhase =
  | "capability"
  | "open"
  | "delivery"
  | "decode"
  | "store"
  | "console"
  | "lifecycle";

/**
 * Additive context for an operation which crossed a browser storage boundary.
 * `phase` is deliberately nested in `details`; the public `phase` property
 * remains the coarse adapter phase used by existing consumers.
 */
export interface EngineWebAdapterErrorContext {
  readonly operation: string;
  readonly resource: string;
  readonly phase: string;
}

/**
 * Evidence for a verified mismatch. A corruption code without this shape is
 * not a valid integrity result.
 */
export interface EngineWebAdapterVerification {
  readonly kind: "digest" | "length";
  readonly expected: string | number;
  readonly observed: string | number;
  readonly algorithm?: string;
}

/**
 * Bounded, structured form used when an Error crosses a Worker boundary.
 * `causes` preserves all members of an AggregateError instead of selecting
 * one reason. It is intentionally data-only so callers can log it safely.
 */
export interface EngineWebAdapterErrorCause {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: EngineWebAdapterErrorCause;
  readonly causes?: readonly EngineWebAdapterErrorCause[];
}

interface CodeRow {
  readonly phase: EngineWebAdapterErrorPhase;
  /** What the caller can actually do about it. Never empty. */
  readonly remedy: string;
  /** Whether the identical operation can succeed on a later attempt. */
  readonly transient: boolean;
}

/**
 * One row per code, so a new code cannot ship without a remedy.
 *
 * `Record<EngineWebAdapterErrorCode, CodeRow>` is the gate: adding a member to
 * the union without a row here stops the build. That is why the remedy is a
 * table rather than a constructor argument -- an argument can be forgotten at
 * one of the sixty call sites, a table row cannot.
 */
const CODES: Record<EngineWebAdapterErrorCode, CodeRow> = {
  "session.playback": {
    phase: "lifecycle",
    remedy: "Open a new session after the playback worker fails; inspect the retained cause.",
    transient: false,
  },
  "storage.io": {
    phase: "store",
    remedy: "Inspect details.operation, details.resource, details.phase and the retained cause; retry only after the caller has resolved the named storage condition.",
    transient: false,
  },
  "session.busy": {
    phase: "lifecycle",
    remedy: "Await seekFrames() before calling play() from a user gesture.",
    transient: true,
  },
  "session.seek": {
    phase: "lifecycle",
    remedy: "Open a new session after seek preparation fails; inspect the retained cause.",
    transient: false,
  },
  "capability.audio_worklet": {
    phase: "capability",
    remedy: "Serve over HTTPS or localhost in a browser with AudioWorklet, and confirm the feed worklet module URL resolves.",
    transient: false,
  },
  "capability.cross_origin_isolation": {
    phase: "capability",
    remedy: "Send Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp on the document and every subresource.",
    transient: false,
  },
  "capability.module_worker": {
    phase: "capability",
    remedy: "Serve the package's Worker assets from a same-origin or CORS-enabled URL, and check the assets overrides if you supplied any.",
    transient: false,
  },
  "capability.opfs": {
    phase: "capability",
    remedy: "Use a browser that exposes navigator.storage.getDirectory(); private-mode windows in some browsers do not.",
    transient: false,
  },
  "capability.shared_array_buffer": {
    phase: "capability",
    remedy: "Enable cross-origin isolation so SharedArrayBuffer is available; the shared-memory rings have no fallback.",
    transient: false,
  },
  "capability.simd128": {
    phase: "capability",
    remedy: "Use a browser with WebAssembly SIMD128; the Engine ships no scalar browser build.",
    transient: false,
  },
  "capability.web_locks": {
    phase: "capability",
    remedy: "Use a browser that exposes navigator.locks; the verified store needs it to make one writer per stem.",
    transient: false,
  },
  "console.lease_refused": {
    phase: "console",
    remedy: "Attach the console (do not pass console: false) and keep policy.console.meterBlocks nonzero, then subscribe again.",
    transient: false,
  },
  "console.not_attached": {
    phase: "console",
    remedy: "Open the session without console: false. The adapter attaches the Engine's published default console unless you opt out.",
    transient: false,
  },
  "console.refused": {
    phase: "console",
    remedy: "Correct the edit: check the track id against session.shape.tracks and the parameter against the Engine catalog. Retrying an identical edit will not help.",
    transient: false,
  },
  "session.closed": {
    phase: "lifecycle",
    remedy: "Open a new session; close() is terminal and idempotent.",
    transient: false,
  },
  "session.declaration_mismatch": {
    phase: "open",
    remedy: "Make the session document and any explicit sources declare the same id, content digest, channels, bit depth and frame count.",
    transient: false,
  },
  "session.input_path": {
    phase: "open",
    remedy: "Pass exactly one of flac (the default native-FLAC path) or resolver (the advanced canonical-PCM escape hatch).",
    transient: false,
  },
  "session.open": {
    phase: "open",
    remedy: "Inspect cause for the underlying refusal; the session released everything it had opened before rethrowing.",
    transient: false,
  },
  "stem.cancelled": {
    phase: "lifecycle",
    remedy: "This is the answer to an abort: nothing failed. Drop the signal or open again if the cancellation was not intended.",
    transient: false,
  },
  "stem.corrupt": {
    phase: "store",
    remedy: "Republish the stem: the delivered bytes did not hash to the declared blake3 identity.",
    transient: false,
  },
  "stem.decode.asset": {
    phase: "decode",
    remedy: "Serve the package's libFLAC Wasm asset with Content-Type application/wasm, or override assets.flacDecoderWasmUrl.",
    transient: false,
  },
  "stem.decode.flac": {
    phase: "decode",
    remedy: "Re-encode the stem as standards-compliant native FLAC; the decoder refused the bitstream.",
    transient: false,
  },
  "stem.decode.output": {
    phase: "decode",
    remedy: "Re-encode the stem so its decoded shape matches the declaration; the decoder produced blocks the session did not declare.",
    transient: false,
  },
  "stem.decode.stall": {
    phase: "decode",
    remedy: "Check that the FLAC Worker is not being starved by other main-thread work, then retry the open.",
    transient: true,
  },
  "stem.decode.worker": {
    phase: "decode",
    remedy: "Check that the FLAC Worker asset URL loads as a module Worker; inspect cause for the load or runtime failure.",
    transient: false,
  },
  "stem.delivery.address": {
    phase: "delivery",
    remedy: "Return an absolute URL or a bodyless GET Request from locate(); the adapter never derives a host or filename.",
    transient: false,
  },
  "stem.delivery.http": {
    phase: "delivery",
    remedy: "Return 206 with exact Content-Range and Content-Length and no Content-Encoding; refresh credentials in locate() for each attempt.",
    transient: true,
  },
  "stem.delivery.range": {
    phase: "delivery",
    remedy: "Serve exact byte ranges and keep total size and any visible ETag stable across attempts.",
    transient: false,
  },
  "stem.delivery.retry_exhausted": {
    phase: "delivery",
    remedy: "Fix the transient condition named by cause, or raise flac.maximumAttempts, then open again.",
    transient: true,
  },
  "stem.delivery.stall": {
    phase: "delivery",
    remedy: "The origin stopped sending within the read deadline; check the CDN or raise flac.readDeadlineMs.",
    transient: true,
  },
  "stem.flac.invalid": {
    phase: "decode",
    remedy: "Publish a stem whose STREAMINFO is present and well formed before the first audio frame.",
    transient: false,
  },
  "stem.flac.resource_limit": {
    phase: "decode",
    remedy: "Publish a stem within the package's bounded block and buffer limits, or lower flac.memoryBudgetBytes expectations.",
    transient: false,
  },
  "stem.flac.shape": {
    phase: "decode",
    remedy: "Make the FLAC STREAMINFO agree with the session document: same sample rate, channels, bit depth and frame count.",
    transient: false,
  },
  "stem.invalid_declaration": {
    phase: "open",
    remedy: "Declare 1 or 2 channels, 16- or 24-bit depth, and a frame count inside the browser's exact integer range.",
    transient: false,
  },
  "stem.not_found": {
    phase: "store",
    remedy: "Read a stem the lease declares; the store never serves an identity the session did not require.",
    transient: false,
  },
  "stem.quota": {
    phase: "store",
    remedy: "Free origin storage or reduce the session's total canonical PCM; OPFS refused the write.",
    transient: true,
  },
  "stem.read_deadline": {
    phase: "store",
    remedy: "Another tab holds the write lock for this stem longer than the deadline; close it or retry the open.",
    transient: true,
  },
};

const MAX_SERIALIZED_CAUSE_DEPTH = 4;
const MAX_SERIALIZED_CAUSES = 8;
const MAX_SERIALIZED_STRING = 512;
const MAX_SERIALIZED_DETAIL_KEYS = 24;

/** Runtime guard used by Worker clients before reviving a public code. */
export function isEngineWebAdapterErrorCode(value: unknown): value is EngineWebAdapterErrorCode {
  return typeof value === "string" && Object.hasOwn(CODES, value);
}

/**
 * Convert an arbitrary Error-like value to bounded plain data. This preserves
 * browser exception names and nested causes without making classification
 * decisions from their message text.
 */
export function serializeEngineWebAdapterCause(value: unknown): EngineWebAdapterErrorCause {
  return serializeCause(value, 0, new Set<object>());
}

/** Revive the data-only representation used by the Worker wire protocols. */
export function reviveEngineWebAdapterCause(value: EngineWebAdapterErrorCause): unknown {
  return reviveCause(value, 0);
}

function reviveCause(value: EngineWebAdapterErrorCause, depth: number): Error {
  if (depth >= MAX_SERIALIZED_CAUSE_DEPTH) {
    const bounded = new Error("Nested cause depth exceeded the adapter bound");
    bounded.name = "CauseDepthLimit";
    return bounded;
  }
  const nestedCause = value.cause === undefined ? undefined : reviveCause(value.cause, depth + 1);
  const nestedCauses = value.causes?.slice(0, MAX_SERIALIZED_CAUSES).map((cause) => reviveCause(cause, depth + 1)) ?? [];
  const revived = value.causes === undefined
    ? new Error(value.message, nestedCause === undefined ? undefined : { cause: nestedCause })
    : new AggregateError(nestedCauses, value.message, nestedCause === undefined ? undefined : { cause: nestedCause });
  revived.name = value.name;
  if (value.code !== undefined) Object.defineProperty(revived, "code", { value: value.code, enumerable: true, configurable: true });
  if (value.details !== undefined) Object.defineProperty(revived, "details", { value: value.details, enumerable: true, configurable: true });
  return revived;
}

function serializeCause(value: unknown, depth: number, seen: Set<object>): EngineWebAdapterErrorCause {
  if (depth >= MAX_SERIALIZED_CAUSE_DEPTH) return { name: "CauseDepthLimit", message: "Nested cause depth exceeded the adapter bound" };
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return { name: "CircularCause", message: "Circular cause was omitted at the adapter boundary" };
    seen.add(value);
  }
  const record = value as { readonly name?: unknown; readonly message?: unknown; readonly code?: unknown; readonly details?: unknown; readonly cause?: unknown } | null;
  const name = value instanceof Error
    ? value.name
    : typeof record?.name === "string" ? record.name : value === null ? "null" : typeof value === "object" ? "Object" : typeof value;
  const message = value instanceof Error
    ? value.message
    : typeof record?.message === "string" ? record.message : safeString(value);
  const output: {
    name: string;
    message: string;
    code?: string;
    details?: Readonly<Record<string, unknown>>;
    cause?: EngineWebAdapterErrorCause;
    causes?: readonly EngineWebAdapterErrorCause[];
  } = { name: trimString(name), message: trimString(message) };
  if (typeof record?.code === "string") output.code = trimString(record.code);
  if (isRecord(record?.details)) output.details = boundedRecord(record.details, depth + 1, seen);
  if (value instanceof AggregateError) {
    output.causes = value.errors.slice(0, MAX_SERIALIZED_CAUSES).map((item) => serializeCause(item, depth + 1, seen));
  }
  const nested = readCause(value);
  if (nested.found) output.cause = serializeCause(nested.value, depth + 1, seen);
  return output;
}

function readCause(value: unknown): { readonly found: boolean; readonly value?: unknown } {
  if (typeof value !== "object" || value === null) return { found: false };
  try {
    if (!Object.hasOwn(value, "cause") && !("cause" in value)) return { found: false };
    return { found: true, value: (value as { readonly cause?: unknown }).cause };
  } catch {
    return { found: true, value: "Cause getter threw while crossing the adapter boundary" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedRecord(value: Record<string, unknown>, depth: number, seen: Set<object>): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, MAX_SERIALIZED_DETAIL_KEYS)) {
    try { result[key] = boundedValue(value[key], depth, seen); }
    catch { result[key] = "Unable to serialize detail"; }
  }
  return result;
}

function boundedValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return `${value}n`;
  if (depth >= MAX_SERIALIZED_CAUSE_DEPTH) return "[detail depth limit]";
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular detail]";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, MAX_SERIALIZED_CAUSES).map((item) => boundedValue(item, depth + 1, seen));
    return boundedRecord(value as Record<string, unknown>, depth + 1, seen);
  }
  return safeString(value);
}

function trimString(value: string): string { return value.length > MAX_SERIALIZED_STRING ? value.slice(0, MAX_SERIALIZED_STRING) : value; }
function safeString(value: unknown): string { try { return String(value); } catch { return "[unprintable cause]"; } }

/**
 * The single adapter-boundary failure.
 *
 * Every rejection a consumer can observe is this class. `code` is the stable
 * machine-readable name, `phase` says where the adapter was, `remedy` says what
 * to do, and `transient` says whether the identical operation could succeed
 * later. No Engine host object, Effect value or Worker message reaches a
 * consumer through it -- only `details`, which is frozen plain data, and
 * `cause`.
 */
export class EngineWebAdapterError extends Error {
  readonly code: EngineWebAdapterErrorCode;
  readonly phase: EngineWebAdapterErrorPhase;
  readonly remedy: string;
  readonly transient: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: EngineWebAdapterErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    const row = CODES[code];
    this.name = "EngineWebAdapterError";
    this.code = code;
    this.phase = row.phase;
    this.remedy = row.remedy;
    // A delivery layer that already decided an attempt was retryable outranks
    // the table: it inspected the actual response, the table only knows a code.
    this.transient = details.retryable === true ? true : row.transient;
    this.details = Object.freeze({ ...details });
  }
}
