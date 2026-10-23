import * as THREE from "three/webgpu";
import {
  FILMIC_CURVE,
  installFilmicToneMapping,
  resolveColorGrade,
} from "../../../../create-threenative/templates/starter/src/render/tonemap.ts";
import { assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-632 Phase 4: the starter's filmic curve with Unreal's colour grade, white balance and tone curve
 * amount switched on, on the host as well as the browser. The grade is constants folded into the TSL graph
 * (a white balance matrix, three weighted AP1 corrections with pow, a smoothstep split by luma, a blend with
 * the curve), so a host that drops a `pow` of a vector, a clamp or a matrix constant cannot match the browser.
 *
 * The chart is the one of `filmic-tonemap`: nine greys from deep shadow to four stops over white, and six
 * saturated primaries. Shadow, middle and highlight greys all sit on it, so each range of the grade is read.
 */

const GREYS = [0.002, 0.01, 0.045, 0.18, 0.5, 1, 2, 4, 16];
const SATURATED = [
  [0.9, 0.04, 0.03],
  [0.04, 0.6, 0.05],
  [0.02, 0.05, 1.2],
  [6, 0.3, 0.2],
  [0.3, 5, 0.3],
  [0.15, 0.3, 8],
];

export const GRADE = {
  whiteTemp: 5200,
  whiteTint: 0.2,
  toneCurveAmount: 0.85,
  global: { saturation: [1, 1, 1, 1.15], contrast: [1, 1, 1, 1.1] },
  shadows: { gain: [1, 1, 1.2, 1] },
  highlights: { offset: [0, 0, 0, -0.01] },
};

function patch(scene, rgb, x, y) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.36, 0.8),
    new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(...rgb) }),
  );
  mesh.position.set(x, y, 0);
  scene.add(mesh);
}

export function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "filmic-grade",
    ({ renderer, scene }) => {
      const mode = installFilmicToneMapping(renderer, FILMIC_CURVE, resolveColorGrade(GRADE));
      assertCondition(mode === THREE.CustomToneMapping, "renderer has no node library");
      renderer.toneMapping = mode;
      renderer.toneMappingExposure = 1;
      GREYS.forEach((g, i) => patch(scene, [g, g, g], (i - (GREYS.length - 1) / 2) * 0.4, 0.5));
      SATURATED.forEach((rgb, i) =>
        patch(scene, rgb, (i - (SATURATED.length - 1) / 2) * 0.5, -0.5),
      );
      return { detail: { curve: "filmic", grade: GRADE, greys: GREYS.length, primaries: SATURATED.length } };
    },
    {
      camera: () => {
        const camera = new THREE.OrthographicCamera(-2.2, 2.2, 1.24, -1.24, 0.1, 10);
        camera.position.set(0, 0, 3);
        return camera;
      },
    },
  );
}
