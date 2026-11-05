import * as THREE from "three/webgpu";
import { texture, vec4 } from "three/tsl";
import { startVisualScene } from "./scene-support.js";

// three's renderer.clear() and autoClear false into a render target (PRD-777: the spell port's FxTarget, GroundField and
// particle passes clear a target once, then draw several passes over it). The target is cleared to blue, then two
// renders with autoClear false add a near red quad (left) and a far green quad (right): both stay on the blue, and the
// kept depth hides the green one where they overlap.
export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "render-target-autoclear", ({ renderer, scene }) => {
    const target = new THREE.RenderTarget(64, 64, { type: THREE.HalfFloatType });
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4);
    camera.position.z = 2;
    const quad = (color, x, z) => {
      const inner = new THREE.Scene();
      const material = new THREE.MeshBasicNodeMaterial();
      material.colorNode = vec4(...color, 1);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.6), material);
      mesh.position.set(x, 0, z);
      inner.add(mesh);
      return inner;
    };
    const previous = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x2050a0, 1);
    renderer.clear();
    renderer.autoClear = false;
    renderer.render(quad([1, 0.1, 0.1], -0.3, 0.5), camera);
    renderer.render(quad([0.1, 0.9, 0.2], 0.3, -0.5), camera);
    renderer.autoClear = true;
    renderer.setRenderTarget(null);
    renderer.setClearColor(previous, previousAlpha);

    const panel = new THREE.MeshBasicNodeMaterial();
    panel.colorNode = vec4(texture(target.texture).rgb, 1);
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), panel));
    return { target, detail: { autoClear: renderer.autoClear } };
  });
}
