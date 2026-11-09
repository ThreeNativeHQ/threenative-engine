import { Group, Mesh } from "three";
import { describe, expect, it } from "vitest";
import { warmUnculled } from "../src/world.js";

function draws() {
  const callbacks: (() => void)[] = [];
  return {
    ctx: { beforeRender: (callback: () => void) => callbacks.push(callback) },
    draw: () => {
      for (const callback of callbacks) callback();
    },
  };
}

describe("warmUnculled", () => {
  it("draws the subtree unculled for two counted draws, then culls it and resolves", async () => {
    const root = new Group();
    const early = new Mesh();
    root.add(early);
    const { ctx, draw } = draws();
    let ready = false;
    let resolved = false;
    const warm = warmUnculled(ctx, root, { when: () => ready }).then(() => {
      resolved = true;
    });
    draw();
    expect(early.frustumCulled).toBe(false);
    const late = new Mesh();
    root.add(late);
    ready = true;
    draw();
    draw();
    await Promise.resolve();
    expect(late.frustumCulled).toBe(false);
    expect(resolved).toBe(false);
    draw();
    await warm;
    expect(resolved).toBe(true);
    expect(early.frustumCulled).toBe(true);
    expect(late.frustumCulled).toBe(true);
    // Warm once: later draws leave the game's culling alone.
    late.frustumCulled = false;
    draw();
    expect(late.frustumCulled).toBe(false);
  });

  it("rejects a draw count that is not a positive integer", () => {
    expect(() => warmUnculled(draws().ctx, new Group(), { draws: 0 })).toThrow(
      "TN_WARM_UNCULLED_INVALID",
    );
  });
});
