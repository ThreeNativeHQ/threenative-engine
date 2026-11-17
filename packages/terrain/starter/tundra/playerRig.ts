import type { Heightfield } from "@threenative/core/world";
import {
  type IMannequin,
  type IPlayerRig,
  type PlayerWallProbe,
  createPlayerRig as createRig,
} from "@threenative/terrain/starter";
import { type AnimationClip, Vector3 } from "three";
import { CAMERA_RIG, type WallProbe, createOrbitCamera } from "./render/orbitCamera.js";
import { SIGHT_RADIUS, sightLine } from "./render/props/pack.js";
import type { TerrainCtx } from "./sceneState.js";

export type { IMannequin, IPlayerRig };
export type { WallProbe };

/** The starter kit's mannequin (Quaternius Universal Animation Library, CC0) and its clips. */
const CLIPS = {
  idle: "Idle_Loop",
  walk: "Walk_Loop",
  run: "Jog_Fwd_Loop",
  fall: "Jump_Loop",
  swim: "Swim_Fwd_Loop",
  tread: "Swim_Idle_Loop",
} as const;
/** Ground speeds in m/s: the walk clip's pace, the jog, and the Shift sprint. */
const STRIDE = 1.8;
const JOG = 6;
const SPRINT = 9;

export interface IPlayerRigOptions {
  readonly world: string;
  /** The player's launch point, in world metres. */
  readonly at: readonly [number, number];
  /** Where the launch camera stands relative to the player: above the ground under the spawn. */
  readonly cameraOffset: readonly [number, number, number];
  /** The ground the spawn stands on: the launch pose is measured from it, not guessed. */
  readonly field: Heightfield;
  readonly mannequin: IMannequin;
  /** The rig's two swim clips, which the mannequin's own clips do not carry. */
  readonly swimClips: readonly AnimationClip[];
  /** A staged world streams its own ground, so the player walks only while the player view draws. */
  readonly staged: boolean;
  /** A vista look frames the player from a fixed aim instead of the orbit camera. */
  readonly vista: boolean;
  /** Centres the sun's shadow pages, or clears them when no player framing draws. */
  readonly focusShadows: (at: Vector3 | undefined) => void;
  /** The horizon seam the scene draws under the player, for the scene picker's report. */
  readonly horizon: () => unknown;
}

/**
 * The player: the package's capsule and clip state machine, this kit's mannequin, gait data and
 * orbit camera. The follow camera and the wall probe stay here because the arm's framing and the
 * sight line are look decisions of this game.
 */
export function createPlayerRig(ctx: TerrainCtx, options: IPlayerRigOptions): IPlayerRig {
  const { at, cameraOffset, field, focusShadows, horizon, mannequin, staged, swimClips, vista } =
    options;
  // The terrain and the prop colliders are the camera's walls; both answer on the kit's ground lens.
  const along = new Vector3();
  const probe: WallProbe = (from, to) =>
    along.subVectors(to, from).lengthSq() < 1e-8
      ? undefined
      : ctx.physics.directSpaceState.intersectRay({
          ...(staged ? {} : { collisionMask: 4 }),
          from,
          to,
        })?.distance;
  const camera = createOrbitCamera(ctx.camera);
  return createRig({
    ctx,
    at,
    field,
    mannequin,
    clips: CLIPS,
    swimClips,
    cameraOffset,
    collisionMask: staged ? undefined : 4,
    gait: { stride: STRIDE, run: JOG, sprint: SPRINT },
    camera,
    probe: probe as PlayerWallProbe,
    following: () => !vista && ctx.state.getState().view === "player",
    aimHeight: CAMERA_RIG.aimHeight,
    // The vision line the camera aims: the player's own eye line at the prop pack's sight radius.
    sight: { aim: sightLine.aim, radius: sightLine.radius, radiusValue: SIGHT_RADIUS },
    focusShadows,
    horizon,
  });
}
