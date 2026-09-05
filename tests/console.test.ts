import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ABI_LAYOUT, encodeLaneEdits } from "@misofm/engine";
import type { BootOptions, LaneEdit } from "@misofm/engine";
import type { BrowserEngine } from "@misofm/engine/browser";

import { EngineWebAdapterError, openEngineWebSession } from "../src/index.js";
import { attachSessionControl } from "../src/console.js";
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
  readonly rejectedIndex?: number;
  readonly appliedAtSample?: bigint;
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
        reason: refusal.reason, rejectedIndex: refusal.rejectedIndex ?? 0, admitted: 0, appliedAtSample: refusal.appliedAtSample ?? 0n,
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
  host.refuse = { result: 5, reason: UNSUPPORTED_KIND, times: 1, rejectedIndex: 1, appliedAtSample: 384n };
  const report = await session.console.submit(session.console.edit.track("kick").mute(true), session.console.edit.track("snare").mute(true));
  assert.equal(report.ok, false);
  assert.equal(report.admitted, 0);
  assert.equal(report.rejectedIndex, 1);
  assert.equal(report.reason, UNSUPPORTED_KIND);
  assert.deepEqual(report, {
    ok: false, result: 5, code: "refusedBudget", reason: UNSUPPORTED_KIND,
    reasonName: "unsupportedKind", rejectedIndex: 1, admitted: 0, appliedAtSample: 384n,
  });
  host.refuse = undefined;
  const recovered = await session.console.submit(session.console.edit.track("kick").mute(false));
  assert.deepEqual(recovered, {
    ok: true, result: 0, code: "ok", reason: 0, reasonName: "none",
    rejectedIndex: 0, admitted: 1, appliedAtSample: 0n,
  });
  await session.close();
});

test("a multi-edit submit returns the complete strict receipt", async () => {
  const { session } = await open({});
  const edits = [session.console.edit.track("kick").faderDb(-3), session.console.edit.track("snare").mute(true)];
  const report = await session.console.submit(...edits);
  assert.deepEqual(report, {
    ok: true, result: 0, code: "ok", reason: 0, reasonName: "none",
    rejectedIndex: 0, admitted: edits.length, appliedAtSample: 0n,
  });
  await session.close();
});

test("the SDK rejects a torn success report instead of exposing it as admission", async () => {
  const { session, host } = await open({});
  host.malformed = true;
  await assert.rejects(session.console.submit(session.console.edit.track("kick").mute(true)));
  await session.close();
});

test("backpressure is an exact strict refusal with no hidden retry", async () => {
  const { session, host } = await open({});
  host.refuse = { result: 5, reason: BACKPRESSURE, times: 1 };
  const report = await session.console.submit(session.console.edit.track("kick").mute(true));
  assert.deepEqual(report, {
    ok: false, result: 5, code: "refusedBudget", reason: BACKPRESSURE,
    reasonName: "backpressure", rejectedIndex: 0, admitted: 0, appliedAtSample: 0n,
  });
  assert.equal(host.batches.length, 0);
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

test("SDK console, leases, session map, and raw host interleave without caller IDs", async () => {
  const { session, host } = await open({});
  const stopMeters = await session.meters(() => undefined);
  const stopTelemetry = await session.telemetry(() => undefined);
  const [report, map, raw] = await Promise.all([
    session.console.submit(session.console.edit.track("kick").faderDb(-2)),
    session.host.sessionMap(),
    session.host.command({ commands: [] }),
  ]);
  assert.equal(report.ok, true);
  assert.deepEqual(map.tracks, TRACKS);
  assert.equal(raw.result, 0);
  stopMeters(); stopTelemetry();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(host.leases, [["meters", true], ["telemetry", true], ["meters", false], ["telemetry", false]]);
  await session.close();
});

// Expose only the packed module's class for a controlled port; its host logic is unchanged.
async function packedControl() {
  type Request = { tag: string; requestId: number; enabled?: boolean; count?: number; records?: Uint8Array };
  const sent: Request[] = [];
  const pending: Request[] = [];
  const port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(message: Request): void } = {
    onmessage: null,
    postMessage(message) {
      sent.push(message);
      if (message.tag === "miso.sessionmap.v1") queueMicrotask(() => frame({ tag: message.tag, requestId: message.requestId, result: 0, tracks: [...TRACKS], sources: [], metersAttached: true }));
      else pending.push(message);
    },
  };
  function frame(data: unknown) { port.onmessage?.({ data }); }
  const asset = await readFile("node_modules/@misofm/engine/dist/assets/miso-engine-v1-audio-worklet-host.js", "utf8");
  const sdk = await import(`data:text/javascript;base64,${Buffer.from(`${asset}\nexport { MisoAudioWorkletHost };`).toString("base64")}`) as {
    readonly MisoAudioWorkletHost: new (...args: readonly unknown[]) => BrowserEngine["host"];
  };
  const host = new sdk.MisoAudioWorkletHost({ port, disconnect() {} }, "simd128", 48_000, 128, {}, 65_536, 8, 32, 1);
  const control = await attachSessionControl(host);
  function ack(tag: string, fields: Record<string, unknown> = {}) {
    const index = pending.findIndex((request) => request.tag === tag);
    assert.notEqual(index, -1, `missing ${tag}`);
    const request = pending.splice(index, 1)[0]!;
    const extra = tag === "miso.command.v1" ? { reason: 0, rejectedIndex: 0, admitted: request.count, appliedAtSample: 256n, records: request.records }
      : tag === "miso.status.v1" ? { state: 1, lastResult: 0, backend: 1, sampleRateHz: 48_000, quantumFrames: 128, nextAbsoluteSample: 256n, renderedQuanta: 2n, memoryBytes: 65_536 } : {};
    frame({ tag: tag === "miso.status.v1" ? tag : "miso.ack.v1", requestId: request.requestId, result: 0, ...extra, ...fields });
    return request;
  }
  return { host, control, sent, pending, frame, ack };
}
const tick = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
const meterFrame = { tag: "miso.meter.v1", sequence: 7, windows: 3, trackCount: 2, peaks: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.9, 0.8]), trackGrDb: new Float32Array([1.5, 2]), masterGrDb: 2.5, firstSample: 128n, endSample: 512n };
const telemetryFrame = { tag: "miso.telemetry.v1", sequence: 8, blocks: 3, cpuPercent: 20, peakBlockMs: 0.7, meanBlockMs: 0.5, budgetMs: 2.6, deadlineMisses: 1, resolutionMs: 0.1, belowResolution: false };

for (const feed of ["meters", "telemetry"] as const) {
  const tag = feed === "meters" ? "miso.meters.v1" : "miso.telemetry.v1";
  test(`packed ${feed}: shared lease, projections, release/resubscribe and close race`, async () => {
    for (const closeDuringRelease of [false, true]) {
      const f = await packedControl();
      const updates: unknown[][] = [[], []];
      const first = f.control[feed]((value) => updates[0]!.push(value));
      const second = f.control[feed]((value) => updates[1]!.push(value));
      assert.equal(f.pending.length, 1);
      assert.equal(f.ack(tag).enabled, true);
      const [stopFirst, stopSecond] = await Promise.all([first, second]);
      f.frame(feed === "meters" ? meterFrame : telemetryFrame);
      assert.deepEqual(updates[0], updates[1]);
      assert.equal(updates[0]!.length, 1);
      if (feed === "meters") {
        const value = updates[0]![0] as MeterUpdate;
        assert.deepEqual({ sequence: value.sequence, windows: value.windows, firstSample: value.firstSample, endSample: value.endSample }, { sequence: 7n, windows: 3, firstSample: 128n, endSample: 512n });
        assert.deepEqual([...value.tracks].map(([id, meter]) => [id, rounded(meter)]), [
          ["kick", { peakLeft: 0.1, peakRight: 0.2, peak: 0.2, gainReductionDb: 1.5 }],
          ["snare", { peakLeft: 0.3, peakRight: 0.4, peak: 0.4, gainReductionDb: 2 }],
        ]);
        assert.deepEqual(rounded(value.master), { peakLeft: 0.9, peakRight: 0.8, peak: 0.9, gainReductionDb: 2.5 });
      } else {
        const { tag: _tag, ...expected } = telemetryFrame;
        assert.deepEqual(updates[0]![0], { ...expected, sequence: 8n });
      }
      stopFirst(); stopFirst();
      assert.equal(f.pending.length, 0);
      stopSecond(); stopSecond();
      assert.equal(f.pending[0]?.enabled, false);
      const laterUpdates: unknown[] = [];
      let settlements = 0;
      const later = f.control[feed]((value) => laterUpdates.push(value)).then((stop) => { settlements += 1; return stop; });
      await tick();
      assert.equal(settlements, 0);
      assert.equal(f.pending.length, 1, "resubscribe cannot overlap release");
      if (closeDuringRelease) { f.control.close(); f.control.close(); }
      assert.equal(f.ack(tag).enabled, false);
      await tick();
      if (!closeDuringRelease) {
        assert.equal(f.ack(tag).enabled, true);
        const stopLater = await later;
        f.frame(feed === "meters" ? meterFrame : telemetryFrame);
        assert.equal(laterUpdates.length, 1, "new callback survives release and rearm");
        stopLater();
        assert.equal(f.ack(tag).enabled, false);
      } else {
        await later;
        f.frame(feed === "meters" ? meterFrame : telemetryFrame);
        assert.equal(laterUpdates.length, 0);
      }
      f.control.close(); await tick();
      assert.equal(settlements, 1);
      assert.equal(f.pending.length, 0, "close never rearms");
      assert.deepEqual(f.sent.map((request) => request.requestId), f.sent.map((_, index) => index + 1));
    }
  });

  test(`packed ${feed}: refused shared arm clears and a later subscriber recovers`, async () => {
    const f = await packedControl();
    const refused = (error: unknown) => error instanceof EngineWebAdapterError && error.code === "console.lease_refused" && error.details.feed === feed && error.details.result === 7 && error.details.code === "unsupported";
    const a = assert.rejects(f.control[feed](() => undefined), refused);
    const b = assert.rejects(f.control[feed](() => undefined), refused);
    assert.equal(f.pending.length, 1);
    f.ack(tag, { result: 7 }); await Promise.all([a, b]); await tick();
    assert.equal(f.pending.length, 0, "refusal is not retried");
    const recovered = f.control[feed](() => undefined);
    assert.equal(f.ack(tag).enabled, true);
    const stop = await recovered; stop();
    assert.equal(f.ack(tag).enabled, false);
    f.control.close(); await tick();
  });

  test(`packed ${feed}: pending arm and command settle once after close`, async () => {
    const f = await packedControl();
    let updates = 0; let armSettlements = 0; let commandSettlements = 0;
    const arm = f.control[feed](() => { updates += 1; }).then((stop) => { armSettlements += 1; return stop; });
    const cached = f.control.console;
    const command = cached.submit(cached.edit.track("kick").mute(true)).then((report) => { commandSettlements += 1; return report; });
    f.control.close(); f.control.close();
    const closed = (error: unknown) => error instanceof EngineWebAdapterError && error.code === "session.closed";
    await assert.rejects(cached.submit(cached.edit.track("kick").mute(false)), closed);
    await assert.rejects(f.control[feed](() => undefined), closed);
    assert.equal(armSettlements, 0); assert.equal(commandSettlements, 0);
    f.ack(tag); await tick();
    assert.equal(f.ack(tag).enabled, false, "late successful arm receives ordinary release");
    f.ack("miso.command.v1");
    const [stop, report] = await Promise.all([arm, command]); stop(); stop();
    f.frame(feed === "meters" ? meterFrame : telemetryFrame);
    await tick();
    assert.equal(report.ok, true); assert.equal(report.appliedAtSample, 256n);
    assert.equal(updates, 0); assert.equal(armSettlements, 1); assert.equal(commandSettlements, 1);
    assert.equal(f.pending.length, 0);
  });
}

test("packed host interleaves payload-only control, status, map, raw command and both leases", async () => {
  const f = await packedControl();
  const edits = [f.control.console.edit.track("kick").mute(true), f.control.console.edit.track("snare").faderDb(-3)];
  const command = f.control.console.submit(...edits);
  const meters = f.control.meters(() => undefined);
  const telemetry = f.control.telemetry(() => undefined);
  const status = f.host.status(); const map = f.host.sessionMap();
  const raw = f.host.command({ commands: [{ kind: ABI_LAYOUT.constants.wireCommandKinds.find((row) => row.name === "mute")!.value, trackIndex: 0, rack: 0, channel: 0, effectIndex: 0, parameterId: 0, smoothingSamples: 0, values: [1, 0, 0, 0] }] });
  f.ack("miso.telemetry.v1"); f.ack("miso.status.v1"); f.ack("miso.command.v1"); f.ack("miso.meters.v1"); f.ack("miso.command.v1");
  const [report, stopMeters, stopTelemetry, state, mapping, rawReport] = await Promise.all([command, meters, telemetry, status, map, raw]);
  assert.deepEqual(report, { ok: true, result: 0, code: "ok", reason: 0, reasonName: "none", rejectedIndex: 0, admitted: 2, appliedAtSample: 256n });
  assert.equal(state.nextAbsoluteSample, 256n); assert.deepEqual(mapping.tracks, TRACKS); assert.equal(rawReport.admitted, 1);
  stopMeters(); stopTelemetry();
  f.ack("miso.telemetry.v1"); f.ack("miso.meters.v1"); await tick();
  assert.deepEqual(f.sent.map((request) => request.requestId), f.sent.map((_, index) => index + 1));
  assert.equal(f.pending.length, 0);
  f.control.close();
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
  // The SDK mapping preserves the published wire record width.
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
