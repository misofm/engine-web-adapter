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
  readonly role?: "body" | "finalizer";
  readonly code?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: EngineWebAdapterErrorCause;
  readonly causes?: readonly EngineWebAdapterErrorCause[];
  readonly truncated?: true;
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
const MAX_SERIALIZED_PAYLOAD = 16 * 1024;
const SERIALIZED_TRUNCATION_RESERVE = 64;

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
  const budget: SerializationBudget = { used: 0, truncated: false };
  const serialized = serializeCause(value, 0, new Set<object>(), budget);
  const marked = budget.truncated ? { ...serialized, truncated: true as const } : serialized;
  return jsonLength(marked) <= MAX_SERIALIZED_PAYLOAD ? marked : compactCause(marked);
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
  const nestedCauses = Array.isArray(value.causes)
    ? value.causes.slice(0, MAX_SERIALIZED_CAUSES).map((cause) => reviveCause(cause, depth + 1))
    : [];
  const revived = value.causes === undefined
    ? new Error(value.message, nestedCause === undefined ? undefined : { cause: nestedCause })
    : new AggregateError(nestedCauses, value.message, nestedCause === undefined ? undefined : { cause: nestedCause });
  revived.name = value.name;
  if (value.role !== undefined) Object.defineProperty(revived, "role", { value: value.role, enumerable: true, configurable: true });
  if (value.truncated === true) Object.defineProperty(revived, "truncated", { value: true, enumerable: true, configurable: true });
  if (value.code !== undefined && !(value.code === "stem.corrupt" && !serializedVerification(value.details?.verification))) {
    Object.defineProperty(revived, "code", { value: value.code, enumerable: true, configurable: true });
  }
  if (value.details !== undefined) Object.defineProperty(revived, "details", { value: value.details, enumerable: true, configurable: true });
  return revived;
}

interface SerializationBudget { used: number; truncated: boolean }
interface MutableSerializedCause {
  [key: string]: unknown;
  name: string;
  message: string;
  role?: "body" | "finalizer";
  code?: string;
  details?: Readonly<Record<string, unknown>>;
  cause?: EngineWebAdapterErrorCause;
  causes?: readonly EngineWebAdapterErrorCause[];
  truncated?: true;
}
interface ContainerState { count: number }
interface PropertyRead { found: boolean; value?: unknown; threw?: boolean }

function serializeCause(value: unknown, depth: number, seen: Set<object>, budget: SerializationBudget): EngineWebAdapterErrorCause {
  if (depth >= MAX_SERIALIZED_CAUSE_DEPTH) {
    budget.truncated = true;
    return { name: "CauseDepthLimit", message: "Nested cause depth exceeded the adapter bound" };
  }
  if (isObjectLike(value)) {
    if (seen.has(value)) {
      budget.truncated = true;
      return { name: "CircularCause", message: "Circular cause was omitted at the adapter boundary" };
    }
    seen.add(value);
  }
  const output = {} as MutableSerializedCause;
  const state = beginContainer(budget);
  if (state === undefined) {
    budget.truncated = true;
    return { name: "CausePayloadLimit", message: "Cause payload exceeded the adapter bound" };
  }
  const nameRead = readProperty(value, "name");
  const messageRead = readProperty(value, "message");
  addValue(output, state, "name", trimString(typeof nameRead.value === "string" ? nameRead.value : causeName(value)), budget);
  addValue(output, state, "message", trimString(typeof messageRead.value === "string" ? messageRead.value : safeString(value)), budget);

  const roleRead = readProperty(value, "role");
  if (roleRead.value === "body" || roleRead.value === "finalizer") {
    if (addValue(output, state, "role", roleRead.value, budget)) output.role = roleRead.value;
  }

  const detailsRead = readProperty(value, "details");
  const codeRead = readProperty(value, "code");
  const rawCode = typeof codeRead.value === "string" ? trimString(codeRead.value) : undefined;
  let serializedDetails: Readonly<Record<string, unknown>> | undefined;
  if (detailsRead.threw) {
    budget.truncated = true;
    serializedDetails = { serialization: "details-unreadable" };
  } else if (isPlainRecord(detailsRead.value)) {
    serializedDetails = serializeDetails(detailsRead.value, depth + 1, seen, budget,
      rawCode === "stem.corrupt" && !serializedVerification(readProperty(detailsRead.value, "verification").value)
        ? "integrity-evidence-insufficient" : undefined);
  }
  if (serializedDetails !== undefined) {
    if (reserveChildField(output, state, "details", budget)) output.details = serializedDetails;
  }
  const verified = serializedVerification(serializedDetails?.verification);
  if (rawCode !== undefined && (rawCode !== "stem.corrupt" || verified !== undefined)) {
    addValue(output, state, "code", rawCode, budget);
  } else if (rawCode === "stem.corrupt") {
    budget.truncated = true;
    if (output.details === undefined) {
      output.details = { serialization: "integrity-evidence-insufficient" };
    } else if (isPlainRecord(output.details) && output.details.serialization === undefined) {
      (output.details as Record<string, unknown>).serialization = "integrity-evidence-insufficient";
    }
  }

  const aggregate = aggregateValues(value);
  if (aggregate.threw || aggregate.truncated) budget.truncated = true;
  if (aggregate.values !== undefined) {
    if (aggregate.values.length > MAX_SERIALIZED_CAUSES) budget.truncated = true;
    if (reserveChildField(output, state, "causes", budget)) {
      const causes = serializeCauseArray(aggregate.values, depth + 1, seen, budget);
      output.causes = causes;
    }
  }
  const nested = readCause(value);
  if (nested.found) {
    const nestedValue = nested.threw
      ? { name: "CauseAccessError", message: "Cause getter threw while crossing the adapter boundary" }
      : nested.value;
    if (reserveChildField(output, state, "cause", budget)) output.cause = serializeCause(nestedValue, depth + 1, seen, budget);
  }
  if (readProperty(value, "truncated").value === true) budget.truncated = true;
  return output;
}

function readCause(value: unknown): PropertyRead {
  return readProperty(value, "cause");
}

function aggregateValues(value: unknown): { readonly values?: readonly unknown[]; readonly threw?: boolean; readonly truncated?: boolean } {
  const aggregate = isAggregate(value);
  const read = readProperty(value, aggregate ? "errors" : "causes");
  if (read.threw) return { threw: true };
  if (!isArray(read.value)) return {};
  const values = boundedArrayValues(read.value);
  return { values, ...(safeArrayLength(read.value) > MAX_SERIALIZED_CAUSES ? { truncated: true } : {}) };
}

function serializeCauseArray(values: readonly unknown[], depth: number, seen: Set<object>, budget: SerializationBudget): readonly EngineWebAdapterErrorCause[] {
  const state = beginArray(budget);
  if (state === undefined) return [];
  const output: EngineWebAdapterErrorCause[] = [];
  for (let index = 0; index < Math.min(values.length, MAX_SERIALIZED_CAUSES); index += 1) {
    if (!reserveArrayItem(state, budget)) break;
    output.push(serializeCause(values[index], depth, seen, budget));
  }
  return output;
}

function serializeDetails(
  value: Record<string, unknown>,
  depth: number,
  seen: Set<object>,
  budget: SerializationBudget,
  marker?: string,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  if (seen.has(value)) {
    budget.truncated = true;
    return { serialization: "circular detail" };
  }
  seen.add(value);
  const state = beginContainer(budget);
  if (state === undefined) return result;
  if (depth >= MAX_SERIALIZED_CAUSE_DEPTH) {
    budget.truncated = true;
    const verification = readProperty(value, "verification");
    const proof = verification.threw ? undefined : serializedVerification(verification.value);
    if (proof !== undefined) addValue(result, state, "verification", proof, budget);
    else addValue(result, state, "serialization", "detail depth limit", budget);
    return result;
  }
  if (marker !== undefined) addValue(result, state, "serialization", marker, budget);
  const verification = readProperty(value, "verification");
  if (verification.threw) {
    budget.truncated = true;
    addValue(result, state, "verification", "Unable to serialize verification evidence", budget);
  } else {
    const proof = serializedVerification(verification.value);
    if (proof !== undefined) addValue(result, state, "verification", proof, budget);
  }
  try {
    const keys = enumerableKeys(value);
    for (const key of keys.values) {
      if (key === "verification") continue;
      const property = readProperty(value, key);
      const outputKey = trimString(key);
      if (property.threw) {
        addValue(result, state, outputKey, "Unable to serialize detail", budget);
        continue;
      }
      addBoundedValue(result, state, outputKey, property.value, depth, seen, budget);
    }
    if (keys.truncated) budget.truncated = true;
  } catch {
    budget.truncated = true;
  }
  return result;
}

function addBoundedValue(
  target: Record<string, unknown>,
  state: ContainerState,
  key: string,
  value: unknown,
  depth: number,
  seen: Set<object>,
  budget: SerializationBudget,
): void {
  if (depth >= MAX_SERIALIZED_CAUSE_DEPTH) {
    budget.truncated = true;
    addValue(target, state, key, "[detail depth limit]", budget);
    return;
  }
  if (isArray(value)) {
    if (!reserveFieldPrefix(state, key, budget)) return;
    target[key] = boundedArray(value, depth + 1, seen, budget);
    return;
  }
  if (isPlainRecord(value)) {
    if (!reserveFieldPrefix(state, key, budget)) return;
    target[key] = serializeDetails(value, depth + 1, seen, budget);
    return;
  }
  addValue(target, state, key, boundedScalar(value), budget);
}

function boundedArray(value: unknown[], depth: number, seen: Set<object>, budget: SerializationBudget): readonly unknown[] {
  if (seen.has(value)) {
    budget.truncated = true;
    return ["[circular detail]"];
  }
  seen.add(value);
  const state = beginArray(budget);
  if (state === undefined) return [];
  if (depth >= MAX_SERIALIZED_CAUSE_DEPTH) {
    budget.truncated = true;
    return ["[detail depth limit]"];
  }
  const output: unknown[] = [];
  const length = safeArrayLength(value);
  for (let index = 0; index < Math.min(length, MAX_SERIALIZED_CAUSES); index += 1) {
    let item: unknown;
    try { item = value[index]; }
    catch { item = "Unable to serialize detail"; budget.truncated = true; }
    if (isArray(item)) {
      if (!reserveArrayItem(state, budget)) break;
      output.push(boundedArray(item, depth + 1, seen, budget));
    } else if (isPlainRecord(item)) {
      if (!reserveArrayItem(state, budget)) break;
      output.push(serializeDetails(item, depth + 1, seen, budget));
    } else {
      if (!reserveArrayValue(state, boundedScalar(item), budget)) break;
      output.push(boundedScalar(item));
    }
  }
  if (length > MAX_SERIALIZED_CAUSES) budget.truncated = true;
  return output;
}

function boundedScalar(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return trimString(value);
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return trimString(`${value}n`);
  return trimString(safeString(value));
}

function serializedVerification(value: unknown): EngineWebAdapterVerification | undefined {
  if (!isObjectLike(value)) return undefined;
  const kind = readProperty(value, "kind").value;
  const expected = readProperty(value, "expected").value;
  const observed = readProperty(value, "observed").value;
  const algorithm = readProperty(value, "algorithm").value;
  if ((kind !== "digest" && kind !== "length") ||
    (typeof expected !== "string" && typeof expected !== "number") ||
    (typeof observed !== "string" && typeof observed !== "number") ||
    expected === observed ||
    (algorithm !== undefined && typeof algorithm !== "string")) return undefined;
  return {
    kind,
    expected: typeof expected === "string" ? trimString(expected) : expected,
    observed: typeof observed === "string" ? trimString(observed) : observed,
    ...(algorithm === undefined ? {} : { algorithm: trimString(algorithm) }),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObjectLike(value) || isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isArray(value: unknown): value is unknown[] {
  try { return Array.isArray(value); }
  catch { return false; }
}

function isAggregate(value: unknown): boolean {
  try { return value instanceof AggregateError; }
  catch { return false; }
}

function readProperty(value: unknown, property: string): PropertyRead {
  if (!isObjectLike(value)) return { found: false };
  try {
    if (!(property in value)) return { found: false };
    return { found: true, value: (value as Record<string, unknown>)[property] };
  } catch {
    return { found: true, threw: true };
  }
}

function enumerableKeys(value: Record<string, unknown>): { readonly values: readonly string[]; readonly truncated: boolean } {
  const keys: string[] = [];
  let truncated = false;
  for (const key in value) {
    try {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
      if (keys.length >= MAX_SERIALIZED_DETAIL_KEYS) {
        truncated = true;
        break;
      }
      keys.push(key);
    } catch {
      truncated = true;
      break;
    }
  }
  return { values: keys, truncated };
}

function boundedArrayValues(value: unknown[]): readonly unknown[] {
  const length = safeArrayLength(value);
  const output: unknown[] = [];
  for (let index = 0; index < Math.min(length, MAX_SERIALIZED_CAUSES); index += 1) {
    try { output.push(value[index]); }
    catch { output.push({ name: "CauseAccessError", message: "Aggregate member could not be read" }); }
  }
  return output;
}

function safeArrayLength(value: unknown[]): number {
  try { return Number.isSafeInteger(value.length) && value.length >= 0 ? value.length : 0; }
  catch { return 0; }
}

function beginContainer(budget: SerializationBudget): ContainerState | undefined {
  return reserve(budget, 2) ? { count: 0 } : undefined;
}

function beginArray(budget: SerializationBudget): ContainerState | undefined {
  return beginContainer(budget);
}

function reserveChildField(target: Record<string, unknown>, state: ContainerState, key: string, budget: SerializationBudget): boolean {
  void target;
  return reserveFieldPrefix(state, key, budget);
}

function reserveFieldPrefix(state: ContainerState, key: string, budget: SerializationBudget): boolean {
  if (!reserve(budget, jsonLength(key) + 1 + (state.count === 0 ? 0 : 1))) return false;
  state.count += 1;
  return true;
}

function addValue(target: Record<string, unknown>, state: ContainerState, key: string, value: unknown, budget: SerializationBudget): boolean {
  if (!reserveFieldPrefix(state, key, budget) || !reserve(budget, jsonLength(value))) return false;
  target[key] = value;
  return true;
}

function reserveArrayItem(state: ContainerState, budget: SerializationBudget): boolean {
  if (!reserve(budget, state.count === 0 ? 0 : 1)) return false;
  state.count += 1;
  return true;
}

function reserveArrayValue(state: ContainerState, value: unknown, budget: SerializationBudget): boolean {
  return reserveArrayItem(state, budget) && reserve(budget, jsonLength(value));
}

function reserve(budget: SerializationBudget, amount: number): boolean {
  if (!Number.isSafeInteger(amount) || amount < 0 || budget.used + amount > MAX_SERIALIZED_PAYLOAD - SERIALIZED_TRUNCATION_RESERVE) {
    budget.truncated = true;
    return false;
  }
  budget.used += amount;
  return true;
}

function jsonLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 0 : encoded.length;
  } catch {
    return MAX_SERIALIZED_PAYLOAD;
  }
}

function compactCause(value: EngineWebAdapterErrorCause): EngineWebAdapterErrorCause {
  const output: MutableSerializedCause = {
    name: trimString(value.name),
    message: trimString(value.message),
    truncated: true,
  };
  if (value.role !== undefined) output.role = value.role;
  const verification = serializedVerification(value.details?.verification);
  if (value.code !== undefined && (value.code !== "stem.corrupt" || verification !== undefined)) output.code = value.code;
  if (verification !== undefined) output.details = { verification };
  else if (value.code === "stem.corrupt") output.details = { serialization: "integrity-evidence-insufficient" };
  return output;
}

function causeName(value: unknown): string {
  if (value === null) return "null";
  if (isObjectLike(value)) return "Object";
  return typeof value;
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
