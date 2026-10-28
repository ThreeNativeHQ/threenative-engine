import { describe, expect, it } from "vitest";
import { GRAVITY, HITBOX, JUMP_SPEED } from "../templates/runner/src/entities/Runner.js";
import { OBSTACLE_SIZE } from "../templates/runner/src/render/shapes.js";

describe("the runner's jump", () => {
  it("lifts the hitbox over a block for long enough to pass it at the start speed", () => {
    // The hitbox's bottom is the feet plus `lift - height / 2`; the block's top is its height.
    const clearance = OBSTACLE_SIZE.height - (HITBOX.lift - HITBOX.height / 2);
    // h(t) = v t + g t² / 2 rises past `clearance` at t1 and falls back through it at t2.
    const disc = JUMP_SPEED ** 2 + 2 * GRAVITY * clearance;
    expect(disc).toBeGreaterThan(0);
    const airborneOver = (2 * Math.sqrt(disc)) / -GRAVITY;
    // The slowest the runner ever goes is 11 m/s; it must cross the block's depth plus its own.
    const startSpeed = 11;
    expect(airborneOver * startSpeed).toBeGreaterThan(OBSTACLE_SIZE.depth + HITBOX.depth);
  });
});
