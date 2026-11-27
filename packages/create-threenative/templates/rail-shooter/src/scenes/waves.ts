import { Vector3 } from "three";
import { Enemy } from "../entities/Enemy.js";
import type { IWave } from "../level.js";
import type { IRailFrame, Rail } from "../rail.js";

/** The enemies of one wave: the same spline for each, a gap apart, every other one mirrored if the wave splits. */
export function createWave(spec: IWave, index: number, rail: Rail, scratch: IRailFrame): Enemy[] {
  return Array.from({ length: spec.count }, (_, slot) => {
    const side = spec.mirror === true && slot % 2 === 1 ? -1 : 1;
    const path = spec.path.map(([distance, x, y]) =>
      rail.worldAt(spec.trigger + distance, x * side, y, new Vector3(), scratch),
    );
    return new Enemy({
      id: `w${index + 1}.${slot + 1}`,
      kind: spec.kind,
      path,
      delay: slot * spec.gap,
    });
  });
}
