import test from "node:test";

import type { EngineWebSessionOptions, EngineWebSession, SourceObservation, FeedDiagnostics, PumpAllocation } from "../src/index.js";
import type { VerifiedStemStore, OpfsStemStore, StemIdentity } from "../src/stems/index.js";
import type { StemResolver } from "../src/stems/index.js";
import type { CommandReport } from "@misofm/engine";
import type { EngineWebConsole } from "../src/session-types.js";

const common = {
  document: "{}",
  leaseId: "lease",
  sources: [],
};
const resolver = {} as StemResolver;

const raw: EngineWebSessionOptions = { ...common, resolver };
const flac: EngineWebSessionOptions = { ...common, flac: { locate: () => "https://caller.invalid/stem" } };
void [raw, flac];

// @ts-expect-error exactly one input path is required
const neither: EngineWebSessionOptions = common;
// @ts-expect-error FLAC and canonical PCM resolver paths are mutually exclusive
const both: EngineWebSessionOptions = { ...common, resolver, flac: { locate: () => "https://caller.invalid/stem" } };
void [neither, both];

function strictReceiptProbe(strictConsole: EngineWebConsole): Promise<CommandReport> {
  return strictConsole.submit(strictConsole.edit.track("track").mute(true));
}
function voidReceiptProbe(strictConsole: EngineWebConsole): Promise<void> {
  // @ts-expect-error submit is a strict SDK receipt, never Promise<void>
  return strictConsole.submit(strictConsole.edit.track("track").mute(true));
}
void [strictReceiptProbe, voidReceiptProbe];

test("public session input union compiles", () => undefined);

function cachePins(store: VerifiedStemStore | OpfsStemStore, identity: StemIdentity): [Promise<Blob>, Promise<void>] {
  return [store.read(identity), store.setOfflinePin(identity, "library", true)];
}
void cachePins;

function sourceProjection(session: EngineWebSession): [SourceObservation, FeedDiagnostics, PumpAllocation | null] {
  const observation = session.observeSource("source");
  observation.pull((chunk) => {
    const generation: bigint = chunk.generation;
    const frames: number = chunk.frames;
    const planes: readonly Float32Array[] = chunk.planes;
    // @ts-expect-error SDK borrowed metadata is readonly.
    chunk.frames = 0;
    void [generation, frames, planes];
  }, 2);
  const diagnostics = session.feedDiagnostics();
  // @ts-expect-error projected sources are readonly.
  diagnostics.sources.push({});
  return [observation, diagnostics, diagnostics.allocation.pump];
}
void sourceProjection;
