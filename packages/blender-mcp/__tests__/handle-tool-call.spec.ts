import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleToolCall } from "../src/index.js";

/** Every process start the bridge could make. A bad argument must fail before any of them runs. */
const spawns = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const refuse = (name: string) => () => {
    spawns.push(name);
    throw new Error(`${name} reached: Blender would have started`);
  };
  return { ...actual, execFile: refuse("execFile"), execFileSync: refuse("execFileSync") };
});

function call(name: string, args: Record<string, unknown> = {}) {
  return handleToolCall({ arguments: args, name });
}

beforeEach(() => {
  spawns.length = 0;
});

describe("handleToolCall argument guards", () => {
  it.each([
    [
      "blender_inspect without a source",
      "blender_inspect",
      {},
      "blender_inspect requires a non-empty string 'source' argument.",
    ],
    [
      "blender_convert with a blank out",
      "blender_convert",
      { out: "  ", source: "a.glb" },
      "blender_convert requires a non-empty string 'out' argument.",
    ],
    [
      "blender_export_world with a zero cell",
      "blender_export_world",
      { cell: 0, out: "o", source: "s.blend" },
      "blender_export_world 'cell' must be a number greater than zero.",
    ],
    [
      "blender_export_world with a text cell",
      "blender_export_world",
      { cell: "64", out: "o", source: "s.blend" },
      "blender_export_world 'cell' must be a number greater than zero.",
    ],
    [
      "blender_export_world with a negative spacing",
      "blender_export_world",
      { cell: 64, out: "o", source: "s.blend", spacing: -2 },
      "blender_export_world 'spacing' must be a number greater than zero.",
    ],
    [
      "blender_run_python without a script",
      "blender_run_python",
      {},
      "blender_run_python requires a non-empty string 'script' argument.",
    ],
    [
      "blender_run_python with a text timeout",
      "blender_run_python",
      { script: "s.py", timeoutMs: "5000" },
      "blender_run_python 'timeoutMs' must be a positive whole number of milliseconds.",
    ],
    [
      "blender_recipes with text arguments",
      "blender_recipes",
      { arguments: "cell=64", name: "export_world" },
      "blender_recipes 'arguments' must be an object.",
    ],
    ["an unknown tool", "blender_fly", {}, "Unknown blender MCP tool 'blender_fly'."],
  ])(
    "refuses %s with its named error before Blender starts",
    async (_label, name, args, message) => {
      await expect(call(name, args)).rejects.toThrow(message);
      expect(spawns).toEqual([]);
    },
  );

  it("refuses run_python arguments that are not an object instead of running with none", async () => {
    await expect(
      call("blender_run_python", { arguments: "cell=64", script: "s.py" }),
    ).rejects.toThrow("blender_run_python 'arguments' must be an object.");
    expect(spawns).toEqual([]);
  });

  it.each([-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses run_python timeoutMs %s, which Node rejects or leaves unbounded",
    async (timeoutMs) => {
      await expect(call("blender_run_python", { script: "s.py", timeoutMs })).rejects.toThrow(
        "blender_run_python 'timeoutMs' must be a positive whole number of milliseconds.",
      );
      expect(spawns).toEqual([]);
    },
  );
});
