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
  readonly role?: "interruption" | "body" | "finalizer";
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
const SERIALIZED_CAUSE_SUMMARY_RESERVE = 512;
const SERIALIZED_TRUNCATION_MARKER = "[truncated]";

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
  const budget: SerializationBudget = { used: 0, protected: 0, truncated: false };
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

interface SerializationBudget { used: number; protected: number; truncated: boolean }
interface MutableSerializedCause {
  [key: string]: unknown;
  name: string;
  message: string;
  role?: "interruption" | "body" | "finalizer";
  code?: string;
  details?: Readonly<Record<string, unknown>>;
  cause?: EngineWebAdapterErrorCause;
  causes?: readonly EngineWebAdapterErrorCause[];
  truncated?: true;
}
interface ContainerState { count: number }
interface PropertyRead { found: boolean; value?: unknown; threw?: boolean }
interface CauseSummary { readonly name: string; readonly message: string }

function serializeCause(
  value: unknown,
  depth: number,
  seen: Set<object>,
  budget: SerializationBudget,
  summaryLimit?: number,
): EngineWebAdapterErrorCause {
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
  const name = typeof nameRead.value === "string" ? nameRead.value : causeName(value);
  const message = typeof messageRead.value === "string" ? messageRead.value : safeString(value);
  if (summaryLimit === undefined) {
    addValue(output, state, "name", boundedText(name, budget), budget);
    addValue(output, state, "message", boundedText(message, budget), budget);
  } else {
    const summary = boundedSummary(name, message, Math.min(summaryLimit, availableSummaryBytes(budget)), budget);
    if (!addSummary(output, state, summary, budget)) budget.truncated = true;
  }

  const roleRead = readProperty(value, "role");
  if (roleRead.value === "interruption" || roleRead.value === "body" || roleRead.value === "finalizer") {
    if (addValue(output, state, "role", roleRead.value, budget)) output.role = roleRead.value;
  }

  const detailsRead = readProperty(value, "details");
  const codeRead = readProperty(value, "code");
  const rawCode = typeof codeRead.value === "string" ? codeRead.value : undefined;
  const boundedCode = rawCode === undefined ? undefined : boundedText(rawCode, budget);
  let serializedDetails: Readonly<Record<string, unknown>> | undefined;
  let detailsIncluded = false;
  let serializedDetailsSeen: Set<object> | undefined;
  let serializedDetailsBudget: SerializationBudget | undefined;
  if (detailsRead.threw) {
    budget.truncated = true;
    serializedDetails = { serialization: "details-unreadable" };
  } else if (isPlainRecord(detailsRead.value)) {
    const detailsBudget: SerializationBudget = { used: 0, protected: 0, truncated: false };
    const detailsSeen = new Set(seen);
    serializedDetailsSeen = detailsSeen;
    serializedDetailsBudget = detailsBudget;
    serializedDetails = serializeDetails(detailsRead.value, depth + 1, detailsSeen, detailsBudget,
      rawCode === "stem.corrupt" && !serializedVerification(readProperty(detailsRead.value, "verification").value)
        ? "integrity-evidence-insufficient" : undefined);
  }
  if (serializedDetails !== undefined) {
    const detailAmount = jsonLength("details") + 1 + (state.count === 0 ? 0 : 1) + jsonLength(serializedDetails);
    if (reserve(budget, detailAmount)) {
      state.count += 1;
      output.details = serializedDetails;
      detailsIncluded = true;
      if (serializedDetailsSeen !== undefined) for (const entry of serializedDetailsSeen) seen.add(entry);
      if (serializedDetailsBudget?.truncated === true) budget.truncated = true;
    }
  }
  const verified = detailsIncluded ? serializedVerification(output.details?.verification) : undefined;
  if (rawCode !== undefined && (rawCode !== "stem.corrupt" || verified !== undefined)) {
    addValue(output, state, "code", boundedCode ?? rawCode, budget);
  } else if (rawCode === "stem.corrupt") {
    budget.truncated = true;
    if (output.details === undefined) {
      addValue(output, state, "details", { serialization: "integrity-evidence-insufficient" }, budget);
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
  const errors = readProperty(value, "errors");
  const causes = readProperty(value, "causes");
  if (errors.threw || causes.threw) return { threw: true };
  const arrays: unknown[][] = [];
  let truncated = false;
  if (isAggregate(value) || isArray(errors.value)) {
    if (isArray(errors.value)) {
      arrays.push([...boundedArrayValues(errors.value)]);
      truncated ||= safeArrayLength(errors.value) > MAX_SERIALIZED_CAUSES;
    }
  }
  if (isArray(causes.value)) {
    arrays.push([...boundedArrayValues(causes.value)]);
    truncated ||= safeArrayLength(causes.value) > MAX_SERIALIZED_CAUSES;
  }
  if (arrays.length === 0) return {};
  const combined = arrays.flat();
  const values = combined.slice(0, MAX_SERIALIZED_CAUSES);
  return { values, ...(truncated || combined.length > MAX_SERIALIZED_CAUSES ? { truncated: true } : {}) };
}

function serializeCauseArray(values: readonly unknown[], depth: number, seen: Set<object>, budget: SerializationBudget): readonly EngineWebAdapterErrorCause[] {
  const state = beginArray(budget);
  if (state === undefined) return [];
  const output: EngineWebAdapterErrorCause[] = [];
  const count = Math.min(values.length, MAX_SERIALIZED_CAUSES);
  for (let index = 0; index < count; index += 1) {
    const remaining = count - index - 1;
    budget.protected += remaining * (SERIALIZED_CAUSE_SUMMARY_RESERVE + 1);
    try {
      if (!reserveArrayItem(state, budget)) break;
      output.push(serializeCause(values[index], depth, seen, budget, SERIALIZED_CAUSE_SUMMARY_RESERVE));
    } finally {
      budget.protected -= remaining * (SERIALIZED_CAUSE_SUMMARY_RESERVE + 1);
    }
  }
  return output;
}

function boundedSummary(name: string, message: string, limit: number, budget: SerializationBudget): CauseSummary {
  const boundedName = boundedText(name, budget);
  const boundedMessage = boundedText(message, budget);
  if (summaryLength(boundedName, boundedMessage) <= limit) {
    return { name: boundedName, message: boundedMessage };
  }

  const emptyValueLength = jsonLength("");
  const availableValueBytes = Math.max(0, limit - summaryLength("", ""));
  const nameBytes = Math.max(0, jsonLength(boundedName) - emptyValueLength);
  const messageBytes = Math.max(0, jsonLength(boundedMessage) - emptyValueLength);
  let nameBudget = Math.min(nameBytes, Math.floor(availableValueBytes / 2));
  let messageBudget = Math.min(messageBytes, availableValueBytes - nameBudget);
  let remaining = availableValueBytes - nameBudget - messageBudget;
  if (remaining > 0 && nameBudget < nameBytes) {
    const extra = Math.min(remaining, nameBytes - nameBudget);
    nameBudget += extra;
    remaining -= extra;
  }
  if (remaining > 0 && messageBudget < messageBytes) messageBudget += Math.min(remaining, messageBytes - messageBudget);

  const fittedName = fitSummaryText(boundedName, emptyValueLength + nameBudget);
  const fittedMessage = fitSummaryText(boundedMessage, emptyValueLength + messageBudget);
  if (fittedName !== boundedName || fittedMessage !== boundedMessage) budget.truncated = true;
  return { name: fittedName, message: fittedMessage };
}

function summaryLength(name: string, message: string): number {
  return 2 +
    jsonLength("name") + 1 + jsonLength(name) + 1 +
    jsonLength("message") + 1 + jsonLength(message);
}

function fitSummaryText(value: string, maxJsonBytes: number): string {
  if (jsonLength(value) <= maxJsonBytes) return value;
  if (jsonLength(SERIALIZED_TRUNCATION_MARKER) > maxJsonBytes) return "";
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${SERIALIZED_TRUNCATION_MARKER}`;
    if (jsonLength(candidate) <= maxJsonBytes) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join("")}${SERIALIZED_TRUNCATION_MARKER}`;
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
    else if (verification.found) {
      budget.truncated = true;
      addValue(result, state, "serialization", "integrity-evidence-insufficient", budget);
    }
  }
  try {
    const keys = enumerableKeys(value);
    for (const key of keys.values) {
      if (key === "verification") continue;
      const property = readProperty(value, key);
      const outputKey = boundedText(key, budget);
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
    const childBudget: SerializationBudget = { used: 0, protected: 0, truncated: false };
    const childSeen = new Set(seen);
    const bounded = boundedArray(value, depth + 1, childSeen, childBudget);
    if (!reserve(budget, jsonLength(key) + 1 + (state.count === 0 ? 0 : 1) + jsonLength(bounded))) return;
    state.count += 1;
    target[key] = bounded;
    if (childBudget.truncated) budget.truncated = true;
    for (const entry of childSeen) seen.add(entry);
    return;
  }
  if (isPlainRecord(value)) {
    const childBudget: SerializationBudget = { used: 0, protected: 0, truncated: false };
    const childSeen = new Set(seen);
    const serialized = serializeDetails(value, depth + 1, childSeen, childBudget);
    if (!reserve(budget, jsonLength(key) + 1 + (state.count === 0 ? 0 : 1) + jsonLength(serialized))) return;
    state.count += 1;
    target[key] = serialized;
    if (childBudget.truncated) budget.truncated = true;
    for (const entry of childSeen) seen.add(entry);
    return;
  }
  addValue(target, state, key, boundedScalar(value, budget), budget);
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
      const childBudget: SerializationBudget = { used: 0, protected: 0, truncated: false };
      const childSeen = new Set(seen);
      const bounded = boundedArray(item, depth + 1, childSeen, childBudget);
      if (!reserve(budget, jsonLength(bounded) + (state.count === 0 ? 0 : 1))) break;
      state.count += 1;
      output.push(bounded);
      if (childBudget.truncated) budget.truncated = true;
      for (const entry of childSeen) seen.add(entry);
    } else if (isPlainRecord(item)) {
      const childBudget: SerializationBudget = { used: 0, protected: 0, truncated: false };
      const childSeen = new Set(seen);
      const serialized = serializeDetails(item, depth + 1, childSeen, childBudget);
      if (!reserve(budget, jsonLength(serialized) + (state.count === 0 ? 0 : 1))) break;
      state.count += 1;
      output.push(serialized);
      if (childBudget.truncated) budget.truncated = true;
      for (const entry of childSeen) seen.add(entry);
    } else {
      const scalar = boundedScalar(item, budget);
      if (!reserveArrayValue(state, scalar, budget)) break;
      output.push(scalar);
    }
  }
  if (length > MAX_SERIALIZED_CAUSES) budget.truncated = true;
  return output;
}

function boundedScalar(value: unknown, budget: SerializationBudget): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedText(value, budget);
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return boundedText(`${value}n`, budget);
  return boundedText(safeString(value), budget);
}

function serializedVerification(value: unknown): EngineWebAdapterVerification | undefined {
  if (!isEngineWebAdapterVerification(value)) return undefined;
  const kind = readProperty(value, "kind").value as EngineWebAdapterVerification["kind"];
  const expected = readProperty(value, "expected").value as string | number;
  const observed = readProperty(value, "observed").value as string | number;
  const algorithm = readProperty(value, "algorithm").value as string | undefined;
  return {
    kind,
    expected,
    observed,
    ...(algorithm === undefined ? {} : { algorithm }),
  };
}

/**
 * Integrity evidence is meaningful only when it could have come from one of
 * the adapter's canonical verification boundaries. This is also the guard
 * used when reviving evidence from a Worker or a storage exception.
 */
export function isEngineWebAdapterVerification(value: unknown): value is EngineWebAdapterVerification {
  if (!isObjectLike(value)) return false;
  const kind = readProperty(value, "kind");
  const expected = readProperty(value, "expected");
  const observed = readProperty(value, "observed");
  const algorithm = readProperty(value, "algorithm");
  const truncated = readProperty(value, "truncated");
  if (kind.threw || expected.threw || observed.threw || algorithm.threw || truncated.threw || truncated.value === true) return false;
  if (kind.value === "length") {
    return algorithm.value === undefined &&
      typeof expected.value === "number" && Number.isSafeInteger(expected.value) && expected.value >= 0 &&
      typeof observed.value === "number" && Number.isSafeInteger(observed.value) && observed.value >= 0 &&
      expected.value !== observed.value;
  }
  if (kind.value !== "digest" ||
    typeof expected.value !== "string" || !/^[0-9a-f]{64}$/u.test(expected.value) ||
    typeof observed.value !== "string" || !/^[0-9a-f]{64}$/u.test(observed.value) ||
    expected.value === observed.value) return false;
  return algorithm.value === undefined || algorithm.value === "blake3-256" || algorithm.value === "sha256";
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

function availableSummaryBytes(budget: SerializationBudget): number {
  return Math.max(0, MAX_SERIALIZED_PAYLOAD - SERIALIZED_TRUNCATION_RESERVE - budget.protected - budget.used + 2);
}

function addSummary(target: MutableSerializedCause, state: ContainerState, summary: CauseSummary, budget: SerializationBudget): boolean {
  const amount = jsonLength("name") + 1 + jsonLength(summary.name) +
    (state.count === 0 ? 0 : 1) +
    jsonLength("message") + 1 + jsonLength(summary.message);
  if (!reserve(budget, amount)) return false;
  state.count += 2;
  target.name = summary.name;
  target.message = summary.message;
  return true;
}

function addValue(target: Record<string, unknown>, state: ContainerState, key: string, value: unknown, budget: SerializationBudget): boolean {
  const amount = jsonLength(key) + 1 + (state.count === 0 ? 0 : 1) + jsonLength(value);
  if (!reserve(budget, amount)) return false;
  state.count += 1;
  target[key] = value;
  return true;
}

function reserveArrayItem(state: ContainerState, budget: SerializationBudget): boolean {
  if (!reserve(budget, state.count === 0 ? 0 : 1)) return false;
  state.count += 1;
  return true;
}

function reserveArrayValue(state: ContainerState, value: unknown, budget: SerializationBudget): boolean {
  const amount = jsonLength(value) + (state.count === 0 ? 0 : 1);
  if (!reserve(budget, amount)) return false;
  state.count += 1;
  return true;
}

function reserve(budget: SerializationBudget, amount: number): boolean {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_SERIALIZED_PAYLOAD - SERIALIZED_TRUNCATION_RESERVE - budget.protected - budget.used) {
    budget.truncated = true;
    return false;
  }
  budget.used += amount;
  return true;
}

function jsonLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 0 : new TextEncoder().encode(encoded).byteLength;
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
  if (value.code !== undefined && (value.code !== "stem.corrupt" || verification !== undefined)) output.code = trimString(value.code);
  if (verification !== undefined) output.details = { verification };
  else if (value.code === "stem.corrupt") output.details = { serialization: "integrity-evidence-insufficient" };
  if (value.causes !== undefined) output.causes = value.causes.slice(0, MAX_SERIALIZED_CAUSES).map(compactCause);
  if (value.cause !== undefined) output.cause = compactCause(value.cause);
  if (jsonLength(output) > MAX_SERIALIZED_PAYLOAD) {
    delete output.cause;
    if (output.causes !== undefined) {
      output.causes = output.causes.map((cause) => ({
        name: compactSummary(cause.name),
        message: compactSummary(cause.message),
        ...(cause.role === undefined ? {} : { role: cause.role }),
        truncated: true as const,
      }));
    }
  }
  while (jsonLength(output) > MAX_SERIALIZED_PAYLOAD && output.causes !== undefined && output.causes.length > 0) {
    output.causes = output.causes.slice(0, -1);
  }
  if (jsonLength(output) > MAX_SERIALIZED_PAYLOAD) {
    delete output.causes;
    delete output.cause;
    delete output.details;
    delete output.code;
    output.name = compactSummary(output.name);
    output.message = compactSummary(output.message);
  }
  return output;
}

function compactSummary(value: string): string {
  const limit = 128;
  return value.length > limit
    ? `${value.slice(0, limit - SERIALIZED_TRUNCATION_MARKER.length)}${SERIALIZED_TRUNCATION_MARKER}`
    : value;
}

function causeName(value: unknown): string {
  if (value === null) return "null";
  if (isObjectLike(value)) return "Object";
  return typeof value;
}

function boundedText(value: string, budget: SerializationBudget): string {
  const bounded = trimString(value);
  if (bounded !== value) budget.truncated = true;
  return bounded;
}
function trimString(value: string): string {
  return value.length > MAX_SERIALIZED_STRING
    ? `${value.slice(0, MAX_SERIALIZED_STRING - SERIALIZED_TRUNCATION_MARKER.length)}${SERIALIZED_TRUNCATION_MARKER}`
    : value;
}
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
