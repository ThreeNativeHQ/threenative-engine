import * as THREE from "three/webgpu";
import { installFilmicToneMapping } from "../../../../create-threenative/templates/starter/src/render/tonemap.ts";
import { assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-632: the starter's filmic tone curve (generated template source, installed as three's
 * CustomToneMapping through the renderer's node library) on the host as well as the browser.
 * The curve is a TSL graph with a log, an exp, a step and two 3x3 matrices, so a host that
 * drops the custom mapping falls back to a linear clamp and fails this frame.
 *
 * The frame is a grey ramp from deep shadow to four stops over white (toe, line and shoulder),
 * and a row of saturated primaries at mid and high level (the gamut and blue correction steps).
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
    "filmic-tonemap",
    ({ renderer, scene }) => {
      const mode = installFilmicToneMapping(renderer);
      assertCondition(mode === THREE.CustomToneMapping, "renderer has no node library");
      renderer.toneMapping = mode;
      renderer.toneMappingExposure = 1;
      GREYS.forEach((g, i) => patch(scene, [g, g, g], (i - (GREYS.length - 1) / 2) * 0.4, 0.5));
      SATURATED.forEach((rgb, i) =>
        patch(scene, rgb, (i - (SATURATED.length - 1) / 2) * 0.5, -0.5),
      );
      return { detail: { curve: "filmic", greys: GREYS.length, primaries: SATURATED.length } };
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
