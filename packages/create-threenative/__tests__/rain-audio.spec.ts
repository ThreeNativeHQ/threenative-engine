import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { audioPass } from "@threenative/assets";
import { AudioContext, Object3D } from "three";
import { describe, expect, it } from "vitest";
import {
  type IStormAudio,
  STORM_AUDIO_ENTITY,
  createStormAudio,
} from "../templates/rain/src/audio/storm.js";
import type { GameState } from "../templates/rain/src/state.js";
import config from "../templates/rain/threenative.config.js";

/**
 * The storm's sound, as generated source, against the engine's real `AudioBus`.
 *
 * This imports `src/audio/storm.ts` itself rather than restating its maths: the helper is the
 * deliverable, and a copy of it would keep passing after the file it was copied from broke. The
 * fake `AudioContext` is the narrow surface `packages/core/__tests__/audio.spec.ts` builds — the
 * one the native host binds — so a wiring that needs a browser-only node fails here.
 *
 * The second half cooks the template's own clips through the shared audio pass with the config's
 * declarations, because the authored amplitudes are what the sound is: a peak above 1.0 and
 * Float32 samples are choices this storm made, and a pipeline that quietly normalised or
 * transcoded them would be as wrong as a mistuned constant.
 */

interface IFakeParam {
  value: number;
  cancelScheduledValues(): void;
  setValueAtTime(value: number): void;
  linearRampToValueAtTime(value: number): void;
  setTargetAtTime(value: number, at: number, tau: number): void;
}

/** Every `setTargetAtTime` a param was asked for, as `[value, timeConstant]`. */
let ramps: Array<[number, number]> = [];

function param(value: number, scheduling = false): IFakeParam {
  const fake: IFakeParam = {
    value,
    cancelScheduledValues() {},
    setValueAtTime(next) {
      this.value = next;
    },
    linearRampToValueAtTime(next) {
      this.value = next;
    },
    setTargetAtTime(next, _at, tau) {
      ramps.push([next, tau]);
      this.value = next;
    },
  };
  // The native host binds no cancellable params; a browser has them. The default here is native,
  // which is the surface a claim about the game has to survive.
  if (scheduling) fake.cancelScheduledValues = () => undefined;
  return fake;
}

const TEMPLATE = path.resolve(fileURLToPath(import.meta.url), "../../templates/rain");

function fakeContext(): globalThis.AudioContext {
  const context = {
    createBufferSource: () => ({
      connect: () => undefined,
      detune: param(0),
      disconnect: () => undefined,
      loop: false,
      loopEnd: 0,
      loopStart: 0,
      onended: null as (() => void) | null,
      playbackRate: param(1),
      start: () => undefined,
      stop: () => undefined,
    }),
    createDynamicsCompressor: () => ({
      attack: param(0.003),
      connect: () => undefined,
      disconnect: () => undefined,
      knee: param(30),
      ratio: param(12),
      release: param(0.25),
      threshold: param(-24),
    }),
    createGain: () => ({ connect: () => undefined, disconnect: () => undefined, gain: param(1) }),
    createBiquadFilter: () => ({
      connect: () => undefined,
      disconnect: () => undefined,
      frequency: param(350),
      type: "lowpass" as const,
    }),
    createPanner: () => ({ connect: () => undefined, disconnect: () => undefined }),
    currentTime: 0,
    destination: {},
    resume: async () => undefined,
  } as unknown as globalThis.AudioContext;
  AudioContext.setContext(context);
  return context;
}

const clip = { duration: 1 } as AudioBuffer;

function state(over: Partial<GameState> = {}): GameState {
  return {
    audioEnabled: true,
    elapsed: 0,
    muted: false,
    safe: false,
    weather: { cloud: 1, exposure: 1, fog: 1, rain: 1, wet: 1, wind: 1 },
    ...over,
  } as GameState;
}

/** Clips resolve a microtask after the first frame, and `unlock` is async. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function armed(over: Partial<GameState> = {}): Promise<IStormAudio> {
  fakeContext();
  ramps = [];
  const storm = createStormAudio({
    assets: { audio: async () => clip },
    camera: new Object3D(),
  } as unknown as Parameters<typeof createStormAudio>[0]);
  await settle();
  storm.update(state(over));
  await settle();
  return storm;
}

const debug = (storm: IStormAudio): Record<string, number | boolean | string | string[]> =>
  storm.debug() as Record<string, number | boolean | string | string[]>;

describe("the storm audio entity", () => {
  it("should start the two beds on the enable edge, through a compressor", async () => {
    const storm = await armed();
    const reading = debug(storm);

    expect(reading.enabled).toBe(true);
    expect(reading.voices).toBe(2);
    // The source's `DynamicsCompressor`, asked for by name and not stood in for with gains.
    expect(reading.compressor).toBe(true);
    expect(reading.unsupported).toEqual([]);
    expect(reading.loadError).toBe("none");
    expect(reading.unlockError).toBe("none");
    storm.dispose();
  });

  it("should register under the name the game reaches it by", () => {
    expect(STORM_AUDIO_ENTITY).toBe("storm-audio");
  });

  it("should hold on pause and on visibility independently, releasing only when both clear", async () => {
    const storm = await armed();

    storm.setHidden(true);
    expect(debug(storm).paused).toBe(true);
    expect(debug(storm).pausedVoices).toBe(2);

    storm.setHidden(false);
    expect(debug(storm).paused).toBe(false);

    // A tab that comes back must not resume a paused storm.
    storm.setHidden(true);
    storm.setSilenced(true);
    storm.setHidden(false);
    expect(debug(storm).paused).toBe(true);

    storm.setSilenced(false);
    expect(debug(storm).paused).toBe(false);
    storm.dispose();
  });

  it("should take the beds down when audio is turned off, and bring them back when it returns", async () => {
    const storm = await armed();

    storm.update(state({ audioEnabled: false }));
    expect(debug(storm).voices).toBe(0);
    expect(debug(storm).queued).toBe(0);

    storm.update(state({ audioEnabled: true }));
    await settle();
    expect(debug(storm).voices).toBe(2);
    storm.dispose();
  });

  it("should queue each strike for its own delay and fire it exactly once", async () => {
    const storm = await armed();
    const delay = (metres: number): number => metres / 343;

    storm.queueStrike({ at: 10 + delay(3430), metres: 3430 });
    storm.queueStrike({ at: 10 + delay(100), metres: 100 });

    storm.update(state({ elapsed: 10 }));
    expect(debug(storm).pendingThunder).toBe(2);
    expect(debug(storm).thunderVoices).toBe(0);

    // The nearer strike lands first: queueing is not last-write-wins.
    storm.update(state({ elapsed: 10 + delay(100) }));
    expect(debug(storm).pendingThunder).toBe(1);
    expect(debug(storm).thunderVoices).toBe(1);

    storm.update(state({ elapsed: 10 + delay(100) }));
    expect(debug(storm).thunderVoices).toBe(1);

    storm.update(state({ elapsed: 10 + delay(3430) }));
    expect(debug(storm).pendingThunder).toBe(0);
    expect(debug(storm).thunderVoices).toBe(2);
    storm.dispose();
  });

  it("should suppress thunder while lightning is gated, without leaving it queued", async () => {
    const storm = await armed();
    storm.queueStrike({ at: 5, metres: 400 });

    storm.update(state({ elapsed: 6, safe: true }));
    expect(debug(storm).pendingThunder).toBe(0);
    expect(debug(storm).thunderVoices).toBe(0);

    // Safe is a hold on the one strike, not a switch: lifting it lets the next one through.
    storm.queueStrike({ at: 7, metres: 400 });
    storm.update(state({ elapsed: 8, safe: false }));
    expect(debug(storm).thunderVoices).toBe(1);
    storm.dispose();
  });

  it("should ramp the bed gains with the source's own time constants", async () => {
    const storm = await armed();
    ramps = [];

    storm.update(
      state({ weather: { cloud: 1, exposure: 1, fog: 1, rain: 0.5, wet: 1, wind: 0.5 } }),
    );
    expect([...new Set(ramps.map(([, tau]) => tau))].sort()).toEqual([0.25, 0.4]);
    storm.dispose();
  });

  it("should refuse a strike with no finite time or distance", async () => {
    const storm = await armed();

    expect(() => storm.queueStrike({ at: Number.NaN, metres: 1 })).toThrow(RangeError);
    expect(() => storm.queueStrike({ at: 1, metres: -1 })).toThrow(RangeError);
    storm.dispose();
  });

  it("should report a missing clip rather than failing silently", async () => {
    fakeContext();
    const storm = createStormAudio({
      assets: { audio: async () => Promise.reject(new Error("no such clip")) },
      camera: new Object3D(),
    } as unknown as Parameters<typeof createStormAudio>[0]);
    await settle();
    storm.update(state());

    expect(String(debug(storm).loadError)).toContain("no such clip");
    // Sound is not the storm: the weather still runs and the beds come up empty rather than throw.
    expect(debug(storm).enabled).toBe(true);
    storm.dispose();
  });

  it("should silence every voice when the game disposes it", async () => {
    const storm = await armed();
    storm.dispose();

    expect(debug(storm).voices).toBe(0);
  });
});

interface IAuthoredWav {
  readonly channels: number;
  readonly frames: number;
  readonly peak: number;
  readonly sampleRate: number;
}

/** A Float32 WAV as authored, read by hand so the check needs no encoder to agree with itself. */
function authoredWav(bytes: Buffer): IAuthoredWav {
  expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(bytes.readUInt16LE(20)).toBe(3);
  const channels = bytes.readUInt16LE(22);
  const frames = (bytes.length - 44) / (channels * 4);
  let peak = 0;
  for (let frame = 0; frame < frames; frame += 1)
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.abs(bytes.readFloatLE(44 + (frame * channels + channel) * 4));
      if (value > peak) peak = value;
    }
  return { channels, frames, peak, sampleRate: bytes.readUInt32LE(24) };
}

describe("the storm clips through the shared audio pass", () => {
  const overrides = config.assets?.audio === "none" ? [] : (config.assets?.audio?.overrides ?? []);

  it("should declare every clip unconditioned, so the authored bytes ship", () => {
    expect(overrides.map((override) => override.glob).sort()).toEqual([
      "rain-loop.wav",
      "thunder.wav",
      "wind-loop.wav",
    ]);
    for (const override of overrides) expect(override.conditioning).toBe("none");
    // The two beds are declared loops, so their seam is still measured and still asserted.
    expect(overrides.filter((override) => override.loop === true)).toHaveLength(2);
  });

  it("should ship each clip byte for byte, Float32 samples and peak intact", async () => {
    const pass = audioPass({ overrides });

    for (const name of ["rain-loop.wav", "thunder.wav", "wind-loop.wav"]) {
      const input = await readFile(path.join(TEMPLATE, "assets", name));
      const authored = authoredWav(input);
      const output = await pass.apply(input, name);

      expect(Buffer.isBuffer(output)).toBe(false);
      const cooked = output as { buffer: Buffer; entry?: { audio?: Record<string, unknown> } };
      expect(cooked.buffer.equals(input)).toBe(true);
      expect(cooked.entry?.audio).toMatchObject({
        conditioned: false,
        container: "RIFF/WAVE",
        reencoded: false,
      });
      // Measured on the shipped bytes, so this is the amplitude the player gets rather than the
      // one the source file was written with.
      const shipped = authoredWav(cooked.buffer);
      expect(shipped).toEqual(authored);
    }
  });
});
