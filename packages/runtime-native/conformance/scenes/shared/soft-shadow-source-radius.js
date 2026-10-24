import { sourceRadiusShadowFilter } from "../../../../core/src/render/soft-shadow.ts";
import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-650: a lamp's source radius softens its shadow. A spot light (left) and a point light (right),
 * each 3 m above a plate 1.5 m above the floor, with `sourceRadiusShadowFilter({ sourceRadius })`:
 * the plates' edges blur by about 2 x 0.25 x 1.5 / 1.5 = 0.5 m on the floor.
 */
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "soft-shadow-source-radius", ({ renderer, scene, camera }) => {
    renderer.shadowMap.enabled = true;
    camera.position.set(0, 7, 4);
    camera.lookAt(0, 0, 0);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 8),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    const plate = (x) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 0.05, 1.2),
        new THREE.MeshStandardMaterial({ color: 0x4a5568, roughness: 1 }),
      );
      mesh.position.set(x, 1.5, 0);
      mesh.castShadow = true;
      return mesh;
    };
    const filter = sourceRadiusShadowFilter({ sourceRadius: 0.25 });
    const spot = new THREE.SpotLight(0xffffff, 40, 0, Math.PI / 3, 0.2, 2);
    spot.position.set(-2.2, 3, 0);
    spot.target.position.set(-2.2, 0, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.filterNode = filter;
    const point = new THREE.PointLight(0xffffff, 40, 0, 2);
    point.position.set(2.2, 3, 0);
    point.castShadow = true;
    point.shadow.mapSize.set(1024, 1024);
    point.shadow.filterNode = filter;
    scene.add(floor, plate(-2.2), plate(2.2), spot, spot.target, point, new THREE.AmbientLight(0x405070, 0.3));
    assertCondition(point.shadow.filterNode === filter, "the lamp keeps its filter");
    return { floor, spot, point };
  });
}
