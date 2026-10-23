import { installFoliageTransmission } from "../../../../core/src/render/two-sided-foliage.ts";
import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-643: a Two Sided Foliage leaf lets the sun through from behind, `subsurfaceColor` times a wrapped -N.L times a
 * GGX lobe around the light seen through the leaf (Unreal's SSS_TYPE_TWO_SIDED_WRAP). The sun is behind three cards
 * that face the camera, so no card takes front sun. The left one is marked `twoSidedFoliage` and has a
 * `subsurfaceColor`, so it glows; the middle one is marked and has none, and the right one has one but is not
 * marked: both stay at the ambient level. three's classes get the term from installFoliageTransmission; the owned
 * engine evaluates it in its light loop, where the same call patches nothing.
 */
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "foliage-transmission", ({ scene }) => {
    installFoliageTransmission(THREE);
    const card = (x, marked, subsurface) => {
      const material = new THREE.MeshStandardNodeMaterial({ color: 0x3a7d44, roughness: 1, side: THREE.DoubleSide });
      if (marked) material.twoSidedFoliage = true;
      if (subsurface) material.subsurfaceColor = new THREE.Color(0.5, 0.4, 0.1);
      assertCondition((material.subsurfaceColor !== undefined) === subsurface, "subsurfaceColor reads undefined until set");
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.4), material);
      mesh.position.set(x, 0, 0);
      return mesh;
    };
    const cards = [card(-1, true, true), card(0, true, false), card(1, false, true)];
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.position.set(0, 0.3, -5);
    scene.add(...cards, sun, new THREE.AmbientLight(0xffffff, 0.3));
    return { cards, detail: { transmits: [true, false, false] } };
  });
}
