import { float, uv, vec3, vec4 } from "three/tsl";
import { GIVisualize } from "../../../../core/src/render/gi-visualize.ts";
import { assertCondition, startVisualScene, THREE } from "./scene-support.js";

/**
 * PRD-646: `GIVisualize` returns the finished frame in `off` mode and the indirect diffuse term alone in
 * `indirectDiffuse` mode. Both quads hold the same two terms (a warm direct-lit frame, and a cool gradient of
 * albedo x bounce light); the left quad shows the frame, the right quad the term, so a browser and a native
 * frame can differ only by how each engine draws a node material.
 */
function quad(view, x) {
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = view.node;
  material.toneMapped = false;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), material);
  mesh.position.set(x, 0, 0);
  return mesh;
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "gi-visualize-indirect",
    ({ scene }) => {
      const beauty = vec4(0.9, 0.55, 0.2, 1);
      const albedo = vec3(0.8, 0.8, 0.8);
      const bounce = vec3(0.1, 0.25, 0.5).mul(uv().x.mul(0.8).add(0.2));
      const indirectDiffuse = albedo.mul(bounce).mul(float(1));
      const frame = new GIVisualize({ mode: "off", beauty, indirectDiffuse });
      const term = new GIVisualize({ mode: "indirectDiffuse", beauty, indirectDiffuse });
      assertCondition(frame.node === beauty, "off mode returns the finished frame");
      assertCondition(term.node !== beauty, "indirectDiffuse mode returns the term");
      let refused = false;
      try {
        new GIVisualize({ mode: "indirectDiffuse", beauty });
      } catch (error) {
        refused = String(error).includes("TN_GI_VISUALIZE_TERM");
      }
      assertCondition(refused, "a mode without its term fails instead of showing the frame");
      scene.add(quad(frame, -0.8), quad(term, 0.8));
      return { detail: { modes: [frame.mode, term.mode], refused } };
    },
    {
      background: 0x101010,
      camera: (size) => {
        const view = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 100);
        view.position.set(0, 0, 3.2);
        return view;
      },
    },
  );
}
