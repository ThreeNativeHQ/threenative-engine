/**
 * Records what three@0.185.1's GLTFLoader builds from the repository's glTF corpus, as the JSON the
 * native loader's test compares against (PRD-515 phase 1): the scene hierarchy in traversal order
 * (names, types, parents, transforms), every mesh's geometry layout and materials, skins and the
 * clip list.
 *
 * The loader runs for real, with one plugin: images are not decoded (Node has no DOM), so a texture
 * stands in for each glTF texture and the dump records which material slots hold one.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/assets/gltf-reference.ts
 *   ... -- --check   (fails when the committed dump is not what this three produces)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Material, type Mesh, type Object3D, type SkinnedMesh, Texture } from "three";
import { GLTFLoader, type GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../../..");
const OUT = path.join(HERE, "gltf_reference.json");

/** The corpus: every tracked glTF this loader must reproduce, small to large. */
export const CORPUS = [
  "packages/create-threenative/templates/starter/assets/native-proof.glb",
  "packages/core/__tests__/fixtures/world-v1/assets/rock.glb",
  "examples/csg-doorway/assets/doorway.glb",
  "packages/create-threenative/__tests__/fixtures/bounded-decals/public/receiver.glb",
  "test-support/fixtures/skinned-character.glb",
  "test-support/fixtures/morph-clip.glb",
  "examples/abyss-framework/assets/world/assets/pine.glb",
  "examples/auto-lod/assets/hull.glb",
  "packages/assets/__tests__/fixtures/foliage-conifer.glb",
  "packages/create-threenative/template-assets/assets/mannequin.glb",
  "packages/create-threenative/templates/sailing/assets/ship.glb",
  "packages/create-threenative/template-assets/assets/player-viewmodel.glb",
];

const MAP_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "emissiveMap",
  "aoMap",
  "alphaMap",
  "clearcoatMap",
  "clearcoatNormalMap",
  "clearcoatRoughnessMap",
  "sheenColorMap",
  "sheenRoughnessMap",
  "transmissionMap",
  "thicknessMap",
  "specularIntensityMap",
  "specularColorMap",
  "iridescenceMap",
  "iridescenceThicknessMap",
  "anisotropyMap",
] as const;

function material(m: Material): Record<string, unknown> {
  const any = m as unknown as Record<string, unknown> & {
    color?: { r: number; g: number; b: number };
    emissive?: { r: number; g: number; b: number };
  };
  const out: Record<string, unknown> = {
    type: m.type,
    name: m.name,
    opacity: m.opacity,
    transparent: m.transparent,
    side: m.side,
    alphaTest: m.alphaTest,
    depthWrite: m.depthWrite,
    vertexColors: m.vertexColors,
  };
  if (any.color) out.color = [any.color.r, any.color.g, any.color.b];
  if (any.emissive) out.emissive = [any.emissive.r, any.emissive.g, any.emissive.b];
  for (const key of ["roughness", "metalness", "emissiveIntensity", "flatShading"])
    if (key in any) out[key] = any[key];
  out.maps = MAP_SLOTS.filter((slot) => any[slot] instanceof Texture);
  return out;
}

function node(object: Object3D, index: Map<Object3D, number>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: object.name,
    type: object.type,
    parent: object.parent ? (index.get(object.parent) ?? -1) : -1,
    position: object.position.toArray(),
    quaternion: object.quaternion.toArray(),
    scale: object.scale.toArray(),
  };
  const mesh = object as Mesh;
  if (mesh.isMesh) {
    const geometry = mesh.geometry;
    out.geometry = {
      // By name: three inserts them as their accessors resolve, an order no file states.
      attributes: Object.entries(geometry.attributes)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, attribute]) => ({
          name,
          itemSize: attribute.itemSize,
          count: attribute.count,
          normalized: attribute.normalized,
          array: (attribute.array as { constructor: { name: string } }).constructor.name,
        })),
      index: geometry.index ? geometry.index.count : null,
      morphTargets: geometry.morphAttributes.position?.length ?? 0,
      groups: geometry.groups.length,
    };
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    out.materials = materials.map(material);
    if (mesh.morphTargetInfluences) out.morphTargetInfluences = [...mesh.morphTargetInfluences];
  }
  const skinned = object as SkinnedMesh;
  if (skinned.isSkinnedMesh) out.skeleton = skinned.skeleton.bones.map((bone) => bone.name);
  return out;
}

async function dump(file: string): Promise<Record<string, unknown>> {
  const bytes = readFileSync(path.join(REPO, file));
  const loader = new GLTFLoader();
  loader.register((parser: GLTFParser) => ({
    name: "tn_no_image_decode",
    loadTexture(textureIndex: number) {
      const textureDef = parser.json.textures[textureIndex];
      const texture = new Texture();
      texture.name = textureDef.name ?? "";
      return Promise.resolve(texture);
    },
  }));
  const gltf = await loader.parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "",
  );
  const objects: Object3D[] = [];
  gltf.scene.traverse((object) => objects.push(object));
  const index = new Map(objects.map((object, i) => [object, i]));
  return {
    file,
    nodes: objects.map((object) => node(object, index)),
    animations: gltf.animations.map((clip) => ({
      name: clip.name,
      duration: clip.duration,
      tracks: clip.tracks.map((track) => ({
        name: track.name,
        type: track.ValueTypeName,
        times: track.times.length,
        values: track.values.length,
        interpolation: track.getInterpolation(),
      })),
    })),
  };
}

const files = [];
for (const file of CORPUS) files.push(await dump(file));
const text = `${JSON.stringify({ three: "0.185.1", files }, null, 1)}\n`;
if (process.argv.includes("--check")) {
  const committed = readFileSync(OUT, "utf8");
  if (committed !== text) {
    console.error(`TN_GLTF_REFERENCE_STALE: ${OUT} is not what this three produces`);
    process.exit(1);
  }
  console.log(`gltf reference current: ${files.length} files`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${files.length} files to ${OUT}`);
}
