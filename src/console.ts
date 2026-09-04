import { ABI_LAYOUT, ConsoleEdits, ConsoleWriter, commandReasonName, resultName } from "@misofm/engine";
import type { SessionMap } from "@misofm/engine";
import type { BrowserEngine } from "@misofm/engine/browser";

import { EngineWebAdapterError } from "./errors.js";
import type { EngineWebConsole, MeterUpdate, TelemetryUpdate, TrackMeter } from "./session-types.js";

type EngineHost = BrowserEngine["host"];
type HostCommand = Parameters<EngineHost["command"]>[0]["commands"][number];
type MeterFrame = Parameters<NonNullable<Parameters<EngineHost["meters"]>[0]["onFrame"]>>[0];
type TelemetryFrame = Parameters<NonNullable<Parameters<EngineHost["telemetry"]>[0]["onFrame"]>>[0];

type CommandRecordField = (typeof ABI_LAYOUT.commandRecord.fields)[number]["name"];

const RECORD_BYTES = ABI_LAYOUT.commandRecord.bytes;
const OFFSET = new Map<CommandRecordField, number>(
  ABI_LAYOUT.commandRecord.fields.map((row) => [row.name, row.offset] as const),
);

/** One flush's worth of backpressure, retried on the render thread's own clock. */
const BACKPRESSURE_RETRY_MS = 4;
const BACKPRESSURE_RETRY_CEILING_MS = 64;

function offsetOf(name: CommandRecordField): number {
  const offset = OFFSET.get(name);
  if (offset === undefined) throw new Error(`the generated command record has no field ${name}`);
  return offset;
}

/**
 * Read one staged record block back into the shipped host's command objects.
 *
 * The Engine's `ConsoleWriter` owns coalescing, batch splitting and flush
 * serialization, and it speaks the wire's 48-byte records. The shipped
 * AudioWorklet host speaks objects. Both spellings are generated from the same
 * `ABI_LAYOUT.commandRecord` table, so this reads the table rather than
 * restating a layout: a field that moves moves here too, and the round-trip
 * test pins it.
 */
function decodeLaneRecords(records: Uint8Array, count: number): HostCommand[] {
  const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
  const values = offsetOf("values");
  const commands: HostCommand[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = index * RECORD_BYTES;
    commands.push({
      kind: view.getUint8(base + offsetOf("kind")) as HostCommand["kind"],
      rack: view.getUint8(base + offsetOf("rack")),
      channel: view.getUint8(base + offsetOf("channel")),
      trackIndex: view.getUint32(base + offsetOf("trackIndex"), true),
      effectIndex: view.getUint32(base + offsetOf("effectIndex"), true),
      parameterId: view.getUint32(base + offsetOf("parameterId"), true),
      smoothingSamples: view.getUint32(base + offsetOf("smoothingSamples"), true),
      values: [
        view.getFloat32(base + values, true),
        view.getFloat32(base + values + 4, true),
        view.getFloat32(base + values + 8, true),
        view.getFloat32(base + values + 12, true),
      ],
    });
  }
  return commands;
}

/**
 * The session's one request-identifier ledger.
 *
 * The shipped host answers a request by its identifier and refuses one it has
 * already seen. Two independent counters -- a console's and a caller's
 * hand-written meter lease -- therefore collide on the first call, and the
 * refusal reads as `invalidArgument` about the payload rather than about the
 * identifier. So the adapter allocates every identifier from one place, inside
 * a serialized chain, and no consumer ever names one.
 */
class HostRequests {
  readonly #host: EngineHost;
  #next: number;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(host: EngineHost, seed: number) {
    this.#host = host;
    this.#next = seed + 1;
  }

  /**
   * Resolve the compiled map and seed the ledger from the identifier the host
   * itself consumed answering it. Restarting at one would be well typed and
   * refused.
   */
  static async open(host: EngineHost): Promise<{ readonly requests: HostRequests; readonly map: SessionMap }> {
    const remote = await host.sessionMap();
    const map: SessionMap = Object.freeze({
      tracks: Object.freeze([...remote.tracks]),
      sources: Object.freeze(remote.sources.map((source) => Object.freeze({ ...source }))),
      metersAttached: remote.metersAttached,
    });
    return { requests: new HostRequests(host, remote.requestId), map };
  }

  get host(): EngineHost {
    return this.#host;
  }

  run<T>(operation: (requestId: number) => Promise<T>): Promise<T> {
    const attempt = this.#tail.then(() => operation(this.#next++));
    this.#tail = attempt.then(() => undefined, () => undefined);
    return attempt;
  }
}

/**
 * One lease shared by every listener.
 *
 * The host's meter and telemetry leases are single switches with one callback.
 * A subscription feed is what a caller actually wants, so the first listener
 * takes the lease, the last one to leave releases it, and nobody coordinates a
 * lease or an identifier.
 */
class HostFeed<Frame, Update> {
  readonly #requests: HostRequests;
  readonly #lease: (host: EngineHost, requestId: number, onFrame: ((frame: Frame) => void) | null) => Promise<{ readonly result: number }>;
  readonly #project: (frame: Frame) => Update;
  readonly #name: "meters" | "telemetry";
  readonly #listeners = new Set<(update: Update) => void>();
  #arming: Promise<void> | undefined;
  #closed = false;

  constructor(options: {
    readonly requests: HostRequests;
    readonly name: "meters" | "telemetry";
    readonly lease: (host: EngineHost, requestId: number, onFrame: ((frame: Frame) => void) | null) => Promise<{ readonly result: number }>;
    readonly project: (frame: Frame) => Update;
  }) {
    this.#requests = options.requests;
    this.#name = options.name;
    this.#lease = options.lease;
    this.#project = options.project;
  }

  async subscribe(listener: (update: Update) => void): Promise<() => void> {
    if (typeof listener !== "function") throw new TypeError(`${this.#name} requires a listener function`);
    if (this.#closed) throw new EngineWebAdapterError("session.closed", "Engine Web session is closed");
    this.#listeners.add(listener);
    try {
      this.#arming ??= this.#arm();
      await this.#arming;
    } catch (error) {
      this.#listeners.delete(listener);
      throw error;
    }
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#release();
    };
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
    this.#arming = undefined;
  }

  async #arm(): Promise<void> {
    const ack = await this.#requests.run((requestId) => this.#lease(this.#requests.host, requestId, (frame) => {
      const update = this.#project(frame);
      for (const listener of [...this.#listeners]) listener(update);
    }));
    if (ack.result !== 0) {
      this.#arming = undefined;
      throw new EngineWebAdapterError(
        "console.lease_refused",
        `The Engine refused the ${this.#name} lease`,
        { feed: this.#name, result: ack.result, code: resultName(ack.result, "call") },
      );
    }
  }

  #release(): void {
    const arming = this.#arming;
    if (arming === undefined || this.#closed) return;
    this.#arming = undefined;
    void arming
      .then(() => this.#requests.run((requestId) => this.#lease(this.#requests.host, requestId, null)))
      // A release that loses a race with close() is not a caller's problem: the
      // host is going away and the lease with it.
      .catch(() => undefined);
  }
}

function trackMeter(left: number, right: number, gainReductionDb: number): TrackMeter {
  return Object.freeze({
    peakLeft: left,
    peakRight: right,
    peak: Math.max(left, right),
    gainReductionDb,
  });
}

/** The console, meter feed and telemetry feed one open session shares. */
export interface SessionControl {
  readonly console: EngineWebConsole;
  readonly map: SessionMap;
  meters(listener: (update: MeterUpdate) => void): Promise<() => void>;
  telemetry(listener: (update: TelemetryUpdate) => void): Promise<() => void>;
  close(): void;
}

export async function attachSessionControl(host: EngineHost): Promise<SessionControl> {
  const { requests, map } = await HostRequests.open(host);
  let closed = false;
  let escalation: EngineWebAdapterError | undefined;
  let retryMs = BACKPRESSURE_RETRY_MS;
  let pumping = false;

  const writer = new ConsoleWriter({
    submit: async (records, count) => {
      const ack = await requests.run((requestId) => host.command({
        requestId,
        commands: decodeLaneRecords(records, count),
      }));
      return Object.freeze({
        ok: ack.result === 0,
        result: ack.result,
        code: resultName(ack.result, "call"),
        reason: ack.reason,
        reasonName: commandReasonName(ack.reason),
        rejectedIndex: ack.rejectedIndex,
        admitted: ack.admitted,
        appliedAtSample: ack.appliedAtSample,
      });
    },
  });

  /**
   * Keep flushing what backpressure refused, on a timer rather than in the
   * caller's await.
   *
   * A full queue with a paused transport is a legitimate steady state, so the
   * submit that hit it must not block on it. The staged value stays coalescable
   * meanwhile: a newer edit for the same address replaces it, so what finally
   * lands is where the hand actually is.
   */
  const pump = (): void => {
    if (pumping || closed || writer.pending === 0) return;
    pumping = true;
    setTimeout(() => {
      pumping = false;
      if (closed || writer.pending === 0) return;
      void writer.drain().then(
        (outcome) => {
          retryMs = outcome.refused ? Math.min(BACKPRESSURE_RETRY_CEILING_MS, retryMs * 2) : BACKPRESSURE_RETRY_MS;
          pump();
        },
        (error: unknown) => { escalation = consoleRefusal(error); },
      );
    }, retryMs);
  };

  const console: EngineWebConsole = {
    edit: new ConsoleEdits(map),
    async submit(...edits) {
      if (closed) throw new EngineWebAdapterError("session.closed", "Engine Web session is closed");
      if (escalation !== undefined) {
        const pending = escalation;
        escalation = undefined;
        throw pending;
      }
      for (const edit of edits) writer.stage(edit);
      try { await writer.drain(); }
      catch (error) { throw consoleRefusal(error); }
      // Anything the drain could not place is the flusher's, not the caller's.
      if (writer.pending > 0) pump();
    },
  };

  const meters = new HostFeed<MeterFrame, MeterUpdate>({
    requests,
    name: "meters",
    lease: (target, requestId, onFrame) => target.meters({ requestId, enabled: onFrame !== null, onFrame }),
    project: (frame) => {
      const tracks = new Map<string, TrackMeter>();
      map.tracks.forEach((id, index) => {
        tracks.set(id, trackMeter(
          frame.peaks[index * 2] ?? 0,
          frame.peaks[index * 2 + 1] ?? 0,
          frame.trackGrDb[index] ?? 0,
        ));
      });
      return Object.freeze({
        sequence: BigInt(frame.sequence),
        windows: frame.windows,
        firstSample: frame.firstSample,
        endSample: frame.endSample,
        tracks: tracks as ReadonlyMap<string, TrackMeter>,
        master: trackMeter(
          frame.peaks[frame.trackCount * 2] ?? 0,
          frame.peaks[frame.trackCount * 2 + 1] ?? 0,
          frame.masterGrDb ?? 0,
        ),
      });
    },
  });

  const telemetry = new HostFeed<TelemetryFrame, TelemetryUpdate>({
    requests,
    name: "telemetry",
    lease: (target, requestId, onFrame) => target.telemetry({ requestId, enabled: onFrame !== null, onFrame }),
    project: (frame) => Object.freeze({
      sequence: BigInt(frame.sequence),
      blocks: frame.blocks,
      cpuPercent: frame.cpuPercent,
      peakBlockMs: frame.peakBlockMs,
      meanBlockMs: frame.meanBlockMs,
      budgetMs: frame.budgetMs,
      deadlineMisses: frame.deadlineMisses,
      resolutionMs: frame.resolutionMs,
      belowResolution: frame.belowResolution,
    }),
  });

  return {
    console,
    map,
    meters: (listener) => meters.subscribe(listener),
    telemetry: (listener) => telemetry.subscribe(listener),
    close() {
      closed = true;
      meters.close();
      telemetry.close();
    },
  };
}

function consoleRefusal(error: unknown): EngineWebAdapterError {
  if (error instanceof EngineWebAdapterError) return error;
  return new EngineWebAdapterError(
    "console.refused",
    error instanceof Error ? error.message : "The Engine console refused a transaction",
    {},
    error,
  );
}
