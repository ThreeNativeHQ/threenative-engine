import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { expect, test, vi } from "vitest";

import {
  measurementBrowserArgs,
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

test("a frame-time assertion unthrottles only the virtual display, so a real display keeps its cadence", () => {
  expect(measurementBrowserArgs(true, false, "virtual")).toEqual(PERFORMANCE_BROWSER_ARGS);
  // Unthrottled on a real display, a game faster than 60 fps reads the swapchain's back-pressure
  // (about one 17 ms wait every few rAF callbacks) as an interval p95 over 16.7 ms.
  expect(measurementBrowserArgs(true, false, "real")).toEqual([]);
  // The completion window measures unthrottled completion on the session display by design.
  expect(measurementBrowserArgs(false, true, "real")).toEqual(PERFORMANCE_BROWSER_ARGS);
  expect(measurementBrowserArgs(false, false, "virtual")).toEqual([]);
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

// The forced ANGLE/Vulkan flags turned the sky black on the owner's KDE Xwayland display
// (2026-10-23): the same NVIDIA adapter drew the sky with them off. One recipe for every display.
test.each([undefined, "0", "1"])("the webgpu recipe adds no ANGLE/Vulkan override on any display (%s)", async (hostDisplay) => {
  vi.stubEnv("TN_PLAYTEST_HOST_DISPLAY", hostDisplay);
  vi.resetModules();
  try {
    const { WEBGPU_BROWSER_ARGS: args } = await import("../src/runner/browser.js");
    expect(args).not.toContain("--disable-vulkan-surface");
    expect(args).not.toContain("--use-angle=vulkan");
    expect(args).not.toContain("--use-vulkan");
    expect(args).toContain("--enable-features=Vulkan");
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});
