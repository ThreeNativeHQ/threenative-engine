import { OrthographicCamera, Plane, Ray, Scene, Vector3 } from "three";
import { expect, it } from "vitest";
import { ZOOM_RANGE, applyRtsCamera, createRtsView } from "../templates/rts/src/render/camera.js";
import { setupLighting } from "../templates/rts/src/render/lighting.js";

// Owner, 2026-10-28: rock shadows "cut off" in a hard line that moved with every pan. The sun's
// shadow window must hold all the ground the frame shows, at every zoom and screen shape.
const ground = new Plane(new Vector3(0, 1, 0), 0);

it.each([
  [ZOOM_RANGE.near, 16 / 9],
  [30, 1920 / 913],
  [30, 2.4],
  [ZOOM_RANGE.far, 1920 / 913],
])("keeps every corner of the frame in the shadow window at zoom %d, aspect %f", (zoom, aspect) => {
  const scene = new Scene();
  const sun = setupLighting(scene, { shadowMap: { enabled: false, type: 0 } });
  const camera = new OrthographicCamera();
  const view = createRtsView(-70, 58);
  view.zoom = zoom;
  view.desiredZoom = zoom;
  applyRtsCamera(camera, view, { width: 913 * aspect, height: 913 }, 0);
  sun.follow(view.target.x, view.target.z, camera);
  scene.updateMatrixWorld(true);
  // What three's shadow pass does before it draws.
  sun.key.shadow.updateMatrices(sun.key);
  const frustum = sun.key.shadow.getFrustum();
  for (const [x, y] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const near = new Vector3(x, y, -1).unproject(camera);
    const direction = new Vector3(x, y, 1).unproject(camera).sub(near).normalize();
    const hit = new Ray(near, direction).intersectPlane(ground, new Vector3());
    expect(hit).not.toBeNull();
    expect(frustum.containsPoint(hit as Vector3)).toBe(true);
  }
});
