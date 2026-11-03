import * as THREE from "three/webgpu";
import { texture, uv, vec4 } from "three/tsl";
import { startVisualScene } from "./scene-support.js";

// three's RenderTarget options the spell port's GroundField and FluidVolume pass (PRD-777): an 8x8 RGFormat
// HalfFloatType target with RepeatWrapping, NearestFilter and generateMipmaps false. The left panel samples it
// tiled three times (repeat wrap, hard texel edges, blue 0); the right panel shows its alpha (1 for an RG texture).
export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "render-target-options", ({ renderer, scene }) => {
    const target = new THREE.RenderTarget(8, 8, {
      type: THREE.HalfFloatType,
      format: THREE.RGFormat,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    const inner = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4);
    camera.position.z = 2;
    const board = new THREE.MeshBasicNodeMaterial();
    board.colorNode = vec4(uv(), 0.7, 0.3);
    inner.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), board));
    renderer.setRenderTarget(target);
    renderer.render(inner, camera);
    renderer.setRenderTarget(null);

    const tiled = new THREE.MeshBasicNodeMaterial();
    tiled.colorNode = vec4(texture(target.texture, uv().mul(3)).rgb, 1);
    const alpha = new THREE.MeshBasicNodeMaterial();
    alpha.colorNode = vec4(texture(target.texture).aaa, 1);
    [tiled, alpha].forEach((material, i) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), material);
      mesh.position.x = (i - 0.5) * 1.7;
      scene.add(mesh);
    });
    return { target, detail: { format: target.texture.format, wrapS: target.texture.wrapS } };
  });
}
