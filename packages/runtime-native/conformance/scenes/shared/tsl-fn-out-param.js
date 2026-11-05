import * as THREE from "three/webgpu";
import { Fn, float, uv, vec3, vec4 } from "three/tsl";
import { startVisualScene } from "./scene-support.js";

// A TSL Fn assigning a variable handed to it as an `out` argument (GLSL's impactWeights, volumeSample), PRD-777: one
// variable made inside a Fn, one made at the top level of a material graph.
export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "tsl-fn-out-param", ({ scene }) => {
    const weights = Fn(([p, o]) => {
      o.assign(vec3(p.x, p.y, 0.5));
      return float(0.9);
    });
    const inside = new THREE.MeshBasicNodeMaterial();
    inside.colorNode = Fn(() => {
      const o = vec3(0).toVar();
      const gain = weights(uv(), o);
      return vec4(o.mul(gain), 1);
    })();
    const top = new THREE.MeshBasicNodeMaterial();
    const o = vec3(0).toVar();
    const gain = weights(uv().yx, o);
    top.colorNode = vec4(gain.mul(o), 1);
    [inside, top].forEach((material, i) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), material);
      mesh.position.x = i === 0 ? -0.9 : 0.9;
      scene.add(mesh);
    });
    return { detail: { outParams: 2 } };
  });
}
