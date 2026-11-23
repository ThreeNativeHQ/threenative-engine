import { PerspectiveCamera, AudioContext as ThreeAudioContext } from "three";
import { describe, expect, it, vi } from "vitest";
import { AudioBus, audioRuntimeSnapshot } from "../src/audio.js";
import { type IGame, defineGame } from "../src/game.js";
import { Scene } from "../src/scene.js";

/**
 * A bus with no graph behind it.
 *
 * `pause()` reads the clock and walks the live voices, and this bus never plays one, so the stub
 * only has to satisfy `AudioListener`'s constructor: one gain node wired to the destination.
 */
function stubAudioContext(): void {
  const gain = {
    connect: () => undefined,
    disconnect: () => undefined,
    gain: { cancelScheduledValues: () => undefined, value: 1 },
  };
  ThreeAudioContext.setContext({
    createGain: () => gain,
    currentTime: 0,
    destination: {},
    resume: async () => undefined,
  } as unknown as globalThis.AudioContext);
}

class Idle extends Scene {
  static override readonly initialState = {};
}

/**
 * `pause()` sets a boot flag and touches the bus registry; neither needs a started loop, so no
 * canvas is stubbed here — the frame loop is not what these cases are about.
 */
function newGame(): IGame {
  return defineGame({ initialState: {}, scenes: { idle: Idle }, start: "idle" });
}

function newBus(): AudioBus {
  return new AudioBus({ camera: new PerspectiveCamera(), gestureTarget: new EventTarget() });
}

describe("IGame.pause audio", () => {
  it("pauses every live audio bus, and resume lifts that pause", () => {
    stubAudioContext();
    const bus = newBus();
    const game = newGame();
    try {
      game.pause();
      expect(bus.paused).toBe(true);
      game.resume();
      expect(bus.paused).toBe(false);
    } finally {
      bus.dispose();
    }
  });

  it("leaves a bus the game paused itself paused, across a double pause", () => {
    stubAudioContext();
    const held = newBus();
    const playing = newBus();
    const game = newGame();
    try {
      held.pause();
      game.pause();
      game.pause();
      game.resume();
      expect(held.paused).toBe(true);
      expect(playing.paused).toBe(false);
    } finally {
      held.dispose();
      playing.dispose();
    }
  });

  it("keeps audio playing on pause({ audio: false }) and says so once", () => {
    stubAudioContext();
    const bus = newBus();
    const game = newGame();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      game.pause({ audio: false });
      game.pause({ audio: false });
      expect(bus.paused).toBe(false);
      const markers = warn.mock.calls.filter((call) =>
        String(call[0]).startsWith("TN_PAUSE_AUDIO_KEPT"),
      );
      expect(markers).toHaveLength(1);
      // A game that opted out of the audio pause has nothing for resume to lift.
      game.resume();
      expect(bus.paused).toBe(false);
    } finally {
      warn.mockRestore();
      bus.dispose();
    }
  });

  it("reports the mix silenced only when every live bus is paused", () => {
    stubAudioContext();
    const game = newGame();
    // An empty registry is not a silenced mix: nothing was paused, nothing was measured.
    expect(audioRuntimeSnapshot().silent).toBe(false);
    const one = newBus();
    const two = newBus();
    try {
      expect(audioRuntimeSnapshot().silent).toBe(false);
      game.pause();
      expect(audioRuntimeSnapshot().silent).toBe(true);
      // A bus built during the pause is not silence the pause can claim.
      const late = newBus();
      try {
        expect(audioRuntimeSnapshot().silent).toBe(false);
      } finally {
        late.dispose();
      }
      game.resume();
      expect(audioRuntimeSnapshot().silent).toBe(false);
    } finally {
      one.dispose();
      two.dispose();
    }
  });

  it("resumes audio on the teardown that clears the pause flag", () => {
    stubAudioContext();
    const bus = newBus();
    const game = newGame();
    try {
      game.pause();
      expect(bus.paused).toBe(true);
      game.stop();
      expect(bus.paused).toBe(false);
    } finally {
      bus.dispose();
    }
  });
});
