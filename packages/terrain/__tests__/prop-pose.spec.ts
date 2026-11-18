import { BoxGeometry } from "three";
/**
 * PRD-892: the prop pose mechanism, out of the forest kit.
 *
 * The kit's own copies of these rules were compared before deletion: the package reproduces the
 * forest's snap, burial, footprint and base-ring order, and the rows that decide *which* assets bury
 * stay in the kit. These cases pin the parts a copied environment can get wrong.
 */
import { describe, expect, it } from "vitest";
import type { IPlacement } from "../src/core/types.js";
import {
  type IPropGroundRules,
  authoredQuaternion,
  preparePose,
  propKey,
  propRatio,
  withAuthoredPose,
} from "../src/starter.js";

const GROUND_RULES: IPropGroundRules = {
  burial: (placement) =>
    ["boulder", "mountain"].includes(placement.asset)
      ? { share: placement.asset === "mountain" ? 0.5 : 1, crag: placement.asset === "mountain" }
      : undefined,
  footprint: () => false,
  baseRing: () => false,
};

function placement(overrides: Partial<IPlacement> = {}): IPlacement {
  return {
    id: "seed:layer:0",
    layer: "layer",
    asset: "boulder",
    position: [0, 0, 0],
    rotation: 0,
    scale: 1,
    normal: [0, 1, 0],
    alignToNormal: false,
    ...overrides,
  };
}

/** A one-metre cube whose lowest point is 0.5 m below its origin. */
function cube(): BoxGeometry {
  return new BoxGeometry(1, 1, 1);
}

const AT_TEN = (): { height: number; offset: number } => ({ height: 10, offset: 0.1 });

describe("the prop pose", () => {
  it("names the model by variant and folds a non-uniform edit into the shape suffix", () => {
    const uniform = placement({ asset: "spruce", scale: 2.5 });
    expect(propKey(uniform, 3)).toBe("spruce:3");
    const stretched = placement({
      asset: "spruce",
      transform: {
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [2, 1, 0.5],
        grounding: true,
      },
    });
    expect(propKey(stretched, 3)).toBe("spruce:3@1,0.5,0.25");
    expect(propRatio("spruce:3@1,0.5,0.25")).toEqual([1, 0.5, 0.25]);
    expect(propRatio("spruce:3")).toEqual([1, 1, 1]);
    expect(() => propRatio("spruce:3@0,1,1")).toThrow(/does not name a usable shape/);
  });

  it("folds an authored pose into one record transform, quaternion included", () => {
    const authored = withAuthoredPose(
      placement({ asset: "spruce", scale: 4, rotation: Math.PI / 2 }),
    );
    expect(authored.transform?.scale).toEqual([4, 4, 4]);
    expect(authored.transform?.position).toEqual([0, 0, 0]);
    expect(authored.transform?.quaternion?.[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(authored.transform?.quaternion?.[3]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(authoredQuaternion(placement())).toEqual([0, 0, 0, 1]);
  });

  it("snaps the lowest posed point onto the ground and applies the authored offset", () => {
    const pose = preparePose(
      cube(),
      null as never,
      placement({ asset: "fern" }),
      undefined,
      AT_TEN,
      GROUND_RULES,
    );
    expect(pose.matrix.elements[13]).toBeCloseTo(10.6, 6);
    expect(pose.clearance).toBeCloseTo(0.1, 6);
    expect(pose.grounding).toBe(true);
  });

  it("keeps the requested height when a transform disables grounding, and still measures clearance", () => {
    const pose = preparePose(
      cube(),
      null as never,
      placement(),
      {
        position: [3, 0, 4],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        grounding: false,
      },
      AT_TEN,
      GROUND_RULES,
    );
    expect(pose.matrix.elements[12]).toBe(3);
    expect(pose.matrix.elements[13]).toBe(0);
    expect(pose.clearance).toBeCloseTo(-10.5, 6);
    expect(pose.grounding).toBe(false);
  });

  it("fails closed by placement id when the ground under a grounded prop is missing", () => {
    const at = () => ({ height: null, offset: 0 });
    expect(() =>
      preparePose(cube(), null as never, placement(), undefined, at, GROUND_RULES),
    ).toThrow(/Missing terrain ground for 'seed:layer:0'/);
  });

  it("sinks a boulder by its own height and a crag by its world-space height", () => {
    const flat = () => ({ height: 0, offset: 0 });
    const boulder = preparePose(
      cube(),
      null as never,
      placement({ asset: "boulder", scale: 2 }),
      undefined,
      flat,
      GROUND_RULES,
    );
    // Lowest point snapped to 0 puts the origin at 1 m; a full 2 m sink lands it 1 m underground.
    expect(boulder.matrix.elements[13]).toBeCloseTo(-1, 6);
    const crag = preparePose(
      cube(),
      null as never,
      placement({ asset: "mountain", scale: 2 }),
      undefined,
      flat,
      GROUND_RULES,
    );
    // Half of the 2 m world-space height sinks from the snapped 1 m to the ground.
    expect(crag.matrix.elements[13]).toBeCloseTo(0, 6);
  });
});
