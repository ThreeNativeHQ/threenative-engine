import { Frustum, Matrix4, OrthographicCamera, PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import { frustumPlanes } from "../src/world-gpu-types.js";

// PRD-857: the owned engine's facade has no `Frustum.planes` array, so the GPU scene reads the
// planes from the matrix. They must be the planes three's own Frustum writes.
describe("frustumPlanes", () => {
  const cameras = [
    new PerspectiveCamera(60, 16 / 9, 0.1, 2000),
    new PerspectiveCamera(35, 1, 2, 50),
    new OrthographicCamera(-40, 40, 30, -30, 1, 400),
  ];
  for (const [index, camera] of cameras.entries()) {
    it(`matches Frustum.setFromProjectionMatrix (camera ${index})`, () => {
      camera.position.set(12, 7, -3);
      camera.lookAt(-4, 1, 9);
      camera.updateMatrixWorld();
      const matrix = new Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      const out = new Float32Array(24);
      frustumPlanes(matrix, out);
      const frustum = new Frustum().setFromProjectionMatrix(matrix);
      for (const [at, plane] of frustum.planes.entries()) {
        expect(out[at * 4]).toBeCloseTo(plane.normal.x, 5);
        expect(out[at * 4 + 1]).toBeCloseTo(plane.normal.y, 5);
        expect(out[at * 4 + 2]).toBeCloseTo(plane.normal.z, 5);
        expect(out[at * 4 + 3]).toBeCloseTo(plane.constant, 4);
      }
    });
  }
});
