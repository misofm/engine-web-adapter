import assert from "node:assert/strict";
import test from "node:test";

import { ABI_LAYOUT, encodeLaneEdits } from "@misofm/engine";
import type { BootOptions, LaneEdit } from "@misofm/engine";
import type { BrowserEngine } from "@misofm/engine/browser";

import { EngineWebAdapterError, openEngineWebSession } from "../src/index.js";
import type {
  EngineAudioContext,
  EngineWebSession,
  EngineWebSessionCommonOptions,
  MeterUpdate,
  TrackMeter,
} from "../src/session-types.js";
import { MSB1_CONTROL } from "../src/stems/ring.js";
import type { DeclaredStemSource, StemSessionLease, StemStore } from "../src/stems/types.js";

const IDENTITY = `sha256:${"a".repeat(64)}` as const;
const SOURCES: readonly DeclaredStemSource[] = [
  { id: "source", spec: { channels: 1, bitDepth: 16, frames: 4, content: IDENTITY } },
];
const TRACKS = ["kick", "snare"] as const;

const BACKPRESSURE = ABI_LAYOUT.constants.commandReasons.find((row) => row.name === "backpressure")!.value;
const UNSUPPORTED_KIND = ABI_LAYOUT.constants.commandReasons.find((row) => row.name === "unsupportedKind")!.value;

type HostCommand = Parameters<BrowserEngine["host"]["command"]>[0]["commands"][number];
type MeterFrame = Parameters<NonNullable<Parameters<BrowserEngine["host"]["meters"]>[0]["onFrame"]>>[0];

interface Refusal {
  readonly reason: number;
  readonly result: number;
  readonly times: number;
}

class FakeHost {
  readonly node = { connect() {}, disconnect() {} } as unknown as AudioWorkletNode;
  readonly batches: HostCommand[][] = [];
  readonly leases: Array<readonly ["meters" | "telemetry", boolean]> = [];
  meterFrame: ((frame: MeterFrame) => void) | null = null;
  refuse: Refusal | undefined;
  malformed = false;
  meterResult = 0;
  disposed = false;
  async sessionMap() {
    return {
      tag: "miso.sessionmap.v1" as const,
      result: 0,
      tracks: [...TRACKS],
      sources: [{ id: "source", channels: 1, frames: 4n }],
      metersAttached: true,
    };
  }

  async command(request: { commands: HostCommand[] }) {
    const refusal = this.refuse;
    if (refusal !== undefined) {
      this.refuse = refusal.times > 1 ? { ...refusal, times: refusal.times - 1 } : undefined;
      return {
        tag: "miso.ack.v1" as const, result: refusal.result,
        reason: refusal.reason, rejectedIndex: 0, admitted: 0, appliedAtSample: 0n,
        records: new Uint8Array(),
      };
    }
    this.batches.push(request.commands);
    if (this.malformed) return {
      tag: "miso.ack.v1" as const, result: 0, reason: 0,
      rejectedIndex: 0, admitted: 0, appliedAtSample: 0n, records: new Uint8Array(),
    };
    return {
      tag: "miso.ack.v1" as const, result: 0, reason: 0,
      rejectedIndex: 0, admitted: request.commands.length, appliedAtSample: 0n, records: new Uint8Array(),
    };
  }

  async meters(request: { enabled: boolean; onFrame: ((frame: MeterFrame) => void) | null }) {
    this.leases.push(["meters", request.enabled]);
    this.meterFrame = request.onFrame;
    return { tag: "miso.ack.v1" as const, result: this.meterResult };
  }

  async telemetry(request: { enabled: boolean }) {
    this.leases.push(["telemetry", request.enabled]);
    return { tag: "miso.ack.v1" as const, result: 0 };
  }

  async dispose() { this.disposed = true; }
}

test("the default session attaches the Engine's published console words", async () => {
  const seen: BootOptions[] = [];
  const opened = await open({ onBoot: (options) => seen.push(options) });
  const words = seen[0]!.console!;
  assert.equal(words.commandQueueRecords, ABI_LAYOUT.constants.defaultCommandQueueRecords);
  assert.equal(words.meterBlocks, ABI_LAYOUT.constants.defaultMeterBlocks);
  assert.equal(words.observationTaps ?? 0, 0);
  assert.equal(words.masterTrackPlusOne ?? 0, 0);
  await opened.session.close();
});

test("explicit console sizes and other policy fields survive the default", async () => {
  const seen: BootOptions[] = [];
  const opened = await open({
    onBoot: (options) => seen.push(options),
    options: { policy: { sourceRingFrames: 512, console: { commandQueueRecords: 8, observationTaps: 2 } } },
  });
  const words = seen[0]!.console!;
  assert.equal(seen[0]!.sourceRingFrames, 512);
  assert.equal(words.commandQueueRecords, 8);
  assert.equal(words.observationTaps, 2);
  assert.equal(words.meterBlocks, ABI_LAYOUT.constants.defaultMeterBlocks, "unstated words still take the Engine default");
  await opened.session.close();
});

test("an explicit no-console session names the missing console at first access", async () => {
  const seen: BootOptions[] = [];
  const { session, host } = await open({ onBoot: (options) => seen.push(options), options: { console: false } });
  assert.equal(seen[0]!.console, undefined, "no console words are written");
  assert.equal(host.batches.length, 0, "a playback-only session never opens a control channel");

  assert.throws(
    () => session.console,
    (error: unknown) => error instanceof EngineWebAdapterError &&
      error.code === "console.not_attached" &&
      error.phase === "console" &&
      error.remedy.length > 0,
  );
  for (const feed of [session.meters(() => undefined), session.telemetry(() => undefined)]) {
    await assert.rejects(feed, (error: unknown) =>
      error instanceof EngineWebAdapterError && error.code === "console.not_attached" && error.remedy.length > 0);
  }
  await session.close();
});

test("a first console command and a first meter subscription work in either order", async () => {
  for (const consoleFirst of [true, false]) {
    const { session, host } = await open({});
    const updates: MeterUpdate[] = [];
    if (consoleFirst) {
      const report = await session.console.submit(session.console.edit.track("kick").faderDb(-6));
      assert.deepEqual({ ok: report.ok, admitted: report.admitted, rejectedIndex: report.rejectedIndex, appliedAtSample: report.appliedAtSample }, { ok: true, admitted: 1, rejectedIndex: 0, appliedAtSample: 0n });
      await session.meters((update) => updates.push(update));
    } else {
      await session.meters((update) => updates.push(update));
      const report = await session.console.submit(session.console.edit.track("kick").faderDb(-6));
      assert.equal(report.ok, true);
      assert.equal(report.admitted, 1);
    }
    assert.equal(host.batches.length, 1, "no retry was needed");
    assert.equal(host.batches[0]![0]!.trackIndex, 0);
    await session.close();
  }
});

test("meters arrive keyed by track id with the master fold separated", async () => {
  const { session, host } = await open({});
  const updates: MeterUpdate[] = [];
  const stop = await session.meters((update) => updates.push(update));
  host.meterFrame!({
    tag: "miso.meter.v1", sequence: 7, windows: 1, trackCount: 2,
    peaks: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.9, 0.8]),
    trackGrDb: new Float32Array([1.5, 0]), masterGrDb: 2.5,
    firstSample: 0n, endSample: 128n,
  } as unknown as MeterFrame);
  const update = updates[0]!;
  assert.deepEqual([...update.tracks.keys()], ["kick", "snare"]);
  assert.deepEqual(rounded(update.tracks.get("kick")!), { peakLeft: 0.1, peakRight: 0.2, peak: 0.2, gainReductionDb: 1.5 });
  assert.deepEqual(rounded(update.tracks.get("snare")!), { peakLeft: 0.3, peakRight: 0.4, peak: 0.4, gainReductionDb: 0 });
  assert.equal(round(update.master.peak), 0.9);
  assert.equal(round(update.master.gainReductionDb), 2.5);
  assert.equal(update.sequence, 7n);

  stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(host.leases, [["meters", true], ["meters", false]], "the last listener out releases the lease");
  await session.close();
});

test("a semantic refusal stays visible in the strict CommandReport", async () => {
  const { session, host } = await open({});
  host.refuse = { result: 5, reason: UNSUPPORTED_KIND, times: 1 };
  const report = await session.console.submit(session.console.edit.track("kick").mute(true));
  assert.equal(report.ok, false);
  assert.equal(report.admitted, 0);
  assert.equal(report.rejectedIndex, 0);
  assert.equal(report.reason, UNSUPPORTED_KIND);
  await session.close();
});

test("the SDK rejects a torn success report instead of exposing it as admission", async () => {
  const { session, host } = await open({});
  host.malformed = true;
  await assert.rejects(session.console.submit(session.console.edit.track("kick").mute(true)));
  await session.close();
});

test("a refused meter lease is the one public error class", async () => {
  const { session, host } = await open({});
  host.meterResult = 7;
  await assert.rejects(
    session.meters(() => undefined),
    (error: unknown) => error instanceof EngineWebAdapterError &&
      error.code === "console.lease_refused" && error.details.feed === "meters" && error.remedy.length > 0,
  );
  await session.close();
});

test("the session derives declarations and a lease id from the document alone", async () => {
  let observedLeaseId = "";
  let observedStems: unknown;
  const { session } = await open({
    onLease: (leaseId, stems) => { observedLeaseId = leaseId; observedStems = stems; },
    omitDeclarations: true,
  });
  assert.match(observedLeaseId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.deepEqual(observedStems, [{ sourceId: "source", identity: IDENTITY, bytes: 8 }]);
  assert.deepEqual(session.shape.sources, [{ id: "source", channels: 1, frames: 4n }]);
  await session.close();

  const second = await open({ onLease: (leaseId) => { observedLeaseId = leaseId; }, omitDeclarations: true });
  assert.notEqual(observedLeaseId, "", "each open pins under its own generated lease id");
  await second.session.close();
});

test("every staged record survives the wire round trip for every live command kind", async () => {
  const { session, host } = await open({});
  const track = session.console.edit.track("snare");
  const edits: readonly LaneEdit[] = [
    track.faderDb(-12.5, { channel: "both", smoothingSamples: 64 }),
    track.pan(0.25, 0.75),
    track.matrix({ ll: 1, lr: 0.5, rl: 0.25, rr: 0.125 }),
    track.mute(true),
    track.solo(true),
    track.trimDb(3.5),
    track.polarityInvert(true),
  ];
  await session.console.submit(...edits);
  const staged = host.batches.flat();
  assert.equal(staged.length, edits.length);
  const wire = ABI_LAYOUT.constants.wireCommandKinds;
  edits.forEach((edit, index) => {
    const command = staged[index]!;
    const expectedKind = wire.find((row) => row.name === edit.kind)!.value;
    assert.equal(command.kind, expectedKind, edit.kind);
    assert.equal(command.trackIndex, edit.trackIndex, edit.kind);
    assert.equal(command.rack, edit.rack, edit.kind);
    assert.equal(command.channel, edit.channel, edit.kind);
    assert.equal(command.effectIndex, edit.effectIndex ?? 0, edit.kind);
    assert.equal(command.parameterId, edit.parameterId ?? 0, edit.kind);
    assert.equal(command.smoothingSamples, edit.smoothingSamples ?? 0, edit.kind);
    assert.deepEqual(command.values.map(round), [...edit.values].map(round), edit.kind);
  });
  // The block the writer actually hands the adapter is what was decoded.
  assert.equal(encodeLaneEdits(edits).byteLength, edits.length * ABI_LAYOUT.commandRecord.bytes);
  await session.close();
});

test("every adapter error code carries a phase and a nonempty remedy", () => {
  const codes = new Set<string>();
  for (const code of allCodes()) {
    const error = new EngineWebAdapterError(code, "message");
    assert.ok(error.remedy.trim().length > 0, `${code} has no remedy`);
    assert.ok(error.phase.length > 0, `${code} has no phase`);
    assert.equal(typeof error.transient, "boolean", `${code} has no transience`);
    codes.add(code);
  }
  assert.ok(codes.has("console.not_attached"));
  const retryable = new EngineWebAdapterError("stem.delivery.address", "message", { retryable: true });
  assert.equal(retryable.transient, true, "a delivery layer's own retryable verdict outranks the table");
});

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function rounded(meter: TrackMeter): Record<string, number> {
  return Object.fromEntries(Object.entries(meter).map(([key, value]) => [key, round(value)]));
}

/**
 * Every code the union declares, read back from the one table that defines them.
 *
 * The table is not exported, so the list is asserted against the declaration's
 * own members through a total mapping: a code with no row cannot compile.
 */
function allCodes(): readonly EngineWebAdapterError["code"][] {
  const rows: Record<EngineWebAdapterError["code"], true> = {
    "capability.audio_worklet": true, "capability.cross_origin_isolation": true,
    "capability.module_worker": true, "capability.opfs": true,
    "capability.shared_array_buffer": true, "capability.simd128": true, "capability.web_locks": true,
    "console.lease_refused": true, "console.not_attached": true, "console.refused": true,
    "session.closed": true, "session.declaration_mismatch": true, "session.input_path": true,
    "session.open": true, "stem.cancelled": true, "stem.corrupt": true, "stem.decode.asset": true,
    "stem.decode.flac": true, "stem.decode.output": true, "stem.decode.stall": true,
    "stem.decode.worker": true, "stem.delivery.address": true, "stem.delivery.http": true,
    "stem.delivery.range": true, "stem.delivery.retry_exhausted": true, "stem.delivery.stall": true,
    "stem.flac.invalid": true, "stem.flac.resource_limit": true, "stem.flac.shape": true,
    "stem.invalid_declaration": true, "stem.not_found": true, "stem.quota": true,
    "stem.read_deadline": true,
  };
  return Object.keys(rows) as EngineWebAdapterError["code"][];
}

async function open(setup: {
  readonly onBoot?: (options: BootOptions) => void;
  readonly onLease?: (leaseId: string, stems: unknown) => void;
  readonly omitDeclarations?: boolean;
  readonly options?: Partial<EngineWebSessionCommonOptions>;
}): Promise<{ readonly session: EngineWebSession; readonly host: FakeHost }> {
  const host = new FakeHost();
  const lease: StemSessionLease = {
    leaseId: "lease",
    stems: [{ sourceId: "source", identity: IDENTITY, bytes: 8 }],
    async read() { return new Blob([new Uint8Array(8)]); },
    async close() {},
  };
  const store: StemStore = {
    async open() { return this; },
    async openSession(request) {
      setup.onLease?.(request.leaseId, request.stems.map((stem) => ({ ...stem })));
      return lease;
    },
  };
  const session = await openEngineWebSession({
    document: documentFor(SOURCES),
    ...(setup.omitDeclarations === true ? {} : { sources: SOURCES, leaseId: "lease" }),
    resolver: { async resolve() { throw new Error("warm fixture must not resolve"); } },
    capabilityScope: capabilities(),
    store,
    scratchBoot: async (request) => {
      setup.onBoot?.(request.options);
      return {
        sampleRateHz: 48_000, quantumFrames: 4, sourceRingFrames: 16, backend: "simd128",
        sources: [{ id: "source", channels: 1, frames: 4n }], tracks: [...TRACKS],
      };
    },
    createContext: () => fakeContext(),
    createHost: async () => host as unknown as BrowserEngine["host"],
    createAttachNode: () => ({
      port: { postMessage(message: unknown) {
        const value = message as { op: string; rings?: SharedArrayBuffer[] };
        if (value.op === "attach") for (const ring of value.rings ?? []) Atomics.store(new Int32Array(ring), MSB1_CONTROL.ATTACHED, 1);
      } },
      disconnect() {},
    }),
    createPump: async ({ sources }) => {
      for (const source of sources) Atomics.store(new Int32Array(source.ring), MSB1_CONTROL.WROTE, 1);
      return { async seekFrames() { return 0n; }, close() {} };
    },
    createOutput: () => ({ connect() {}, disconnect() {} }) as unknown as AudioNode,
    ...setup.options,
  });
  return { session, host };
}

function documentFor(sources: readonly DeclaredStemSource[]): string {
  return JSON.stringify({
    schema_version: 1,
    session_id: "console-test",
    revision: "0",
    sample_rate_hz: 48_000,
    quantum_frames: 4,
    sources: sources.map((source) => ({
      id: source.id,
      content: source.spec.content,
      channels: source.spec.channels,
      bit_depth: source.spec.bitDepth,
      frames: String(source.spec.frames),
    })),
  });
}

function fakeContext(): EngineAudioContext {
  let state = "suspended";
  return {
    sampleRate: 48_000,
    renderQuantumSize: 4,
    get state() { return state; },
    destination: {} as AudioNode,
    audioWorklet: { async addModule() {} },
    async resume() { state = "running"; },
    async suspend() { state = "suspended"; },
    async close() { state = "closed"; },
  };
}

function capabilities() {
  return {
    crossOriginIsolated: true,
    SharedArrayBuffer,
    Worker: class {} as unknown as typeof Worker,
    AudioContext: class {} as unknown as typeof AudioContext,
    AudioWorkletNode: class {} as unknown as typeof AudioWorkletNode,
    navigator: { storage: { getDirectory() {} }, locks: { request() {} } },
    WebAssembly: { validate: () => true },
    FileSystemFileHandle: class { getFile() {} },
  } as unknown as NonNullable<EngineWebSessionCommonOptions["capabilityScope"]>;
}
