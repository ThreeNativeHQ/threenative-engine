import * as THREE from "three/webgpu";
import { float, mrt, texture, uv, vec4 } from "three/tsl";
import { startVisualScene } from "./scene-support.js";

// three's MRT render target (PRD-777): a RenderTarget made with `count: 3`, drawn once with each material's mrtNode
// writing a named output per texture, an additive CustomBlending quad accumulating into all three (the weighted OIT
// shape of the spell port), then each texture shown on its own panel.
export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "render-target-mrt", ({ renderer, scene }) => {
    const target = new THREE.RenderTarget(64, 64, { count: 3, type: THREE.HalfFloatType });
    const names = ["base", "accum", "reveal"];
    target.textures.forEach((attachment, i) => {
      attachment.name = names[i];
    });
    const inner = new THREE.Scene();
    inner.background = new THREE.Color(0x102030);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4);
    camera.position.z = 2;
    const board = new THREE.MeshBasicNodeMaterial();
    board.mrtNode = mrt({ base: vec4(uv(), 0.25, 1), accum: vec4(0.1, 0.2, 0.3, 1), reveal: float(0.6) });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), board);
    // One/One adds into every attachment: the material's blending writes each one, as three's does without a renderer MRT.
    const glow = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    glow.mrtNode = mrt({ base: vec4(0.3, 0, 0, 1), accum: vec4(uv().x, 0.25, 0, 1), reveal: float(0.3) });
    const spot = new THREE.Mesh(new THREE.CircleGeometry(0.6, 32), glow);
    spot.position.z = 0.1;
    inner.add(quad, spot);
    renderer.setRenderTarget(target);
    renderer.render(inner, camera);
    renderer.setRenderTarget(null);

    target.textures.forEach((attachment, i) => {
      const panel = new THREE.MeshBasicNodeMaterial();
      panel.colorNode = vec4(texture(attachment).rgb, 1);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), panel);
      mesh.position.x = (i - 1) * 1.2;
      scene.add(mesh);
    });
    return { target, detail: { count: target.textures.length } };
  });
}
