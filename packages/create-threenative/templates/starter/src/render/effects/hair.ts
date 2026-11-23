// Generated for you. A hair-card material for strand atlases: coverage decides the edge, the
// root-to-tip gradient colours the strand, and the highlight follows the card tangent.
import * as THREE from "three/webgpu";
// @ts-expect-error -- the vendored upstream module is JavaScript with no declaration file.
import { createHairMaterials } from "./vendor/hair-shader.js";

/**
 * Every knob the card material reads. An omitted option keeps the upstream default named beside it.
 *
 * @situation hair material options
 * @constraint every colour, root gradient, anisotropy and density is a named option on this object
 */
export interface IHairCardMaterialOptions {
  /** Strand data atlas: R coverage, G root→tip, B per-strand seed. No atlas renders plain cards. */
  atlas?: THREE.Texture | null;
  /** Tangent-space map whose RG channel holds the strand direction; anisotropy needs it. */
  tangent?: THREE.Texture | null;
  /** Strand colour at the tip. @default DEFAULTS.color (#3a2a1e) */
  color?: THREE.ColorRepresentation;
  /** Root colour; it reaches the surface only in `rootMode: "multi"`. @default DEFAULTS.rootColor */
  rootColor?: THREE.ColorRepresentation;
  /** `mono` darkens one colour at the root; `multi` runs the root colour into the tip colour. @default "mono" */
  rootMode?: "mono" | "multi";
  /** How dark the root end of a mono strand is, 0…1. @default 0 */
  rootDarkening?: number;
  /** How far up the strand the root colour reaches, 0…1. @default 1 */
  rootStrength?: number;
  /** Per-strand brightness variance from the atlas seed. @default 0.36 */
  seedVariation?: number;
  /** Base roughness before the seed and tip offsets. @default 0.5 */
  roughness?: number;
  /** Lower bound on roughness, so the head is never one uniform mirror. @default 0.55 */
  roughnessFloor?: number;
  /** Per-strand roughness jitter from the atlas seed. @default 0.08 */
  roughnessSeedAmp?: number;
  /** GGX highlight strength along the strand tangent; it needs `atlas` and `tangent`. @default 0.44 */
  anisotropy?: number;
  /** Anisotropic highlight rotation, in radians. @default -1.09 */
  anisotropyRotation?: number;
  /** Coverage gain for the blended fringe. @default DEFAULTS.density (2.5 with MSAA, 1.0 without) */
  density?: number;
  /** Alpha-to-coverage resolves the edge through MSAA; without it the opaque core is the solid layer. */
  alphaToCoverage?: boolean;
  /** Force one pass set instead of detecting MSAA: `a2c`, `blend` or `both`. */
  mode?: "a2c" | "blend" | "both";
  /** The renderer, so alpha-to-coverage follows its sample count. */
  renderer?: {
    readonly isWebGPURenderer?: boolean;
    readonly samples?: number;
    readonly currentSamples?: number;
    readonly getContext?: () => WebGL2RenderingContext | null;
  } | null;
  /** Opaque core clip against raw coverage, no-MSAA fallback only. @default 0.5 */
  innerThreshold?: number;
  /** Fringe opacity. @default 0.4 */
  blendOpacity?: number;
  /** Matte roughness for the fringe, which owns no sharp specular. @default 0.6 */
  blendRoughness?: number;
  /** Atlas channel that holds coverage. @default "r" */
  alphaChannel?: "r" | "g" | "b" | "a";
  /** Name the passes carry. @default "hair" */
  materialName?: string;
}

/** The passes upstream builds: the hair itself, plus the fallback core or the blended fringe. */
export interface IHairCardMaterials {
  /** The hair. Alpha-to-coverage when MSAA is on, the depth-writing blended pass otherwise. */
  readonly outer: THREE.MeshPhysicalNodeMaterial;
  /** Opaque core, built only without MSAA; otherwise null. */
  readonly inner: THREE.MeshPhysicalNodeMaterial | null;
  /** Blended fringe, built only with MSAA; `mode: "a2c"` keeps it hidden. */
  readonly blend: THREE.MeshPhysicalNodeMaterial | null;
  readonly mode: "a2c" | "blend" | "both";
  readonly useA2C: boolean;
  /** Coverage gain actually in force. */
  readonly density: number;
}

/**
 * Hair cards that read as hair under any light: a coverage mask resolves the edge instead of a
 * hard cut, the root gradient and per-strand seed break up the flat sheet, and an anisotropic
 * highlight follows the strand.
 *
 * @situation hair cards look flat
 * @situation hair material
 * @situation anisotropic hair highlight
 * @situation hair alpha sorting
 * @constraint every colour, gradient, anisotropy and density is a named option; the upstream defaults apply when omitted
 * @override alphaToCoverage, mode, density, innerThreshold, blendOpacity, blendRoughness, alphaChannel
 * @example const hair = createHairCardMaterial({ atlas, tangent, alphaToCoverage: true });
 */
export function createHairCardMaterial(options: IHairCardMaterialOptions = {}): IHairCardMaterials {
  // Only defined keys travel: an explicit `undefined` would override an upstream default.
  const opts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) opts[key] = value;
  }
  // A ThreeNative game always renders with WebGPU. Without a renderer, upstream guesses from the
  // namespace, and the owned engine's `three/webgpu` also exports `WebGLRenderer`, so it would pick
  // GLSL patches that the node renderer never runs.
  opts.renderer ??= { isWebGPURenderer: true };
  const materials = createHairMaterials(THREE, undefined, opts) as IHairCardMaterials;
  // three r187 NodeMaterial.maskShadowNode: the shadow depth pass discards a texel where this node
  // is false. Under alpha-to-coverage the visible pass clips nothing (`alphaTest` 0), so without it
  // every card texel casts and the shadow is the card rectangle, not the strands. Keep a texel
  // exactly when the visible pass shows it at half coverage or more, on the raw atlas channel.
  if (options.atlas) {
    const channel = options.alphaChannel ?? "r";
    for (const pass of [materials.outer, materials.inner, materials.blend]) {
      if (pass)
        pass.maskShadowNode = THREE.TSL.texture(options.atlas)[channel].greaterThanEqual(0.5);
    }
  }
  return materials;
}
