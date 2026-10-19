import type { AnimationPlayer } from "@threenative/core";
import { createDirectionWeights, createSpeedWeights } from "./locomotion-weights.js";

/** One authored clip domain. Every threshold, triangle and phase rule is the game's. */
export interface ILocomotionSettings {
  /** Clip name and the ground speed at which it takes over, in the world's own units. */
  readonly speedSamples: readonly { readonly clip: string; readonly speed: number }[];
  /** The directional domain. Absent means this game authored no directional clips at all. */
  readonly direction?: {
    readonly samples: readonly {
      readonly clip: string;
      readonly point: readonly [number, number];
    }[];
    readonly triangles: readonly (readonly [number, number, number])[];
  };
  /** Seconds the weights ramp towards the request. Zero snaps them on the call. */
  readonly transitionSeconds?: number;
  /** False keeps an entering clip on its own authored phase instead of joining the gait. */
  readonly phaseSync?: boolean;
}

/**
 * The whole mannequin, watched from outside: every authored locomotion loop, thresholds in
 * metres per second, and an entering clip joins the gait so a walk to run change never crosses
 * the feet mid-stride.
 */
export const THIRD_PERSON_LOCOMOTION: ILocomotionSettings = {
  speedSamples: [
    { clip: "Idle_Loop", speed: 0 },
    { clip: "Walk_Loop", speed: 1.2 },
    { clip: "Jog_Fwd_Loop", speed: 3.2 },
    { clip: "Sprint_Loop", speed: 5.5 },
  ],
  transitionSeconds: 0.2,
  phaseSync: true,
};

/**
 * The same rig seen from inside the head, with its own authored settings: no sprint loop, lower
 * thresholds, a short transition and no phase sync. These are placeholders for a game to tune, not
 * measured values.
 */
export const FIRST_PERSON_BODY_LOCOMOTION: ILocomotionSettings = {
  speedSamples: [
    { clip: "Idle_Loop", speed: 0 },
    { clip: "Walk_Loop", speed: 0.8 },
    { clip: "Jog_Fwd_Loop", speed: 2.4 },
  ],
  transitionSeconds: 0.08,
  phaseSync: false,
};

/**
 * A real CC0 directional set, on one Rig_Medium skeleton, playing the clips KayKit authored for the
 * direction they actually are. Nothing here is retargeted or relabelled; `x` is right, `y` is
 * forward, and the four triangles fan the diamond around the idle from the four authored axes.
 *
 * `phaseSync` is on because the clips measure that way, not because a phase join sounds right.
 * `vq-locomotion-blend-spaces.spec.ts` samples each real clip's bones and reports the normalized
 * phase at which foot.l is at its forward-most (toe travel, so a marker with no stride behind it
 * cannot pass). Measured: Running_A 0.996; Running_Strafe_Left 0.9998, Walking_Backwards 0.9998 and
 * Walking_A 0.9998 sit 0.004 from it, Running_Strafe_Right 0.9546 sits 0.041 from it, and Idle_A
 * carries 3 mm of toe travel, so it has no stride to join. The largest gap between clips that ever
 * blend is 0.041 of a phase — 33 ms of the 0.8 s run cycle — inside the 0.05 tolerance that test
 * asserts, which is the only reason the gait is allowed to join instead of starting mid-stride.
 *
 * The speed thresholds are placeholders for a game to tune, the way the other two consumers' are.
 */
export const KAYKIT_DIRECTIONAL: ILocomotionSettings = {
  speedSamples: [
    { clip: "Idle_A", speed: 0 },
    { clip: "Walking_A", speed: 1.2 },
    { clip: "Running_A", speed: 3.4 },
  ],
  direction: {
    samples: [
      { clip: "Idle_A", point: [0, 0] },
      { clip: "Running_A", point: [0, 1] },
      { clip: "Running_Strafe_Right", point: [1, 0] },
      { clip: "Walking_Backwards", point: [0, -1] },
      { clip: "Running_Strafe_Left", point: [-1, 0] },
    ],
    triangles: [
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 4],
      [0, 4, 1],
    ],
  },
  transitionSeconds: 0.2,
  phaseSync: true,
};

/**
 * Turn one speed into clip weights and hand them to a player, once per frame.
 *
 * The samples and their thresholds, the transition and the phase rule are the game's settings; the
 * player stays the only mixer, the only updater and the owner of the actions. A direction is read
 * only from a game that authored a directional domain, and asking for one without authoring it
 * throws instead of quietly playing the forward clips as if they were strafes.
 */
export function createLocomotionDriver(settings: ILocomotionSettings, player: AnimationPlayer) {
  const speedWeights = createSpeedWeights(settings.speedSamples);
  const directionWeights =
    settings.direction === undefined
      ? undefined
      : createDirectionWeights(settings.direction.samples, settings.direction.triangles);
  const transition = settings.transitionSeconds ?? 0;
  const phaseSync = settings.phaseSync ?? true;
  return {
    update(speed: number, direction?: readonly [number, number]): void {
      if (direction !== undefined && directionWeights === undefined)
        throw new Error(
          "Locomotion received a direction but this game authored no directional clips to play it.",
        );
      const entries =
        directionWeights === undefined || direction === undefined
          ? speedWeights(speed)
          : directionWeights(direction);
      player.playWeighted(entries, { phaseSync, transition });
    },
  };
}
