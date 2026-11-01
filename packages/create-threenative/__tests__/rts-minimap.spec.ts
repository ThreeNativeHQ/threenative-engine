import { describe, expect, it } from "vitest";
import { HALF, WORLD } from "../templates/rts/src/sim/terrain.js";
import { minimapWorld } from "../templates/rts/src/ui/minimapPoint.js";

/**
 * Reading a click off the tactical overview.
 *
 * The overview stretches the whole map into a frame that is wider than it is tall, so a click has
 * to be read against the frame's own proportion. Reading it off the raster's cells instead lands
 * the camera a few metres off whenever the panel is not square — the sort of offset that looks
 * like a broken minimap rather than a broken sum.
 */

/** The map frame at 1920x913: 205 wide, 150 tall, inset from the panel. */
const RECT = { height: 150, left: 36, top: 676, width: 205 };

describe("rts minimap point", () => {
  it("maps the frame's corners onto the map's corners", () => {
    expect(minimapWorld(RECT.left, RECT.top, RECT)).toEqual({ x: -HALF, z: -HALF });
    expect(minimapWorld(RECT.left + RECT.width, RECT.top + RECT.height, RECT)).toEqual({
      x: HALF,
      z: HALF,
    });
  });

  it("maps the middle of the frame onto the middle of the map, stretched axes included", () => {
    const middle = minimapWorld(RECT.left + RECT.width / 2, RECT.top + RECT.height / 2, RECT);
    expect(middle.x).toBeCloseTo(0, 10);
    expect(middle.z).toBeCloseTo(0, 10);
    // Three quarters along the width is three quarters of the world: 224 m, 56 m a quarter.
    expect(minimapWorld(RECT.left + RECT.width * 0.75, RECT.top, RECT).x).toBeCloseTo(
      WORLD * 0.75 - HALF,
      10,
    );
  });

  it("clamps a drag that leaves the panel to the map edge", () => {
    expect(minimapWorld(RECT.left - 400, RECT.top - 400, RECT)).toEqual({ x: -HALF, z: -HALF });
    expect(minimapWorld(RECT.left + RECT.width + 400, RECT.top + 400, RECT)).toEqual({
      x: HALF,
      z: HALF,
    });
  });
});
