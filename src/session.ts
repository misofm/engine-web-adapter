import { bindIngestDiagnostics, inheritFlacRegistration } from "./stems/ingest-diagnostics.js";
import { ABI_LAYOUT } from "@misofm/engine";
import type { BrowserBootPolicy } from "@misofm/engine/browser";
import { BUNDLED_ENGINE_ASSETS } from "@misofm/engine/assets";
import { createEngine, createDefaultHost, scratchBootOptions, MSB1_CONTROL, Msb1RingObserver } from "@misofm/engine/browser";
import type { BrowserEngine, CreateEngineOptions } from "@misofm/engine/browser";

import { ADAPTER_ASSETS } from "./assets.js";
import { assertEngineWebCapabilities } from "./capabilities.js";
import { attachSessionControl } from "./console.js";
import type { SessionControl } from "./console.js";
import { EngineWebAdapterError } from "./errors.js";
import { attachEngineFeed, prepareEngineFeed } from "./feed.js";
import type { EngineFeed } from "./feed.js";
import { scratchBootWithWorker } from "./scratch.js";
import type {
  EngineAudioContext,
  EnginePump,
  EngineWebConsole,
  EngineWebSession,
  EngineWebSessionOptions,
  EngineWebSessionState,
  SourceObservation,
} from "./session-types.js";
import {
  BoundedStemAdmission,
  defaultFlacMemoryBudgetBytes,
  flacAdmissionWidth,
} from "./stems/flac-admission.js";
import { createFlacStemResolver } from "./stems/flac-resolver.js";
import { canonicalPcmBytes } from "./stems/identity.js";
import { OpfsStemStore } from "./stems/store.js";
import { PcmPumpWorkerClient } from "./stems/worker-client.js";
import type { PcmPumpSource } from "./stems/pump.js";
import type {
  CanonicalPcmExpectation,
  DeclaredStemSource,
  StemRequirement,
  StemResolver,
  StemSessionLease,
} from "./stems/types.js";

const PREFILL_TIMEOUT_MS = 2_000;

export async function openEngineWebSession(options: EngineWebSessionOptions): Promise<EngineWebSession> {
  bindIngestDiagnostics(options.ingestDiagnostics);
  const hasFlac = options.flac !== undefined;
  const hasResolver = options.resolver !== undefined;
  if (hasFlac === hasResolver) {
    throw new EngineWebAdapterError(
      "session.input_path",
      "Exactly one of flac or resolver must be supplied",
      { hasFlac, hasResolver },
    );
  }
  assertEngineWebCapabilities(options.capabilityScope);
  const abort = new AbortController();
  const detachAbort = forwardAbort(options.signal, abort);
  const cleanup: Array<() => void | Promise<void>> = [];
  let lease: StemSessionLease | undefined;
  let engine: BrowserEngine<EngineAudioContext> | undefined;
  let feed: EngineFeed | undefined;
  let pump: EnginePump | undefined;
  let output: AudioNode | undefined;
  let control: SessionControl | undefined;

  try {
    const document = normalizeDocument(options.document);
    // Parsed before anything is constructed: the document is the session's own
    // declaration of its sources, so a caller who has one has already said
    // everything `sources` could say.
    const documentDeclaration = extractDocumentDeclaration(document);
    const sources = options.sources === undefined
      ? declaredSourcesFrom(documentDeclaration)
      : snapshotSources(options.sources);
    const leaseId = options.leaseId ?? crypto.randomUUID();
    const policy = bootPolicy(options);
    const requirements = requirementsFor(leaseId, sources);
    const engineWasmUrl = options.assets?.engineWasmUrl ?? BUNDLED_ENGINE_ASSETS.wasm;
    const engineWorkletUrl = options.assets?.engineWorkletModuleUrl ?? BUNDLED_ENGINE_ASSETS.workletModule;
    const engineHostUrl = options.assets?.engineHostModuleUrl ?? BUNDLED_ENGINE_ASSETS.hostModule;
    const feedPreludeUrl = options.assets?.feedWorkletModuleUrl ?? ADAPTER_ASSETS.feedWorkletModule;
    const scratchBoot = options.scratchBoot ?? ((request: Parameters<NonNullable<EngineWebSessionOptions["scratchBoot"]>>[0]) =>
      scratchBootWithWorker({ ...request, moduleUrl: engineWasmUrl,
        ...(options.assets === undefined ? {} : { assets: options.assets }), signal: abort.signal }));
    const compiledShape = await scratchBoot({ document, options: scratchBootOptions(policy) });
    const orderedSources = crossSessionDeclarations(compiledShape, documentDeclaration, sources);

    let resolver: StemResolver;
    let admission: BoundedStemAdmission | undefined;
    if (options.flac !== undefined) {
      const navigatorHints = typeof navigator === "undefined"
        ? undefined
        : navigator as Navigator & { readonly deviceMemory?: number };
      const hardwareConcurrency = options.flac.hardwareConcurrency ?? navigatorHints?.hardwareConcurrency;
      admission = options.flac.admission ?? new BoundedStemAdmission(flacAdmissionWidth({
        ...(hardwareConcurrency === undefined ? {} : { hardwareConcurrency }),
        memoryBudgetBytes: options.flac.memoryBudgetBytes ?? defaultFlacMemoryBudgetBytes(
          options.flac.deviceMemory ?? navigatorHints?.deviceMemory,
        ),
        ...(options.flac.maximumWorkers === undefined ? {} : { maximum: options.flac.maximumWorkers }),
      }));
      const expectations = expectationsFor(orderedSources, compiledShape.sampleRateHz);
      const flacResolver = createFlacStemResolver({
        ...options.flac,
        assets: { ...options.assets, ...options.flac.assets },
        admission,
      });
      const withExpectations = (producer: StemResolver): StemResolver => ({
        resolve(identity, resolveOptions = {}) {
          const expected = expectations.get(identity);
          if (expected === undefined) {
            return Promise.reject(new EngineWebAdapterError(
              "session.declaration_mismatch",
              "FLAC resolver received an undeclared stem identity",
              { identity },
            ));
          }
          return producer.resolve(identity, { ...resolveOptions, expected });
        },
      });
      resolver = withExpectations(flacResolver);
      inheritFlacRegistration(resolver, flacResolver, withExpectations);
    } else {
      resolver = options.resolver;
    }
    const store = options.store
      ?? new OpfsStemStore(options.assets === undefined ? {} : { assets: options.assets });
    options.onProgress?.({ stage: "loading", sourcesTotal: requirements.length });
    lease = await store.openSession({
      leaseId,
      stems: requirements,
      resolver,
      ...(options.ingestDiagnostics === undefined ? {} : { ingestDiagnostics: options.ingestDiagnostics }),
      ...(admission === undefined ? {} : { admission }),
      signal: abort.signal,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    cleanup.push(() => lease!.close());

    const reuseScratchBoot = async () => compiledShape;
    const createHost: NonNullable<CreateEngineOptions["createHost"]> = async (request) => {
      await prepareEngineFeed(request.context, feedPreludeUrl);
      if (options.createHost !== undefined) return options.createHost(request);
      try { return await createDefaultHost({ ...request, hostModuleUrl: String(engineHostUrl) }); }
      catch (error) {
        throw new EngineWebAdapterError("session.open", "Engine AudioWorklet host could not start", {}, error);
      }
    };
    const engineOptions = {
      document,
      sources: sources.map((source) => ({ id: source.id, spec: source.spec })),
      scratchBoot: reuseScratchBoot,
      createHost,
      simd128ModuleUrl: String(engineWasmUrl),
      workletModuleUrl: String(engineWorkletUrl),
      policy,
    };
    engine = options.createContext === undefined
      ? await createEngine(engineOptions)
      : await createEngine({ ...engineOptions, createContext: options.createContext });
    cleanup.push(() => engine!.close());
    crossCompiledSources(engine.shape.sources, orderedSources);

    feed = attachEngineFeed({
      context: engine.context as unknown as BaseAudioContext,
      sources: orderedSources.map((source) => ({ sourceId: source.id, channels: source.spec.channels })),
      quantumFrames: engine.shape.quantumFrames,
      ...(options.createAttachNode === undefined ? {} : { createNode: options.createAttachNode }),
    });
    cleanup.push(() => feed!.close());

    const pumpSources: PcmPumpSource[] = orderedSources.map((source, index) => ({
      sourceId: source.id,
      identity: source.spec.content as `sha256:${string}`,
      channels: source.spec.channels,
      bitDepth: source.spec.bitDepth as 16 | 24,
      frames: exactFrames(source.spec.frames),
      ring: feed!.rings[index]!,
    }));
    pump = await (options.createPump?.({ lease, sources: pumpSources, signal: abort.signal }) ??
      PcmPumpWorkerClient.create({
        lease,
        sources: pumpSources,
        signal: abort.signal,
        ...(options.assets === undefined ? {} : { assets: options.assets }),
      }));
    cleanup.push(() => pump!.close());
    options.onProgress?.({ stage: "prefilling", sourcesTotal: pumpSources.length });
    await waitForPrefill(feed.rings, abort.signal);

    const context = engine.context;
    output = options.createOutput?.({ context, engineNode: engine.host.node }) ?? engine.host.node;
    if (options.createOutput === undefined) output.connect(context.destination);
    cleanup.push(() => { try { output!.disconnect(); } catch { /* already disconnected */ } });
    // One request-identifier ledger, resolved before the session is handed back,
    // so a first console command and a first meter subscription work in either
    // order and neither caller nor adapter ever names an identifier.
    if (consoleAttached(policy)) {
      control = await attachSessionControl(engine.host);
      cleanup.push(() => control!.close());
    }
    detachAbort();

    let state: EngineWebSessionState = "ready";
    let closing = false;
    let tail: Promise<void> = Promise.resolve();
    let closePromise: Promise<void> | undefined;
    const enqueue = (operation: () => Promise<void>): Promise<void> => {
      const next = tail.then(operation, operation);
      tail = next.then(() => undefined, () => undefined);
      return next;
    };
    const counters = new Map<string, Msb1RingObserver>();
    const observations = new Map<SourceObservation, number>();
    cleanup.push(() => {
      for (const observation of observations.keys()) observation.close();
      observations.clear();
      for (const observer of counters.values()) observer.close();
      counters.clear();
    });
    for (const [index, source] of orderedSources.entries()) {
      counters.set(source.id, new Msb1RingObserver(feed.rings[index]!));
    }
    const counterBytes = [...counters.values()].reduce((bytes, observer) =>
      bytes + observer.channels * observer.frameCapacity * Float32Array.BYTES_PER_ELEMENT, 0);
    const assertOpen = () => {
      if (closing || state === "closed") throw new EngineWebAdapterError("session.closed", "Engine Web session is closed");
    };
    const session: EngineWebSession = {
      shape: engine.shape,
      context,
      host: engine.host,
      get console(): EngineWebConsole {
        if (control === undefined) throw consoleNotAttached();
        return control.console;
      },
      output,
      get state() { return state; },
      meters(listener) {
        if (control === undefined) return Promise.reject(consoleNotAttached());
        return control.meters(listener);
      },
      telemetry(listener) {
        if (control === undefined) return Promise.reject(consoleNotAttached());
        return control.telemetry(listener);
      },
      observeSource(sourceId) {
        assertOpen();
        const index = orderedSources.findIndex((source) => source.id === sourceId);
        if (index < 0) throw new EngineWebAdapterError("stem.not_found", "Session source was not found", { sourceId });
        const observer = new Msb1RingObserver(feed!.rings[index]!);
        const observation: SourceObservation = {
          sampleRateHz: engine!.shape.sampleRateHz,
          channels: observer.channels,
          pull: (consume, maximumChunks) => observer.pull(consume, maximumChunks),
          close() {
            observer.close();
            observations.delete(observation);
          },
        };
        observations.set(observation, observer.channels * observer.frameCapacity * Float32Array.BYTES_PER_ELEMENT);
        return observation;
      },
      feedDiagnostics() {
        assertOpen();
        return Object.freeze({
          sources: Object.freeze([...counters].map(([sourceId, observer]) => Object.freeze({ sourceId, ...observer.counters() }))),
          allocation: Object.freeze({
            sources: counters.size,
            ringBytes: feed!.rings.reduce((bytes, ring) => bytes + ring.byteLength, 0),
            engineMemoryBytes: engine!.host.memoryBytes,
            observationBytes: counterBytes + [...observations.values()].reduce((bytes, owned) => bytes + owned, 0),
            pump: pump!.allocation === undefined ? null : Object.freeze({ ...pump!.allocation }),
          }),
        });
      },
      play() {
        if (closing || state === "closed") return Promise.reject(new EngineWebAdapterError("session.closed", "Engine Web session is closed"));
        // This call intentionally precedes the first await and preserves the user gesture.
        const resumed = context.resume();
        return enqueue(async () => {
          await abortable(resumed, abort.signal);
          if (context.state !== "running") await abortable(context.resume(), abort.signal);
          await abortable(feed!.ready(), abort.signal);
          if (closing) throw new EngineWebAdapterError("session.closed", "Engine Web session is closed");
          state = "playing";
        });
      },
      pause() {
        return enqueue(async () => {
          if (closing || state === "closed") throw new EngineWebAdapterError("session.closed", "Engine Web session is closed");
          await abortable(context.suspend(), abort.signal);
          if (closing) throw new EngineWebAdapterError("session.closed", "Engine Web session is closed");
          state = "paused";
        });
      },
      seekFrames(frame) {
        return enqueue(async () => {
          if (closing || state === "closed") throw new EngineWebAdapterError("session.closed", "Engine Web session is closed");
          await abortable(pump!.seekFrames(frame), abort.signal);
        });
      },
      close() {
        if (closePromise === undefined) {
          closing = true;
          state = "closed";
          abort.abort(new DOMException("Engine Web session closed", "AbortError"));
          // Cleanup starts now; it never waits behind a hung lifecycle call.
          closePromise = reverseCleanup(cleanup);
        }
        return closePromise;
      },
    };
    return session;
  } catch (error) {
    abort.abort(error);
    detachAbort();
    try { await reverseCleanup(cleanup); } catch { /* the opening refusal remains authoritative */ }
    throw error instanceof EngineWebAdapterError
      ? error
      : new EngineWebAdapterError("session.open", "Engine Web session could not open", {}, error);
  }
}

/**
 * The boot policy both boots read.
 *
 * The Engine reads an absent `console` as "attach no console at all", which
 * reaches `ready`, plays audio, and then answers every ordinary command with a
 * reason about the command rather than about the missing console. So the
 * adapter attaches the Engine's own published default sizes -- not sizes of its
 * own invention -- unless the caller asked for a playback-only session, and any
 * console word the caller states wins field by field.
 */
function bootPolicy(options: EngineWebSessionOptions): BrowserBootPolicy {
  if (options.console === false) {
    const { console: _opted, ...rest } = options.policy ?? {};
    return rest;
  }
  return {
    ...options.policy,
    console: {
      commandQueueRecords: ABI_LAYOUT.constants.defaultCommandQueueRecords,
      meterBlocks: ABI_LAYOUT.constants.defaultMeterBlocks,
      ...options.policy?.console,
    },
  };
}

function consoleAttached(policy: BrowserBootPolicy): boolean {
  return (policy.console?.commandQueueRecords ?? 0) > 0;
}

function consoleNotAttached(): EngineWebAdapterError {
  return new EngineWebAdapterError(
    "console.not_attached",
    "This Engine Web session has no console attached",
    { commandQueueRecords: 0 },
  );
}

/**
 * The stem declarations the document already carries.
 *
 * Session V1 states every source's id, digest, channel count, bit depth and
 * frame count, and the adapter has already parsed all five to cross-check a
 * caller's own declarations. Re-deriving them is therefore free, and it removes
 * the only reason a caller had to restate the document in a second vocabulary.
 */
function declaredSourcesFrom(declaration: DocumentDeclaration): readonly DeclaredStemSource[] {
  return declaration.sources.map((source) => {
    if (source.bitDepth === "32f") {
      throw new EngineWebAdapterError(
        "stem.invalid_declaration",
        "The browser adapter supports canonical 16-bit and 24-bit integer PCM only",
        { sourceId: source.id, bitDepth: source.bitDepth },
      );
    }
    if (source.channels !== 1 && source.channels !== 2) {
      throw new EngineWebAdapterError(
        "stem.invalid_declaration",
        "The browser adapter supports mono and stereo sources only",
        { sourceId: source.id, channels: source.channels },
      );
    }
    return Object.freeze({
      id: source.id,
      spec: Object.freeze({
        channels: source.channels,
        bitDepth: source.bitDepth,
        frames: exactFrames(source.frames),
        content: source.identity,
      }),
    });
  });
}

function requirementsFor(leaseId: string, sources: readonly DeclaredStemSource[]): StemRequirement[] {
  if (leaseId.length === 0) throw new TypeError("leaseId must not be empty");
  const ids = new Set<string>();
  return sources.map((source) => {
    if (source.id.length === 0 || ids.has(source.id)) throw new EngineWebAdapterError("session.declaration_mismatch", "Source IDs must be non-empty and unique", { sourceId: source.id });
    ids.add(source.id);
    return { sourceId: source.id, identity: source.spec.content as `sha256:${string}`, bytes: canonicalPcmBytes(source.spec) };
  });
}

function normalizeDocument(document: EngineWebSessionOptions["document"]): Uint8Array<ArrayBuffer> {
  if (typeof document === "string") return new TextEncoder().encode(document);
  if (document instanceof Uint8Array) return new Uint8Array(document);
  return new TextEncoder().encode(document.toJson());
}

function snapshotSources(sources: readonly DeclaredStemSource[]): readonly DeclaredStemSource[] {
  return sources.map((source) => Object.freeze({
    id: source.id,
    spec: Object.freeze({
      channels: source.spec.channels,
      bitDepth: source.spec.bitDepth,
      frames: source.spec.frames,
      content: source.spec.content,
    }),
  }));
}

function expectationsFor(
  sources: readonly DeclaredStemSource[],
  sampleRateHz: number,
): ReadonlyMap<`sha256:${string}`, CanonicalPcmExpectation> {
  const expectations = new Map<`sha256:${string}`, CanonicalPcmExpectation>();
  for (const source of sources) {
    if (source.spec.bitDepth !== 16 && source.spec.bitDepth !== 24) {
      throw new EngineWebAdapterError("session.declaration_mismatch", "Browser FLAC delivery requires PCM16 or PCM24", {
        sourceId: source.id,
        bitDepth: source.spec.bitDepth,
      });
    }
    const identity = source.spec.content as `sha256:${string}`;
    const expectation: CanonicalPcmExpectation = {
      sampleRateHz,
      channels: source.spec.channels,
      bitDepth: source.spec.bitDepth,
      frames: exactFrames(source.spec.frames),
      canonicalBytes: canonicalPcmBytes(source.spec),
    };
    const prior = expectations.get(identity);
    if (prior !== undefined && (
      prior.sampleRateHz !== expectation.sampleRateHz || prior.channels !== expectation.channels ||
      prior.bitDepth !== expectation.bitDepth || prior.frames !== expectation.frames ||
      prior.canonicalBytes !== expectation.canonicalBytes
    )) {
      throw new EngineWebAdapterError(
        "session.declaration_mismatch",
        "One FLAC identity has conflicting source declarations",
        { identity },
      );
    }
    expectations.set(identity, expectation);
  }
  return expectations;
}

function crossCompiledSources(
  compiled: readonly { readonly id: string; readonly channels: number; readonly frames: bigint }[],
  declared: readonly DeclaredStemSource[],
): readonly DeclaredStemSource[] {
  const byId = new Map(declared.map((source) => [source.id, source]));
  const ordered = compiled.map((source) => byId.get(source.id));
  const mismatch = compiled.length !== declared.length || ordered.some((expected, index) => {
    const source = compiled[index]!;
    return expected === undefined || source.channels !== expected.spec.channels || source.frames !== BigInt(expected.spec.frames);
  });
  if (mismatch) throw new EngineWebAdapterError("session.declaration_mismatch", "Engine-reported source order or shape differs from declarations");
  return ordered as readonly DeclaredStemSource[];
}

interface DocumentSourceDeclaration {
  readonly id: string;
  readonly identity: string;
  readonly channels: number;
  readonly bitDepth: 16 | 24 | "32f";
  readonly frames: bigint;
  readonly canonicalBytes: bigint | undefined;
}

interface DocumentDeclaration {
  readonly sampleRateHz: number;
  readonly sources: readonly DocumentSourceDeclaration[];
}

function extractDocumentDeclaration(document: Uint8Array): DocumentDeclaration {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(document)); }
  catch (error) {
    throw new EngineWebAdapterError(
      "session.declaration_mismatch",
      "Normalized Session V1 JSON could not be inspected at the stem boundary",
      {},
      error,
    );
  }
  if (!isRecord(value) || value.schema_version !== 1 || typeof value.sample_rate_hz !== "number" ||
    !Number.isSafeInteger(value.sample_rate_hz) ||
    !Array.isArray(value.sources)) {
    throw declarationMismatch("Normalized document is not a strict Session V1 source declaration");
  }
  const ids = new Set<string>();
  const sources = value.sources.map((candidate, index): DocumentSourceDeclaration => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0 ||
      typeof candidate.content !== "string" || typeof candidate.channels !== "number" ||
      !Number.isSafeInteger(candidate.channels) || candidate.channels < 1 ||
      (candidate.bit_depth !== 16 && candidate.bit_depth !== 24 && candidate.bit_depth !== "32f") ||
      typeof candidate.frames !== "string" || !/^(?:0|[1-9]\d*)$/u.test(candidate.frames)) {
      throw declarationMismatch("Document source declaration is not strict Session V1 JSON", { sourceIndex: index });
    }
    if (ids.has(candidate.id)) {
      throw declarationMismatch("Document source IDs must be unique", { sourceId: candidate.id });
    }
    ids.add(candidate.id);
    const frames = BigInt(candidate.frames);
    const canonicalBytes = typeof candidate.bit_depth === "number"
      ? frames * BigInt(candidate.channels) * BigInt(candidate.bit_depth / 8)
      : undefined;
    return {
      id: candidate.id,
      identity: candidate.content,
      channels: candidate.channels,
      bitDepth: candidate.bit_depth,
      frames,
      canonicalBytes,
    };
  });
  return { sampleRateHz: value.sample_rate_hz as number, sources };
}

function crossSessionDeclarations(
  compiled: Readonly<{
    readonly sampleRateHz: number;
    readonly sources: readonly { readonly id: string; readonly channels: number; readonly frames: bigint }[];
  }>,
  document: DocumentDeclaration,
  declared: readonly DeclaredStemSource[],
): readonly DeclaredStemSource[] {
  const ordered = crossCompiledSources(compiled.sources, declared);
  if (document.sampleRateHz !== compiled.sampleRateHz) {
    throw declarationMismatch("Document sample rate differs from the scratch-compiled session", {
      field: "sample_rate_hz", expected: compiled.sampleRateHz, actual: document.sampleRateHz,
    });
  }
  const byId = new Map(document.sources.map((source) => [source.id, source]));
  if (document.sources.length !== declared.length || byId.size !== declared.length) {
    throw declarationMismatch("Document and caller source ID sets differ", {
      documentSourceIds: document.sources.map((source) => source.id),
      callerSourceIds: declared.map((source) => source.id),
    });
  }
  for (const caller of declared) {
    const source = byId.get(caller.id);
    if (source === undefined) {
      throw declarationMismatch("Document and caller source ID sets differ", { sourceId: caller.id, field: "id" });
    }
    const expectedFrames = BigInt(caller.spec.frames);
    const expectedBytes = BigInt(canonicalPcmBytes(caller.spec));
    const comparisons: readonly [string, unknown, unknown][] = [
      ["content", caller.spec.content, source.identity],
      ["channels", caller.spec.channels, source.channels],
      ["bit_depth", caller.spec.bitDepth, source.bitDepth],
      ["frames", expectedFrames, source.frames],
      ["canonical_bytes", expectedBytes, source.canonicalBytes],
    ];
    for (const [field, expected, actual] of comparisons) {
      if (expected !== actual) {
        throw declarationMismatch("Document source differs from the caller stem declaration", {
          sourceId: caller.id,
          field,
          expected: typeof expected === "bigint" ? expected.toString() : expected,
          actual: typeof actual === "bigint" ? actual.toString() : actual,
        });
      }
    }
  }
  return ordered;
}

function declarationMismatch(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): EngineWebAdapterError {
  return new EngineWebAdapterError("session.declaration_mismatch", message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFrames(value: number | bigint): number {
  const frames = typeof value === "bigint" ? value : BigInt(value);
  if (frames > BigInt(Number.MAX_SAFE_INTEGER)) throw new EngineWebAdapterError("stem.invalid_declaration", "Stem frames exceed browser exact range");
  return Number(frames);
}

async function waitForPrefill(rings: readonly SharedArrayBuffer[], signal: AbortSignal): Promise<void> {
  const deadline = performance.now() + PREFILL_TIMEOUT_MS;
  while (rings.some((ring) => Atomics.load(new Int32Array(ring), MSB1_CONTROL.WROTE) === 0)) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new EngineWebAdapterError("session.open", "PCM pump prefill timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function reverseCleanup(cleanup: Array<() => void | Promise<void>>): Promise<void> {
  let first: unknown;
  for (const close of cleanup.reverse()) {
    try { await close(); } catch (error) { first ??= error; }
  }
  if (first !== undefined) throw first;
}


function forwardAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (parent === undefined) return () => undefined;
  const abort = () => child.abort(parent.reason);
  if (parent.aborted) abort(); else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException("Operation aborted", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}
