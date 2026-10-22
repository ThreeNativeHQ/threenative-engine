import { vec3 } from "three/tsl";
import { addFoliageBackLight } from "../../../../core/src/render/two-sided-foliage.ts";
import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-643: a Two Sided Foliage leaf takes `subsurfaceColor` times the irradiance that reaches its back face.
 * Three cards face the camera under the same front irradiance and the same back irradiance. The left one is marked
 * `twoSidedFoliage` and has a `subsurfaceColor`, so the back term brightens it. The middle one is marked and has no
 * `subsurfaceColor`, and the right one has one but is not marked: both add nothing, so all three differ only by that term.
 */
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "foliage-back-light", ({ scene }) => {
    const front = vec3(0.25, 0.25, 0.25);
    const back = vec3(2.0, 1.6, 1.0);
    const card = (x, marked, subsurface) => {
      const material = new THREE.MeshStandardNodeMaterial({ color: 0x3a7d44, roughness: 1, side: THREE.DoubleSide });
      material.irradianceNode = front;
      if (marked) material.twoSidedFoliage = true;
      if (subsurface) material.subsurfaceColor = new THREE.Color(0.5, 0.4, 0.1);
      const added = addFoliageBackLight(material, back);
      assertCondition(added === (marked && subsurface), "only a marked material with a subsurfaceColor takes the back term");
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.4), material);
      mesh.position.set(x, 0, 0);
      return mesh;
    };
    const cards = [card(-1, true, true), card(0, true, false), card(1, false, true)];
    scene.add(...cards);
    return { cards, detail: { backTerm: [true, false, false] } };
  });
}
