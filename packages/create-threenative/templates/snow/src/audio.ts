import { AudioBus } from "@threenative/core";
import type { Audio, Object3D } from "three";
import type { IFootstep } from "./entities/Explorer.js";

/**
 * Boot crunch and a wind bed through one `AudioBus`. Both clips in `assets/` are generated
 * noise — a bandpass sweep for the crunch, filtered brown noise for the wind — so swap either
 * file for a recording without touching this code. Muted means the bus level is zero; the wind
 * keeps looping underneath so unmuting never restarts it mid-gust.
 */
export class SnowAudio {
  readonly bus: AudioBus;
  #crunch: AudioBuffer | undefined;
  #wind: Audio | undefined;
  #muted = true;

  constructor(camera: Object3D, load: (name: string) => Promise<AudioBuffer>) {
    this.bus = new AudioBus({ camera });
    this.bus.setVolume(0);
    void load("crunch.wav")
      .then((buffer) => {
        this.#crunch = buffer;
      })
      .catch(() => undefined);
    void load("wind.wav")
      .then((buffer) => {
        this.#wind = this.bus.play(buffer, { cue: "wind", loop: true, volume: 0 });
      })
      .catch(() => undefined);
  }

  get muted(): boolean {
    return this.#muted;
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.bus.setVolume(muted ? 0 : 1, 0.2);
  }

  footstep(step: IFootstep): void {
    if (this.#muted || this.#crunch === undefined || step.penetration <= 0) return;
    this.bus.play(this.#crunch, {
      cue: "crunch",
      detune: (Math.random() - 0.5) * 400,
      volume: Math.min(1, 0.42 + step.penetration * 2),
    });
  }

  /** The wind bed follows the live wind and swells with the storm. */
  update(wind: number, storm: number): void {
    this.#wind?.setVolume(Math.min(1, 0.12 + storm * 0.55 + wind * 0.01));
  }

  dispose(): void {
    this.bus.dispose();
  }
}
