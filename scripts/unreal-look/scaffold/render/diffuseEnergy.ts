// PRD-646 round 9, harness only: the diffuse's specular-energy loss, Unreal's term.
//
// Unreal multiplies a lit slab's diffuse by what the specular layer leaves it,
// `ComputeEnergyPreservation` (UE 5.8.3: Engine/Shaders/Private/ShadingEnergyConservationTemplate.ush:126-132)
//
//   preservation = 1 - Luminance(E),   E = W * (E.x * F0 + E.y * (F90 - F0)),   W = 1 + F0 * ((1 - E.x) / E.x)
//
// with (E.x, E.y) the specular lobe's directional albedo at the view's NoV (`:46-67`) read from
// `GGXEnergyLookup(roughness, NoV)` (Engine/Shaders/Private/ShadingEnergyConservation.ush:70-80). It is applied
// to the direct diffuse (Engine/Shaders/Private/Substrate/SubstrateEvaluation.ush:587-589, `:836-837`) and to the
// environment diffuse (`:1948`, `:2082`): an integral over the lobe, and one value for every light.
//
// three subtracts the pointwise Fresnel at the light's half angle instead,
// `1 - F_Schlick(f0, specularF90, dotVH)` (packages/runtime-native/src/engine/shader/standard.cpp:1433-1442),
// and its indirect diffuse subtracts the integrated one from the dfg texel (`:1389`, `:1462`). At a grazing half
// angle the pointwise value is 4 to 7 times its own integral: VoH = NoV = 0.274 gives 0.2336 against 0.0333, so a
// grazing row loses 4 to 7 times too much of its diffuse.
//
// The engine is not this harness's to change (PRD-646 round 9), so the term arrives on the material: the albedo
// is scaled by `preservation / (1 - F)`. The engine multiplies that albedo by `NdotL * light * (1 - F)` for the
// scene's one direct light, which leaves exactly `NdotL * light * preservation`. It is exact where the frame is the
// direct light alone, layer L1; from L2 the sky and GI diffuse already lose the integrated term through three's own
// `energyLoss`, which a per-material scale cannot be separated from, so later layers keep three's term.
//
// Round 13: `preservation` follows the project's own switch, and this project compiles the term out
// (`ENERGY_CONSERVATION` below), so the scale is `1 / (1 - F)` and the diffuse keeps every bit of its light. Round 12
// measured the pair on `cornell`: Unreal's specular on/off is 1 + the lobe (Floor 1.0274, Back 1.0138), the harness's
// was 1 - E + the lobe (0.9993, 1.0038).
//
// F0 and F90 are the two engines' shared values: F0 = 0.04, `DielectricSpecularToF0(Specular)` = `0.08 x
// Specular` (Engine/Shaders/Private/ShadingCommon.ush:122-125) with Unreal's default Specular 0.5, and F90 = 1
// for a dielectric (`ComputeF90` with the default edge colour, `:170-176`); a standard material carries the same
// 0.04 and 1 (standard.cpp:1367-1371). The term reads them from the material the engine will draw
// (`specularTerms`), so a diagnosis ablation's zero F0 and its own F90 divide out the loss the engine really
// subtracts. ?diffuseEnergy=three restores three's term and leaves every material untouched, so that arm draws the
// frame the harness drew before this file existed.
import { type Material, type Object3D, Vector3 } from "three";
import {
  cameraPosition,
  dot,
  exp2 as exp2Node,
  float,
  normalWorld,
  positionWorld,
  pow as powNode,
  saturate as saturateNode,
  texture,
  vec3,
  vec4,
} from "three/tsl";
import {
  MeshPhysicalNodeMaterial,
  type MeshStandardMaterial,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import { copyFields } from "./giCache.js";

/** Which loss the direct diffuse takes: Unreal's integrated term (default) or three's pointwise Fresnel. */
export type DiffuseEnergyMode = "unreal" | "three";

/**
 * `?diffuseEnergy=three` puts three's pointwise `1 - F_Schlick` back, the BEFORE arm; unset means Unreal's term.
 * A name that is neither fails closed, as `?specular=` does.
 */
export function diffuseEnergyMode(params: URLSearchParams): DiffuseEnergyMode {
  const value = params.get("diffuseEnergy");
  if (value === null || value === "unreal") return "unreal";
  if (value === "three") return "three";
  throw new Error(
    `TN_DIFFUSE_ENERGY: '${value}' is not a term; use unreal (default) or three (three's Fresnel mix)`,
  );
}

/** The scene's one direct light: a direction for the sun, a world position for a lamp. */
export interface IDirectLight {
  /** From the surface to the light, for a directional light. */
  direction?: Vector3;
  /** The lamp's world position, for a point or spot light. */
  position?: Vector3;
}

/** One formula, two arithmetics: plain numbers for the spec, TSL nodes for the page. */
export interface IEnergyArithmetic<A> {
  constant(value: number): A;
  add(a: A, b: A): A;
  sub(a: A, b: A): A;
  mul(a: A, b: A): A;
  div(a: A, b: A): A;
  pow(a: A, b: A): A;
  exp2(a: A): A;
  saturate(a: A): A;
}

export const NUMBER_ARITHMETIC: IEnergyArithmetic<number> = {
  constant: (value) => value,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  pow: (a, b) => a ** b,
  exp2: (a) => 2 ** a,
  saturate: (a) => Math.min(1, Math.max(0, a)),
};

/**
 * Unreal's analytic GGX directional albedo, `GGXEnergyLookup` under `USE_ENERGY_CONSERVATION == 2`
 * (Engine/Shaders/Private/ShadingEnergyConservation.ush:74-79): E.x is the F = 1 albedo, E.y the F90-weighted
 * one. The texture the shipped shader samples (`:71`) holds the same integral, and the two agree to 2% on the
 * rows this harness measures (0.0321 against 0.0324 on `cornell` `Floor`, 0.0563 against 0.0570 on
 * `sun15-window` `Ground`).
 */
export function ggxEnergyLookup<A>(
  arithmetic: IEnergyArithmetic<A>,
  roughness: A,
  noV: A,
): { x: A; y: A } {
  const a = arithmetic;
  const r = roughness;
  const c = noV;
  // const float E = 1.0 - saturate(pow(r, c / r) * ((r * c + 0.0266916) / (0.466495 + c)));
  const x = a.sub(
    a.constant(1),
    a.saturate(
      a.mul(
        a.pow(r, a.div(c, r)),
        a.div(a.add(a.mul(r, c), a.constant(0.0266916)), a.add(a.constant(0.466495), c)),
      ),
    ),
  );
  // const float Ef = Pow5(1 - c) * pow(2.36651 * pow(c, 4.7703 * r) + 0.0387332, r);
  const y = a.mul(
    a.pow(a.sub(a.constant(1), c), a.constant(5)),
    a.pow(
      a.add(
        a.mul(a.constant(2.36651), a.pow(c, a.mul(a.constant(4.7703), r))),
        a.constant(0.0387332),
      ),
      r,
    ),
  );
  return { x, y };
}

/**
 * `1 - Luminance(E)`, the factor Unreal puts on the diffuse: `ComputeFresnelEnergyTerms` builds W and E
 * (ShadingEnergyConservationTemplate.ush:55-62) and `ComputeEnergyPreservation` returns the loss (`:126-132`).
 */
export function energyPreservation<A>(
  arithmetic: IEnergyArithmetic<A>,
  terms: { roughness: A; noV: A; f0: A; f90: A },
): A {
  const a = arithmetic;
  const { x, y } = ggxEnergyLookup(a, terms.roughness, terms.noV);
  const w = a.add(a.constant(1), a.mul(terms.f0, a.div(a.sub(a.constant(1), x), x)));
  const e = a.mul(w, a.add(a.mul(x, terms.f0), a.mul(y, a.sub(terms.f90, terms.f0))));
  return a.sub(a.constant(1), e);
}

/**
 * The Fresnel three subtracts, in the engine's own form:
 * `fc = exp2((dotVH * -5.55473 - 6.98316) * dotVH)` and `F = f0 (1 - fc) + f90 fc`
 * (packages/runtime-native/src/engine/shader/standard.cpp:47-51, three's r187 `F_Schlick`; Unreal's
 * `BRDF.ush:412-416` writes the same term as `Pow5(1 - VoH)`, 0.3% apart at VoH 0.274). The ratio has to use
 * this form: any other leaves the engine's subtraction only partly cancelled.
 */
export function fresnel<A>(
  arithmetic: IEnergyArithmetic<A>,
  terms: { f0: A; f90: A; dotVH: A },
): A {
  const a = arithmetic;
  const fc = a.exp2(
    a.mul(a.sub(a.mul(terms.dotVH, a.constant(-5.55473)), a.constant(6.98316)), terms.dotVH),
  );
  return a.add(a.mul(terms.f0, a.sub(a.constant(1), fc)), a.mul(terms.f90, fc));
}

/**
 * `USE_ENERGY_CONSERVATION` for the reference project: off, so a lit slab's diffuse loses nothing.
 *
 * The macro is 1 only when `(SUBSTRATE_ENABLED && SUBSTRATE_GBUFFER_FORMAT>0) ||
 * LEGACY_MATERIAL_ENERGYCONSERVATION` (UE 5.8.3: Engine/Shaders/Private/ShadingEnergyConservation.ush:20-31). This
 * project asks for the blendable Substrate GBuffer, `r.Substrate.ProjectGBufferFormat=0`
 * (tools/unreal-reference/Config/DefaultEngine.ini), which keeps the blendable format
 * (`Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp:2226-2233`) and compiles `SUBSTRATE_GBUFFER_FORMAT` to
 * 0 (`Engine/Source/Runtime/Engine/Private/ShaderCompiler/ShaderCompiler.cpp:4093`); legacy energy conservation
 * defaults to 0 (`Engine/Source/Runtime/Renderer/Private/ShadingEnergyConservation.cpp:72-74`). With both off,
 * `ComputeEnergyPreservation` returns 1 and `ComputeEnergyConservation` returns `W`
 * (ShadingEnergyConservationTemplate.ush:126-143). Round 12 measured the pair on `cornell`: Unreal's specular
 * on/off is 1 + the lobe (Floor 1.0274), the harness's is 1 - E + the lobe (0.9993).
 */
export const ENERGY_CONSERVATION: boolean = false;

/** A float-valued node: the type every arithmetic step of the formula returns. */
type TslFloat = import("three/webgpu").Node<"float">;
/** A vec3-valued node, as a light's direction or a colour. */
type TslVec3 = import("three/webgpu").Node<"vec3">;

const TSL_ARITHMETIC: IEnergyArithmetic<TslFloat> = {
  constant: (value) => float(value) as TslFloat,
  add: (a, b) => a.add(b) as TslFloat,
  sub: (a, b) => a.sub(b) as TslFloat,
  mul: (a, b) => a.mul(b) as TslFloat,
  div: (a, b) => a.div(b) as TslFloat,
  pow: (a, b) => powNode(a, b) as TslFloat,
  exp2: (a) => exp2Node(a) as TslFloat,
  saturate: (a) => saturateNode(a) as TslFloat,
};

/**
 * One surface's albedo scale, `preservation / (1 - F)`: the engine's own `1 - F` divides out of the diffuse, which
 * leaves Unreal's `1 - E` where the project keeps the term and every bit of the light where it compiles it out.
 * The angles are the engine's own (`VoH` at the half angle, `NoV` at the view), so the pair cancels exactly.
 */
export function diffuseEnergyScale<A>(
  arithmetic: IEnergyArithmetic<A>,
  terms: { roughness: A; noV: A; f0: A; f90: A; dotVH: A },
): A {
  const a = arithmetic;
  // The project's switch, not the shader's default: no `1 - E` where Unreal compiles the term out.
  const preservation = ENERGY_CONSERVATION ? energyPreservation(a, terms) : a.constant(1);
  return a.div(preservation, a.sub(a.constant(1), fresnel(a, terms)));
}

/** The part of a material `setupSpecular` reads: the class flag, and the physical body's two numbers. */
export interface ISpecularSource {
  readonly isMeshPhysicalMaterial?: boolean;
  readonly ior?: number;
  readonly specularIntensity?: number;
  readonly metalness: number;
}

/** The engine's own class test for the physical body: true for three's physical material and its node class. */
function isPhysical(source: ISpecularSource): boolean {
  return source.isMeshPhysicalMaterial === true;
}

/**
 * The F0 and F90 the engine reads for this material, from `setupSpecular`
 * (packages/runtime-native/src/engine/shader/standard.cpp:1354-1372): a standard material carries the fixed 0.04
 * and 1, and a physical one derives F0 from its `ior` and `specularIntensity` and F90 from `specularIntensity` and
 * `metalness`. That is how a diagnosis ablation zeroes the lobe, and the ratio has to divide out that same value:
 * `?specular=0` leaves the engine no loss to cancel. specularColor is white on every physical slot of these scenes (the
 * ablation twin's, `render/specular.ts`), so the scalar product is the material's F0.
 */
export function specularTerms(source: ISpecularSource): { f0: number; f90: number } {
  if (!isPhysical(source)) return { f0: 0.04, f90: 1 };
  const ior = source.ior ?? 1.5;
  const intensity = source.specularIntensity ?? 1;
  return {
    f0: ((ior - 1) / (ior + 1)) ** 2 * intensity,
    f90: intensity + (1 - intensity) * source.metalness,
  };
}

/** `diffuseEnergyScale` for one surface, in world space: the lamp's direction or position, the view and its angles. */
function albedoScale(source: MeshStandardMaterial, light: IDirectLight): TslFloat {
  const a = TSL_ARITHMETIC;
  const terms = specularTerms(source);
  const f0 = a.constant(terms.f0);
  const f90 = a.constant(terms.f90);
  const view = cameraPosition.sub(positionWorld).normalize() as unknown as TslVec3;
  const noV = saturateNode(dot(normalWorld.normalize(), view)) as TslFloat;
  const toLight =
    light.direction !== undefined
      ? (vec3(light.direction.clone()).normalize() as unknown as TslVec3)
      : (vec3((light.position ?? new Vector3()).clone())
          .sub(positionWorld)
          .normalize() as unknown as TslVec3);
  const half = vec3(
    toLight.x.add(view.x),
    toLight.y.add(view.y),
    toLight.z.add(view.z),
  ).normalize();
  const dotVH = saturateNode(dot(view, half)) as TslFloat;
  // The material's roughness is a number, not a map value: the scenes this harness measures carry one per slot.
  return diffuseEnergyScale(a, {
    roughness: a.constant(source.roughness),
    noV,
    f0,
    f90,
    dotVH,
  }) as TslFloat;
}

/**
 * The twin a specular ablation needs, `?specular=0` or `=f0` (`render/specular.ts`): the physical class keeps the
 * ablation's F0 0 and F90, which its `ior` 1 and `specularIntensity` set. The engine picks its F0/F90 body from the
 * material's class (packages/runtime-native/src/engine/shader/standard.cpp:1265-1268, `:1612-1616`), and its standard
 * body is the fixed 0.04 / 1 (`:1354-1372`). The owned engine bridges no `MeshPhysicalNodeMaterial`
 * (packages/three-native/api/catalog.json), so there the ablation would silently read as a lobe that came back: it
 * fails closed by name instead.
 */
export function physicalAblationTwin(
  name: string,
  // `new MeshPhysicalNodeMaterial()`: injectable so the refusal has a test that the engine cannot give it.
  construct: () => MeshStandardNodeMaterial = () =>
    new MeshPhysicalNodeMaterial() as unknown as MeshStandardNodeMaterial,
): MeshStandardNodeMaterial {
  try {
    return construct();
  } catch {
    throw new Error(
      `TN_DIFFUSE_ENERGY_SPECULAR: ${name} is a specular ablation, and this engine bridges no physical node material: the term would turn its lobe back on`,
    );
  }
}

/**
 * The term on one surface: the same material with its albedo scaled by `preservation / (1 - F)` at the scene's one
 * direct light, so the engine's diffuse loses what Unreal's does.
 *
 * The twin keeps its source's class, as the engine picks its material body from the class, so a diagnosis ablation
 * stays an ablation under the term. A mapped surface fails closed: this path carries no `map` (and no map-driven
 * roughness), so a silent pass would change the albedo instead of the loss.
 */
export function energyPreservingTwin(
  source: MeshStandardMaterial,
  light: IDirectLight,
): MeshStandardNodeMaterial {
  // A map-driven roughness would leave the formula's one number per surface: those fail closed.
  if (source.roughnessMap != null || source.metalnessMap != null)
    throw new Error(
      `TN_DIFFUSE_ENERGY_MAP: ${source.name} takes its roughness or metalness from a map`,
    );
  const twin = isPhysical(source)
    ? physicalAblationTwin(source.name)
    : new MeshStandardNodeMaterial();
  copyFields(source, twin as unknown as Record<string, unknown>);
  // The albedo as a node: the material's own colour times its base map, which the twin's `colorNode` replaces (a
  // uniform and a texture, as the ID pass reads them, so the values are the numbers the material holds).
  const colour = vec3(source.color.r, source.color.g, source.color.b);
  const albedo = source.map === null ? colour : colour.mul(texture(source.map).xyz);
  twin.colorNode = vec4(
    albedo.mul(albedoScale(source, light)),
    source.map === null ? 1 : texture(source.map).w,
  );
  twin.needsUpdate = true;
  return twin;
}

/**
 * Puts the term on every surface of `root` and returns how many took it. `three` leaves the materials alone: the
 * BEFORE arm draws the frame three's own term draws.
 */
export function applyDiffuseEnergy(
  root: Object3D,
  light: IDirectLight,
  mode: DiffuseEnergyMode = "unreal",
): number {
  if (mode === "three") return 0;
  let surfaces = 0;
  root.traverse((object) => {
    const mesh = object as unknown as { material?: Material | Material[] };
    const material = mesh.material;
    if (material === undefined) return;
    const twins = [material].flat().map((source) => {
      surfaces += 1;
      return energyPreservingTwin(source as MeshStandardMaterial, light);
    });
    mesh.material = Array.isArray(material) ? twins : twins[0];
  });
  // The capture's record of what drew the frame, beside TN_CALIBRATION_SCENE.
  console.info(
    `TN_CALIBRATION_DIFFUSE_ENERGY ${JSON.stringify({
      term: "unreal",
      surfaces,
      light: light.direction !== undefined ? "directional" : "punctual",
    })}`,
  );
  return surfaces;
}
