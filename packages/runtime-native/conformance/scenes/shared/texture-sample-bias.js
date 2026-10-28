import { texture, uniform, uv } from "three/tsl";
import { THREE, startVisualScene } from "./scene-support.js";

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "texture-sample-bias", ({ scene }) => {
    const size = 256;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offset = (y * size + x) * 4;
        const value = (x + y) % 2 === 0 ? 255 : 0;
        data.set([value, value, value, 255], offset);
      }
    }
    const map = new THREE.DataTexture(data, size, size);
    map.generateMipmaps = true;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.magFilter = THREE.LinearFilter;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.needsUpdate = true;
    // Opposite biases expose a missing/ignored bias: both panels would choose the same mip.
    for (const [x, bias] of [[-0.8, -0.75], [0.8, 0.75]]) {
      const material = new THREE.MeshBasicNodeMaterial();
      material.colorNode = texture(map, uv().mul(2)).bias(uniform(bias));
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.8), material);
      mesh.position.x = x;
      scene.add(mesh);
    }
  });
}
