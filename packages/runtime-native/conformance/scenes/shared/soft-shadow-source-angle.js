import { sourceAngleShadowFilter } from "../../../../core/src/render/soft-shadow.ts";
import { VirtualShadowNode } from "../../../../core/src/render/virtual-shadow.ts";
import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-634: a sun's source angle softens its shadow with the gap between caster and receiver, and
 * `minPenumbraPixels` adds the receiver's own pixel to the edge, so a contact edge is never sharper
 * than the screen can show. A sun 30 degrees above the horizon over a floor and two plates: one 0.1 m
 * above it (its penumbra is 0.1 x 0.02 = 2 mm, so the pixel sets the edge) and one 3 m above it (its
 * penumbra is 3 x 0.02 x 2 = 12 cm wide). The browser and native frames must agree on both edges.
 */
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "soft-shadow-source-angle", ({ renderer, scene, camera }) => {
    renderer.shadowMap.enabled = true;
    camera.position.set(-1.5, 4.5, 4.5);
    camera.lookAt(-2.4, 0, 0);
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(12, 0.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1 }),
    );
    floor.position.y = -0.1;
    floor.castShadow = true;
    floor.receiveShadow = true;
    const plate = (x, y) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 0.05, 1.2),
        new THREE.MeshStandardMaterial({ color: 0x4a5568, roughness: 1 }),
      );
      mesh.position.set(x, y, 0);
      mesh.castShadow = true;
      return mesh;
    };
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(5.2, 3, 0);
    light.castShadow = true;
    const filter = sourceAngleShadowFilter({ sourceAngleRad: 0.02, minPenumbraPixels: 3 });
    light.shadow.filterNode = filter;
    const node = new VirtualShadowNode(light, { clipExtents: [8], mapSize: 1024, marker: false });
    light.shadow.shadowNode = node;
    assertCondition(light.shadow.filterNode === filter, "the sun keeps its source-angle filter");
    scene.add(floor, plate(-1.2, 0.1), plate(1.2, 3), light, light.target, new THREE.AmbientLight(0x405070, 0.4));
    return { floor, light, node };
  });
}
