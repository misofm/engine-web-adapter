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

test("cause transport uses UTF-8 byte bounds and keeps bounded sibling summaries", () => {
  const details = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`detail-${index}`, "漢".repeat(512)]));
  const bounded = serializeEngineWebAdapterCause(new EngineWebAdapterError("storage.io", "wide details", details));
  assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).byteLength <= 16 * 1024);
  assert.equal(bounded.truncated, true);

  const siblings = Array.from({ length: 8 }, (_, index) => new EngineWebAdapterError("storage.io", `sibling-${index}`, Object.fromEntries(
    Array.from({ length: 6 }, (_, detail) => [`detail-${detail}`, "x".repeat(483)]),
  )));
  const first = serializeEngineWebAdapterCause(new AggregateError(siblings, "many siblings"));
  const second = serializeEngineWebAdapterCause(first);
  assert.deepEqual(first.causes?.map((cause) => cause.message), siblings.map((error) => error.message));
  assert.deepEqual(second.causes?.map((cause) => cause.message), siblings.map((error) => error.message));
  assert.ok(new TextEncoder().encode(JSON.stringify(second)).byteLength <= 16 * 1024);
  const revived = reviveEngineWebAdapterCause(second) as AggregateError;
  const revivedSerialized = serializeEngineWebAdapterCause(revived);
  assert.deepEqual(revivedSerialized.causes?.map((cause) => cause.message), siblings.map((error) => error.message));

  const plainErrors = serializeEngineWebAdapterCause({
    name: "AggregateError",
    message: "plain errors",
    errors: [{ name: "BODY", message: "body" }, { name: "FINALIZER", message: "cleanup" }],
  });
  assert.deepEqual(plainErrors.causes?.map((cause) => cause.name), ["BODY", "FINALIZER"]);

  const clipped = serializeEngineWebAdapterCause(new Error("m".repeat(2_000), {
    cause: new EngineWebAdapterError("storage.io", "key clipping", { ["k".repeat(2_000)]: "v".repeat(2_000) }),
  }));
  assert.equal(clipped.truncated, true);
  assert.match(clipped.message, /\[truncated\]$/u);
  const clippedDetails = Object.entries(clipped.cause?.details ?? {});
  assert.ok(clippedDetails.some(([key, value]) => key.endsWith("[truncated]") && value === "v".repeat(501) + "[truncated]"));

  const clippedProof = serializeEngineWebAdapterCause(new EngineWebAdapterError("stem.corrupt", "clipped proof", {
    verification: { kind: "digest", expected: "漢".repeat(512), observed: "異".repeat(512), algorithm: "blake3-256" },
  }));
  assert.equal(clippedProof.code, undefined);
  assert.equal(clippedProof.details?.serialization, "integrity-evidence-insufficient");
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

test("cause transport reserves every retained sibling summary before detail pressure", () => {
  const detailPressure = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`d${index}`, "x".repeat(483)]));
  const identity = (cause: EngineWebAdapterErrorCause) => cause.causes?.map((sibling) => [sibling.name, sibling.message]);
  const assertRoundTrips = (serialized: EngineWebAdapterErrorCause, expected: readonly (readonly [string, string])[]) => {
    assert.equal(serialized.causes?.length, expected.length);
    assert.deepEqual(identity(serialized), expected);
    assert.ok(serialized.causes?.every((sibling) => sibling.name.length > 0 && sibling.message.length > 0));
    assert.ok(new TextEncoder().encode(JSON.stringify(serialized)).byteLength <= 16 * 1024);

    const repeated = serializeEngineWebAdapterCause(serialized);
    assert.deepEqual(identity(repeated), expected);
    const revived = reviveEngineWebAdapterCause(repeated) as AggregateError;
    assert.deepEqual(identity(serializeEngineWebAdapterCause(revived)), expected);
  };

  const wide = serializeEngineWebAdapterCause({
    name: "AggregateError",
    message: "root",
    errors: Array.from({ length: 3 }, (_, index) => ({
      name: `N${index}${"漢".repeat(512)}`,
      message: `S${index}${"漢".repeat(512)}`,
      details: detailPressure,
    })),
  });
  const wideExpected = wide.causes!.map((sibling) => [sibling.name, sibling.message] as const);
  assert.ok(wideExpected.every(([name, message], index) =>
    name.startsWith(`N${index}`) && name.endsWith("[truncated]") &&
    message.startsWith(`S${index}`) && message.endsWith("[truncated]")));
  assertRoundTrips(wide, wideExpected);
  assert.equal(wide.truncated, true);

  const ordinary = serializeEngineWebAdapterCause({
    name: "AggregateError",
    message: "root",
    errors: Array.from({ length: 3 }, (_, index) => ({
      name: "Error",
      message: `S${index}${"漢".repeat(512)}`,
      details: detailPressure,
    })),
  });
  const ordinaryExpected = ordinary.causes!.map((sibling) => [sibling.name, sibling.message] as const);
  assert.ok(ordinaryExpected.every(([name, message], index) =>
    name === "Error" && message.startsWith(`S${index}`) && message.endsWith("[truncated]")));
  assertRoundTrips(ordinary, ordinaryExpected);

  const cases = [
    { count: 1, glyph: "x", repeats: 32, detailKeys: 0, detailLength: 0 },
    { count: 2, glyph: "漢", repeats: 256, detailKeys: 8, detailLength: 192 },
    { count: 4, glyph: "𐍈", repeats: 128, detailKeys: 24, detailLength: 320 },
  ] as const;
  for (const { count, glyph, repeats, detailKeys, detailLength } of cases) {
    const details = Object.fromEntries(Array.from({ length: detailKeys }, (_, index) => [`d${index}`, "v".repeat(detailLength)]));
    const serialized = serializeEngineWebAdapterCause(new AggregateError(
      Array.from({ length: count }, (_, index) => ({
        name: `N${index}${glyph.repeat(repeats)}`,
        message: `S${index}${glyph.repeat(repeats)}`,
        details,
      })),
      `table-${count}`,
    ));
    const expected = serialized.causes!.map((sibling) => [sibling.name, sibling.message] as const);
    assert.ok(expected.every(([name, message], index) =>
      name.startsWith(`N${index}`) && message.startsWith(`S${index}`)));
    assertRoundTrips(serialized, expected);
  }
});
