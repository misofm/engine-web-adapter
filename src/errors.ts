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
  "session.busy": {
    phase: "lifecycle",
    remedy: "Await seekFrames() before calling play() from a user gesture.",
    transient: true,
  },
  "session.seek": {
    phase: "lifecycle",
    remedy: "Open a new session after paused seek preparation fails; inspect the retained cause.",
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
    remedy: "Republish the stem: the delivered bytes did not hash to the declared sha256 identity.",
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
