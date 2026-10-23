import { describe, expect, it } from "vitest";

import { withFnBuilder } from "../src/fn-builder.js";

// The back end's Fn: calls the body with the inputs it was given and returns what the body built.
const backEnd = (callback: unknown) => {
  const inline = (...args: unknown[]) => (callback as (inputs: unknown) => unknown)(args);
  return Object.assign(inline, { setLayout: () => inline });
};

describe("Fn's builder argument", () => {
  it("passes the inputs through and keeps setLayout", () => {
    const Fn = withFnBuilder(backEnd);
    const double = Fn((inputs: unknown) => (inputs as number[]).map((value) => value * 2)) as ((
      ...args: number[]
    ) => number[]) & { setLayout(): unknown };
    expect(double(1, 2)).toEqual([2, 4]);
    expect(double.setLayout()).toBe(double);
  });

  it("refuses builder.object, geometry and material by name", () => {
    const Fn = withFnBuilder(backEnd);
    for (const name of ["object", "geometry", "material"]) {
      const body = Fn(
        (_: unknown, builder: Record<string, unknown>) => builder[name],
      ) as () => unknown;
      expect(body).toThrow(
        new RegExp(`TN_NATIVE_FN_BUILDER_UNSUPPORTED: Fn's builder\\.${name}`, "u"),
      );
    }
    expect(() => Fn(1)).toThrow(/TN_TSL Fn: expected a callback/u);
  });
});
