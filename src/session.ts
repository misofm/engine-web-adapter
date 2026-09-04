import { BUNDLED_ENGINE_ASSETS } from "@misofm/engine/assets";
import { createEngine, toWebBootOptions } from "@misofm/engine/browser";
import type { BrowserEngine, CreateEngineOptions } from "@misofm/engine/browser";

import { ADAPTER_ASSETS } from "./assets.js";
import { assertEngineWebCapabilities } from "./capabilities.js";
import { EngineWebAdapterError } from "./errors.js";
import { attachEngineFeed, prepareEngineFeed } from "./feed.js";
import type { EngineFeed } from "./feed.js";
import { ScratchWorkerClient } from "./scratch.js";
import type {
  EngineAudioContext,
  EnginePump,
  EngineWebSession,
  EngineWebSessionOptions,
  EngineWebSessionState,
} from "./session-types.js";
import { canonicalPcmBytes, OpfsStemStore, PcmPumpWorkerClient } from "./stems/index.js";
import type { PcmPumpSource, StemRequirement, StemSessionLease } from "./stems/index.js";

const PREFILL_TIMEOUT_MS = 2_000;

export async function openEngineWebSession(options: EngineWebSessionOptions): Promise<EngineWebSession> {
  assertEngineWebCapabilities(options.capabilityScope);
  const abort = new AbortController();
  const detachAbort = forwardAbort(options.signal, abort);
  const cleanup: Array<() => void | Promise<void>> = [];
  let lease: StemSessionLease | undefined;
  let engine: BrowserEngine | undefined;
  let feed: EngineFeed | undefined;
  let pump: EnginePump | undefined;
  let output: AudioNode | undefined;

  try {
    const scratchWorker = options.scratchBoot === undefined
      ? await ScratchWorkerClient.create({
        ...(options.assets === undefined ? {} : { assets: options.assets }), signal: abort.signal,
      })
      : undefined;
    const closeScratchWorker = scratchWorker === undefined ? undefined : () => scratchWorker.close();
    if (closeScratchWorker !== undefined) cleanup.push(closeScratchWorker);
    const requirements = requirementsFor(options);
    const store = options.store ?? new OpfsStemStore();
    options.onProgress?.({ stage: "loading", sourcesTotal: requirements.length });
    lease = await store.openSession({
      leaseId: options.leaseId,
      stems: requirements,
      resolver: options.resolver,
      signal: abort.signal,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
    cleanup.push(() => lease!.close());

    const engineWasmUrl = options.assets?.engineWasmUrl ?? BUNDLED_ENGINE_ASSETS.wasm;
    const engineWorkletUrl = options.assets?.engineWorkletModuleUrl ?? BUNDLED_ENGINE_ASSETS.workletModule;
    const engineHostUrl = options.assets?.engineHostModuleUrl ?? BUNDLED_ENGINE_ASSETS.hostModule;
    const feedPreludeUrl = options.assets?.feedWorkletModuleUrl ?? ADAPTER_ASSETS.feedWorkletModule;

    const createContext = options.createContext ?? defaultCreateContext;
    const scratchBoot: CreateEngineOptions["scratchBoot"] = options.scratchBoot ?? ((request) =>
      scratchWorker!.boot({
        ...request,
        moduleUrl: engineWasmUrl,
        signal: abort.signal,
      }));
    const createHost: CreateEngineOptions["createHost"] = options.createHost ?? (async (request) => {
      const context = request.context as unknown as BaseAudioContext & { suspend?: () => Promise<void> };
      if (context.state === "running") await context.suspend?.();
      await prepareEngineFeed(request.context, feedPreludeUrl);
      const module = await import(/* @vite-ignore */ String(engineHostUrl)) as {
        createMisoAudioWorkletHost(value: unknown): Promise<BrowserEngine["host"]>;
      };
      const hostRequest = { ...request, options: toWebBootOptions(request.options) };
      try { return await module.createMisoAudioWorkletHost(hostRequest); }
      catch (error) {
        throw new EngineWebAdapterError("session.open", "Engine AudioWorklet host could not start", {
          contextState: request.context.state,
          sampleRate: request.context.sampleRate,
          renderQuantumSize: request.context.renderQuantumSize,
          documentBytes: request.document.byteLength,
          optionKeys: Object.keys(hostRequest.options),
          simd128ModuleUrlType: typeof request.simd128ModuleUrl,
          workletModuleUrlType: typeof request.workletModuleUrl,
        }, error);
      }
    });

    engine = await createEngine({
      document: options.document,
      sources: options.sources.map((source) => ({ id: source.id, spec: source.spec })),
      createContext,
      scratchBoot,
      createHost: async (request) => {
        if (options.createHost !== undefined) await prepareEngineFeed(request.context, feedPreludeUrl);
        return createHost(request);
      },
      simd128ModuleUrl: String(engineWasmUrl),
      workletModuleUrl: String(engineWorkletUrl),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    });
    cleanup.push(() => engine!.close());
    if (scratchWorker !== undefined && closeScratchWorker !== undefined) {
      scratchWorker.close();
      const cleanupIndex = cleanup.indexOf(closeScratchWorker);
      if (cleanupIndex >= 0) cleanup.splice(cleanupIndex, 1);
    }
    const orderedSources = crossCompiledSources(engine.shape.sources, options.sources);

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

    const context = engine.context as EngineAudioContext;
    output = options.createOutput?.({ context, engineNode: engine.host.node }) ?? engine.host.node;
    if (options.createOutput === undefined) output.connect(context.destination);
    cleanup.push(() => { try { output!.disconnect(); } catch { /* already disconnected */ } });
    const semanticConsole = await engine.console();
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
    const session: EngineWebSession = {
      shape: engine.shape,
      context,
      host: engine.host,
      console: semanticConsole,
      output,
      get state() { return state; },
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

function requirementsFor(options: EngineWebSessionOptions): StemRequirement[] {
  if (options.leaseId.length === 0) throw new TypeError("leaseId must not be empty");
  const ids = new Set<string>();
  return options.sources.map((source) => {
    if (source.id.length === 0 || ids.has(source.id)) throw new EngineWebAdapterError("session.declaration_mismatch", "Source IDs must be non-empty and unique", { sourceId: source.id });
    ids.add(source.id);
    return { sourceId: source.id, identity: source.spec.content as `sha256:${string}`, bytes: canonicalPcmBytes(source.spec) };
  });
}

function crossCompiledSources(
  compiled: readonly { readonly id: string; readonly channels: number; readonly frames: bigint }[],
  declared: EngineWebSessionOptions["sources"],
): EngineWebSessionOptions["sources"] {
  const byId = new Map(declared.map((source) => [source.id, source]));
  const ordered = compiled.map((source) => byId.get(source.id));
  const mismatch = compiled.length !== declared.length || ordered.some((expected, index) => {
    const source = compiled[index]!;
    return expected === undefined || source.channels !== expected.spec.channels || source.frames !== BigInt(expected.spec.frames);
  });
  if (mismatch) throw new EngineWebAdapterError("session.declaration_mismatch", "Engine-reported source order or shape differs from declarations");
  return ordered as EngineWebSessionOptions["sources"];
}

function exactFrames(value: number | bigint): number {
  const frames = typeof value === "bigint" ? value : BigInt(value);
  if (frames > BigInt(Number.MAX_SAFE_INTEGER)) throw new EngineWebAdapterError("stem.invalid_declaration", "Stem frames exceed browser exact range");
  return Number(frames);
}

async function waitForPrefill(rings: readonly SharedArrayBuffer[], signal: AbortSignal): Promise<void> {
  const deadline = performance.now() + PREFILL_TIMEOUT_MS;
  while (rings.some((ring) => Atomics.load(new Int32Array(ring), 14) === 0)) {
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

function defaultCreateContext(options: { readonly sampleRate: number; readonly renderSizeHint: number }): EngineAudioContext {
  const Constructor = AudioContext as unknown as new (options: { sampleRate: number; renderSizeHint: number }) => EngineAudioContext;
  return new Constructor({ sampleRate: options.sampleRate, renderSizeHint: options.renderSizeHint });
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
