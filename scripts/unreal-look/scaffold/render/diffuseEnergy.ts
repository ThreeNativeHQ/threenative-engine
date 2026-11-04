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
// is scaled by (1 - E) / (1 - F). The engine multiplies that albedo by `NdotL * light * (1 - F)` for the scene's
// one direct light, which leaves exactly `NdotL * light * (1 - E)`. It is exact where the frame is the direct
// light alone, layer L1; from L2 the sky and GI diffuse already lose the integrated term through three's own
// `energyLoss`, which a per-material scale cannot be separated from, so later layers keep three's term.
//
// F0 and F90 are the two engines' shared values: F0 = 0.04, `DielectricSpecularToF0(Specular)` = `0.08 x
// Specular` (Engine/Shaders/Private/ShadingCommon.ush:122-125) with Unreal's default Specular 0.5, and F90 = 1
// for a dielectric (`ComputeF90` with the default edge colour, `:170-176`); a standard material carries the same
// 0.04 and 1 (standard.cpp:1367-1371). ?diffuseEnergy=three restores three's term and leaves every material
// untouched, so that arm draws the frame the harness drew before this file existed.
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
import { type MeshStandardMaterial, MeshStandardNodeMaterial } from "three/webgpu";
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
 * `(1 - E) / (1 - F)` for one surface, in world space: the engine's own angles (`VoH` at the half angle, `NoV`
 * at the view), so that the engine's `(1 - F)` and this ratio cancel to Unreal's `(1 - E)`.
 */
function albedoScale(source: MeshStandardMaterial, light: IDirectLight): TslFloat {
  const a = TSL_ARITHMETIC;
  const f0 = a.constant(0.04);
  const f90 = a.constant(1);
  const view = cameraPosition.sub(positionWorld).normalize() as unknown as TslVec3;
  const noV = saturateNode(dot(normalWorld.normalize(), view)) as TslFloat;
  // The material's roughness is a number, not a map value: the scenes this harness measures carry one per slot.
  const preservation = energyPreservation(a, {
    roughness: a.constant(source.roughness),
    noV,
    f0,
    f90,
  });
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
  return preservation.div(fresnel(a, { f0, f90, dotVH }).oneMinus()) as TslFloat;
}

/**
 * The term on one surface: the same material with its albedo scaled by `(1 - E) / (1 - F)` at the scene's one
 * direct light, so the engine's diffuse loses Unreal's `1 - E`. A mapped surface fails closed: this path carries
 * no `map` (and no map-driven roughness), so a silent pass would change the albedo instead of the loss.
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
  const twin = new MeshStandardNodeMaterial();
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
