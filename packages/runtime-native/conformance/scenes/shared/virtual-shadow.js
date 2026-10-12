import { VirtualShadowNode } from "../../../../core/src/render/virtual-shadow.ts";
import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

/**
 * One directional shadow through `VirtualShadowNode`: the same sphere-over-plane the browser
 * proof used, so a native frame is compared against a browser reference on the same adapter
 * rules as every other shadow row. The node lives in three's own `shadowNode` slot; nothing here
 * chooses a look beyond what the stock shadow row chooses.
 */
export function assertVirtualShadowProof({ renderer, light, node }) {
  assertCondition(renderer.shadowMap.enabled === true, "shadow map must be enabled");
  assertCondition(light.castShadow === true, "light must cast shadows");
  assertCondition(light.shadow.shadowNode === node, "the virtual shadow node must own the light's shadow slot");
  assertCondition(node.options.clipExtents.length === 3, "three clip levels expected");
}

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "virtual-shadow", buildVirtualShadowScene);
}

export function buildVirtualShadowScene({ renderer, scene, camera }) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    camera.position.set(0, 4, 7);
    camera.lookAt(0, 0, 0);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.MeshStandardMaterial({ color: 0xff8040 }),
    );
    ball.position.set(0, 1.5, 0);
    ball.castShadow = true;

    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(4, 10, 2);
    light.target.position.set(0, 0, 0);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.02;
    const node = new VirtualShadowNode(light, { clipExtents: [6, 18, 54], mapSize: 1024, marker: false });
    light.shadow.shadowNode = node;
    assertVirtualShadowProof({ renderer, light, node });

    scene.add(floor, ball, light, light.target, new THREE.AmbientLight(0xffffff, 0.15));
    return { ball, floor, light, node, detail: { levels: node.options.clipExtents.length } };
}
