import type { Light, Material, Mesh, Object3D } from "three";
import {
  clamp,
  diffuseColor,
  metalness,
  normalView,
  positionViewDirection,
  roughness,
  uniform,
  vec3,
} from "three/tsl";
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type Node } from "three/webgpu";

declare module "three" {
  // quality-allow: declaration merging needs three's own interface name, and the naming rule would demand an I prefix
  // biome-ignore lint/style/useNamingConvention: a module augmentation keeps three's own class name.
  interface Material {
    /**
     * Unreal's Substrate rough diffuse, the EON model (PRD-653): direct light shades the diffuse lobe of a
     * standard or physical material with EON where three shades Lambert. The default is off. Indirect light
     * stays Lambert, and a material changed after its first draw needs `needsUpdate`.
     */
    roughDiffuse?: boolean;
  }
  // quality-allow: declaration merging needs three's own interface name, and the naming rule would demand an I prefix
  // biome-ignore lint/style/useNamingConvention: a module augmentation keeps three's own class name.
  interface PointLight {
    /** Unreal's Source Radius in metres: how large the lamp is. A rough diffuse surface blends back to Lambert at 20 cm. */
    sourceRadius?: number;
  }
  // quality-allow: declaration merging needs three's own interface name, and the naming rule would demand an I prefix
  // biome-ignore lint/style/useNamingConvention: a module augmentation keeps three's own class name.
  interface SpotLight {
    /** Unreal's Source Radius in metres, as on PointLight. */
    sourceRadius?: number;
  }
}

/** Diffuse_GGX_Rough (Engine/Shaders/Private/BRDF.ush): EON's roughness is 0.4 x the material's. */
const ROUGHNESS_SCALE = 0.4;
/** The same function weights EON by the lamp's size: a lamp of 20 cm or more is shaded as Lambert. */
const SIZE_LIMIT = 0.2;
/** The EON model's fit constants (Portsmouth, Kutz and Hill), the ones the native engine's standard program holds too. */
const SINGLE_LOSS = 1 - 1 / (1 + (0.5 - 2 / (3 * Math.PI)));
const MULTI_TILT = 0.262048;
const ALBEDO_GAIN = 0.189468;
const EPSILON = 1e-6;

type Lamp = Light & { readonly isDirectionalLight?: boolean; readonly sourceRadius?: number };

/** The lighting model's `direct`, as far as this module drives it. */
interface IDirectInput {
  readonly lightDirection: Node<"vec3">;
  readonly lightNode?: { readonly light?: Lamp };
  readonly reflectedLight: { readonly directDiffuse: Node<"vec3"> };
}
interface ILightingModel {
  direct(input: IDirectInput, builder: unknown): void;
}
interface IPatchable {
  setupLightingModel?: (this: Material, builder: unknown) => ILightingModel;
}

const sourceRadii = new WeakMap<object, Node<"float">>();
const installed = new WeakSet<object>();

/** Undefined for a sun, else `1 - sourceRadius / 20 cm` held in 0..1; the radius is read each render. */
function lampWeight(light: Lamp | undefined): Node<"float"> | undefined {
  if (light === undefined || light.isDirectionalLight === true) return undefined;
  let radius = sourceRadii.get(light);
  if (radius === undefined) {
    radius = uniform(0).onRenderUpdate(() => light.sourceRadius ?? 0) as Node<"float">;
    sourceRadii.set(light, radius);
  }
  return clamp(radius.mul(1 / SIZE_LIMIT).oneMinus()) as Node<"float">;
}

/**
 * EON's factor on Lambert for one light, so `albedo / pi * factor` is the EON BRDF (Portsmouth, Kutz and Hill). It is 1 at
 * r = 0, and it never divides by the albedo, so black stays black. The native engine's standard program holds the same
 * arithmetic (`roughDiffuseFactor` in shader/standard.cpp); `conformance/registry.json` keeps the two equal.
 */
function roughDiffuseFactor(
  albedo: Node<"vec3">,
  r: Node<"float">,
  nov: Node<"float">,
  nol: Node<"float">,
  vol: Node<"float">,
): Node<"vec3"> {
  const s = vol.sub(nov.mul(nol));
  const sOverT = s.div(nov.max(nol).max(EPSILON)).max(s);
  const single = r.mul(SINGLE_LOSS).oneMinus();
  const front = single.mul(r.mul(sOverT).add(1));
  const multi = single.mul(r.mul(MULTI_TILT).mul(nov.oneMinus()).add(1)).oneMinus();
  const gain = albedo.oneMinus().mul(ALBEDO_GAIN).mul(r).add(1);
  return gain.mul(front.add(albedo.mul(gain).mul(multi))) as Node<"vec3">;
}

/**
 * Turns a stock lighting model's Lambert diffuse into EON. The model adds irradiance x Lambert to `directDiffuse`; that term
 * goes into a scratch variable here and returns scaled by EON's factor, so whatever else the model multiplies it by (sheen's
 * energy compensation) stays in, and the specular and clearcoat terms are untouched.
 */
function roughen(model: ILightingModel): ILightingModel {
  const lambert = model.direct;
  model.direct = function direct(
    this: ILightingModel,
    input: IDirectInput,
    builder: unknown,
  ): void {
    const scratch = vec3(0).toVar() as Node<"vec3">;
    lambert.call(
      this,
      { ...input, reflectedLight: { ...input.reflectedLight, directDiffuse: scratch } },
      builder,
    );
    const nov = clamp(normalView.dot(positionViewDirection)) as Node<"float">;
    const nol = clamp(normalView.dot(input.lightDirection)) as Node<"float">;
    const vol = positionViewDirection.dot(input.lightDirection) as Node<"float">;
    let r = roughness.mul(ROUGHNESS_SCALE) as Node<"float">;
    const weight = lampWeight(input.lightNode?.light);
    if (weight !== undefined) r = r.mul(weight) as Node<"float">;
    // three's diffuseContribution, which three/tsl does not export: the colour less its metal share.
    const albedo = diffuseColor.rgb.mul(metalness.oneMinus()) as Node<"vec3">;
    const factor = roughDiffuseFactor(albedo, r, nov, nol, vol);
    (
      input.reflectedLight.directDiffuse as Node<"vec3"> & { addAssign(value: Node): void }
    ).addAssign(scratch.mul(factor));
  };
  return model;
}

/**
 * Hooks `setupLightingModel` of three's standard and physical node materials once, so a material with `roughDiffuse` set
 * shades its direct diffuse with EON. A material without it gets three's own model back untouched. Idempotent. Call
 * {@link useRoughDiffuse} to mark the materials as well.
 */
export function installRoughDiffuse(): void {
  for (const material of [MeshStandardNodeMaterial, MeshPhysicalNodeMaterial]) {
    // quality-allow: three's setupLightingModel types its direct input as LightingModelDirectInput, which IDirectInput narrows to the fields read here
    const proto = material?.prototype as unknown as IPatchable | undefined;
    const original = proto?.setupLightingModel;
    if (proto === undefined || original === undefined || installed.has(proto)) continue;
    installed.add(proto);
    proto.setupLightingModel = function setupLightingModel(this: Material, builder: unknown) {
      const model = original.call(this, builder);
      return this.roughDiffuse === true ? roughen(model) : model;
    };
  }
}

/** The Node variants set no `isMeshStandardMaterial`, so the type name is the one test that covers three and the owned engine. */
const STANDARD = /^Mesh(?:Standard|Physical)(?:Node)?Material$/u;

function isStandard(material: unknown): material is Material {
  return STANDARD.test((material as { type?: string } | null)?.type ?? "");
}

/**
 * Shades every standard and physical material under `root` the way Unreal's Substrate does a rough surface: direct light
 * meets the diffuse lobe with the EON model, not Lambert. Returns how many materials changed. `enabled: false` puts Lambert
 * back. The owned engine reads `material.roughDiffuse` itself; on three's own WebGPU renderer this also installs the hook.
 */
export function useRoughDiffuse(root: Object3D, enabled = true): number {
  installRoughDiffuse();
  let changed = 0;
  root.traverse((object) => {
    const material = (object as Partial<Mesh>).material;
    for (const each of Array.isArray(material) ? material : [material]) {
      if (!isStandard(each) || (each.roughDiffuse === true) === enabled) continue;
      each.roughDiffuse = enabled;
      each.needsUpdate = true;
      changed++;
    }
  });
  return changed;
}
