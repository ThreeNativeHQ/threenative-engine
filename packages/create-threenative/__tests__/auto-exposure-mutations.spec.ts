import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mutateExposureSource } from "./fixtures/auto-exposure/mutations.js";

const source = readFileSync(new URL("../template-assets/autoExposure.ts", import.meta.url), "utf8");
const graph = readFileSync(new URL("../template-assets/exposureGraph.ts", import.meta.url), "utf8");
const consumer = readFileSync(
  new URL("../template-assets/worldEnvironment.ts", import.meta.url),
  "utf8",
);
const entry = readFileSync(new URL("./fixtures/auto-exposure/main.ts", import.meta.url), "utf8");

describe("exposure mutation controls", () => {
  it.each(["linear", "disabled", "meter"] as const)(
    "changes exactly one declared %s shader seam",
    (mutation) => {
      const target = mutation === "disabled" ? source : graph;
      const mutated = mutateExposureSource(target, mutation);
      expect(mutated).not.toBe(target);
      expect(() => mutateExposureSource(mutated, mutation)).toThrow(/exactly one/);
    },
  );
  it("removes only the generated environment's actual auto-exposure installation in the control build", () => {
    const changed = mutateExposureSource(consumer, "consumer");
    expect(changed).toContain("const exposure = false");
    expect(changed).not.toContain("const exposure = options.autoExposureEnabled");
    expect(() => mutateExposureSource(changed, "consumer")).toThrow(/exactly one/);
  });
  it("uses the existing fixed-step clock only in the negative-control entry", () => {
    expect(mutateExposureSource(entry, "clock")).toContain(
      "Reflect.deleteProperty(globalThis, PLAYTEST_CLOCK_GLOBAL)",
    );
  });
  it("fails closed if the target disappeared or became ambiguous", () => {
    expect(() => mutateExposureSource("unrelated", "linear")).toThrow(/exactly one/);
    expect(() => mutateExposureSource(graph + graph, "linear")).toThrow(/exactly one/);
  });
});
