/** The skeleton landmarks both the calibrator view and `animation_inspect` name. One list, because
 * a view that offered an anchor the tools do not report is a calibration nobody can bake. */
export type AnchorId = "head" | "hips" | "left-foot" | "left-hand" | "right-foot" | "right-hand";

export interface AnchorInfo {
  readonly id: AnchorId;
  readonly label: string;
  readonly node: string;
  readonly source: "detected" | "estimated";
}

interface AnchorSpec {
  readonly id: AnchorId;
  readonly label: string;
  readonly patterns: readonly RegExp[];
}

/** Matched against a lowercased, alphanumeric-only bone name, so `mixamorig:RightHand_035` and
 * `RightHand` both answer to `righthand`. The order is the order the view renders. */
export const ANCHOR_SPECS: readonly AnchorSpec[] = [
  { id: "right-hand", label: "Right hand", patterns: [/righthand/u, /handright/u, /rhand/u] },
  { id: "left-hand", label: "Left hand", patterns: [/lefthand/u, /handleft/u, /lhand/u] },
  { id: "head", label: "Head", patterns: [/head/u] },
  { id: "hips", label: "Hips / root", patterns: [/hips/u, /pelvis/u, /^root$/u] },
  { id: "right-foot", label: "Right foot", patterns: [/rightfoot/u, /footright/u, /rfoot/u] },
  { id: "left-foot", label: "Left foot", patterns: [/leftfoot/u, /footleft/u, /lfoot/u] },
];

export function normalizedBoneName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

/** The shortest matching name wins: a humanoid rig carries both `mixamorigRightHand` and
 * `mixamorigRightHandThumb1`, and the anchor is the hand, not the thumb. */
export function detectedAnchor(spec: AnchorSpec, names: readonly string[]): string | undefined {
  return names
    .filter((name) => spec.patterns.some((pattern) => pattern.test(normalizedBoneName(name))))
    .sort((left, right) => normalizedBoneName(left).length - normalizedBoneName(right).length)[0];
}

/** Every landmark a rig answers to, in {@link ANCHOR_SPECS} order. Nothing here estimates: an
 * operation that needs a missing landmark reports it rather than inventing a position. */
export function detectedAnchors(names: readonly string[]): AnchorInfo[] {
  return ANCHOR_SPECS.flatMap((spec) => {
    const node = detectedAnchor(spec, names);
    return node === undefined
      ? []
      : [{ id: spec.id, label: spec.label, node, source: "detected" } as const];
  });
}
