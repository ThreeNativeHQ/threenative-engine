import { THREE, startVisualScene } from "./scene-support.js";

// three r187's anisotropic GGX (USE_ANISOTROPY): the specular highlight stretches along the
// material's tangent direction. Five physical spheres under one directional light show the
// isotropic baseline, two strengths, a rotated frame and an anisotropyMap-driven frame.
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "material-anisotropy", ({ scene }) => {
    const size = 4;
    const pixels = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; ++i) {
      pixels[i * 4] = 64;  // x direction
      pixels[i * 4 + 1] = 255;  // y direction
      pixels[i * 4 + 2] = 255;  // strength
      pixels[i * 4 + 3] = 255;
    }
    const anisotropyMap = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    anisotropyMap.magFilter = THREE.NearestFilter;
    anisotropyMap.minFilter = THREE.NearestFilter;
    anisotropyMap.needsUpdate = true;

    const geometry = new THREE.SphereGeometry(0.45, 64, 32);
    const spheres = [];
    const add = (x, options) => {
      const material = new THREE.MeshPhysicalMaterial({
        color: 0x9aa4b2,
        roughness: 0.18,
        metalness: 0.85,
        ...options,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.x = x;
      scene.add(mesh);
      spheres.push(mesh);
    };
    add(-1.8, { anisotropy: 0 });
    add(-0.9, { anisotropy: 0.5 });
    add(0, { anisotropy: 1 });
    add(0.9, { anisotropy: 0.9, anisotropyRotation: Math.PI / 4 });
    add(1.8, { anisotropy: 1, anisotropyMap });

    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(1.5, 2.5, 3);
    scene.add(light, new THREE.AmbientLight(0x30384a, 0.6));
    return { spheres, anisotropyMap, light };
  });
}
