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
export type ViewName =
  | "ridge"
  | "mesa"
  | "plain"
  | "horizon-sea"
  | "meadow-close"
  | "overview"
  | "player"
  | "river"
  | "vista";

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
  alpine: {
    focus: { x: 180, z: -190 },
    poses: {
      ridge: { at: [220, -220], eye: 150, look: [-75, 40], lookUp: 0, lookY: 320 },
      overview: { at: [850, -1000], eye: 0, eyeY: 760, look: [-55, 35], lookUp: 0, lookY: 330 },
    },
    views: ["player", "ridge", "overview"],
  },
  desert: {
    focus: { x: 170, z: 180 },
    poses: {
      mesa: { at: [195, 190], eye: 3.2, look: [-35, -30], lookUp: 20 },
      overview: { at: [200, 200], eye: 165, look: [-40, -30], lookUp: 10 },
    },
    views: ["player", "mesa", "overview"],
  },
  tundra: {
    focus: { x: 150, z: 160 },
    poses: {
      plain: { at: [166, 180], eye: 2.2, look: [-65, -50], lookUp: 2 },
      overview: { at: [180, 180], eye: 62, look: [-20, -50], lookUp: 2 },
    },
    views: ["player", "plain", "overview"],
  },
  forest: {
    size: 512,
    focus: { x: 150, z: -100 },
    poses: {
      "meadow-close": { at: [165, -95], eye: 1.7, look: [-70, -180], lookUp: 2.2 },
      overview: { at: [190, 170], eye: 65, look: [-70, 25], lookUp: 5 },
      river: { at: [-145, -120], eye: 1.7, look: [-110, -185], lookUp: 0 },
      // The look goal's frame: from the hillside north-east of the lake, over the lake and the
      // forest to the high backdrop peaks south-west (bearing 210-240 degrees, 0.5-0.7 km tall).
      vista: { at: [360, 200], eye: 0, eyeY: 71, look: [-900, -700], lookUp: 0, lookY: 90 },
    },
    views: ["player", "meadow-close", "overview", "river", "vista"],
  },
  coastal: {
    focus: { x: 80, z: 5 },
    poses: {
      "meadow-close": { at: [110, -35], eye: 1.7, look: [155, 100], lookUp: 1.5 },
      overview: { at: [-140, -120], eye: 75, look: [160, 115], lookUp: 0 },
      "horizon-sea": { at: [185, 145], eye: 6, look: [220, 450], lookUp: 0, lookY: 1.5 },
    },
    views: ["player", "meadow-close", "overview", "horizon-sea"],
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
