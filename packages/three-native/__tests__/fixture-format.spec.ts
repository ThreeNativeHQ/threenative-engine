import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FIXTURES_DIR,
  GOLDENS_DIR,
  type IFixture,
  type IFixtureTolerance,
  bitsNumber,
  fixtureErrors,
  goldenErrors,
  loadFixtures,
  numberBits,
  parseFixture,
  pinnedThreeVersion,
  readGolden,
} from "../src/fixture-format.js";

/** The format is readonly on purpose; a fixture that breaks one rule has to be mutable to do it. */
type Writable<T> = {
  -readonly [Key in keyof T]: T[Key] extends object ? Writable<T[Key]> : T[Key];
};

/** A fixture the validator must accept, before a test breaks exactly one rule in it. */
function fixture(): Writable<IFixture> {
  return {
    name: "sample",
    adaptedFrom: "original",
    tolerance: { abs: 0 },
    ops: [{ op: "new", id: "m", class: "Matrix4", args: [] }],
    observe: [{ id: "m", path: "elements", kind: "numbers" }],
  };
}

function copy(): Writable<IFixture> {
  return JSON.parse(JSON.stringify(fixture())) as Writable<IFixture>;
}

function messages(value: unknown): readonly string[] {
  return fixtureErrors(value, "sample");
}

function without(key: "tolerance" | "observe"): unknown {
  const value = copy();
  Reflect.deleteProperty(value, key);
  return value;
}

function withTolerance(tolerance: IFixtureTolerance): unknown {
  const value = copy();
  value.tolerance = tolerance;
  return value;
}

function withOp(op: unknown): unknown {
  const value = copy();
  value.ops[0] = op as never;
  return value;
}

function withObservation(observation: unknown): unknown {
  const value = copy();
  value.observe[0] = observation as never;
  return value;
}

/** Two rules broken at once, so the validator has to name both. */
function withNoToleranceAndNoObservations(): unknown {
  const value = withTolerance({});
  Reflect.deleteProperty(value as object, "observe");
  return value;
}

/** A fixture that renders one frame and observes it: the shape every render golden needs. */
function rendered(): Writable<IFixture> {
  const value = copy();
  value.ops.unshift({ op: "new", id: "s", class: "Scene", args: [] });
  value.render = {
    scene: "s",
    camera: "m",
    width: 320,
    height: 240,
    toneMapping: "aces",
    toneMappingExposure: 1,
    outputColorSpace: "srgb",
  };
  value.observe.push({
    id: "s",
    kind: "pixels",
    metric: { maxPixelMismatchRatio: 0.002, maxPerceptualDeltaE: 1 },
  });
  return value;
}

describe("fixture format", () => {
  it("accepts a gltf op on a repository path and refuses one that leaves the repository", () => {
    const at = (file: string) => messages(withOp({ op: "gltf", id: "m", file }));
    expect(at("examples/csg-doorway/assets/doorway.glb")).toEqual([]);
    for (const file of ["../secret.glb", "/etc/model.glb", "a/../../b.glb", "model.obj", ""])
      expect(at(file).join("\n"), file).toMatch(/\.file: required, a repository-relative/u);
  });

  it("accepts a minimal fixture", () => {
    expect(messages(fixture())).toEqual([]);
  });

  it("rejects a fixture with no observations", () => {
    expect(messages(without("observe"))).toContainEqual(expect.stringContaining("$.observe"));
  });

  it("rejects a fixture with no tolerance", () => {
    expect(messages(without("tolerance"))).toContainEqual(
      expect.stringContaining("$.tolerance: required"),
    );
  });

  it("rejects a tolerance with neither an absolute nor a ulp bound", () => {
    expect(messages(withTolerance({}))).toContainEqual(
      expect.stringContaining("$.tolerance: needs at least one"),
    );
  });

  it("rejects a negative tolerance", () => {
    expect(messages(withTolerance({ abs: -1 }))).toContainEqual(
      expect.stringContaining("$.tolerance.abs"),
    );
  });

  it("rejects an unknown observation kind", () => {
    expect(messages(withObservation({ id: "m", path: "x", kind: "colour" }))).toContainEqual(
      expect.stringContaining("$.observe[0].kind"),
    );
  });

  it("rejects an unknown operation", () => {
    expect(messages(withOp({ op: "bind" }))).toContainEqual(expect.stringContaining("$.ops[0].op"));
  });

  it("rejects a reference to an id no operation bound", () => {
    expect(
      messages(withOp({ op: "call", id: "ghost", method: "copy", args: [{ ref: "nowhere" }] })),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("$.ops[0].id"),
        expect.stringContaining("$.ops[0].args[0].ref"),
      ]),
    );
  });

  it("accepts a record of scalars and rejects a nested value or a key that is no identifier", () => {
    const at = (record: unknown) =>
      messages(withOp({ op: "new", id: "m", class: "ExtrudeGeometry", args: [{ record }] }));
    expect(at({ depth: 2, bevelEnabled: false, name: "x", path: null })).toEqual([]);
    expect(at({ shape: { ref: "s" } }).join("\n")).toMatch(
      /record\.shape: must be a finite number/u,
    );
    expect(at({ depth: Number.POSITIVE_INFINITY }).join("\n")).toMatch(
      /record\.depth: must be a finite/u,
    );
    expect(at({ "bad key": 1 }).join("\n")).toMatch(/keys must match/u);
  });

  it("rejects an observation that reads both a path and a method", () => {
    expect(
      messages(withObservation({ id: "m", path: "x", method: "det", kind: "number" })),
    ).toEqual(expect.arrayContaining([expect.stringContaining("$.observe[0]")]));
  });

  it("rejects a fixture whose name does not match its file", () => {
    expect(fixtureErrors(fixture(), "other")).toContainEqual(
      expect.stringContaining("does not match its file"),
    );
  });

  it("names every disagreement and throws on the first call that reads them", () => {
    const broken = withNoToleranceAndNoObservations();
    expect(fixtureErrors(broken, "sample").length).toBeGreaterThanOrEqual(2);
    expect(() => parseFixture(broken, "sample")).toThrow(/TN_FIXTURE_INVALID/u);
  });

  it("accepts a render block whose frame something observes", () => {
    expect(messages(rendered())).toEqual([]);
  });

  it("rejects a render block with no size, and one naming a tone mapping three does not have", () => {
    const sizeless = rendered();
    Reflect.deleteProperty(sizeless.render as object as object, "height");
    expect(messages(sizeless)).toContainEqual(expect.stringContaining("$.render.height"));
    const unknown = rendered();
    (unknown.render as { toneMapping: string }).toneMapping = "filmic";
    expect(messages(unknown)).toContainEqual(expect.stringContaining("$.render.toneMapping"));
  });

  it("rejects a pixels observation with no render block, a missing metric, or a foreign scene", () => {
    const orphan = withObservation({
      id: "m",
      kind: "pixels",
      metric: { maxPixelMismatchRatio: 0.002, maxPerceptualDeltaE: 1 },
    });
    expect(messages(orphan)).toContainEqual(
      expect.stringContaining("a pixels observation needs a $.render block"),
    );
    const metricless = rendered();
    metricless.observe[0] = { id: "s", kind: "pixels" };
    expect(messages(metricless)).toEqual(
      expect.arrayContaining([expect.stringContaining("$.observe[0].metric")]),
    );
    const foreign = rendered();
    foreign.observe[0] = {
      id: "m",
      kind: "pixels",
      metric: { maxPixelMismatchRatio: 0.002, maxPerceptualDeltaE: 1 },
    };
    expect(messages(foreign)).toContainEqual(expect.stringContaining("$.observe[0].id"));
  });

  it("rejects a render block that renders a frame nothing observes", () => {
    const silent = rendered();
    silent.observe = [];
    expect(messages(silent)).toEqual(
      expect.arrayContaining([expect.stringContaining("$.render: a render block needs a pixels")]),
    );
  });

  it("rejects a golden whose pixels observation names no capture, and one whose capture is unhashed", () => {
    const unhashed = JSON.parse(
      readFileSync(path.join(GOLDENS_DIR, pinnedThreeVersion(), "lit-render.json"), "utf8"),
    );
    Reflect.deleteProperty(unhashed.render, "pngSha256");
    expect(goldenErrors(unhashed, "lit-render")).toContainEqual(
      expect.stringContaining("$.render.pngSha256"),
    );
    Reflect.deleteProperty(unhashed, "render");
    expect(goldenErrors(unhashed, "lit-render")).toContainEqual(
      expect.stringContaining("$.render: required"),
    );
    unhashed.render = { png: "lit-render.png", pngSha256: "nope", width: 320, height: 240 };
    expect(goldenErrors(unhashed, "lit-render")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("$.render.pngSha256"),
        expect.stringContaining("$.render.adapter"),
      ]),
    );
  });

  it("reads every number's bits without losing -0", () => {
    expect(numberBits(-0)).toBe("8000000000000000");
    expect(numberBits(0)).toBe("0000000000000000");
    expect(Object.is(bitsNumber(numberBits(-0)), -0)).toBe(true);
    expect(Object.is(bitsNumber(numberBits(0)), -0)).toBe(false);
    expect(numberBits(Number.NaN)).toBe("7ff8000000000000");
    expect(Number.isNaN(bitsNumber(numberBits(Number.NaN)))).toBe(true);
    expect(numberBits(Number.POSITIVE_INFINITY)).toBe("7ff0000000000000");
    expect(bitsNumber(numberBits(Number.NEGATIVE_INFINITY))).toBe(Number.NEGATIVE_INFINITY);
    expect(() => bitsNumber("nope")).toThrow(/TN_FIXTURE_BITS_INVALID/u);
  });
});

describe("the seed corpus", () => {
  const fixtures = loadFixtures(FIXTURES_DIR);
  const version = pinnedThreeVersion();

  it("parses every fixture in the corpus, seeds first and in name order", () => {
    const names = fixtures.map((entry) => entry.name);
    // PRD-498 seeded this corpus; PRD-501 added the four math groups beside those seeds.
    expect(names).toEqual(
      expect.arrayContaining([
        "euler-orders",
        "lit-render",
        "matrix4-compose-invert",
        "nan-and-signed-zero",
        "object3d-hierarchy-matrixworld",
        "quaternion-slerp",
        "vector3-apply-quaternion",
      ]),
    );
    for (const group of ["math-core-", "math-edges-", "math-euler-", "math-primitives-"])
      expect(names.some((name) => name.startsWith(group))).toBe(true);
    // The conformance parent orders its rows by name, so the corpus has to arrive in that order.
    expect(names).toEqual([...names].sort());
  });

  it("covers the hierarchy, matrix and edge cases the PRD names", () => {
    const names = fixtures.map((entry) => entry.name).join(",");
    for (const required of [
      "matrix4-compose-invert",
      "object3d-hierarchy-matrixworld",
      "nan-and-signed-zero",
    ])
      expect(names).toContain(required);
  });

  it("has a recorded golden for every fixture at the pinned reference version", () => {
    for (const entry of fixtures) {
      const golden = readGolden(entry.name, version);
      expect(golden, `${entry.name} has no golden for three ${version}`).not.toBeNull();
      if (golden?.blocked === null) expect(golden.observations.length).toBeGreaterThan(0);
    }
  });

  it("records the sign of zero in the golden, because JSON cannot", () => {
    expect(readGolden("nan-and-signed-zero", version)?.observations[0]?.value).toBe(
      "n:8000000000000000",
    );
    expect(readFileSync(path.join(FIXTURES_DIR, "nan-and-signed-zero.json"), "utf8")).toContain(
      "-0",
    );
  });
});
