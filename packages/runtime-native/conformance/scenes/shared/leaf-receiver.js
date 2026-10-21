import { VirtualShadowNode } from "../../../../core/src/render/virtual-shadow.ts";
import { THREE, assertCondition, startVisualScene } from "./scene-support.js";
import { assertVirtualShadowProof } from "./virtual-shadow.js";

/**
 * PRD-651: a leaf receiver is not over-biased. A plate casts a straight shadow edge across a floor
 * and across a two-sided, alpha-tested card that lies on the floor. The light's normal bias is large,
 * so the floor's edge moves by it and the leaf card's edge stays where the plate puts it: the edge
 * jogs where the card starts. Both shadows run through `VirtualShadowNode`, the sun's shadow in the
 * templates.
 */
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "leaf-receiver", ({ renderer, scene, camera }) => {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    camera.position.set(1.5, 7, 0.01);
    camera.lookAt(1.5, 0, 0);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    // The leaf: two-sided and cut by alpha, on the +z half, a hair above the floor.
    const leaf = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 3),
      new THREE.MeshStandardMaterial({ color: 0x3a7d44, roughness: 1, side: THREE.DoubleSide, alphaTest: 0.5 }),
    );
    leaf.rotation.x = -Math.PI / 2;
    leaf.position.set(1.5, 0.01, 1.6);
    leaf.receiveShadow = true;
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(2, 0.1, 6.4),
      new THREE.MeshStandardMaterial({ color: 0xff8040 }),
    );
    plate.position.set(0, 1.5, 0);
    plate.castShadow = true;

    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(-4, 4, 0);
    light.target.position.set(0, 0, 0);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.3;
    const node = new VirtualShadowNode(light, { clipExtents: [6, 18, 54], mapSize: 1024, marker: false });
    light.shadow.shadowNode = node;
    assertVirtualShadowProof({ renderer, light, node });
    assertCondition(leaf.material.side === THREE.DoubleSide && leaf.material.alphaTest > 0, "the card must be a leaf receiver");

    scene.add(floor, leaf, plate, light, light.target, new THREE.AmbientLight(0xffffff, 0.15));
    return { floor, leaf, light, node, plate, detail: { normalBias: light.shadow.normalBias } };
  });
}
