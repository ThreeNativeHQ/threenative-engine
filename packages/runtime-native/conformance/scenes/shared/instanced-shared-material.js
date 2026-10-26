import { THREE, startVisualScene } from "./scene-support.js";

// Two InstancedMeshes on one material (a game's cached material, as Clover Cup's lit() hands out). The right one
// is added first and never rewritten; the left one moves from a row to a ring by setMatrixAt from the tenth frame
// on. A third, behind them, is a stand-in as core's projection makes one (projection-apply.ts): it is handed the left
// mesh's instanceMatrix, so it draws the same ring. The row captures after 30 frames (captureFrames).
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "instanced-shared-material", ({ renderer, scene, camera }) => {
    const material = new THREE.MeshBasicMaterial({ color: 0xf6ad55 });
    const left = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), material, 6);
    const right = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), material, 6);
    left.position.x = -1.1;
    right.position.x = 1.1;
    const transform = new THREE.Object3D();
    const place = (mesh, ring, column) => {
      for (let index = 0; index < 6; index += 1) {
        const angle = (index / 6) * Math.PI * 2;
        if (ring) transform.position.set(Math.cos(angle) * 0.6, Math.sin(angle) * 0.5 - 0.1, 0);
        else if (column) transform.position.set(0, 0.9 - index * 0.32, 0);
        else transform.position.set((index - 2.5) * 0.3, 0.85, 0);
        transform.rotation.set(index * 0.2, index * 0.3, 0);
        transform.updateMatrix();
        mesh.setMatrixAt(index, transform.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    place(left, false, false);
    place(right, false, true);
    left.frustumCulled = false;
    right.frustumCulled = false;
    const standIn = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), material, 6);
    standIn.instanceMatrix = left.instanceMatrix;
    standIn.position.set(0.1, 0.6, -1.5);
    standIn.frustumCulled = false;
    scene.add(right, left, standIn);
    let frame = 0;
    return {
      render() {
        frame += 1;
        if (frame >= 10) place(left, true, false);
        return renderer.render(scene, camera);
      },
    };
  });
}
