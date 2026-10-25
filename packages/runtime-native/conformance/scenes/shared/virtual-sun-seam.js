import { VirtualShadowNode } from "../../../../core/src/render/virtual-shadow.ts";
import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

/**
 * A box standing on a floor under a virtual-shadow sun, both with a null shadowSide. A virtual page
 * draws the front faces of a front-sided caster (Unreal's sun does), so the strip the box shades at
 * its foot stays dark; three's derived back faces store the depth on the floor and leak the sun along
 * every seam where a box meets a surface. The browser and native frames must agree on the strip.
 */
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "virtual-sun-seam", ({ renderer, scene, camera }) => {
    renderer.shadowMap.enabled = true;
    camera.position.set(0.6, 3, 2.2);
    camera.lookAt(0.6, 0, 0);
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(6, 0.2, 6),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1 }),
    );
    floor.position.y = -0.1;
    floor.castShadow = true;
    floor.receiveShadow = true;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(1, 2, 1),
      new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 1 }),
    );
    box.position.set(1.5, 1, 0);
    box.castShadow = true;
    box.receiveShadow = true;
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(3, 3, 0);
    light.castShadow = true;
    const node = new VirtualShadowNode(light, { clipExtents: [8], mapSize: 512, marker: false });
    light.shadow.shadowNode = node;
    assertCondition(light.shadow.shadowNode === node, "the virtual shadow node must own the light's shadow slot");
    assertCondition(box.material.shadowSide === null, "the box keeps three's derived shadowSide");
    scene.add(floor, box, light, light.target, new THREE.AmbientLight(0x405070, 0.4));
    return { box, floor, light, node };
  });
}
