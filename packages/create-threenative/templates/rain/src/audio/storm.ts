// Generated for you. The storm's sound, as the reference study mixed it.
//
// The study synthesised all of this live: a Web Audio graph of noise buffers and biquads, built on
// the first click. This file plays three clips that `tools/make-storm-audio.mjs` baked from the same
// maths, through the engine's own `AudioBus`. Everything that used to be a node is a constant below,
// next to the line of the study it came from; nothing is re-tuned, and nothing here is a framework
// concept.
//
// What is the source's, exactly:
//   rain hiss    noise → highpass 1800 / lowpass 11000, gain = weather.rain * .20 over .25 s
//   wind bed     pink noise → bandpass 35..350, gain = .02 + weather.wind * .18 * LFO over .4 s
//   thunder      crack + rumble + 9 Hz tremolo, lowpass and gain set by how far it was struck
//
// One seam the source had and this file now asks the engine for: the `DynamicsCompressor` it ran
// in front of the master is declared by name below, on the engine's own `AudioBus`. A second,
// native-only seam is named at `thunderDistance`. What has been exercised is the maths and this
// wiring against the engine's real `AudioBus`, plus a headed WebGPU playtest of the registered
// entity; no native target has run the file.

import { AudioBus, type ICtx } from "@threenative/core";
import type { GameState } from "../state.js";

/** The name this is registered under, so a pause intent can reach it without a captured closure. */
export const STORM_AUDIO_ENTITY = "storm-audio";

/** Baked by `tools/make-storm-audio.mjs`, logical paths into `assets/`. */
const CLIPS = {
  rain: "rain-loop.wav",
  thunder: "thunder.wav",
  wind: "wind-loop.wav",
} as const;

/**
 * `this.master.gain.setTargetAtTime(.42, this.ctx.currentTime, .12)`.
 *
 * The source ran a `DynamicsCompressor` in front of this, to hold the three voices down when they
 * summed; that response to a loud mix is `MASTER_COMPRESSOR` below, asked for on the bus rather
 * than rebuilt out of gains. What this gain cannot do on its own is soften anything: a mix past
 * `MASTER_GAIN` clips, and the compressor ahead of it is what keeps that from happening.
 */
const MASTER_GAIN = 0.42;
const MASTER_FADE = 0.12;
/** `mute()`'s `setTargetAtTime(0, currentTime, .06)`. */
const MUTE_FADE = 0.06;

/**
 * The source's compressor, value by value: `new DynamicsCompressorNode(ctx, {
 * threshold: -15, knee: 30, ratio: 5, attack: .003, release: .25 })`.
 *
 * `AudioBus` takes all five as one option and installs the node where every voice sums, ahead of
 * the master gain — the same place the source had it. A runtime with no dynamics node reports
 * `compressor` in `bus.unsupported` rather than playing on uncompressed and quiet about it.
 */
const MASTER_COMPRESSOR = {
  attack: 0.003,
  knee: 30,
  ratio: 5,
  release: 0.25,
  threshold: -15,
} as const;

/** `weather.rain * .20` — the source overwrote the loop node's own .09 with this every frame. */
const RAIN_GAIN = 0.2;
/** `.02 + weather.wind * .18 * (.78 + .22 * Math.sin(time * .37))`, term by term. */
const WIND_BASE = 0.02;
const WIND_GAIN = 0.18;
const WIND_LFO_RATE = 0.37;
const WIND_LFO_FLOOR = 0.78;
const WIND_LFO_DEPTH = 0.22;
/** The two time constants the source smoothed its own gain nodes with. */
const RAIN_TAU = 0.25;
const WIND_TAU = 0.4;

/**
 * `thunder()`'s distance law: `clamp(4500 - distance * 5, 280, 4500)` and
 * `clamp(1.05 - distance * .0009, .18, .95)`. The low-pass goes to the engine as `lowpassHz`, which
 * is a real `BiquadFilterNode` on the web. The native host binds no `createBiquadFilter`, so it
 * drops the option and the bus names it in `bus.unsupported` — on a phone a near strike is as
 * bright as a far one. That is the one unsupported cue option observed in the installed native
 * audio bindings; `detune` is the other, and this file does not use it.
 */
function thunderDistance(metres: number): { readonly lowpassHz: number; readonly volume: number } {
  return {
    lowpassHz: Math.max(280, Math.min(4500, 4500 - metres * 5)),
    volume: Math.max(0.18, Math.min(0.95, 1.05 - metres * 0.0009)),
  };
}

/** A strike, handed over by the scene at the moment it is struck and not before. */
export interface IStormStrike {
  /** Absolute simulation time the thunder is due, which is what makes it survive a freeze. */
  readonly at: number;
  /** How far away it was struck, for the distance law above. */
  readonly metres: number;
}

export interface IStormAudio {
  /** Queues one strike. Strikes queue: a second one does not overwrite one still crossing the air. */
  queueStrike(strike: IStormStrike): void;
  /** The frame's truth. Call it once per frame, after the simulation has advanced. */
  update(state: GameState): void;
  /**
   * An explicit hold, from the pause intent. Separate from `setHidden` because the two clear
   * independently: the game's own pause outlives the tab it was pressed in.
   */
  setSilenced(silenced: boolean): void;
  /**
   * A visibility hold, from the UI realm or the engine's lifecycle — the one place that knows
   * whether the frame is still on screen. Neither this nor `setSilenced` is a substitute for the
   * other, and the bus is released only when both are clear.
   */
  setHidden(hidden: boolean): void;
  dispose(): void;
  /** What a playtest reads back. */
  debug(): Record<string, unknown>;
}

type LoopVoice = ReturnType<AudioBus["play"]>;

export function createStormAudio(ctx: ICtx<GameState>): IStormAudio {
  const bus = new AudioBus({ camera: ctx.camera, compressor: MASTER_COMPRESSOR });
  const clips: Partial<Record<keyof typeof CLIPS, AudioBuffer>> = {};
  let loops: { readonly rain: LoopVoice; readonly wind: LoopVoice } | undefined;
  /** Struck but not yet crossed the air, oldest first. */
  let pending: IStormStrike[] = [];
  /** Struck and sounding, in play order. */
  const thunder: LoopVoice[] = [];
  let wanted = false;
  let muted = false;
  let silenced = false;
  let hidden = false;
  /** What the bus is actually being told, so neither hold can latch the other. */
  let held = false;
  let master = -1;
  let loadError: string | undefined;
  let unlockError: string | undefined;

  /**
   * `AudioBus.pause` holds each voice where it stands and `resume` gives it back from there, which
   * is the honest reading of a paused simulation. The study suspended the whole `AudioContext`
   * instead; the bus will not, because that would silence every other bus on it.
   *
   * The two holds are kept apart so neither can latch the other: a tab that goes visible again
   * releases the sound, and a pause that was pressed still holds it afterwards.
   */
  function applyHold(): void {
    const hold = silenced || hidden;
    if (hold === held) return;
    held = hold;
    if (hold) bus.pause();
    else bus.resume();
  }

  /** Everything that is sounding but is not a bed, stopped and forgotten. */
  function clearThunder(): void {
    pending = [];
    for (const voice of thunder) bus.stopVoice(voice);
    thunder.length = 0;
  }

  /** The source's own smoothing: `gain.setTargetAtTime(target, t, .25)` for rain, `.4` for wind. */
  function ramp(voice: LoopVoice, target: number, tau: number): void {
    const param = voice.gain.gain;
    if (typeof param.setTargetAtTime === "function")
      param.setTargetAtTime(target, bus.listener.context.currentTime, tau);
    else voice.setVolume(target);
  }

  /** Fires every strike the simulation clock has carried past its own delay, once each. */
  function fireDue(now: number): void {
    // A voice that ran out is back in the bus's pool; a stale handle here is only a wrong count.
    for (let index = thunder.length - 1; index >= 0; index -= 1)
      if (thunder[index]?.isPlaying !== true) thunder.splice(index, 1);
    // A strike queued before its clip landed waits in the queue rather than throwing.
    if (pending.length === 0 || clips.thunder === undefined) return;
    const due = pending.filter((strike) => now >= strike.at);
    if (due.length === 0) return;
    pending = pending.filter((strike) => now < strike.at);
    for (const strike of due)
      thunder.push(
        bus.play(clips.thunder as AudioBuffer, {
          cue: "thunder",
          ...thunderDistance(strike.metres),
        }),
      );
  }

  /** Puts the two beds down. Their gains are written every frame from the eased weather. */
  function startLoops(): void {
    loops = {
      rain: bus.play(clips.rain as AudioBuffer, { cue: "rain-loop", loop: true, volume: 0 }),
      wind: bus.play(clips.wind as AudioBuffer, { cue: "wind-loop", loop: true, volume: 0 }),
    };
  }

  /**
   * The enable edge is the gesture, and the beds wait for it — and for the clips, which arrive
   * after the first frame. Turning sound off has to take the beds down, not just forget that they
   * were asked for: `AudioBus.stop` is the one call that ends every voice, and the strikes in the
   * air go with them rather than piling up on the way back.
   */
  function arm(state: GameState): void {
    if (state.audioEnabled !== wanted) {
      wanted = state.audioEnabled;
      if (wanted) {
        // `AudioBus` also unlocks on the first key or pointer event; doing it here as well is what
        // lets the automation API raise sound with no gesture at all. A refused unlock is
        // reported, never swallowed: a game whose sound silently never starts is worse.
        void bus.unlock().catch((error: unknown) => {
          unlockError = error instanceof Error ? error.message : String(error);
          console.warn(`TN_RAIN_AUDIO_UNLOCK_FAILED ${unlockError}`);
        });
      } else {
        bus.stop();
        loops = undefined;
        clearThunder();
      }
    }
    if (wanted && loops === undefined && clips.rain !== undefined && clips.wind !== undefined)
      startLoops();
  }

  /** The master level and the two bed gains, from the frame's weather. */
  function mix(state: GameState): void {
    muted = state.muted;
    const level = muted ? 0 : MASTER_GAIN;
    if (level !== master) {
      master = level;
      bus.setVolume(level, muted ? MUTE_FADE : MASTER_FADE);
    }
    if (loops === undefined) return;
    ramp(loops.rain, state.weather.rain * RAIN_GAIN, RAIN_TAU);
    ramp(
      loops.wind,
      WIND_BASE +
        state.weather.wind *
          WIND_GAIN *
          (WIND_LFO_FLOOR + WIND_LFO_DEPTH * Math.sin(state.elapsed * WIND_LFO_RATE)),
      WIND_TAU,
    );
  }

  for (const key of Object.keys(CLIPS) as (keyof typeof CLIPS)[]) {
    void ctx.assets
      .audio(CLIPS[key])
      .then((buffer) => {
        clips[key] = buffer;
      })
      .catch((error: unknown) => {
        // Sound is not the storm. A missing clip is reported once and leaves the rest audible.
        loadError = `${key}: ${error instanceof Error ? error.message : String(error)}`;
        console.warn(`TN_RAIN_AUDIO_MISSING ${loadError}`);
      });
  }

  return {
    queueStrike(strike) {
      if (!Number.isFinite(strike.at) || !Number.isFinite(strike.metres) || strike.metres < 0)
        throw new RangeError(
          "a strike needs a finite simulation time and a non-negative distance.",
        );
      pending.push(strike);
    },

    update(state) {
      arm(state);
      mix(state);
      if (loops === undefined) return;
      // Photosensitivity mode is the study's `setSafe`, which also called `clearThunder`.
      if (state.safe) clearThunder();
      else fireDue(state.elapsed);
    },

    setSilenced(next) {
      silenced = next;
      applyHold();
    },

    setHidden(next) {
      hidden = next;
      applyHold();
    },

    dispose() {
      pending = [];
      thunder.length = 0;
      loops = undefined;
      bus.dispose();
    },

    debug() {
      return {
        enabled: wanted,
        muted,
        silenced,
        hidden,
        held: held,
        // The engine's own readings, not a mirror of what this file last asked for.
        master: bus.volume,
        paused: bus.paused,
        compressor: bus.compressor !== undefined,
        loaded: Object.keys(clips).length,
        loadError: loadError ?? "none",
        unlockError: unlockError ?? "none",
        pendingThunder: pending.length,
        thunderVoices: thunder.length,
        voices: bus.voices,
        queued: bus.queued,
        pausedVoices: bus.pausedVoices,
        unsupported: bus.unsupported,
      };
    },
  };
}
