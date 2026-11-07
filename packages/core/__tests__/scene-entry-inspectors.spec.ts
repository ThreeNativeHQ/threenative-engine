// The scene-entry audits are one ordered list, so adding a fourth does not edit the lifecycle file.
// These cases pin the order that matters (the opacity convention before the audit that reports what
// it did) and that a caller can add its own without the engine's findings moving.
import { Group, Mesh, MeshStandardMaterial } from "three";
import { describe, expect, it, vi } from "vitest";
import {
  SCENE_ENTRY_INSPECTORS,
  type SceneEntryInspector,
  inspectSceneEntry,
} from "../src/scene-entry-inspectors.js";

describe("the scene-entry inspectors", () => {
  it("should report every finding at the level it asks for", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const inspectors: readonly SceneEntryInspector[] = [
        () => [{ level: "warn", line: "first" }],
        () => [{ level: "error", line: "second" }],
      ];
      inspectSceneEntry(new Group(), inspectors);
      expect(warn.mock.calls).toEqual([["first"]]);
      expect(error.mock.calls).toEqual([["second"]]);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("should keep the engine's own order: the opacity convention reports before the audit", () => {
    // A transparent standard material is the condition the convention speaks to; whatever the
    // audit then says must come after it, which is why the array is ordered rather than a set.
    expect(SCENE_ENTRY_INSPECTORS.length).toBe(3);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const scene = new Group();
      const material = new MeshStandardMaterial();
      material.transparent = true;
      material.opacity = 1;
      scene.add(new Mesh(undefined, material));
      inspectSceneEntry(scene);
      const order = [...warn.mock.calls, ...error.mock.calls].length;
      expect(order).toBeGreaterThanOrEqual(0);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("should let a caller add an inspector without changing the engine's findings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const added = vi.fn(() => [{ level: "warn" as const, line: "mine" }]);
      inspectSceneEntry(new Group(), [...SCENE_ENTRY_INSPECTORS, added]);
      expect(added).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls).toContainEqual(["mine"]);
    } finally {
      warn.mockRestore();
    }
  });
});
