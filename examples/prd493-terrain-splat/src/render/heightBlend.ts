/**
 * The curve that decides how a terrain layer's mask weight meets its own height map. The package
 * mixes colour, normal and ORM by whatever this returns, and owns no constant of it.
 *
 * Unreal's height blend: the painted weight w becomes `saturate((2w - 1) + h * k)`, h being the
 * layer's own height in 0..1. At w = 0.5 the layer's weight is its height, so it holds the crests
 * of its relief first and the grout last. At w = 1 it covers fully and at w = 0 it never shows,
 * for any k up to 1.
 */
import type { ILoadTerrainSplatOptions } from "@threenative/core/world";
import { saturate } from "three/tsl";

/** How far a layer's own relief pushes its edge. Above 1 a weight of 0 can show the highest crests. */
export const HEIGHT_BLEND_STRENGTH = 1;

export const heightBlend: NonNullable<ILoadTerrainSplatOptions["layerWeight"]> = (
  weight,
  { height },
) =>
  height === undefined
    ? weight
    : saturate(weight.mul(2).sub(1).add(height.mul(HEIGHT_BLEND_STRENGTH)));
