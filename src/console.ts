import { resultName } from "@misofm/engine";
import { createBrowserConsole } from "@misofm/engine/browser";
import type { ConsoleEdits, SessionMap } from "@misofm/engine";
import type { BrowserEngine } from "@misofm/engine/browser";
import { EngineWebAdapterError } from "./errors.js";
import type { EngineWebConsole, MeterUpdate, TelemetryUpdate, TrackMeter } from "./session-types.js";
type EngineHost = BrowserEngine["host"];
type MeterFrame = Parameters<NonNullable<Parameters<EngineHost["meters"]>[0]["onFrame"]>>[0];
type TelemetryFrame = Parameters<NonNullable<Parameters<EngineHost["telemetry"]>[0]["onFrame"]>>[0];

class HostFeed<Frame, Update> {
  readonly #host: EngineHost; readonly #lease: (host: EngineHost, onFrame: ((frame: Frame) => void) | null) => Promise<{ readonly result: number }>;
  readonly #project: (frame: Frame) => Update; readonly #name: "meters" | "telemetry"; readonly #listeners = new Set<(update: Update) => void>();
  #reconciling: Promise<void> | undefined; #armed = false; #closed = false;
  constructor(options: { readonly host: EngineHost; readonly name: "meters" | "telemetry"; readonly lease: (host: EngineHost, onFrame: ((frame: Frame) => void) | null) => Promise<{ readonly result: number }>; readonly project: (frame: Frame) => Update }) {
    this.#host = options.host; this.#name = options.name; this.#lease = options.lease; this.#project = options.project;
  }
  async subscribe(listener: (update: Update) => void): Promise<() => void> {
    if (typeof listener !== "function") throw new TypeError(`${this.#name} requires a listener function`);
    if (this.#closed) throw new EngineWebAdapterError("session.closed", "Engine Web session is closed");
    this.#listeners.add(listener);
    try { await this.#reconcile(); } catch (error) { this.#listeners.delete(listener); throw error; }
    let live = true;
    return () => { if (!live) return; live = false; this.#listeners.delete(listener); void this.#reconcile(); };
  }
  close(): void { this.#closed = true; this.#listeners.clear(); void this.#reconcile(); }
  #reconcile(): Promise<void> {
    if (this.#reconciling !== undefined) return this.#reconciling;
    // A no-op must not occupy the transition slot: another listener can leave in this turn.
    if ((!this.#closed && this.#listeners.size > 0) === this.#armed) return Promise.resolve();
    const run = (async () => {
      for (;;) {
        const wanted = !this.#closed && this.#listeners.size > 0;
        if (wanted === this.#armed) return;
        if (wanted) {
          const ack = await this.#lease(this.#host, (frame) => {
            const update = this.#project(frame);
            for (const listener of [...this.#listeners]) listener(update);
          });
          if (ack.result !== 0) {
            throw new EngineWebAdapterError("console.lease_refused", `The Engine refused the ${this.#name} lease`, { feed: this.#name, result: ack.result, code: resultName(ack.result, "call") });
          }
          this.#armed = true;
        } else {
          try { await this.#lease(this.#host, null); } catch { /* release failures leave the feed conservatively unarmed */ } finally { this.#armed = false; }
        }
      }
    })();
    this.#reconciling = run;
    void run.then(() => { if (this.#reconciling === run) this.#reconciling = undefined; }, () => { if (this.#reconciling === run) this.#reconciling = undefined; });
    return run;
  }
}
function trackMeter(left: number, right: number, gainReductionDb: number): TrackMeter { return Object.freeze({ peakLeft: left, peakRight: right, peak: Math.max(left, right), gainReductionDb }); }
export interface SessionControl { readonly console: EngineWebConsole; readonly map: SessionMap; meters(listener: (update: MeterUpdate) => void): Promise<() => void>; telemetry(listener: (update: TelemetryUpdate) => void): Promise<() => void>; close(): void; }
export async function attachSessionControl(host: EngineHost): Promise<SessionControl> {
  const remote = await host.sessionMap();
  const map: SessionMap = Object.freeze({ tracks: Object.freeze([...remote.tracks]), sources: Object.freeze(remote.sources.map((source) => Object.freeze({ ...source }))), metersAttached: remote.metersAttached });
  const sdkConsole = await createBrowserConsole(host); let closed = false;
  const console: EngineWebConsole = { edit: sdkConsole.edit as ConsoleEdits, submit: (...edits) => closed ? Promise.reject(new EngineWebAdapterError("session.closed", "Engine Web session is closed")) : sdkConsole.submit(...edits) };
  const meters = new HostFeed<MeterFrame, MeterUpdate>({ host, name: "meters", lease: (target, onFrame) => target.meters({ enabled: onFrame !== null, onFrame }), project: (frame) => {
    const tracks = new Map<string, TrackMeter>(); map.tracks.forEach((id, index) => tracks.set(id, trackMeter(frame.peaks[index * 2] ?? 0, frame.peaks[index * 2 + 1] ?? 0, frame.trackGrDb[index] ?? 0)));
    return Object.freeze({ sequence: BigInt(frame.sequence), windows: frame.windows, firstSample: frame.firstSample, endSample: frame.endSample, tracks: tracks as ReadonlyMap<string, TrackMeter>, master: trackMeter(frame.peaks[frame.trackCount * 2] ?? 0, frame.peaks[frame.trackCount * 2 + 1] ?? 0, frame.masterGrDb ?? 0) });
  } });
  const telemetry = new HostFeed<TelemetryFrame, TelemetryUpdate>({ host, name: "telemetry", lease: (target, onFrame) => target.telemetry({ enabled: onFrame !== null, onFrame }), project: (frame) => Object.freeze({ sequence: BigInt(frame.sequence), blocks: frame.blocks, cpuPercent: frame.cpuPercent, peakBlockMs: frame.peakBlockMs, meanBlockMs: frame.meanBlockMs, budgetMs: frame.budgetMs, deadlineMisses: frame.deadlineMisses, resolutionMs: frame.resolutionMs, belowResolution: frame.belowResolution }) });
  return { console, map, meters: (listener) => meters.subscribe(listener), telemetry: (listener) => telemetry.subscribe(listener), close() { closed = true; meters.close(); telemetry.close(); } };
}
