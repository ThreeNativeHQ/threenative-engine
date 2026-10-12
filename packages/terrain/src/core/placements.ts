import type { IPlacementOverride, ITerrainState } from "./types.js";
import { finiteTree } from "./validation.js";

/**
 * Validate and clone stable-key placement transforms before saving or previewing them.
 * @requires npm i -D @threenative/terrain
 * @situation validate finite positive manual prop transforms before a terrain authoring transaction
 * @constraint grounding defaults on only when omitted; position and scale have three components and quaternion is unit length
 * @example const transforms = validatePlacementOverrides(document.placementOverrides);
 * @override grounding=false preserves authored Y and keeps clearance observable
 */
export function validatePlacementOverrides(
  value: unknown = {},
): Record<string, IPlacementOverride> {
  finiteTree(value, "placementOverrides");
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Expected placementOverrides object");
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (!key.length || key.length > 256)
        throw new Error("Placement key must contain 1–256 characters");
      if (
        !entry ||
        typeof entry !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(entry))
      )
        throw new Error(`Invalid placement override '${key}'`);
      const input = entry as Record<string, unknown>;
      if (
        Object.keys(input).some(
          (field) => !["position", "quaternion", "scale", "grounding"].includes(field),
        )
      )
        throw new Error(`Unknown placement override fields '${key}'`);
      function vector(field: string, length: number): number[] {
        const values = input[field];
        if (
          !Array.isArray(values) ||
          values.length !== length ||
          !Array.from(values).every(Number.isFinite)
        )
          throw new Error(`${key}.${field} must contain ${length} finite numbers`);
        return Array.from(values);
      }
      const position = vector("position", 3) as IPlacementOverride["position"];
      const quaternion = vector("quaternion", 4) as IPlacementOverride["quaternion"];
      const scale = vector("scale", 3) as IPlacementOverride["scale"];
      if (scale.some((item) => item <= 0)) throw new Error(`${key}.scale must be positive`);
      if (Math.abs(Math.hypot(...quaternion) - 1) > 1e-6)
        throw new Error(`${key}.quaternion must be a unit quaternion`);
      const grounding = input.grounding === undefined ? true : input.grounding;
      if (typeof grounding !== "boolean") throw new Error(`${key}.grounding must be boolean`);
      return [key, { position, quaternion, scale, grounding }];
    }),
  );
}

/**
 * Attach manual transforms to raw evaluated candidates and report orphan keys.
 * @requires npm i -D @threenative/terrain
 * @situation retain manual prop transforms across terrain scatter re-evaluation
 * @constraint headless authoring; game applies transforms against its model bounds and actual terrain surface
 * @example const state = applyPlacementOverrides(terrain.evaluate(), document.placementOverrides ?? {});
 * @override transform.grounding=false preserves requested Y while the game still measures clearance
 */
export function applyPlacementOverrides(state: ITerrainState, value: unknown): ITerrainState {
  const overrides = validatePlacementOverrides(value);
  const keys = new Set(state.instances.map((item) => item.id));
  return {
    ...state,
    instances: state.instances.map((item) => {
      const { transform: _, ...base } = item;
      return Object.hasOwn(overrides, item.id)
        ? { ...base, transform: overrides[item.id] as IPlacementOverride }
        : base;
    }),
    diagnostics: [
      ...state.diagnostics.filter(
        (message) => !message.startsWith("Unmatched placement override '"),
      ),
      ...Object.keys(overrides)
        .filter((key) => !keys.has(key))
        .map((key) => `Unmatched placement override '${key}'`),
    ],
  };
}
