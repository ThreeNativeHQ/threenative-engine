import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-651: an alpha-tested leaf card casts its cut, not its quad. The card's map is a 4 x 4 alpha
 * checker; with alphaTest 0.5 its shadow on the floor is the checker. One card is double-sided and
 * one front-sided facing the light (three's shadowSide draws its back face, which the cut still cuts).
 */
const CHECKER = new Uint8Array(4 * 4 * 4);
for (let i = 0; i < 16; i++) CHECKER.set([255, 255, 255, ((i % 4) + Math.floor(i / 4)) % 2 ? 255 : 0], i * 4);

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "masked-shadow-caster", ({ renderer, scene, camera }) => {
    renderer.shadowMap.enabled = true;
    camera.position.set(0, 5, 2.5);
    camera.lookAt(0, 0, 0);
    const map = new THREE.DataTexture(CHECKER, 4, 4, THREE.RGBAFormat, THREE.UnsignedByteType);
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    map.generateMipmaps = false;
    map.needsUpdate = true;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    const card = (side, x) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.4, 1.4),
        new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, side, color: 0x3a7d44, roughness: 1 }),
      );
      mesh.rotation.x = -Math.PI / 2; // faces the light above
      mesh.position.set(x, 1.2, 0);
      mesh.castShadow = true;
      return mesh;
    };
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(0.3, 6, 0.6);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    scene.add(floor, card(THREE.DoubleSide, -1.1), card(THREE.FrontSide, 1.1), light, new THREE.AmbientLight(0x405070, 0.4));
    assertCondition(light.castShadow === true, "the light must cast shadows");
    return { floor, light };
  });
}
