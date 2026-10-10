import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

// Midway lives outside this repo: TN_MIDWAY_ASSETS names its `public/assets/` directory.
const root = process.env.TN_MIDWAY_ASSETS;
if (!root) throw new Error("TN_MIDWAY_ASSETS_UNSET: set it to midway-open-pacific/public/assets");
const assets = root.endsWith("/") ? root : `${root}/`;
const model = await new GLTFLoader().loadAsync(`${assets}hornet.glb`);
let meshes = 0;
const materials = new Set<object>();
const textures = new Set<object>();
model.scene.traverse((object: { isMesh?: boolean; material?: object | object[] }) => {
  if (!object.isMesh) return;
  meshes++;
  for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
    if (!material) throw new Error("TN_MIDWAY_MATERIAL_MISSING");
    materials.add(material);
    for (const slot of [
      "map",
      "normalMap",
      "metalnessMap",
      "roughnessMap",
      "emissiveMap",
      "aoMap",
      "specularIntensityMap",
      "specularColorMap",
    ])
      if ((material as Record<string, object>)[slot])
        textures.add((material as Record<string, object>)[slot]);
  }
});
const sky = await new HDRLoader().loadAsync(`${assets}dawn-sky.hdr`);
if (!sky.isTexture || sky.image.width !== 2048 || sky.image.height !== 1024)
  throw new Error("TN_MIDWAY_HDR_IMAGE");
if (!meshes || !materials.size || !textures.size) throw new Error("TN_MIDWAY_EMPTY_ASSETS");
console.log("ship", meshes, materials.size, textures.size);
console.log("sky", 1, sky.image.width, sky.image.height, sky.type);
