/**
 * three/addons/tsl/display's GTAO, Denoise, SMAA and Bloom as the engine's live effects, for both
 * back ends (PRD-540; moved from the V8 player's core-addons.mjs). Each returns the effect's node; its
 * scalar uniforms read and write the native effect (`ao(...).radius.value`) through the node's
 * `__effect(name[, value])`, which the back end routes to tslEffectParameter.
 */

interface IEffectNode {
  __effect(name: string, value?: number): number;
  getTextureNode?: () => IEffectNode;
}

type Effect = (...args: unknown[]) => IEffectNode;

/** The back end's TSL functions the effects are built by (the shared table's "ao", "bloom", ...). */
export interface IEffectTsl {
  readonly ao: Effect;
  readonly denoise: Effect;
  readonly smaa: Effect;
  readonly bloom: Effect;
}

function uniforms(node: IEffectNode, names: readonly string[]): IEffectNode {
  for (const name of names)
    Object.defineProperty(node, name, {
      configurable: true,
      value: Object.freeze({
        get value() {
          return node.__effect(name);
        },
        set value(value: number) {
          node.__effect(name, value);
        },
      }),
    });
  return node;
}

export function definePostEffects(tsl: IEffectTsl) {
  return {
    ao(depthNode: unknown, normalNode: unknown, camera: unknown): IEffectNode {
      const node = uniforms(tsl.ao(depthNode, normalNode ?? null, camera), [
        "radius",
        "thickness",
        "distanceExponent",
        "distanceFallOff",
        "scale",
        "samples",
      ]);
      Object.defineProperty(node, "resolutionScale", {
        configurable: true,
        get() {
          return node.__effect("resolutionScale");
        },
        set(value: number) {
          node.__effect("resolutionScale", value);
        },
      });
      node.getTextureNode = () => node;
      return node;
    },
    denoise: (
      node: unknown,
      depthNode: unknown,
      normalNode: unknown,
      camera: unknown,
    ): IEffectNode =>
      uniforms(tsl.denoise(node, depthNode, normalNode ?? null, camera), [
        "lumaPhi",
        "depthPhi",
        "normalPhi",
        "radius",
        "index",
      ]),
    smaa: (node: unknown): IEffectNode => tsl.smaa(node),
    bloom: (node: unknown, strength?: number, radius?: number, threshold?: number): IEffectNode =>
      uniforms(tsl.bloom(node, strength, radius, threshold), [
        "strength",
        "radius",
        "threshold",
        "smoothWidth",
      ]),
  };
}
