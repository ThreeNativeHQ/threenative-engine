import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { expect, test, vi } from "vitest";

import {
  PERFORMANCE_BROWSER_ARGS,
  reconcileBrowserPointers,
  WEBGPU_BROWSER_ARGS,
} from "../src/runner/browser.js";

test("multi-pointer browser input reconciles a complete held set without reinserting moves", () => {
  const previous = new Map([
    [7, { buttons: 1, id: 7, x: 0.2, y: 0.8 }],
    [3, { buttons: 1, id: 3, x: 0.8, y: 0.8 }],
  ]);

  expect(reconcileBrowserPointers(previous, [
    { id: 7, x: 0.25, y: 0.8 },
    { id: 3, x: 0.8, y: 0.8 },
  ])).toEqual([{
    isPrimary: true,
    pointer: { buttons: 1, id: 7, x: 0.25, y: 0.8 },
    type: "pointermove",
  }]);
  expect([...previous.keys()]).toEqual([7, 3]);
});

test("multi-pointer browser input releases missing pointers before adding new arrivals", () => {
  const previous = new Map([[7, { buttons: 1, id: 7, x: 0.2, y: 0.8 }]]);

  expect(reconcileBrowserPointers(previous, [{ id: 3, x: 0.8, y: 0.8 }])).toEqual([
    {
      isPrimary: true,
      pointer: { buttons: 0, id: 7, x: 0.2, y: 0.8 },
      type: "pointerup",
    },
    {
      isPrimary: true,
      pointer: { buttons: 1, id: 3, x: 0.8, y: 0.8 },
      type: "pointerdown",
    },
  ]);
});

test("the webgpu recipe keeps Vulkan available", () => {
  expect(WEBGPU_BROWSER_ARGS).toContain("--enable-features=Vulkan");
});

test("performance probes can bypass the virtual display compositor cadence", () => {
  expect(PERFORMANCE_BROWSER_ARGS).toEqual([
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
  ]);
});

test("browser module loads without Node process and keeps software adapter detection", () => {
  const source = readFileSync(new URL("../src/runner/browser.ts", import.meta.url), "utf8");
  const module = { exports: {} as Record<string, unknown> };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  runInNewContext(compiled, { exports: module.exports, module });

  const softwareAdapterName = module.exports.softwareAdapterName as (
    adapter: Readonly<Record<string, string>> | undefined,
  ) => string | undefined;
  expect(softwareAdapterName({ architecture: "swiftshader" })).toBe("swiftshader");
});

test("the host-display webgpu recipe selects the Vulkan hardware adapter", async () => {
  vi.stubEnv("TN_PLAYTEST_HOST_DISPLAY", "1");
  vi.resetModules();
  try {
    const { WEBGPU_BROWSER_ARGS: args } = await import("../src/runner/browser.js");
    expect(args).toContain("--use-angle=vulkan");
    expect(args).toContain("--use-vulkan");
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});

test.each([undefined, "0", "1"])("surface-less Vulkan requires the host-display opt-in (%s)", async (hostDisplay) => {
  vi.stubEnv("TN_PLAYTEST_HOST_DISPLAY", hostDisplay);
  vi.resetModules();
  try {
    const { WEBGPU_BROWSER_ARGS: args } = await import("../src/runner/browser.js");
    expect(args.includes("--disable-vulkan-surface")).toBe(hostDisplay === "1");
    expect(args.includes("--use-angle=vulkan")).toBe(hostDisplay === "1");
    expect(args.includes("--use-vulkan")).toBe(hostDisplay === "1");
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});
