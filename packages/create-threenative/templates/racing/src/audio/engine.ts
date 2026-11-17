import { AudioBus } from "@threenative/core";
import type { Audio, Object3D } from "three";

/**
 * The race's sound: an engine bed that pitches with the revs, a tyre squeal that opens with the
 * drift angle, and a nitro burst on the button press.
 *
 * Every clip is baked from maths by `tools/make-racing-audio.mjs` — an engine loop has to be
 * tonal and exactly periodic to be pitched live, and a recording of a real engine is neither. The
 * contested part of this file is the **pitch law**: `engineRate` is the single place the needle
 * becomes a frequency, and the playtest asserts it rises with speed.
 *
 * One runtime gap, named rather than papered over. Pitch is a `playbackRate` write, and the native
 * host binds `playbackRate` on an audio source as a *passive* parameter
 * (`runtime-native/src/audio/audio_bindings.cpp` `createPassiveAudioParamJS`): the write lands and
 * nothing moves, so on native the bed plays at rate 1 with the same volume, squeal and burst. That
 * is a degraded engine note, not a silent game, and no part of this file claims otherwise.
 */
export const ENGINE_SOUND = {
  /** The bed's playback rate at a standstill and at the rev limit. */
  idleRate: 0.62,
  redlineRate: 2.05,
  /** The bed's level with the throttle closed, and the extra it gains under a nitro burn. */
  volume: 0.34,
  nitroVolume: 0.62,
  /** The squeal's level at full lock in a slide, and the slip angle that counts as full lock. */
  squealVolume: 0.5,
  squealAngle: 0.55,
  /** The burst's level. */
  burstVolume: 0.85,
  /** Baked by `tools/make-racing-audio.mjs`, logical paths into `assets/`. */
  clips: {
    engine: "engine-loop.wav",
    squeal: "tyre-squeal.wav",
    nitro: "nitro-burst.wav",
  },
} as const;

/** The bed's pitch for one needle reading, 0 to 1: geometric, because pitch is logarithmic. */
export function engineRate(rpm: number): number {
  const reading = Math.min(1, Math.max(0, rpm));
  return ENGINE_SOUND.idleRate * (ENGINE_SOUND.redlineRate / ENGINE_SOUND.idleRate) ** reading;
}

export interface IEngineAudioInput {
  /** Whether the race is running sound at all: a pause or the outcome panel silences the car. */
  readonly running: boolean;
  /** The needle, 0 to 1, from `gauges.ts`. */
  readonly rpm: number;
  /** The rear slip in radians and whether a tyre is sliding this tick. */
  readonly driftAngle: number;
  readonly sliding: boolean;
  readonly nitroActive: boolean;
}

/**
 * The bus a pause intent mutes: one race sounds at a time, so there is one handle to reach.
 *
 * A muted mix rather than a stopped one. `bus.pause()` holds every voice where it stands and
 * `resume()` starts it again, which is right for a menu bed and wrong for an engine: a paused
 * race must not be audible, and the frame loop does not tick while paused, so nothing would
 * unmute a stopped voice from inside the scene.
 */
let sounding: EngineAudio | undefined;

export function setRaceAudioMuted(muted: boolean): void {
  sounding?.bus.setVolume(muted ? 0 : 1, 0.15);
}

/**
 * The car's own sound, over one `AudioBus`.
 *
 * `AudioBus` queues a cue played before the first gesture and starts it on the browser's unlock
 * (`keydown`/`pointerdown`/`touchstart`, installed by the bus itself), so nothing here needs a
 * "click to start" gate of its own.
 */
export class EngineAudio {
  readonly bus: AudioBus;
  /** The rate last written to the bed. 0 until the clip has loaded: a claim needs a sound. */
  rate = 0;
  #engine: Audio | undefined;
  #squeal: Audio | undefined;
  #nitro: AudioBuffer | undefined;
  #nitroWasActive = false;

  constructor(camera: Object3D, load: (name: string) => Promise<AudioBuffer>) {
    this.bus = new AudioBus({ camera });
    sounding = this;
    const start = (name: keyof typeof ENGINE_SOUND.clips, cue: string, volume: number): void => {
      void load(ENGINE_SOUND.clips[name])
        .then((buffer) => {
          if (name === "nitro") {
            this.#nitro = buffer;
            return;
          }
          const voice = this.bus.play(buffer, { cue, loop: true, volume });
          if (name === "engine") this.#engine = voice;
          else this.#squeal = voice;
        })
        .catch((error: unknown) => {
          // Sound is not the race. A missing clip is reported once, by name, and the rest plays.
          console.warn(
            `TN_RACING_AUDIO_MISSING ${name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    };
    start("engine", "engine", ENGINE_SOUND.volume);
    start("squeal", "tyre-squeal", 0);
    start("nitro", "nitro-burst", 0);
  }

  update(input: IEngineAudioInput): void {
    const target = input.running ? engineRate(input.rpm) : ENGINE_SOUND.idleRate * 0.7;
    if (this.#engine !== undefined && Math.abs(target - this.rate) > 0.004) {
      this.#engine.setPlaybackRate(target);
      this.rate = target;
    }
    // Three's own `setVolume` is a 10 ms `setTargetAtTime` ramp on the voice's gain, on every
    // runtime: a step in a sounding loop is a click, and smoothing it twice only makes the swell
    // late. The bed swells under a burn and settles back.
    this.#engine?.setVolume(
      input.running ? ENGINE_SOUND.volume + (input.nitroActive ? ENGINE_SOUND.nitroVolume : 0) : 0,
    );
    const squeal = input.running
      ? Math.min(1, Math.abs(input.driftAngle) / ENGINE_SOUND.squealAngle) *
        ENGINE_SOUND.squealVolume
      : 0;
    this.#squeal?.setVolume(squeal * (input.sliding ? 1 : 0));
    if (input.nitroActive && !this.#nitroWasActive && input.running && this.#nitro !== undefined)
      this.bus.play(this.#nitro, { cue: "nitro-burst", volume: ENGINE_SOUND.burstVolume });
    this.#nitroWasActive = input.nitroActive;
  }

  dispose(): void {
    if (sounding === this) sounding = undefined;
    this.bus.dispose();
  }
}
