import type { Color, Material } from "three";
import {
  float,
  materialEmissive,
  normalView,
  positionViewDirection,
  uniform,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";

declare module "three" {
  // biome-ignore lint/style/useNamingConvention: a module augmentation keeps three's own class name.
  interface Material {
    /**
     * The colour a Two Sided Foliage leaf returns from light that reaches its other face (PRD-643). Unreal's
     * `SubsurfaceColor`. Read only where `twoSidedFoliage` is true: a material without it gets no back term
     * and lets no sun through.
     */
    subsurfaceColor?: Color;
    /**
     * Marks a Two Sided Foliage leaf (PRD-651). Declared here too, with the type that soft-shadow.ts gives it, so that a
     * declaration build whose entry reaches this file through `renderer.ts` and not through `soft-shadow.ts` still sees it.
     */
    twoSidedFoliage?: boolean;
  }
}

/**
 * The light a Two Sided Foliage leaf takes through its back face: `subsurfaceColor` times the irradiance
 * (E / pi, the unit of `irradianceNode`) that arrives along the opposite of the normal the viewer sees.
 * Unreal adds the same product to the diffuse indirect light at Epic and Cinematic gather quality
 * (UE 5.8.3: `Engine/Shaders/Private/DiffuseIndirectComposite.usf`, the `SHADINGMODELID_TWOSIDED_FOLIAGE` branch).
 * The game reads its own cache along `normal.negate()` and passes the result; this adds it to the material's
 * `emissiveNode`, which both engines evaluate, so the leaf keeps its colours and the engine owns none of them.
 * @situation add bounce light to the far face of a two sided foliage leaf
 * @constraint the material needs `twoSidedFoliage = true` and a `subsurfaceColor`, or nothing is added and false is returned; backIrradiance is a vec3 node in the unit of `irradianceNode`; call once per material
 * @example addFoliageBackLight(leaf, cache.irradianceAt(positionWorld, normalWorld.negate()));
 */
export function addFoliageBackLight(material: Material, backIrradiance: Node<"vec3">): boolean {
  const colour = material.subsurfaceColor;
  if (material.twoSidedFoliage !== true || colour === undefined) return false;
  const back = vec3(colour.r, colour.g, colour.b).mul(backIrradiance);
  const target = material as { emissiveNode?: Node<"vec3"> | null };
  target.emissiveNode = (target.emissiveNode ?? materialEmissive).add(back);
  return true;
}

/**
 * The light a Two Sided Foliage leaf lets through from behind, per direct light (PRD-643): subsurfaceColor times a
 * wrapped -N.L (wrap 0.5, over (1 + wrap)^2) times a GGX lobe of alpha 0.6 around the light seen through the leaf,
 * times the light's colour with its shadow. No N.L and no 1/pi: Unreal adds it to the diffuse light as it is
 * (UE 5.8.3: `Engine/Shaders/Private/Substrate/SubstrateEvaluation.ush:881-899`, the `SSS_TYPE_TWO_SIDED_WRAP`
 * branch). The owned engine evaluates the same term in its light loop (`runtime-native` `standard.cpp`).
 */
export function foliageTransmission(
  lightDirection: Node<"vec3">,
  lightColor: Node<"vec3">,
  subsurface: Node<"vec3">,
): Node<"vec3"> {
  const wrap = normalView.dot(lightDirection).negate().add(0.5).div(2.25).clamp();
  // D_GGX with alpha^2 = 0.36 at saturate(-V.L), written out: the owned engine binds no D_GGX node, and this
  // module is bundled for both engines.
  const cosine = positionViewDirection.dot(lightDirection).negate().clamp();
  const denominator = float(1).sub(cosine.mul(cosine).mul(0.64));
  const scatter = float(0.36 / Math.PI).div(denominator.mul(denominator));
  return lightColor.mul(wrap.mul(scatter)).mul(subsurface);
}

interface ILightingModelLike {
  direct(
    input: {
      lightDirection: Node<"vec3">;
      lightColor: Node<"vec3">;
      reflectedLight: { directDiffuse: Node<"vec3"> };
    },
    builder: unknown,
  ): void;
}
type LitPrototype = {
  setupLightingModel?: (this: Material, builder: unknown) => ILightingModelLike;
};
const PATCHED = Symbol.for("threenative.foliageTransmission");

/**
 * Gives three's standard and physical node materials the Two Sided Foliage sun transmission, so a material marked
 * `twoSidedFoliage` with a `subsurfaceColor` lets the sun through on the `engine: "threejs"` path as it does on the
 * owned engine. Idempotent; a class without `setupLightingModel` is left alone. Returns how many classes it patched.
 */
export function installFoliageTransmission(classes: Readonly<Record<string, unknown>>): number {
  let patched = 0;
  for (const name of ["MeshStandardNodeMaterial", "MeshPhysicalNodeMaterial"]) {
    const prototype = (
      classes[name] as { prototype?: LitPrototype & { [PATCHED]?: true } } | undefined
    )?.prototype;
    const setup = prototype?.setupLightingModel;
    // Own property only: the physical class inherits the standard one's mark but keeps its own lighting model.
    if (prototype === undefined || typeof setup !== "function" || Object.hasOwn(prototype, PATCHED))
      continue;
    prototype.setupLightingModel = function (this: Material, builder: unknown) {
      const model = setup.call(this, builder);
      if (this.twoSidedFoliage !== true || this.subsurfaceColor === undefined) return model;
      const direct = model.direct.bind(model);
      // The material's own Color object: an edit of its r, g or b reaches the uniform.
      const subsurface = uniform(this.subsurfaceColor) as unknown as Node<"vec3">;
      model.direct = (input, inner) => {
        direct(input, inner);
        input.reflectedLight.directDiffuse.addAssign(
          foliageTransmission(input.lightDirection, input.lightColor, subsurface),
        );
      };
      return model;
    };
    prototype[PATCHED] = true;
    patched++;
  }
  return patched;
}
