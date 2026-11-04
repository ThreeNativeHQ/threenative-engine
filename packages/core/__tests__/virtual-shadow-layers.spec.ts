import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_KEY_LAYER,
  VIRTUAL_SHADOW_MOVER_LAYER,
  VIRTUAL_SHADOW_SMALL_CASTER_LAYER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
} from "../src/render/virtual-shadow.js";

/**
 * The five object layers a virtual shadow draws on, and the one number each of them is.
 *
 * They are a contract between files that do not import each other at build time: the node that
 * renders the maps, the world that mints the caster halves, and the chunk proxies that stand in for
 * merged geometry. Two halves that disagree about a layer put the world's casters somewhere no level
 * camera reads, and no error says so — the shadows are simply missing. Pinned here as numbers, so a
 * change is a decision this file has to record rather than a value the next reader trusts.
 */
const LAYERS = {
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_KEY_LAYER,
  VIRTUAL_SHADOW_MOVER_LAYER,
  VIRTUAL_SHADOW_SMALL_CASTER_LAYER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
} as const;
const worldCellRenderSource = readFileSync(
  path.resolve("packages/core/src/world-cell-render.ts"),
  "utf8",
);

describe("virtual shadow layers", () => {
  it("should keep the five shadow layers on their own bits, off the main camera", () => {
    expect(LAYERS).toEqual({
      VIRTUAL_SHADOW_CASTER_LAYER: 28,
      VIRTUAL_SHADOW_KEY_LAYER: 25,
      VIRTUAL_SHADOW_MOVER_LAYER: 29,
      VIRTUAL_SHADOW_SMALL_CASTER_LAYER: 26,
      VIRTUAL_SHADOW_WIDE_CASTER_LAYER: 27,
    });
    // One layer per bit, so enabling one never enables another.
    expect(new Set<number>(Object.values(LAYERS)).size).toBe(5);
  });

  it("should be where world-cell-render.ts takes its caster layers from, not a copy of them", () => {
    // Before this module owned them, the world wrote the two numbers down itself. A second copy is
    // how a layer change reaches one half of the cascade and not the other, so the file may hold
    // none of them and must name the owner for the two it chooses between.
    expect(worldCellRenderSource).not.toMatch(/const VIRTUAL_SHADOW_\w+_LAYER = \d+;/u);
    const owner = /import \{([^}]*)\} from "\.\/render\/virtual-shadow-layers\.js";/u.exec(
      worldCellRenderSource,
    );
    expect(owner?.[1]).toMatch(/\bVIRTUAL_SHADOW_KEY_LAYER\b/u);
    expect(owner?.[1]).toMatch(/\bVIRTUAL_SHADOW_SMALL_CASTER_LAYER\b/u);
  });
});
