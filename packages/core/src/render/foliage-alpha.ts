import type { Material, Texture } from "three";
import { dFdx, dFdy, float, length, log2, max, uv, vec2 } from "three/tsl";
import {
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  type Node,
  type NodeMaterial,
} from "three/webgpu";

/**
 * How much of the mip chain's alpha loss one mip level is compensated by: Golus's `MIP_SCALE`, and
 * the value his `Alpha To Coverage` post measures its distance with. 0.25 takes a `0.5` cutoff to
 * 0.2 by mip 6 and no further — which is the whole of it, since 11 mips is all a 2048px map has.
 */
export const MIP_ALPHA_SCALE = 0.25;

/** The part of a GLTF material this reads. Structural, so a test stub is the same input. */
interface ICutoutSource {
  readonly map?: Texture;
}

/** The classic-to-node classes `NodeLibrary.fromMaterial` picks, for the three a GLB carries. */
type NodeMaterialClass = new () => NodeMaterial;

const NODE_CLASSES: ReadonlyMap<string, NodeMaterialClass> = new Map<string, NodeMaterialClass>([
  ["MeshBasicMaterial", MeshBasicNodeMaterial],
  ["MeshPhysicalMaterial", MeshPhysicalNodeMaterial],
  ["MeshStandardMaterial", MeshStandardNodeMaterial],
]);

/**
 * Never carried from the package's own material onto the cutout: `_listeners` would hand this
 * material's dispose hook to the authored one, and `id`/`uuid`/`version` would make the cutout a
 * distinct material to every cache keyed on them.
 */
const UNSYNCED = new Set(["_listeners", "id", "uuid", "version"]);

/**
 * Alpha loss compensation for one mip level, as Golus's post multiplies it.
 *
 * The fix, in the form his improved shader uses: raise the alpha by the mip level instead of
 * lowering it, which is the same comparison as dividing the cutoff — `a * scale > c` and
 * `a > c / scale` are one inequality.
 */
export function mipScaledAlpha(alpha: number, mipLevel: number, scale = MIP_ALPHA_SCALE): number {
  return alpha * (1 + Math.max(0, mipLevel) * scale);
}

/** The same compensation as a cutoff: `cutoff / scale`, which is what the shader compares against. */
export function mipAdjustedCutoff(
  cutoff: number,
  mipLevel: number,
  scale = MIP_ALPHA_SCALE,
): number {
  return cutoff / (1 + Math.max(0, mipLevel) * scale);
}

/**
 * The mip level a fragment lands on: the uv footprint of the pixel, in texels, log2'd. This is the
 * model of the shader form in `mipThreshold` below, for a square map.
 */
export function mipLevelFromFootprint(du: number, dv: number, texels: number): number {
  return Math.log2(Math.max(Math.abs(du), Math.abs(dv)) * texels);
}

/**
 * The mip level in the shader, from the uv derivatives and the map's own size — the surface
 * gradient of Mikkelsen's mip selection, which is the conservative half of the texel footprint.
 */
function mipThreshold(
  texels: readonly [number, number],
  cutoff: number,
  mipScale: number,
): Node<"float"> {
  const size = vec2(texels[0], texels[1]);
  const footprint = max(length(dFdx(uv()).mul(size)), length(dFdy(uv()).mul(size)));
  const scale = float(1).add(max(log2(footprint), float(0)).mul(mipScale));
  return float(cutoff).div(scale) as unknown as Node<"float">; // quality-allow: TSL result shape is set by construction; three 0.185 types swizzles and Fn loosely
}

/** The map's texel size, or `undefined` when there is no mip chain to compensate. */
function texelSize(map: Texture | undefined): readonly [number, number] | undefined {
  const image = map?.image as { width?: number; height?: number } | undefined;
  const width = image?.width;
  const height = image?.height;
  if (width === undefined || height === undefined) return undefined;
  if (!(width > 0) || !(height > 0)) return undefined;
  return [width, height];
}

function nodeClassOf(material: Material): NodeMaterialClass | undefined {
  if (Reflect.get(material, "isNodeMaterial") === true)
    return material.constructor as NodeMaterialClass;
  return NODE_CLASSES.get(material.type);
}

/** A node twin of the package's own material: its class, every value it authored, by reference. */
function nodeTwin(source: Material, nodeClass: NodeMaterialClass): Material {
  // A material three already draws through nodes clones into its own class with every node copied.
  if (Reflect.get(source, "isNodeMaterial") === true) return source.clone();
  // A classic material needs the conversion `NodeLibrary.fromMaterial` does at draw time, done here
  // instead so the cutoff can be a node instead of a number.
  const twin = new nodeClass();
  for (const key in source)
    if (!UNSYNCED.has(key)) Reflect.set(twin, key, Reflect.get(source, key));
  return twin;
}

/**
 * The mip-compensated cutoff for a source's own map, or `undefined` when it has no map and so no mip
 * chain to compensate. Shared by every path that alpha-tests a cutout it samples at a distance: the
 * scatter cutout above and the impostor bake, which renders a needle card into a 128 px frame.
 */
export function mipAlphaTestNode(
  source: Material,
  cutoff: number,
  mipScale = MIP_ALPHA_SCALE,
): Node<"float"> | undefined {
  const texels = texelSize((source as ICutoutSource).map);
  return texels === undefined ? undefined : mipThreshold(texels, cutoff, mipScale);
}

/**
 * The node form of a cutout whose alpha survives the mip chain: Ben Golus's mip-level alpha
 * compensation, as a dynamic `alphaTestNode`.
 *
 * Alpha-test a mipped alpha and distance deletes the surface. A 2048px needle card is nine percent
 * opaque; at 100 m it is sampled from mip five or six, where the box filter has averaged the card
 * down to about 0.1, and `discard` at 0.5 throws every needle away — a forest drawn as bare trunks.
 * Compensating by the mip level is the standard repair: the deeper the mip the smaller the effective
 * cutoff, because a deeper mip is a coarser question about the same texel, not a stricter one.
 *
 * The threshold is a *node* rather than a number so it reads the mip the fragment is actually on,
 * which depends on distance, on screen size and on how the game scaled the card. `alphaTest` keeps
 * the authored cutoff for every reader that only understands a number (`AlphaAntialiasing` counts
 * the cutout by it), and the discard and the alpha-to-coverage ramp both read the node.
 *
 * Where the coverage mask is on, three resolves the edge itself —
 * `smoothstep(alphaTestNode, alphaTestNode + fwidth(alpha), alpha)`, the derivative ramp Golus's
 * first pass spells out by hand — so the sharpen is not repeated here; applying it twice would
 * narrow the edge to half a pixel.
 *
 * What it never decides: the cutoff, the map, the colours, the geometry. Those are the game's; this
 * only stops the sampler from throwing them away.
 */
export function cutoutSurface(
  source: Material,
  cutoff: number,
  mipScale = MIP_ALPHA_SCALE,
): Material {
  const nodeClass = nodeClassOf(source);
  // A class with no node form — a Lambert card, say — keeps the plain cutout it has always drawn.
  const cutout = nodeClass === undefined ? source.clone() : nodeTwin(source, nodeClass);
  cutout.transparent = false;
  cutout.depthWrite = true;
  cutout.alphaTest = cutoff;
  if (nodeClass !== undefined) {
    // No map means no mip chain and no level to read, so the number is the whole cutoff.
    const node = mipAlphaTestNode(source, cutoff, mipScale);
    if (node !== undefined) (cutout as NodeMaterial).alphaTestNode = node;
  }
  // `transparent` is a program key in three, so the cutout needs its own compile.
  cutout.needsUpdate = true;
  return cutout;
}
