import type { WorldName } from "./biomes.js";

/**
 * The fixed benchmark framings, in world metres, per world.
 *
 * Fixed rather than relative to the player so a capture at seed 73 is the same picture on every
 * machine, and so the rubric's "close ground/vegetation view" and "landscape overview" are two
 * numbers rather than two moods. `eye` is the height above the terrain under the camera, which is
 * what makes "eye height ~1.7 m" true on a slope instead of true only on a flat.
 *
 * The meadow focus is where the ground is grass with spruces on it and a slope to look along, and
 * it is also where the dense grass goes: ground cover is placed around this point, not around the
 * origin, because a meadow is a place rather than a texture.
 */

/** Every framing the `V` key can hold, whether or not the current world has one for it. */
export type ViewName = "meadow-close" | "overview" | "player" | "river" | "vista";

interface IBenchmarkPose {
  /** World x and z of the eye, and the height above the terrain under it. */
  readonly at: readonly [number, number];
  readonly eye: number;
  /** Absolute elevation for an overview over surveyed scenery beyond the playable collider. */
  readonly eyeY?: number;
  /** World x and z to look at, and the height above the terrain under *that*. */
  readonly look: readonly [number, number];
  readonly lookUp: number;
  /**
   * An absolute world height to look at instead, for a target with no ground under it: a sea
   * horizon is a direction, and thirty metres below the surface three hundred metres out is how a
   * hillside tips its view down far enough for the water to be a band rather than a line.
   */
  readonly lookY?: number;
}

interface IBenchmark {
  /**
   * The playable square the poses frame, in metres. A cooked world of another size
   * (`STRATA_WORLD`, "a huge spruce forest") scales them, so the vista still stands past its edge.
   */
  readonly size?: number;
  /** Where this world's ground cover is placed. */
  readonly focus: { readonly x: number; readonly z: number };
  readonly poses: Readonly<Record<string, IBenchmarkPose>>;
  /** The order the `V` key walks, and the framings the playtest screenshots. */
  readonly views: readonly ViewName[];
}

export const BENCHMARK: Record<WorldName, IBenchmark> = {
  desert: {
    size: 512,
    focus: { x: 120, z: 110 },
    poses: {
      // On the sand flat south-east of Setting Hen Butte, looking at its east face across the scrub.
      "meadow-close": { at: [110, 95], eye: 1.7, look: [20, -10], lookUp: 6 },
      overview: { at: [215, 205], eye: 70, look: [-20, -30], lookUp: 5 },
      // Down in the dry wash south-east of the square, looking back up it to the butte.
      river: { at: [215, 215], eye: 1.7, look: [30, -30], lookUp: 8 },
      // From the butte's shoulder east over the valley floor to the surveyed buttes and Cedar Mesa's
      // rim 2-2.5 km off: the frame that shows the far ring and its join with the square.
      vista: { at: [30, -20], eye: 0, eyeY: 110, look: [2200, 300], lookUp: 0, lookY: 70 },
    },
    views: ["player", "meadow-close", "overview", "river", "vista"],
  },
};

/** A world's poses for a square of `size` metres: x and z scale with it, heights do not. */
export function posesFor(world: WorldName, size: number): Readonly<Record<string, IBenchmarkPose>> {
  const { poses, size: framed } = BENCHMARK[world];
  const k = framed === undefined ? 1 : size / framed;
  if (k === 1) return poses;
  const scaled = ([x, z]: readonly [number, number]) => [x * k, z * k] as const;
  return Object.fromEntries(
    Object.entries(poses).map(([name, pose]) => [
      name,
      { ...pose, at: scaled(pose.at), look: scaled(pose.look) },
    ]),
  );
}
