import type { PerspectiveCamera, Vector3 } from "three";
/** Correctness-only close view; paired workload cameras keep the full visible crowd. */
export function qualificationCamera(camera: PerspectiveCamera, center: Vector3, outside: boolean) {
  camera.fov = 50;
  camera.updateProjectionMatrix();
  if (outside) {
    camera.position.set(18, 10, 16);
    camera.lookAt(18, 0, 16); // Course edge remains visible while wolves leave the frustum.
  } else {
    camera.position.set(center.x + 3, center.y + 2.2, center.z + 4);
    camera.lookAt(center.x, center.y - 0.15, center.z);
  }
  camera.updateMatrixWorld();
}
