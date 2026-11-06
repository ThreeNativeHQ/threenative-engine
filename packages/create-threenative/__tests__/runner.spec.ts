import { Matrix4, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { GRAVITY, HITBOX, JUMP_SPEED } from "../templates/runner/src/entities/Runner.js";
import { setupLighting } from "../templates/runner/src/render/lighting.js";
import { OBSTACLE_SIZE } from "../templates/runner/src/render/shapes.js";
import { SUN_DIRECTION } from "../templates/runner/src/render/sky.js";

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

describe("the runner's sun", () => {
  const lighting = () =>
    setupLighting(new Scene(), { shadowMap: { enabled: false, type: 0 } } as never);
  const texel = (2 * 24) / 4096;

  it("leads the runner and keeps the sun's own direction", () => {
    const { key, follow } = lighting();
    follow(new Vector3(4, 0, -40));
    // The box is centred 12 m ahead of the runner, and the sun sits 30 m up its own ray from there.
    expect(Math.abs(key.target.position.z + 52)).toBeLessThanOrEqual(texel);
    const toSun = key.position.clone().sub(key.target.position).normalize();
    expect(toSun.dot(SUN_DIRECTION)).toBeCloseTo(1, 5);
    expect(key.position.distanceTo(key.target.position)).toBeCloseTo(30, 5);
  });

  it("moves in whole texels, so the map does not crawl", () => {
    const { key, follow } = lighting();
    // A shadow texel is a cell of the light's own grid, so the box may only land on whole cells.
    // The sun never turns: this is the frame the shadow camera itself is built in.
    const intoLight = new Matrix4()
      .lookAt(SUN_DIRECTION.clone().multiplyScalar(30), new Vector3(), new Vector3(0, 1, 0))
      .invert();
    const inLight = (target: Vector3) => target.clone().applyMatrix4(intoLight);
    const place = (x: number, z: number) => {
      follow(new Vector3(x, 0, z));
      const centre = inLight(key.target.position);
      for (const axis of [centre.x, centre.y]) {
        const cells = axis / texel;
        expect(Math.abs(cells - Math.round(cells))).toBeLessThan(1e-6);
      }
      return centre;
    };
    // A millimetre at a time: the box must not follow the runner's every step, only the grid.
    let previous = place(0, 0);
    let steps = 0;
    for (let i = 1; i <= 500; i += 1) {
      const centre = place(i * 0.001, -i * 0.001);
      const stepX = Math.abs(centre.x - previous.x) / texel;
      const stepY = Math.abs(centre.y - previous.y) / texel;
      expect(stepX).toBeLessThan(1.000001);
      expect(stepY).toBeLessThan(1.000001);
      if (stepX + stepY > 0) steps += 1;
      previous = centre;
    }
    expect(steps).toBeGreaterThan(10);
    expect(steps).toBeLessThan(500);
  });
});
