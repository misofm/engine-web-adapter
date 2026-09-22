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

const serializedCauseBytes = (cause: EngineWebAdapterErrorCause): number =>
  new TextEncoder().encode(JSON.stringify(cause)).byteLength;

function assertUsefulCauseSummaries(cause: EngineWebAdapterErrorCause, path = "root"): void {
  assert.equal(typeof cause.name, "string", `${path} name must be present`);
  assert.equal(typeof cause.message, "string", `${path} message must be present`);
  assert.ok(cause.name.length > 0, `${path} name must be useful`);
  assert.ok(cause.message.length > 0, `${path} message must be useful`);
  for (const [index, child] of (cause.causes ?? []).entries()) {
    assertUsefulCauseSummaries(child, `${path}.causes[${index}]`);
  }
  if (cause.cause !== undefined) assertUsefulCauseSummaries(cause.cause, `${path}.cause`);
}

function causeIdentity(cause: EngineWebAdapterErrorCause): unknown {
  return {
    name: cause.name,
    message: cause.message,
    causes: cause.causes?.map(causeIdentity),
    cause: cause.cause === undefined ? undefined : causeIdentity(cause.cause),
  };
}

test("cause transport globally reserves nested direct and aggregate identities across the pad boundary", () => {
  const detailPressure = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`d${index}`, "漢".repeat(512)]));
  const build = (edge: "cause" | "causes", pad: number): Record<string, unknown> => {
    const child = { name: "Child", message: "child" };
    const parent: Record<string, unknown> = {
      name: `N${"漢".repeat(512)}`,
      message: `S${"漢".repeat(512)}`,
      details: { ...detailPressure, pad: "x".repeat(pad) },
    };
    if (edge === "cause") parent.cause = child;
    else parent.causes = [child];
    return { name: "AggregateError", message: "root", errors: [parent] };
  };

  for (const edge of ["cause", "causes"] as const) {
    for (let pad = 0; pad <= 512; pad += 1) {
      const first = serializeEngineWebAdapterCause(build(edge, pad));
      assert.ok(serializedCauseBytes(first) <= 16 * 1024, `${edge} pad ${pad} exceeded the byte bound`);
      assertUsefulCauseSummaries(first);
      const parent = first.causes?.[0];
      assert.ok(parent, `${edge} pad ${pad} lost its retained parent`);
      const retainedChild = edge === "cause" ? parent.cause : parent.causes?.[0];
      assert.deepEqual(retainedChild && { name: retainedChild.name, message: retainedChild.message }, {
        name: "Child",
        message: "child",
      }, `${edge} pad ${pad} lost its child identity`);

      const repeated = serializeEngineWebAdapterCause(first);
      assertUsefulCauseSummaries(repeated);
      assert.deepEqual(causeIdentity(repeated), causeIdentity(first), `${edge} pad ${pad} changed on repeat`);
      const revived = serializeEngineWebAdapterCause(reviveEngineWebAdapterCause(repeated));
      assertUsefulCauseSummaries(revived);
      assert.deepEqual(causeIdentity(revived), causeIdentity(first), `${edge} pad ${pad} changed after revival`);
      if (pad === 252 || pad === 270) {
        assert.equal(retainedChild?.name, "Child");
        assert.equal(retainedChild?.message, "child");
      }
    }
  }
});

test("cause transport keeps a bounded generated tree valid for depth, width, Unicode, and JSON escapes", () => {
  const tokens = ["plain", "漢", "𐍈", "\"\\\n\t\u0000"];
  const detailFor = (token: string, depth: number): Readonly<Record<string, unknown>> => Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [
      `k${index}-${token}`,
      `${token}${"漢".repeat(256)}-${depth}-${"\\\"\n".repeat(12)}`,
    ]),
  );
  const build = (depth: number, width: number, token: string, edge: "cause" | "causes"): Record<string, unknown> => {
    const node: Record<string, unknown> = {
      name: `N${depth}-${token}`,
      message: `M${depth}-${token}`,
      details: { ...detailFor(token, depth), pad: "x".repeat(512) },
    };
    if (depth > 0) {
      const children = Array.from({ length: width }, () => build(depth - 1, width, token, edge));
      if (edge === "cause") node.cause = children[0];
      else node.causes = children;
    }
    return node;
  };

  const cases = tokens.flatMap((token, index) => [
    { depth: index + 3, width: 1, edge: index % 2 === 0 ? ("cause" as const) : ("causes" as const) },
    { depth: 2, width: 8, edge: "causes" as const },
  ]);
  for (const { depth, width, edge } of cases) {
    const first = serializeEngineWebAdapterCause({
      name: "AggregateError",
      message: `root-${tokens[depth % tokens.length]}`,
      errors: [build(depth, width, tokens[depth % tokens.length]!, edge)],
    });
    assert.ok(serializedCauseBytes(first) <= 16 * 1024, `generated depth ${depth} width ${width} exceeded the byte bound`);
    assertUsefulCauseSummaries(first);
    const repeated = serializeEngineWebAdapterCause(first);
    assert.ok(serializedCauseBytes(repeated) <= 16 * 1024);
    assertUsefulCauseSummaries(repeated);
    assert.deepEqual(causeIdentity(repeated), causeIdentity(first));
    const revived = serializeEngineWebAdapterCause(reviveEngineWebAdapterCause(repeated));
    assert.ok(serializedCauseBytes(revived) <= 16 * 1024);
    assertUsefulCauseSummaries(revived);
    assert.deepEqual(causeIdentity(revived), causeIdentity(first));
  }
});
