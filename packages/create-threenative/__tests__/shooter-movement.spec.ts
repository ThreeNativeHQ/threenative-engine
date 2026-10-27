import { expect, it } from "vitest";
import {
  type IStairView,
  STAIR_VIEW_MAX_GAP,
  groundMove,
  stairView,
} from "../templates/shooter/src/entities/movement.js";

const DT = 1 / 60;
const WALK = 5.6;

it("eases the body up to walking speed and never past it", () => {
  const velocity = { x: 0, z: 0 };
  const speeds: number[] = [];
  for (let tick = 0; tick < 30; tick += 1) {
    groundMove(velocity, 0, -1, WALK, DT);
    speeds.push(Math.hypot(velocity.x, velocity.z));
  }
  expect(speeds[0]).toBeLessThan(WALK / 4);
  expect(speeds[11]).toBeGreaterThan(WALK * 0.99);
  expect(Math.max(...speeds)).toBeLessThanOrEqual(WALK + 1e-9);
});

it("slides to a stop over a third of a second instead of one tick", () => {
  const velocity = { x: 0, z: -WALK };
  const speeds: number[] = [];
  for (let tick = 0; tick < 40; tick += 1) {
    groundMove(velocity, 0, 0, 0, DT);
    speeds.push(Math.hypot(velocity.x, velocity.z));
  }
  expect(speeds[2]).toBeGreaterThan(WALK / 2);
  expect(speeds[29]).toBe(0);
});

it.each([
  ["walk", 11],
  ["sprint", 7],
])("climbs the eye up a %s flight without stopping between steps", (_gait, period) => {
  // The body's measured climb: 0.3 m in three ticks, then flat until the next step.
  let bodyY = 0.89;
  let view: IStairView | undefined;
  const rises: number[] = [];
  let gap = 0;
  for (let tick = 0; tick < 200; tick += 1) {
    if (tick % period < 3) bodyY += 0.1;
    const before = view?.y;
    view = stairView(view, bodyY, true, DT);
    if (tick >= 60 && before !== undefined) rises.push(view.y - before);
    gap = Math.max(gap, bodyY - view.y);
  }
  // The welded eye rose 0.1 m on a climbing tick and 0 on a flat one.
  expect(Math.min(...rises)).toBeGreaterThan(0);
  expect(Math.max(...rises)).toBeLessThan(0.06);
  expect(gap).toBeLessThanOrEqual(STAIR_VIEW_MAX_GAP);
});

it("follows the body exactly off the ground and never rises past it", () => {
  const view = stairView(undefined, 0.5, true, DT);
  expect(stairView(view, 3, false, DT).y).toBe(3);
  let settled = stairView(undefined, 0, true, DT);
  for (let tick = 0; tick < 120; tick += 1) settled = stairView(settled, 0.3, true, DT);
  expect(settled.y).toBeLessThanOrEqual(0.3);
  expect(settled.y).toBeGreaterThan(0.299);
});
