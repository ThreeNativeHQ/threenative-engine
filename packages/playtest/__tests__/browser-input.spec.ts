import { expect, test } from "vitest";

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

test("the webgpu recipe asks for Vulkan so the run does not land on SwiftShader", () => {
  expect(WEBGPU_BROWSER_ARGS).toContain("--enable-features=Vulkan");
});

test("performance probes can bypass the virtual display compositor cadence", () => {
  expect(PERFORMANCE_BROWSER_ARGS).toEqual([
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
  ]);
});

test("the webgpu recipe selects the Vulkan hardware adapter", () => {
  expect(WEBGPU_BROWSER_ARGS).toContain("--use-angle=vulkan");
  expect(WEBGPU_BROWSER_ARGS).toContain("--use-vulkan");
});
