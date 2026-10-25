import { THREE, startVisualScene } from "./scene-support.js";

// One InstancedMesh changes its count every frame, as a grass LOD does; the two rows beside it
// must keep their own transforms. The churning mesh's instances are scaled to nothing, so it adds
// no pixels and only moves where the other meshes' instances sit in the frame's instance data.
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "instanced-count-churn", ({ renderer, scene, camera }) => {
    const box = new THREE.BoxGeometry(0.34, 0.34, 0.34);
    const transform = new THREE.Object3D();
    const row = (color, y) => {
      const mesh = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color }), 5);
      for (let index = 0; index < 5; index += 1) {
        transform.position.set((index - 2) * 0.5, y + (index % 2) * 0.12, 0);
        transform.rotation.set(index * 0.2, index * 0.3, 0);
        transform.scale.setScalar(1);
        transform.updateMatrix();
        mesh.setMatrixAt(index, transform.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      return mesh;
    };
    row(0x68d391, 0.45);
    // Nearest the camera, so the depth sort packs it before both rows.
    const churn = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0xffffff }), 64);
    transform.rotation.set(0, 0, 0);
    transform.scale.setScalar(0);
    for (let index = 0; index < 64; index += 1) {
      transform.position.set((index % 8) * 0.1 - 0.35, -0.05, 1.2);
      transform.updateMatrix();
      churn.setMatrixAt(index, transform.matrix);
    }
    churn.instanceMatrix.needsUpdate = true;
    churn.frustumCulled = false;
    scene.add(churn);
    row(0xfc8181, -0.45);
    let frame = 0;
    return {
      render() {
        frame += 1;
        churn.count = frame % 2 === 0 ? 0 : 64;
        return renderer.render(scene, camera);
      },
    };
  });
}
