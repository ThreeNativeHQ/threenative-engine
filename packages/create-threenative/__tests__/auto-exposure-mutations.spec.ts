import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  exposureMutationPlugin,
  meanMeterBaselinePlugin,
  mutateExposureSource,
} from "./fixtures/auto-exposure/mutations.js";

const gitSource = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: gitSource }));

const source = readFileSync(
  new URL("../../core/src/look/auto-exposure.ts", import.meta.url),
  "utf8",
);
const graph = readFileSync(
  new URL("../../core/src/look/exposure-graph.ts", import.meta.url),
  "utf8",
);
const consumer = readFileSync(
  new URL("../../core/src/look/world-environment.ts", import.meta.url),
  "utf8",
);
const entry = readFileSync(new URL("./fixtures/auto-exposure/main.ts", import.meta.url), "utf8");

type MutationPlugin = ReturnType<typeof exposureMutationPlugin>;

function runTransform(plugin: MutationPlugin, target: string, id: string): string | undefined {
  const hook = plugin.transform;
  if (typeof hook !== "function") throw new Error("Transform hook is not a function.");
  const result = Reflect.apply(hook, plugin, [target, id]) as
    | string
    | { code: string }
    | null
    | undefined;
  if (result == null) return undefined;
  return typeof result === "string" ? result : result.code;
}

function runBuildEnd(plugin: MutationPlugin): void {
  const hook = plugin.buildEnd;
  if (typeof hook !== "function") throw new Error("Build end hook is not a function.");
  Reflect.apply(hook, plugin, [undefined]);
}

describe("exposure mutation plugin routing", () => {
  it.each([
    ["linear", graph, "/repo/packages/core/src/look/exposure-graph.ts"],
    ["disabled", source, "/repo/packages/core/src/look/auto-exposure.ts"],
    ["meter", graph, "/repo/packages/core/src/look/exposure-graph.ts"],
    ["consumer", consumer, "/repo/packages/core/src/look/world-environment.ts"],
    ["clock", entry, "/repo/packages/create-threenative/__tests__/fixtures/auto-exposure/main.ts"],
  ] as const)("routes %s to the module that owns its seam", (mutation, target, id) => {
    const records: Array<{ mutation: string }> = [];
    const plugin = exposureMutationPlugin(mutation, (value) => records.push(value));
    const code = runTransform(plugin, target, id);
    expect(code).toContain(`// PRD339 mutation: ${mutation}`);
    expect(code).not.toBe(target);
    expect(records).toHaveLength(1);
    expect(() => runBuildEnd(plugin)).not.toThrow();
  });

  it.each(["linear", "disabled", "meter", "consumer", "clock"] as const)(
    "fails the %s build when its module never arrives",
    (mutation) => {
      const plugin = exposureMutationPlugin(mutation, () => {});
      expect(
        runTransform(plugin, "unrelated", "/repo/packages/core/src/look/unrelated.ts"),
      ).toBeUndefined();
      expect(() => runBuildEnd(plugin)).toThrow(/changed 0 modules/);
    },
  );
});

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

it("serves historic meter modules at their installed core paths with resolvable sibling imports", () => {
  const original =
    'import "./exposure.js"; import "./exposureGraph.js"; import "./exposureReadback.js";';
  gitSource.mockReturnValue(original);
  const plugin = meanMeterBaselinePlugin();
  if (typeof plugin.load !== "function") throw new Error("Missing baseline loader");
  for (const file of ["auto-exposure", "exposure-settings", "exposure-graph"]) {
    const loaded = Reflect.apply(plugin.load, plugin, [`/repo/packages/core/src/look/${file}.ts`]);
    expect(loaded).toBe(
      'import "./exposure-settings.js"; import "./exposure-graph.js"; import "./exposure-readback.js";',
    );
  }
  expect(() => runBuildEnd(plugin)).not.toThrow();
});
