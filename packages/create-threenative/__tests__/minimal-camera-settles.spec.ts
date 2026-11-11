import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { followCamera, setupCamera } from "../templates/minimal/src/render/camera.js";

const DT = 1 / 60;
const clear = (): undefined => undefined;

describe("minimal follow camera", () => {
  it("stops dead soon after the player stops, instead of creeping by sub-pixel steps", () => {
    // An exponential ease never arrives: after a walk the lens crept for over a second by steps of
    // a few micrometres. Each flipped the 4x MSAA samples on every high-contrast edge in view, a
    // burst of shimmer on the contact lines each time the player stopped.
    const camera = new PerspectiveCamera();
    setupCamera(camera);
    const target = new Vector3(-2, 0.91, 0);
    for (let frame = 0; frame < 180; frame += 1) {
      target.x += 3 * DT;
      followCamera(camera, target, DT, clear);
    }
    const goal = target.clone().add(new Vector3(0.6, 1.4, 4.6));
    let settled = -1;
    let smallest = Number.POSITIVE_INFINITY;
    for (let frame = 0; frame < 120; frame += 1) {
      const before = camera.position.clone();
      followCamera(camera, target, DT, clear);
      const step = before.distanceTo(camera.position);
      if (step === 0) {
        if (settled < 0) settled = frame;
      } else {
        expect(settled, `moved ${step} m at frame ${frame} after it stopped`).toBe(-1);
        smallest = Math.min(smallest, step);
      }
    }
    // Rests on its goal within 0.6 s, and every step before that is a full millimetre or more: a
    // pixel is about 6 mm at the player's distance on a 900 px tall view.
    expect(settled).toBeGreaterThanOrEqual(0);
    expect(settled).toBeLessThan(36);
    expect(camera.position.toArray()).toEqual(goal.toArray());
    expect(smallest).toBeGreaterThanOrEqual(1e-3);
  });
});
