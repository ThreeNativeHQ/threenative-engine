import { Frustum, Matrix4, OrthographicCamera, Sphere, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  performanceOrigin,
  performanceVelocity,
} from "../../../examples/procedural-animals/src/performance-path.js";
import {
  performanceCamera,
  performanceProjection,
} from "../../../examples/procedural-animals/src/render/performance-camera.js";

describe("separate continuously visible benchmark paths", () => {
  it("keeps the whole measured clearance grid in view and each orbit separated across long runs", () => {
    const radius = 1.144011; // Both pinned tier measurements round up to this conservative test value.
    const camera = new OrthographicCamera(
      (-performanceProjection.size * 8) / 9,
      (performanceProjection.size * 8) / 9,
      performanceProjection.size / 2,
      -performanceProjection.size / 2,
      performanceProjection.near,
      performanceProjection.far,
    );
    performanceCamera(camera);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    for (const elapsed of [0, 1, 4, 9, 12, 25, 35, 120, 1000]) {
      const phase = elapsed / radius;
      const positions = Array.from({ length: 32 }, (_, index) =>
        performanceOrigin(index, 32, radius).add(
          new Vector3(radius * 0.35 * Math.sin(phase), 0, radius * 0.35 * (1 - Math.cos(phase))),
        ),
      );
      for (const [index, position] of positions.entries()) {
        const sphere = new Sphere(new Vector3(position.x, position.x * 0.1, position.z), radius);
        expect(
          frustum.planes.every((plane) => plane.distanceToPoint(sphere.center) >= radius),
        ).toBe(true);
        expect(position.z - radius).toBeGreaterThan(-9.75);
        const projected = sphere.center.clone().applyMatrix4(camera.matrixWorldInverse);
        for (const other of positions.slice(index + 1)) {
          const p = new Vector3(other.x, other.x * 0.1, other.z).applyMatrix4(
            camera.matrixWorldInverse,
          );
          expect(Math.hypot(p.x - projected.x, p.y - projected.y)).toBeGreaterThan(2 * radius);
        }
        const velocity = performanceVelocity(
          position,
          performanceOrigin(index, 32, radius),
          elapsed,
          radius,
          new Vector3(),
        );
        expect(velocity.length()).toBeCloseTo(0.35, 10);
      }
    }
  });
  it("uses one centred high-tier actor and rejects invalid path input", () => {
    expect(performanceOrigin(0, 1, 1).toArray()).toEqual([0, 0, 1]);
    expect(() => performanceOrigin(32, 32, 1)).toThrow(/PATH_INPUT/);
    expect(() => performanceOrigin(0, 1, Number.NaN)).toThrow(/PATH_INPUT/);
    expect(() => performanceVelocity(new Vector3(), new Vector3(), -1, 1, new Vector3())).toThrow(
      /PATH_INPUT/,
    );
    expect(() => performanceCamera(new OrthographicCamera())).not.toThrow();
  });
});
