import { Box3, Frustum, Matrix4, PerspectiveCamera, Sphere, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { qualificationCamera } from "../../../examples/procedural-animals/src/render/qualification-camera.js";
const floor = new Box3(new Vector3(-20, -2.3, -22), new Vector3(20, 2.3, 18));
const frustum = (camera: PerspectiveCamera) =>
  new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
describe("qualification capture camera", () => {
  it("reproduces the actual uniform-capture camera and retains course pixels in the repair", () => {
    const camera = new PerspectiveCamera(75, 1280 / 720, 0.1, 1000);
    camera.position.set(100, 30, 100);
    camera.lookAt(200, 30, 200);
    camera.updateMatrixWorld();
    expect(frustum(camera).intersectsBox(floor)).toBe(false);
    qualificationCamera(camera, new Vector3(0, 0.37, -4), true);
    expect(frustum(camera).intersectsBox(floor)).toBe(true);
    // A generous 5 m envelope covers the qualification movement grid, beyond wolf bounds.
    for (let x = -6; x <= 10; x += 2)
      for (let z = -11; z <= 3; z += 2)
        expect(frustum(camera).intersectsSphere(new Sphere(new Vector3(x, 1, z), 5))).toBe(false);
  });
  it("frames the target wolf at reviewable scale throughout the held capture", () => {
    const camera = new PerspectiveCamera(75, 1280 / 720, 0.1, 1000);
    const root = new Vector3(-5.075, -0.1, -9.38);
    qualificationCamera(camera, root, false);
    const left = root
      .clone()
      .add(new Vector3(-0.5, 0, 0))
      .project(camera);
    const right = root
      .clone()
      .add(new Vector3(0.5, 0, 0))
      .project(camera);
    expect(Math.abs(right.x - left.x) * 640).toBeGreaterThan(100);
    expect(frustum(camera).intersectsBox(floor)).toBe(true);
  });
});
