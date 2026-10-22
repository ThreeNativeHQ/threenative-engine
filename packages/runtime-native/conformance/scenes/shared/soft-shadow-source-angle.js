import { sourceAngleShadowFilter } from "../../../../core/src/render/soft-shadow.ts";
import { VirtualShadowNode } from "../../../../core/src/render/virtual-shadow.ts";
import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-634: the sun's source angle softens its shadow with the gap between caster and receiver.
 * A cube stands on the floor (gap 0, sharp foot) and a plate floats 3 m above it, both under one
 * `VirtualShadowNode` sun with `sourceAngleShadowFilter({ sourceAngleRad: 0.05 })`: the plate's
 * edge blurs by about 3 x tan(0.05) = 0.15 m on the floor, the cube's foot stays sharp.
 */
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "soft-shadow-source-angle", ({ renderer, scene, camera }) => {
    renderer.shadowMap.enabled = true;
    camera.position.set(0, 7, 5);
    camera.lookAt(0, 0, 0);
    const material = (color) => new THREE.MeshStandardMaterial({ color, roughness: 1 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), material(0x9a9a9a));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material(0x4a5568));
    cube.position.set(-1.8, 0.5, 0);
    cube.castShadow = true;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.05, 1.6), material(0x4a5568));
    plate.position.set(1.4, 3, 0);
    plate.castShadow = true;
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(2, 10, 3);
    sun.target.position.set(0, 0, 0);
    sun.castShadow = true;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    const node = new VirtualShadowNode(sun, { clipExtents: [6, 18, 54], mapSize: 1024, marker: false });
    const filter = sourceAngleShadowFilter({ sourceAngleRad: 0.05 });
    sun.shadow.shadowNode = node;
    sun.shadow.filterNode = filter;
    scene.add(floor, cube, plate, sun, sun.target, new THREE.AmbientLight(0x405070, 0.3));
    assertCondition(sun.shadow.shadowNode === node, "the sun keeps its virtual shadow node");
    assertCondition(sun.shadow.filterNode === filter, "the sun keeps its source-angle filter");
    return { floor, cube, plate, sun, node };
  });
}
