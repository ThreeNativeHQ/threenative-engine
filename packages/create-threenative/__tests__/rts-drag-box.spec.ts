import { OrthographicCamera } from "three";
import { describe, expect, it } from "vitest";
import { DRAG_SLOP, dragBoxRect, unitsInBox } from "../templates/rts/src/render/picking.js";
import {
  applyRtsCamera,
  createRtsView,
  type IRtsView,
} from "../templates/rts/src/render/camera.js";
import { Game } from "../templates/rts/src/sim/game.js";

/**
 * The rubber band and the selection it stands for.
 *
 * AstraCraft's drag is two behaviours, and the kit had neither: the band only exists once the
 * pointer has travelled past the slop (under it the gesture is a click), and the band carries a
 * live count of what a release would take. The count is the *same* scan the release runs, so a
 * preview can never claim a number the release does not select.
 */

const SIZE = { height: 913, width: 1920 };

/** The play camera the scene drives, framed on a point, with the whole base inside it. */
function look(camera: OrthographicCamera, view: IRtsView, game: Game): void {
  const own = game.own(0);
  const x = own.reduce((sum, entity) => sum + entity.x, 0) / own.length;
  const z = own.reduce((sum, entity) => sum + entity.z, 0) / own.length;
  view.target.set(x, 0, z);
  view.zoom = 120;
  view.desiredZoom = 120;
  applyRtsCamera(camera, view, SIZE, 1);
}

function view(): IRtsView {
  return createRtsView(0, 0);
}

function camera(): OrthographicCamera {
  return new OrthographicCamera(-1, 1, 1, -1, 1, 600);
}

describe("rts drag box", () => {
  it("draws one rectangle whichever way the drag went", () => {
    const corners: Array<[number, number]> = [
      [120, 40],
      [-80, 40],
      [120, -60],
      [-80, -60],
    ];
    for (const [dx, dy] of corners) {
      const [, , width, height] = dragBoxRect({ x: 200, y: 300 }, { x: 200 + dx, y: 300 + dy });
      expect([width, height], `a drag of ${dx} x ${dy}`).toEqual([Math.abs(dx), Math.abs(dy)]);
      expect(dragBoxRect({ x: 200, y: 300 }, { x: 200 + dx, y: 300 + dy }).slice(0, 2)).toEqual([
        Math.min(200, 200 + dx),
        Math.min(300, 300 + dy),
      ]);
    }
  });

  it("is no box at all while the pointer has not left the slop", () => {
    // A click that wobbles two pixels is a click: a band that flickers on every press is the
    // AstraCraft behaviour this replaces, and it hid a selection that never happened.
    expect(DRAG_SLOP).toBe(4);
    expect(dragBoxRect({ x: 200, y: 300 }, { x: 202, y: 301 })).toBeNull();
    expect(dragBoxRect({ x: 200, y: 300 }, { x: 200 + DRAG_SLOP, y: 300 })).toBeNull();
    expect(dragBoxRect({ x: 200, y: 300 }, { x: 200 + DRAG_SLOP + 1, y: 300 })).not.toBeNull();
  });

  it("counts exactly what a release over the same band would select", () => {
    const game = new Game({ ai: false, seed: 3 });
    const own = game.own().filter((entity) => entity.building !== true);
    expect(own.length, "a start with units to band").toBeGreaterThan(2);
    // A band over the whole frame takes every mobile unit the player owns, workers included.
    const from = { x: 0, y: 0 };
    const to = { x: SIZE.width, y: SIZE.height };
    const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 600);
    const view = createRtsView(0, 0);
    look(camera, view, game);
    const preview = unitsInBox(game, camera, view, SIZE, from, to, true, []);
    const release = unitsInBox(game, camera, view, SIZE, from, to, true, []);

    expect(preview.length).toBe(own.length);
    expect(release).toEqual(preview);
    // The band the HUD draws is the band the count is taken over: both corners of the drag.
    const [, , width, height] = dragBoxRect(from, to);
    expect([width, height]).toEqual([SIZE.width, SIZE.height]);
  });

  it("leaves the mining crew out of a box that also takes a fighting unit", () => {
    const game = new Game({ ai: false, seed: 3 });
    const size = { height: 913, width: 1920 };
    const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 600);
    const view = createRtsView(0, 0);
    look(camera, view, game);
    const from = { x: 0, y: 0 };
    const to = { x: size.width, y: size.height };
    const all = unitsInBox(game, camera, view, size, from, to, false, []);
    const alt = unitsInBox(game, camera, view, size, from, to, true, []);

    expect(all.some((id) => game.get(id)?.type === "worker")).toBe(false);
    expect(alt.some((id) => game.get(id)?.type === "worker")).toBe(true);
  });
});
