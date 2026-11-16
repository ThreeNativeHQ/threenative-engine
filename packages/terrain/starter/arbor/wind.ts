// The wind on baked Arbor trees: copy to src/render/arborWind.ts and pass `partMaterial: arborWind`
// to WorldCells.load. Every Arbor vertex carries `_WIND` (glTF `_WIND`, three `_wind`): x the trunk's
// sway in metres, y the branch's, z the leaf flutter, w a phase. A part without it (a rock, a kit tree)
// keeps its own material. Direction, rates and strength are this file's to change: the game owns its look.
import type { BufferGeometry, Material, MeshStandardMaterial } from "three";
import { attribute, normalLocal, positionLocal, positionWorld, sin, time, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";

export const ARBOR_WIND = {
  /** World-space direction the gusts push, x and z. */
  direction: [0.82, 0.57] as const,
  /** Trunk cycles per second: a tree in a stiff breeze is about one cycle every two seconds. */
  rate: 0.45,
  /** Scales every baked amplitude; 0 stills the forest. */
  strength: 1,
};

const swaying = new WeakMap<Material, Material>();

export function arborWind(material: Material, geometry: BufferGeometry): Material {
  if (geometry.getAttribute("_wind") === undefined) return material;
  const reach = windReach(geometry);
  const known = swaying.get(material);
  if (known !== undefined) {
    grow(known, reach);
    return known;
  }
  const source = material as MeshStandardMaterial;
  const own = new MeshStandardNodeMaterial();
  for (const key of [
    "alphaMap",
    "alphaTest",
    "alphaToCoverage",
    "aoMap",
    "color",
    "emissive",
    "emissiveMap",
    "map",
    "metalness",
    "metalnessMap",
    "name",
    "normalMap",
    "normalScale",
    "roughness",
    "roughnessMap",
    "side",
    "transparent",
    "vertexColors",
  ] as const)
    if (source[key] !== undefined) (own as unknown as Record<string, unknown>)[key] = source[key];

  const wind = attribute<"vec4">("_wind", "vec4");
  const { direction, rate, strength } = ARBOR_WIND;
  const phase = wind.w.add(positionWorld.x.mul(0.07)).add(positionWorld.z.mul(0.05));
  const trunk = sin(time.mul(rate * Math.PI * 2).add(phase)).mul(wind.x);
  const branch = sin(time.mul(rate * 2.3 * Math.PI * 2).add(phase.mul(1.7))).mul(wind.y);
  const flutter = sin(time.mul(7.5).add(phase.mul(9))).mul(wind.z);
  const push = vec3(direction[0], 0, direction[1]).mul(trunk.add(branch));
  own.positionNode = positionLocal.add(push.add(normalLocal.mul(flutter)).mul(strength));
  // Cached shadow pages would freeze a moving cast mid-sway; the shadow keeps the rest pose.
  own.castShadowPositionNode = positionLocal;
  grow(own, reach);
  swaying.set(material, own);
  return own;
}

/** The farthest the wind moves any vertex of `geometry`: its largest trunk + branch + flutter. */
function windReach(geometry: BufferGeometry): number {
  const wind = geometry.getAttribute("_wind");
  let reach = 0;
  for (let vertex = 0; vertex < wind.count; vertex += 1)
    reach = Math.max(
      reach,
      Math.abs(wind.getX(vertex)) + Math.abs(wind.getY(vertex)) + Math.abs(wind.getZ(vertex)),
    );
  return reach * ARBOR_WIND.strength;
}

// engine-override: the farthest the wind moves a vertex, so the owned engine grows each tree's
// shadow and cull box by it, measured per geometry: a palm sways farther than an oak.
function grow(material: Material, reach: number): void {
  const swayed = material as Material & { maxPositionOffset?: number };
  swayed.maxPositionOffset = Math.max(swayed.maxPositionOffset ?? 0, reach);
}
