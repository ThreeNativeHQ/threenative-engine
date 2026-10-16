import { Object3D } from "three";
import { describe, expect, it } from "vitest";
import { FixedStepLoop } from "../src/loop.js";

function coefficientOfVariation(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) / mean;
}

describe("fixed-step motion presentation", () => {
  it.each([56, 75, 120, 144])("presents constant speed smoothly at %i Hz", (hz) => {
    const body = new Object3D();
    const positions: number[] = [];
    const loop = new FixedStepLoop({
      onUpdate: (dt) => { body.position.x += 2 * dt; },
      onRender: () => { positions.push(body.position.x); return undefined; },
    });
    loop.stepFrame(0);
    for (let frame = 1; frame <= hz * 3; frame++) loop.stepFrame(frame * 1000 / hz);
    const deltas = positions.slice(3).map((position, index) => position - positions[index + 2]!);
    expect(coefficientOfVariation(deltas)).toBeLessThan(0.1);
  });
});
