/**
 * What a scene entry checks, in one ordered list.
 *
 * Every audit a scene entry runs used to be welded into `Game.#enterScene` — the opacity
 * convention, the render trap audit, the unlit foliage warning — so a fourth one meant editing the
 * lifecycle file that every other feature already edits. A kit or a game can add its own here, and
 * the order the list states is the order the warnings appear in.
 *
 * Nothing here decides how anything looks: each inspector reads the scene the game just entered and
 * returns what a reader should be told about it.
 */
import type { Object3D } from "three";
import { applyOpacityConvention } from "./profiling/opacity-convention.js";
import { renderTrapAudit } from "./profiling/render-trap-audit.js";
import {
  UNLIT_FOLIAGE_FIX,
  formatUnlitFoliageWarning,
  unlitFoliageWarning,
} from "./profiling/unlit-foliage-warning.js";

/** One line a scene entry reports, and the console level it belongs at. */
export interface ISceneEntryFinding {
  readonly level: "error" | "warn";
  readonly line: string;
}

/** A check that runs once per scene entry, after the game's `enter()` has built the scene. */
export type SceneEntryInspector = (scene: Object3D) => readonly ISceneEntryFinding[];

/**
 * The engine's own inspectors, in the order their findings must appear.
 *
 * The opacity convention runs first: it makes an author's opacity take effect, and the render trap
 * audit then reports what that effect is — the other order reports the state before the convention.
 */
export const SCENE_ENTRY_INSPECTORS: readonly SceneEntryInspector[] = [
  (scene) => {
    const line = applyOpacityConvention(scene);
    return line === undefined ? [] : [{ level: "warn", line }];
  },
  (scene) => renderTrapAudit(scene).map((line) => ({ level: "error", line })),
  (scene) => {
    const warning = unlitFoliageWarning(scene);
    return warning === undefined
      ? []
      : [{ level: "warn", line: `${formatUnlitFoliageWarning(warning)} ${UNLIT_FOLIAGE_FIX}` }];
  },
];

/** Runs every inspector against a scene the game has just entered, reporting each finding once. */
export function inspectSceneEntry(
  scene: Object3D,
  inspectors: readonly SceneEntryInspector[] = SCENE_ENTRY_INSPECTORS,
): void {
  for (const inspector of inspectors) {
    for (const finding of inspector(scene)) {
      if (finding.level === "error") console.error(finding.line);
      else console.warn(finding.line);
    }
  }
}
