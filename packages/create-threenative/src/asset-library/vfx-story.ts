// One `@threenative/core/vfx` effect as a code story (PRD-917): the plugin generates a story module
// per effect that core's capability manifest lists, so the library shows every stock VFX with its
// named overrides as controls. `three` and `@threenative/core` stay the game's own imports.
import { GPUParticles3D } from "@threenative/core";
import { Group, type Object3D } from "three";
import type { IAssetControl, IAssetStory } from "./types.js";

interface IVfxProps extends Record<string, unknown> {
  readonly seed?: number;
  readonly amount?: number;
  readonly color?: string;
  readonly size?: number;
  readonly lifetime?: number;
}

type Layer = ConstructorParameters<typeof GPUParticles3D>[0];
/** A vfx factory: the layers of one effect, or the portal's ring plus its ribbon field. */
type VfxFactory = (
  overrides: Record<string, unknown>,
) => readonly Layer[] | { readonly ring: Layer; readonly ribbons: Object3D };

const CONTROLS: readonly IAssetControl[] = [
  { key: "color", label: "Tint", type: "color", default: "#ffffff" },
  { key: "size", label: "Size ×", type: "range", min: 0.25, max: 4, step: 0.05, default: 1 },
  {
    key: "lifetime",
    label: "Lifetime ×",
    type: "range",
    min: 0.25,
    max: 4,
    step: 0.05,
    default: 1,
  },
  {
    key: "amount",
    label: "Particles per layer (0 = donor)",
    type: "range",
    min: 0,
    max: 2000,
    step: 10,
    default: 0,
  },
  { key: "seed", label: "Seed (0 = stock)", type: "range", min: 0, max: 999, step: 1, default: 0 },
];

/** The story for one effect: every control is the factory's override of the same name. */
export function vfxStory(title: string, factory: VfxFactory): IAssetStory<IVfxProps> {
  return {
    title,
    category: "VFX",
    controls: CONTROLS,
    create(props) {
      const made = factory({
        color: props.color ?? "#ffffff",
        size: Number(props.size ?? 1),
        lifetime: Number(props.lifetime ?? 1),
        ...(Number(props.amount) > 0 ? { amount: Number(props.amount) } : {}),
        ...(Number(props.seed) > 0 ? { seed: Number(props.seed) } : {}),
      });
      const group = new Group();
      group.name = title;
      const portal = "ring" in made ? made : undefined;
      for (const layer of portal ? [portal.ring] : (made as readonly Layer[]))
        group.add(new GPUParticles3D(layer));
      if (portal) group.add(portal.ribbons);
      return group;
    },
  };
}
