import { AudioContext, Object3D, PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  AudioBus,
  type IAudioCompressorOptions,
  audioRuntimeSnapshot,
  resetAudioCueLedger,
} from "../src/audio.js";

interface IFakeAudioParam {
  value: number;
  linearRampToValueAtTime(value: number): void;
  setTargetAtTime(value: number): void;
  setValueAtTime(value: number): void;
  cancelScheduledValues?(when: number): void;
}

/**
 * The scheduling surface the native host actually binds.
 *
 * `cancelScheduledValues` is deliberately absent: `audio_bindings.cpp` binds exactly
 * `setValueAtTime`, `linearRampToValueAtTime` and `setTargetAtTime`, so a fake that carries the
 * whole browser `AudioParam` would prove the bus works on a runtime nobody ships.
 */
function parameter(value = 1, scheduling = false): IFakeAudioParam {
  const param: IFakeAudioParam = {
    value,
    linearRampToValueAtTime(next) {
      this.value = next;
    },
    setTargetAtTime(next) {
      this.value = next;
    },
    setValueAtTime(next) {
      this.value = next;
    },
  };
  // A browser `AudioParam` cancels; the native passive param — what `detune` is over there — does
  // not, and silently drops every write. That difference is the whole point of the probe.
  if (scheduling) param.cancelScheduledValues = () => undefined;
  return param;
}

/** Every `start()` a fake source saw, so a resume can be shown to pick up where it paused. */
interface IFakeSource {
  onended: (() => void) | null;
  startArgs: number[][];
}

/**
 * Every edge the fake graph was asked to make, in order.
 *
 * Routing is the whole question a compressor and a per-voice low-pass turn on — which node feeds
 * which — and a fake whose `connect` returns `undefined` can only prove a node was built. These
 * two record the edge, so a test can read the chain the bus actually wired.
 */
let graphEdges: Array<{ from: unknown; to: unknown }> = [];

/** Every gain node the fake handed out, in order: the listener's first, then one per pooled voice. */
let madeGains: unknown[] = [];

function connect(this: unknown, to: unknown): void {
  graphEdges.push({ from: this, to });
}

function disconnect(this: unknown): void {
  graphEdges.push({ from: this, to: null });
}

/** Did `from` feed `to` at any point? */
function wired(from: unknown, to: unknown): boolean {
  return graphEdges.some((edge) => edge.from === from && edge.to === to);
}

/**
 * @param browser Give the context the parts only a browser has — cancellable params. The default
 * is the native host's narrower surface, which now carries the filter and the compressor.
 */
function audioContext(browser = false): globalThis.AudioContext {
  graphEdges = [];
  madeGains = [];
  const context = {
    createBufferSource: () => ({
      connect,
      detune: parameter(0, browser),
      disconnect,
      loop: false,
      loopEnd: 0,
      loopStart: 0,
      onended: null as (() => void) | null,
      playbackRate: parameter(1, browser),
      startArgs: [] as number[][],
      start(...args: number[]) {
        this.startArgs.push(args);
      },
      stop: () => undefined,
    }),
    createGain: () => {
      const node = { connect, disconnect, gain: parameter(1, browser) };
      madeGains.push(node);
      return node;
    },
    createDynamicsCompressor: () => ({
      attack: parameter(0.003),
      connect,
      disconnect,
      knee: parameter(30),
      ratio: parameter(12),
      release: parameter(0.25),
      threshold: parameter(-24),
    }),
    // The native host binds this once the low-pass gap closed, so the "narrow surface" fake
    // carries it. Its params are inert like every other native param: they take a write and
    // report it back, which is all the portable contract reads.
    createBiquadFilter: () => ({
      connect,
      disconnect,
      frequency: parameter(350),
      type: "lowpass" as const,
    }),
    createPanner: () => ({
      connect,
      distanceModel: "inverse" as const,
      disconnect,
      maxDistance: 10_000,
      panningModel: "HRTF" as const,
      refDistance: 1,
      rolloffFactor: 1,
    }),
    currentTime: 0,
    destination: {},
    resume: async () => undefined,
    ...(browser
      ? {
          createBiquadFilter: () => ({
            connect,
            disconnect,
            frequency: parameter(20_000, true),
            type: "lowpass" as const,
          }),
        }
      : {}),
  } as unknown as globalThis.AudioContext;
  AudioContext.setContext(context);
  return context;
}

/** Move the fake clock, the way a paused game's context keeps running. */
function advance(context: globalThis.AudioContext, seconds: number): void {
  (context as unknown as { currentTime: number }).currentTime += seconds;
}

function masterGain(bus: AudioBus): IFakeAudioParam {
  return bus.listener.gain.gain as unknown as IFakeAudioParam;
}

const buffer = { duration: 1 } as AudioBuffer;

/** Run a voice out the way the browser does: the source node reports it finished. */
function endVoice(voice: { source: unknown }): void {
  (voice.source as { onended?: (() => void) | null } | null)?.onended?.();
}

describe("AudioBus", () => {
  it("should queue playback before the first user gesture and flush after", async () => {
    audioContext();
    const gestures = new EventTarget();
    const bus = new AudioBus({ camera: new PerspectiveCamera(), gestureTarget: gestures });

    bus.play(buffer);
    expect(bus.queued).toBe(1);
    expect(bus.voices).toBe(0);

    gestures.dispatchEvent(new Event("keydown"));
    await Promise.resolve();
    expect(bus.queued).toBe(0);
    expect(bus.voices).toBe(1);
    bus.dispose();
  });

  it("should stop every voice on scene exit", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera(), gestureTarget: new EventTarget() });
    await bus.unlock();
    bus.play(buffer);
    bus.play(buffer, { loop: true });

    expect(bus.voices).toBe(2);
    bus.stop();
    expect(bus.voices).toBe(0);
    expect(bus.queued).toBe(0);
    bus.dispose();
  });

  it("should return the bus to the snapshot baseline after dispose", async () => {
    audioContext();
    const baseline = audioRuntimeSnapshot();
    const bus = new AudioBus({ camera: new PerspectiveCamera(), gestureTarget: new EventTarget() });
    await bus.unlock();
    bus.play(buffer);

    expect(audioRuntimeSnapshot().voices).toBe(baseline.voices + 1);
    bus.dispose();
    expect(audioRuntimeSnapshot()).toEqual(baseline);
  });

  it("should re-parent the listener to the active camera", () => {
    audioContext();
    const first = new PerspectiveCamera();
    const second = new PerspectiveCamera();
    const bus = new AudioBus({ camera: first, gestureTarget: new EventTarget() });

    expect(bus.listener.parent).toBe(first);
    bus.setCamera(second);
    expect(bus.listener.parent).toBe(second);
    bus.dispose();
  });

  it("should throw on a null buffer", () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera(), gestureTarget: new EventTarget() });

    expect(() => bus.play(null as unknown as AudioBuffer)).toThrow(/non-null/u);
    bus.dispose();
  });

  it("gives a voice back to the pool when one voice is stopped", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      const first = bus.play(buffer, { loop: true });
      const second = bus.play(buffer, { loop: true });
      expect(bus.pooled).toBe(0);

      // The missing primitive. `stop()` silenced every voice or none, and there was no way to
      // end one entity's loop.
      expect(bus.stopVoice(first)).toBe(true);
      expect(bus.pooled).toBe(1);
      // The other voice is untouched — this is a per-voice stop, not a bus stop.
      expect(second.isPlaying).toBe(true);

      // Stopping it again is reported, not thrown: a caller stopping a sound that already
      // ended has made no mistake.
      expect(bus.stopVoice(first)).toBe(false);

      // And the pool actually hands it back rather than merely counting it.
      const third = bus.play(buffer);
      expect(third).toBe(first);

      // Which is the documented aliasing hazard, stated here as a fact rather than a warning:
      // once recycled, the old handle addresses somebody else's sound, so `stopVoice` on it is
      // true again — and it would stop the *new* cue. Read `isPlaying` before touching a voice
      // you kept.
      expect(bus.stopVoice(first)).toBe(true);
    } finally {
      bus.dispose();
    }
  });

  it("recovers a voice the caller stopped behind the bus's back", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      const leaked = bus.play(buffer, { loop: true });
      expect(bus.pooled).toBe(0);

      // The natural thing to do with the handle `play` returns — and the leak. three's
      // `Audio.stop()` sets `onended` to null before stopping the node, so the reclaim hook this
      // bus installed never fires: without a sweep the entry stays live for the life of the bus,
      // off the pool, uncounted against `maxVoices`, and still parented into the scene.
      leaked.stop();
      expect(leaked.isPlaying).toBe(false);

      // Claiming is where the sweep runs, because it is free there. The recovered voice is the
      // one that was dropped, which is what proves it came back to the pool rather than the bus
      // simply building a new one.
      const recovered = bus.play(buffer);
      expect(recovered).toBe(leaked);
    } finally {
      bus.dispose();
    }
  });

  it("keeps a rejected cue from consuming a pooled voice", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      const first = bus.play(buffer);
      endVoice(first);
      expect(bus.pooled).toBe(1);

      // The option contract throws — but only before a voice is claimed, never after one
      // has been taken out of the pool and dropped on the floor.
      expect(() => bus.play(buffer, { volume: Number.NaN })).toThrow(RangeError);

      // Documented reclaim rule: an ended voice may be handed to a later cue.
      const second = bus.play(buffer);
      expect(second).toBe(first);
    } finally {
      bus.dispose();
    }
  });

  it("should attach positional playback to its source", () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera(), gestureTarget: new EventTarget() });
    const source = new PerspectiveCamera();

    const voice = bus.playAt(buffer, source);

    expect(voice.parent).toBe(source);
    expect(bus.queued).toBe(1);
    bus.dispose();
  });

  it("should pass spatial tuning through to the positional panner", () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera(), gestureTarget: new EventTarget() });
    const source = new PerspectiveCamera();

    const tuned = bus.playAt(buffer, source, { refDistance: 12, rolloffFactor: 2.5 });

    expect(tuned.parent).toBe(source);
    expect(tuned.getRefDistance()).toBe(12);
    expect(tuned.getRolloffFactor()).toBe(2.5);
    const zeroRolloff = bus.playAt(buffer, source, { rolloffFactor: 0 });
    expect(zeroRolloff.getRolloffFactor()).toBe(0);
    bus.dispose();
  });

  it("should leave positional falloff at runtime defaults when untuned", () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera(), gestureTarget: new EventTarget() });

    const voice = bus.playAt(buffer, new PerspectiveCamera());

    expect(voice.getRefDistance()).toBe(1);
    expect(voice.getRolloffFactor()).toBe(1);
    bus.dispose();
  });

  it("should fail closed on invalid spatial tuning, naming the option", () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera(), gestureTarget: new EventTarget() });
    const source = new PerspectiveCamera();

    expect(() => bus.playAt(buffer, source, { refDistance: 0 })).toThrow(RangeError);
    expect(() => bus.playAt(buffer, source, { refDistance: 0 })).toThrow(/refDistance/u);
    expect(() => bus.playAt(buffer, source, { refDistance: -3 })).toThrow(RangeError);
    expect(() => bus.playAt(buffer, source, { refDistance: Number.NaN })).toThrow(RangeError);
    expect(() => bus.playAt(buffer, source, { refDistance: Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
    expect(() => bus.playAt(buffer, source, { rolloffFactor: -0.5 })).toThrow(/rolloffFactor/u);
    expect(() => bus.playAt(buffer, source, { rolloffFactor: Number.NaN })).toThrow(RangeError);
    expect(() => bus.play(buffer, { refDistance: 0 })).toThrow(/refDistance/u);
    expect(() => bus.play(buffer, { rolloffFactor: -0.5 })).toThrow(/rolloffFactor/u);
    expect(bus.queued).toBe(0);
    bus.dispose();
  });

  it("should fail closed when the runtime has no positional audio", () => {
    const context = audioContext();
    Reflect.deleteProperty(context, "createPanner");
    const bus = new AudioBus({ camera: new PerspectiveCamera(), gestureTarget: new EventTarget() });

    expect(() => bus.playAt(buffer, new PerspectiveCamera())).toThrowError(
      "AudioBus.playAt needs createPanner(); this runtime has none.",
    );
    expect(bus.queued).toBe(0);
    expect(bus.voices).toBe(0);
    bus.dispose();
  });

  it("should use an injected optional gesture source without reading window", async () => {
    audioContext();
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Reflect.deleteProperty(globalThis, "window");
    const gestures = new EventTarget();
    const bus = new AudioBus({
      camera: new PerspectiveCamera(),
      source: () => gestures,
    });

    try {
      bus.play(buffer);
      expect(bus.queued).toBe(1);
      gestures.dispatchEvent(new Event("pointerdown"));
      await Promise.resolve();
      expect(bus.queued).toBe(0);
      expect(bus.voices).toBe(1);
    } finally {
      bus.dispose();
      if (windowDescriptor !== undefined)
        Object.defineProperty(globalThis, "window", windowDescriptor);
    }
  });

  it("should take an ended positional voice back out of the scene graph", async () => {
    audioContext();
    const camera = new PerspectiveCamera();
    const scene = new Object3D();
    scene.add(camera);
    const bus = new AudioBus({ camera });
    await bus.unlock();

    try {
      const voice = bus.playAt(buffer, new Vector3(1, 0, 2));
      expect(scene.children).toContain(voice);
      endVoice(voice);
      // The leak this replaces: the object stayed parented for the rest of the session, so a
      // game emitting hundreds of cues a minute grew its scene by hundreds of nodes a minute.
      expect(scene.children).not.toContain(voice);
      expect(bus.voices).toBe(0);
      expect(bus.pooled).toBe(1);
    } finally {
      bus.dispose();
    }
  });

  it("should reuse a retired voice rather than build another", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      const first = bus.play(buffer);
      endVoice(first);
      expect(bus.pooled).toBe(1);
      const second = bus.play(buffer);
      expect(second).toBe(first);
      expect(bus.pooled).toBe(0);
    } finally {
      bus.dispose();
    }
  });

  it("should hold the voice count flat across a long run of cues", async () => {
    audioContext();
    const camera = new PerspectiveCamera();
    const scene = new Object3D();
    scene.add(camera);
    const bus = new AudioBus({ camera });
    await bus.unlock();

    try {
      for (let index = 0; index < 500; index += 1) {
        endVoice(bus.playAt(buffer, new Vector3(index, 0, 0)));
      }
      // One voice, reused five hundred times. Session length must not be a growth term.
      expect(bus.pooled).toBe(1);
      expect(bus.voices).toBe(0);
      expect(scene.children).toHaveLength(1);
    } finally {
      bus.dispose();
    }
  });

  it("should steal the oldest one-shot once the ceiling is reached", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera(), maxVoices: 3 });
    await bus.unlock();

    try {
      const oldest = bus.play(buffer);
      bus.play(buffer);
      bus.play(buffer);
      expect(bus.voices).toBe(3);
      bus.play(buffer);
      expect(bus.voices).toBe(3);
      expect(oldest.isPlaying).toBe(false);
    } finally {
      bus.dispose();
    }
  });

  it("should never steal a looping voice to make room", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera(), maxVoices: 2 });
    await bus.unlock();

    try {
      const music = bus.music(buffer, { volume: 0.5 });
      bus.play(buffer);
      bus.play(buffer);
      bus.play(buffer);
      // Ambience cut off by gunfire is the failure this guards; one-shots yield, the bed does not.
      expect(music.isPlaying).toBe(true);
    } finally {
      bus.dispose();
    }
  });

  it("should fail closed on invalid cue shaping, naming the option", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });

    try {
      expect(() => bus.play(buffer, { cutoffSeconds: 0 })).toThrow(/cutoffSeconds/);
      expect(() => bus.play(buffer, { lowpassHz: -1 })).toThrow(/lowpassHz/);
      expect(() => bus.play(buffer, { detune: Number.NaN })).toThrow(/detune/);
      expect(() => new AudioBus({ camera: new PerspectiveCamera(), maxVoices: 0 })).toThrow(
        /maxVoices/,
      );
    } finally {
      bus.dispose();
    }
  });

  it("should restate positional falloff on a recycled voice", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      const tuned = bus.playAt(buffer, new Vector3(), { refDistance: 12, rolloffFactor: 0.3 });
      expect(tuned.getRefDistance()).toBe(12);
      endVoice(tuned);
      const plain = bus.playAt(buffer, new Vector3());
      // Same object, second cue. Carrying the previous cue's curve is how a footstep inherits a
      // gunshot's reach and every distance in the mix stops meaning anything.
      expect(plain).toBe(tuned);
      expect(plain.getRefDistance()).toBe(1);
      expect(plain.getRolloffFactor()).toBe(1);
    } finally {
      bus.dispose();
    }
  });

  it("should carry a master volume a mixer can duck and restore", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      expect(bus.volume).toBe(1);
      bus.setVolume(0.25);
      expect(bus.volume).toBe(0.25);
      expect(masterGain(bus).value).toBeCloseTo(0.25, 6);
      bus.setVolume(1, 0.4);
      // The reported volume is the target, not whatever point a ramp is passing through: a slider
      // that reads back mid-fade jumps under the player's finger.
      expect(bus.volume).toBe(1);
      expect(masterGain(bus).value).toBeCloseTo(1, 6);
    } finally {
      bus.dispose();
    }
  });

  it("should fail closed on an invalid master volume", () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    try {
      expect(() => bus.setVolume(-0.1)).toThrow(/volume/);
      expect(() => bus.setVolume(Number.NaN)).toThrow(/volume/);
      expect(() => bus.setVolume(0.5, -1)).toThrow(/fade/);
      expect(bus.volume).toBe(1);
    } finally {
      bus.dispose();
    }
  });

  it("should pause a looping bed and resume it where it stopped", async () => {
    const context = audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      const bed = bus.music({ duration: 10 } as AudioBuffer, { volume: 0.8 });
      expect(bed.isPlaying).toBe(true);
      advance(context, 3);

      bus.pause();
      expect(bed.isPlaying).toBe(false);
      expect(audioRuntimeSnapshot().paused).toBe(1);
      // A pause that drops the voice is a stop wearing a different name.
      expect(bus.voices).toBe(1);

      bus.resume();
      expect(bed.isPlaying).toBe(true);
      expect(audioRuntimeSnapshot().paused).toBe(0);
      const source = bed.source as unknown as IFakeSource;
      const offsets = source.startArgs.map((args) => args[1]);
      expect(offsets.at(-1)).toBeCloseTo(3, 6);
    } finally {
      bus.dispose();
    }
  });

  it("should hold a cue queued while paused and sound it on resume", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });

    try {
      bus.pause();
      bus.play(buffer);
      await bus.unlock();
      // Unlocking a paused bus is the pause menu's first click: it must not fire the backlog.
      expect(bus.queued).toBe(1);
      expect(bus.voices).toBe(0);

      bus.resume();
      expect(bus.queued).toBe(0);
      expect(bus.voices).toBe(1);
    } finally {
      bus.dispose();
    }
  });

  it("should drop a paused voice rather than resume it on stop", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      bus.music({ duration: 10 } as AudioBuffer);
      bus.pause();
      bus.stop();
      expect(audioRuntimeSnapshot().paused).toBe(0);
      expect(bus.voices).toBe(0);
      bus.resume();
      expect(bus.voices).toBe(0);
    } finally {
      bus.dispose();
    }
  });

  it("should name the cue shaping this runtime cannot honour", async () => {
    audioContext();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      bus.play(buffer, { detune: 40, lowpassHz: 900 });
      // `lowpassHz` is honoured on the native host now, because it binds a biquad. `detune` is
      // still an inert stand-in there, and reporting it is the difference between a mix that is
      // quietly flat everywhere and one a build can be failed on.
      expect(bus.unsupported).toEqual(["detune"]);
      expect(audioRuntimeSnapshot().unsupported).toEqual(["detune"]);
    } finally {
      bus.dispose();
    }
  });

  it("sums every voice into a game-configured compressor ahead of the bus volume", async () => {
    const context = audioContext();
    const made: Array<Record<string, IFakeAudioParam>> = [];
    const original = context.createDynamicsCompressor as unknown as () => unknown;
    context.createDynamicsCompressor = () => {
      const node = original.call(context) as Record<string, IFakeAudioParam>;
      made.push(node);
      return node as unknown as DynamicsCompressorNode;
    };
    const bus = new AudioBus({
      camera: new PerspectiveCamera(),
      compressor: { attack: 0.004, knee: 6, ratio: 5, release: 0.18, threshold: -15 },
      gestureTarget: new EventTarget(),
    });

    try {
      await bus.unlock();
      // The mix the source ran: a compressor holding three summed voices down. Every number is
      // the game's, so the bus must not invent one.
      expect(made).toHaveLength(1);
      const node = made[0];
      const values = Object.fromEntries(
        Object.entries(node ?? {}).map(([name, p]) => [name, p.value]),
      );
      expect(values).toEqual({ attack: 0.004, knee: 6, ratio: 5, release: 0.18, threshold: -15 });
      // The compressor is reachable so a mixer can read `reduction` off it.
      expect(bus.compressor).toBe(node);

      // The routing, which is the part that was wrong: voices reach the compressor, the
      // compressor reaches the bus volume gain. Three's own `listener.filter` slot would have put
      // it on the far side of that gain, compressing a level the volume had already moved.
      const masterGain = bus.listener.gain;
      expect(madeGains[0]).toBe(masterGain);
      expect(wired(node, masterGain)).toBe(true);
      bus.play(buffer);
      expect(madeGains[1]).not.toBe(masterGain);
      expect(wired(madeGains[1], node)).toBe(true);
      expect(bus.listener.getFilter()).toBeNull();

      bus.dispose();
      // And it leaves with the bus, so a disposed bus is not still holding voices.
      expect(graphEdges).toContainEqual({ from: node, to: null });
    } finally {
      bus.dispose();
    }
  });

  it("should fail closed on a compressor option it cannot honour", () => {
    audioContext();
    const camera = new PerspectiveCamera();
    const at = (over: Partial<IAudioCompressorOptions>) => () =>
      new AudioBus({
        camera,
        compressor: { attack: 0.01, knee: 6, ratio: 5, release: 0.2, threshold: -15, ...over },
      });

    expect(at({ attack: Number.NaN })).toThrow(/compressor\.attack/u);
    expect(at({ attack: 1.5 })).toThrow(/compressor\.attack/u);
    expect(at({ release: 1.5 })).toThrow(/compressor\.release/u);
    expect(at({ release: Number.POSITIVE_INFINITY })).toThrow(/compressor\.release/u);
    expect(at({ knee: -1 })).toThrow(/compressor\.knee/u);
    expect(at({ knee: 41 })).toThrow(/compressor\.knee/u);
    expect(at({ ratio: 0.5 })).toThrow(/compressor\.ratio/u);
    expect(at({ ratio: 21 })).toThrow(/compressor\.ratio/u);
    expect(at({ threshold: 12 })).toThrow(/compressor\.threshold/u);
    expect(at({ threshold: -140 })).toThrow(/compressor\.threshold/u);
    // A half-spelled compressor is not a compressor with defaults; it is a mistake.
    expect(
      () =>
        new AudioBus({
          camera,
          compressor: {
            knee: 6,
            ratio: 5,
            release: 0.2,
            threshold: -15,
          } as unknown as IAudioCompressorOptions,
        }),
    ).toThrow(/compressor\.attack/u);

    // Zero is inside the platform's range for attack and release — an instant response, not a
    // mistake — so refusing it would be this engine being stricter than the Web Audio it mirrors.
    for (const instant of [0, 1]) {
      const bus = new AudioBus({
        camera,
        compressor: { attack: instant, knee: 0, ratio: 20, release: instant, threshold: -100 },
      });
      expect(bus.compressor).toBeDefined();
      bus.dispose();
    }

    // A runtime with no dynamics node is named, not silently left uncompressed.
    const bare = audioContext();
    Reflect.deleteProperty(bare, "createDynamicsCompressor");
    const bus = new AudioBus({
      camera,
      compressor: { attack: 0.01, knee: 6, ratio: 5, release: 0.2, threshold: -15 },
    });
    expect(bus.unsupported).toEqual(["compressor"]);
    expect(bus.compressor).toBeUndefined();
    bus.dispose();
  });

  it("reports nothing unsupported for a bus that honours the shaping", async () => {
    audioContext(true);
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      bus.play(buffer, { detune: 40, lowpassHz: 900 });
      expect(bus.unsupported).toEqual([]);
      expect(audioRuntimeSnapshot().unsupported).toEqual([]);
    } finally {
      bus.dispose();
    }
  });
  it("counts labelled cues, so a scenario can prove a one-shot line sounded once", async () => {
    audioContext(true);
    resetAudioCueLedger();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      bus.play(buffer, { cue: "P01" });
      bus.play(buffer, { cue: "R10" });
      bus.play(buffer, { cue: "R10" });
      bus.play(buffer);

      // Unlabelled cues are invisible here on purpose: a game opts a line in, and a count that
      // silently included every footstep would answer a different question than the one asked.
      expect(audioRuntimeSnapshot().cues).toEqual({ P01: 1, R10: 2 });
      expect(audioRuntimeSnapshot().recentCues.map(({ cue }) => cue)).toEqual([
        "P01",
        "R10",
        "R10",
      ]);

      // The ledger outlives the bus, because "did it play again after the scene restarted" is the
      // question it exists to answer, and a scene change disposes the bus.
      bus.dispose();
      const replacement = new AudioBus({ camera: new PerspectiveCamera() });
      await replacement.unlock();
      replacement.play(buffer, { cue: "P01" });
      expect(audioRuntimeSnapshot().cues.P01).toBe(2);
      replacement.dispose();
    } finally {
      bus.dispose();
    }
  });

  it("refuses a cue label that is not a label, rather than miscounting under it", async () => {
    audioContext(true);
    resetAudioCueLedger();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      expect(() => bus.play(buffer, { cue: "" })).toThrow(/cue must be a non-empty string/u);
      expect(() => bus.play(buffer, { cue: 7 as unknown as string })).toThrow(
        /cue must be a non-empty string/u,
      );
      expect(audioRuntimeSnapshot().cues).toEqual({});
    } finally {
      bus.dispose();
    }
  });
  it("keeps its registry on the realm, so a second copy of this module sees the same buses", async () => {
    audioContext(true);
    resetAudioCueLedger();
    const bus = new AudioBus({ camera: new PerspectiveCamera() });
    await bus.unlock();

    try {
      bus.play(buffer, { cue: "P01" });

      // Core ships one bundle per entry with no shared chunks, so a game importing both
      // `@threenative/core` and `@threenative/core/playtest` loads this module twice. The playtest
      // bridge runs in the second copy: with module-level state it observed its own empty registry
      // and reported zero voices and no cues for a game that was playing audio the whole time.
      const path = new URL("../src/audio.js", import.meta.url).href;
      const second = (await import(
        /* @vite-ignore */ `${path}?copy=${Date.now()}`
      )) as typeof import("../src/audio.js");
      expect(second).not.toBe(await import("../src/audio.js"));
      expect(second.audioRuntimeSnapshot().voices).toBe(audioRuntimeSnapshot().voices);
      expect(second.audioRuntimeSnapshot().cues).toEqual({ P01: 1 });
    } finally {
      bus.dispose();
    }
  });
});
