import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EngineWebAdapterError,
  type EngineWebAdapterErrorCode,
  type EngineWebAdapterErrorCause,
} from "../src/index.js";
import { reviveEngineWebAdapterCause, serializeEngineWebAdapterCause } from "../src/errors.js";

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

test("cause transport bounds strings, keys, total payload, and serialized aggregates", () => {
  const corrupt = new EngineWebAdapterError("stem.corrupt", "verified mismatch", {
    verification: { kind: "digest", expected: "a".repeat(64), observed: "b".repeat(64), algorithm: "blake3-256" },
    detail: "x".repeat(1_000_000),
  });
  const aggregate = new AggregateError([
    new Error("BODY_IO"),
    new Error("wrapper", { cause: corrupt }),
    new Error("sibling"),
  ], "triple aggregate");
  const serialized = serializeEngineWebAdapterCause(aggregate);
  assert.ok(JSON.stringify(serialized).length < 16_384);
  assert.equal(serialized.causes?.length, 3);
  const wrapped = serialized.causes?.[1];
  const nested = wrapped?.cause;
  assert.equal(nested?.code, "stem.corrupt");
  assert.deepEqual(nested?.details?.verification, corrupt.details.verification);

  const plainSerialized = {
    name: "AggregateError",
    message: "serialized aggregate",
    causes: [
      { name: "BODY_IO", message: "body" },
      serialized.causes![1]!,
      { name: "FINALIZER", message: "cleanup" },
    ],
  } satisfies EngineWebAdapterErrorCause;
  const reserialized = serializeEngineWebAdapterCause(plainSerialized);
  assert.equal(reserialized.causes?.length, 3);
  assert.equal(reserialized.causes?.[1]?.cause?.code, "stem.corrupt");
  assert.deepEqual(reserialized.causes?.[1]?.cause?.details?.verification, corrupt.details.verification);
  const revived = reviveEngineWebAdapterCause(reserialized) as AggregateError;
  assert.equal(revived.errors.length, 3);
});

test("cause transport marks depth/claim truncation and survives throwing exotic access", () => {
  const leaf = new EngineWebAdapterError("stem.corrupt", "verified mismatch", {
    verification: { kind: "length", expected: 4, observed: 3 },
  });
  let supported: unknown = leaf;
  for (let index = 0; index < 3; index += 1) supported = new Error(`supported-${index}`, { cause: supported });
  const supportedCause = serializeEngineWebAdapterCause(supported);
  const supportedLeaf = supportedCause.cause?.cause?.cause;
  assert.equal(supportedLeaf?.code, "stem.corrupt");
  assert.deepEqual(supportedLeaf?.details?.verification, leaf.details.verification);

  let value: unknown = leaf;
  for (let index = 0; index < 5; index += 1) value = new Error(`wrapper-${index}`, { cause: value });
  const deep = serializeEngineWebAdapterCause(value);
  assert.equal(deep.truncated, true);
  const exotic = new Proxy({}, {
    get() { throw new Error("getter exploded"); },
    has() { throw new Error("has exploded"); },
    ownKeys() { throw new Error("keys exploded"); },
  });
  assert.doesNotThrow(() => serializeEngineWebAdapterCause(exotic));

  const codeOnly = serializeEngineWebAdapterCause(new EngineWebAdapterError("stem.corrupt", "no proof"));
  assert.equal(codeOnly.code, undefined);
  assert.equal(codeOnly.truncated, true);
  assert.equal(codeOnly.details?.serialization, "integrity-evidence-insufficient");
  const equalEvidence = serializeEngineWebAdapterCause(new EngineWebAdapterError("stem.corrupt", "no mismatch", {
    verification: { kind: "length", expected: 4, observed: 4 },
  }));
  assert.equal(equalEvidence.code, undefined);
});
