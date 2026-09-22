import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EngineWebAdapterError,
  type EngineWebAdapterErrorCode,
  type EngineWebAdapterErrorCause,
} from "../src/index.js";

const fixture = JSON.parse(await readFile("tests/fixtures/storage-error-contract.json", "utf8")) as {
  readonly name: string;
  readonly message: string;
  readonly code: EngineWebAdapterErrorCode;
  readonly phase: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly cause: EngineWebAdapterErrorCause;
};

test("public storage failure fixture keeps coarse and granular context separate", () => {
  const browserCause = new Error(fixture.cause.message);
  browserCause.name = fixture.cause.name;
  const error = new EngineWebAdapterError(fixture.code, fixture.message, fixture.details, browserCause);
  assert.equal(error.name, fixture.name);
  assert.equal(error.code, "storage.io");
  assert.equal(error.phase, fixture.phase);
  assert.equal(error.details.operation, "open");
  assert.equal(error.details.resource, "sparse-root");
  assert.equal(error.details.phase, "root-open");
  assert.equal(error.details.verification, undefined);
  assert.equal((error.cause as Error).name, "UnknownError");
});
