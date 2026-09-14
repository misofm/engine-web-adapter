import type { ConsoleEdits } from "@misofm/engine";
import type {
  AudioContextLike,
  BrowserEngine,
  MasterMeter as SdkMasterMeter,
  MeterUpdate as SdkMeterUpdate,
  TelemetryUpdate,
  TrackMeter as SdkTrackMeter,
} from "@misofm/engine/browser";

import { EngineWebAdapterError } from "./errors.js";
import type { EngineWebConsole, MasterMeter, MeterUpdate, TrackMeter } from "./session-types.js";

/**
 * The adapter's compatibility control view over the one SDK Engine.
 *
 * The SDK owns console construction, measurement leases, listener multiplexing,
 * and disposal. The adapter only preserves its historical convenience methods
 * and adds the legacy single-bar meter field at callback time.
 */
export interface SessionControl {
  readonly console: EngineWebConsole;
  meters(listener: (update: MeterUpdate) => void): Promise<() => void>;
  telemetry(listener: (update: TelemetryUpdate) => void): Promise<() => void>;
  close(): void;
}

function projectTrackMeter(meter: SdkTrackMeter): TrackMeter {
  return Object.freeze({ ...meter, peak: Math.max(meter.peakLeft, meter.peakRight) });
}

function projectMasterMeter(meter: SdkMasterMeter): MasterMeter {
  return Object.freeze({ ...meter, peak: Math.max(meter.peakLeft, meter.peakRight) });
}

/** Add only the historical `peak` projection while retaining every SDK field. */
function projectMeters(update: SdkMeterUpdate): MeterUpdate {
  const tracks = new Map<string, TrackMeter>();
  for (const [trackId, meter] of update.tracks) tracks.set(trackId, projectTrackMeter(meter));
  return Object.freeze({
    ...update,
    tracks: tracks as ReadonlyMap<string, TrackMeter>,
    master: projectMasterMeter(update.master),
  });
}

function legacyMeasurementError(feed: "meters" | "telemetry", cause: unknown): EngineWebAdapterError {
  const details: Record<string, unknown> = { feed };
  if (cause !== null && typeof cause === "object") {
    const result = (cause as { readonly result?: unknown }).result;
    const code = (cause as { readonly code?: unknown }).code;
    if (typeof result === "number") details.result = result;
    if (typeof code === "string") details.code = code;
  }
  return new EngineWebAdapterError(
    "console.lease_refused",
    `The Engine refused the ${feed} lease`,
    details,
    cause,
  );
}

/**
 * Bind the compatibility control view to the existing SDK Engine.
 *
 * `engine.console()` is the sole console acquisition path. It retains the SDK
 * managed-observation guard and all strict command reports. Measurement methods
 * delegate directly to the SDK's shared leases; no adapter feed is created.
 */
export async function attachSessionControl<Context extends AudioContextLike>(engine: BrowserEngine<Context>): Promise<SessionControl> {
  const sdkConsole = await engine.console();
  let closed = false;
  const console: EngineWebConsole = {
    edit: sdkConsole.edit as ConsoleEdits,
    submit: (...edits) => closed
      ? Promise.reject(new EngineWebAdapterError("session.closed", "Engine Web session is closed"))
      : sdkConsole.submit(...edits),
  };
  return {
    console,
    meters(listener) {
      if (closed) return Promise.reject(new EngineWebAdapterError("session.closed", "Engine Web session is closed"));
      if (typeof listener !== "function") return Promise.reject(new TypeError("meters requires a listener function"));
      return engine.subscribeMeters((update) => listener(projectMeters(update)))
        .catch((error) => { throw legacyMeasurementError("meters", error); });
    },
    telemetry(listener) {
      if (closed) return Promise.reject(new EngineWebAdapterError("session.closed", "Engine Web session is closed"));
      if (typeof listener !== "function") return Promise.reject(new TypeError("telemetry requires a listener function"));
      return engine.subscribeTelemetry(listener)
        .catch((error) => { throw legacyMeasurementError("telemetry", error); });
    },
    close() {
      closed = true;
    },
  };
}
