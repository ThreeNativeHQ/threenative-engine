import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FIXTURES_DIR,
  type IFixtureGolden,
  PACKAGE_ROOT,
  loadFixtures,
  numberBits,
  pinnedThreeVersion,
  readGolden,
} from "../src/fixture-format.js";
import {
  type IFixtureResult,
  NATIVE_RENDER_BLOCKED,
  compareObservation,
  runFixtures,
} from "../src/fixture-native.js";
import { fixturePattern, runNativeSuite } from "../tests/compatibility/run-native.js";

const VERSION = pinnedThreeVersion();
const FIXTURES = loadFixtures(FIXTURES_DIR);
const FAKE_DRIVER = path.join(PACKAGE_ROOT, "__tests__", "fixtures", "fake-driver.mjs");

/** The driver reads its mode from the environment, exactly as a real one would read a flag. */
function withDriverMode(mode: string): void {
  process.env.TN_FAKE_DRIVER_MODE = mode;
}

afterEach(() => {
  Reflect.deleteProperty(process.env, "TN_FAKE_DRIVER_MODE");
});

function goldens(): ReadonlyMap<string, IFixtureGolden> {
  const recorded = new Map<string, IFixtureGolden>();
  for (const fixture of FIXTURES) {
    const golden = readGolden(fixture.name, VERSION);
    if (golden !== null) recorded.set(fixture.name, golden);
  }
  return recorded;
}

function run(driver: string | null, fixtures = FIXTURES): readonly IFixtureResult[] {
  return runFixtures(fixtures, { driver, version: VERSION, goldens: goldens() });
}

function named(results: readonly IFixtureResult[], id: string): IFixtureResult {
  const found = results.find((result) => result.id === id);
  if (found === undefined) throw new Error(`no result for ${id}`);
  return found;
}

describe("the differential runner", () => {
  it("passes every fixture whose observations the driver reproduces", () => {
    withDriverMode("echo");
    const results = run(FAKE_DRIVER);
    expect(named(results, "matrix4-compose-invert").status).toBe("pass");
    expect(named(results, "matrix4-compose-invert").matched).toBe(8);
    expect(named(results, "nan-and-signed-zero").status).toBe("pass");
    expect(results.filter((result) => result.status === "fail")).toEqual([]);
    // A render row has a real golden and still never passes: the native renderer cannot draw it.
    expect(named(results, "lit-render").status).toBe("blocked");
    expect(named(results, "lit-render").reason).toBe(NATIVE_RENDER_BLOCKED);
    expect(
      FIXTURES.filter((fixture) => fixture.render !== undefined).map((fixture) => fixture.name),
    ).toEqual(expect.arrayContaining(["lit-render", "tonemap-ramp-aces", "tonemap-ramp-agx"]));
    for (const name of ["tonemap-ramp-linear", "tonemap-ramp-reinhard", "tonemap-ramp-cineon"])
      expect(named(results, name).reason).toBe(NATIVE_RENDER_BLOCKED);
  });

  it("selects one prefix of the corpus with --only, and refuses a glob that matches nothing", () => {
    const prefix = fixturePattern("math-core-*");
    const selected = FIXTURES.filter((fixture) => prefix.test(fixture.name)).map((f) => f.name);
    expect(selected.length).toBeGreaterThan(1);
    expect(selected.every((name) => name.startsWith("math-core-"))).toBe(true);
    expect(FIXTURES.some((fixture) => !prefix.test(fixture.name))).toBe(true);
    // A dot is a name character, not a wildcard: the glob must not reach across a fixture name.
    expect(fixturePattern("math-core.*").test("math-core-vectors")).toBe(false);
    const several = fixturePattern("lit-render,materials-*");
    expect(several.test("lit-render")).toBe(true);
    expect(several.test("materials-phong")).toBe(true);
    expect(several.test("lit-render-2")).toBe(false);
    expect(several.test("alpha-test")).toBe(false);
    expect(fixturePattern("math-core-?ectors").test("math-core-vectors")).toBe(true);
    expect(() => runNativeSuite(["--only", "math-nothing-*", "--driver", FAKE_DRIVER])).toThrow(
      /TN_FIXTURE_SELECTION_EMPTY/u,
    );
  });

  it("fails, naming the first differing value in bits and in decimals", () => {
    withDriverMode("perturb");
    const result = named(run(FAKE_DRIVER), "nan-and-signed-zero");
    expect(result.status).toBe("fail");
    expect(result.reason).toMatch(/expected n:[0-9a-f]{16}/u);
    expect(result.reason).toMatch(/observed n:[0-9a-f]{16}/u);
    expect(result.firstDifference).toEqual({
      index: 0,
      id: "base",
      source: "x[0]",
      expected: "n:8000000000000000",
      expectedDecimal: "-0",
      actual: "n:8000000000000001",
      actualDecimal: "-5e-324",
    });
  });

  it("blocks, never passes, when the driver refuses a fixture", () => {
    withDriverMode("unsupported");
    const results = run(FAKE_DRIVER);
    expect(results.filter((result) => result.status === "pass")).toEqual([]);
    expect(results.every((result) => result.status === "blocked")).toBe(true);
    expect(named(results, "quaternion-slerp").reason).toMatch(/unsupported/u);
  });

  it("blocks every fixture when the driver binary is missing", () => {
    withDriverMode("echo");
    const results = run(path.join(PACKAGE_ROOT, "no-such-driver"));
    expect(results.every((result) => result.status === "blocked")).toBe(true);
    expect(named(results, "euler-orders").reason).toMatch(/native driver not found/u);
  });

  it("blocks every fixture when no driver was named at all", () => {
    const results = run(null);
    expect(results.every((result) => result.status === "blocked")).toBe(true);
    expect(named(results, "euler-orders").reason).toMatch(/TN_NATIVE_FIXTURE_DRIVER/u);
  });

  it("blocks a render fixture even with no recorded golden, because the native renderer cannot draw", () => {
    withDriverMode("echo");
    const fixture = FIXTURES.find((entry) => entry.name === "lit-render");
    if (fixture === undefined) throw new Error("the corpus lost lit-render");
    const results = runFixtures([fixture], {
      driver: FAKE_DRIVER,
      version: VERSION,
      goldens: new Map(),
    });
    expect(named(results, "lit-render").status).toBe("blocked");
    expect(named(results, "lit-render").reason).toBe(NATIVE_RENDER_BLOCKED);
  });

  it("fails a fixture with no recorded golden, because nobody recorded what to match", () => {
    withDriverMode("echo");
    const fixture = FIXTURES.find((entry) => entry.name === "quaternion-slerp");
    if (fixture === undefined) throw new Error("the corpus lost quaternion-slerp");
    const results = runFixtures([fixture], {
      driver: FAKE_DRIVER,
      version: VERSION,
      goldens: new Map(),
    });
    expect(named(results, "quaternion-slerp").status).toBe("fail");
    expect(named(results, "quaternion-slerp").reason).toMatch(/no golden for three/u);
  });

  it("fails a driver that answers fewer observations than the fixture asserts", () => {
    withDriverMode("short");
    const result = named(run(FAKE_DRIVER), "euler-orders");
    expect(result.status).toBe("fail");
    expect(result.reason).toMatch(/answered 1 observation\(s\), the fixture asserts 30/u);
  });

  it("fails a driver that reports an error instead of an answer", () => {
    withDriverMode("error");
    const result = named(run(FAKE_DRIVER), "quaternion-slerp");
    expect(result.status).toBe("fail");
    expect(result.reason).toMatch(/TN_NATIVE_ENGINE_UNAVAILABLE/u);
  });

  it("accepts a value inside an ulp tolerance and refuses one outside it", () => {
    const golden = {
      index: 0,
      id: "v",
      kind: "number" as const,
      path: "x",
      value: "n:3ff0000000000000",
    };
    const answer = (bits: string) => ({
      kind: "obs" as const,
      index: 0,
      observation: "number" as const,
      value: `n:${bits}`,
    });
    expect(compareObservation(golden, answer("3ff0000000000000"), { ulps: 1 })).toBeNull();
    expect(compareObservation(golden, answer("3ff0000000000001"), { ulps: 1 })).toBeNull();
    expect(compareObservation(golden, answer("3ff0000000000002"), { ulps: 1 })?.actual).toBe(
      "n:3ff0000000000002",
    );
    expect(compareObservation(golden, answer("3ff0000000000001"), { abs: 1 })).toBeNull();
    // A tolerance of zero still refuses +0 where the reference wrote -0.
    const zero = { ...golden, value: "n:8000000000000000" };
    expect(compareObservation(zero, answer("0000000000000000"), { abs: 0 })?.actualDecimal).toBe(
      "0",
    );
    // Two NaNs agree whatever payload the hardware raised.
    const nan = { ...golden, value: `n:${numberBits(Number.NaN)}` };
    expect(compareObservation(nan, answer("fff8000000000000"), { abs: 0 })).toBeNull();
    expect(compareObservation(nan, answer("3ff0000000000000"), { abs: 0 })?.actualDecimal).toBe(
      "1",
    );
  });
});
