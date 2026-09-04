import test from "node:test";

import type { EngineWebSessionOptions } from "../src/index.js";
import type { StemResolver } from "../src/stems/index.js";

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

test("public session input union compiles", () => undefined);
