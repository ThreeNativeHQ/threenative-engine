import {
  Box3,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Scene,
  type Texture,
  Vector3,
} from "three";
import { skyDisc } from "./gpuSky.js";

interface IReflectionRenderer {
  /** @alias reflection probe, cube capture */
  SphereReflectionCapture(scene: Scene, position: Vector3, faceSize: number): Promise<Texture>;
}

/** Capture the static scene after installGi has replaced its materials. */
export async function captureReflections(
  renderer: IReflectionRenderer,
  scene: Scene,
  root: Object3D,
): Promise<() => void> {
  const started = performance.now();
  const meshes: Mesh[] = [];
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.some((material) => material.metalness >= 0.9 && material.roughness <= 0.3))
      meshes.push(object);
  });
  const textures: Texture[] = [];
  const used = new Set<MeshStandardMaterial>();
  try {
    for (const mesh of meshes) {
      const position = new Box3().setFromObject(mesh).getCenter(new Vector3());
      const visible = mesh.visible;
      // 256 texels span about 0.35 degrees at face center; six faces bound static startup work.
      let texture: Texture;
      mesh.visible = false;
      skyDisc.value = 0;
      try {
        texture = await renderer.SphereReflectionCapture(scene, position, 256);
      } finally {
        skyDisc.value = 1;
        mesh.visible = visible;
      }
      textures.push(texture);
      // Each mesh needs its own material when imported meshes share one source material.
      const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // installGi swaps in MeshStandardNodeMaterial, which shares these fields but not the class.
      const materials = (source as MeshStandardMaterial[]).map((material) => {
        if (!(material.metalness >= 0.9 && material.roughness <= 0.3)) return material;
        const local = used.has(material) ? material.clone() : material;
        used.add(material);
        local.envMap = texture;
        local.envMapIntensity = 1;
        local.needsUpdate = true;
        return local;
      });
      mesh.material = Array.isArray(mesh.material)
        ? materials
        : (materials[0] as MeshStandardMaterial);
    }
  } catch (error) {
    for (const texture of textures) texture.dispose();
    throw error;
  }
  console.info(
    `TN_REFLECTION_CAPTURE ${JSON.stringify({ objects: meshes.length, faceSize: 256, milliseconds: Math.round(performance.now() - started), zenith: textures.map(zenithMean) })}`,
  );
  return () => {
    for (const texture of textures) texture.dispose();
  };
}

/**
 * Mean RGB radiance of the capture's zenith cap, the rows above 45 degrees (from the north pole, as the engine writes
 * them): only sky is there, so a capture whose faces missed the sky reads about zero. Null without RGBA data.
 */
function zenithMean(texture: Texture): number[] | null {
  const image = texture.image as { data?: ArrayLike<number>; width?: number; height?: number };
  const { data, width = 0, height = 0 } = image ?? {};
  if (data === undefined || data.length !== width * height * 4) return null;
  const texels = width * Math.max(1, Math.floor(height / 4));
  const sum = [0, 0, 0];
  for (let i = 0; i < texels; i++)
    for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (data[i * 4 + c] ?? 0);
  return sum.map((v) => Number((v / texels).toFixed(3)));
}
