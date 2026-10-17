import { describe, expect, it } from "vitest";
import { defineAudioClasses } from "../src/audio.js";

// The engine side is a stand-in: a world position per object and a parent link. The native and
// Wasm engines are proved by runtime-native's player-imports test; this proves the WebAudio side.
class Vector3 {
  x = 0;
  y = 0;
  z = 0;
  set(x: number, y: number, z: number) {
    Object.assign(this, { x, y, z });
    return this;
  }
  applyQuaternion() {
    return this;
  }
}
class Object3D {
  parent: object | null = null;
  world = new Vector3();
  matrixWorld = {
    decompose: (position: Vector3) => position.set(this.world.x, this.world.y, this.world.z),
  };
  refreshed = 0;
  updateMatrixWorld() {}
  updateWorldMatrix() {
    this.refreshed++;
  }
  copy() {
    return this;
  }
}

/** The stand-in side of an audio object. */
const engineSide = (object: object) => object as unknown as Object3D;

type Call = [string, ...unknown[]];
function fakeContext(legacy: boolean) {
  const calls: Call[] = [];
  const param = (name: string) => ({
    value: 1,
    linearRampToValueAtTime: (value: number) => calls.push([`${name}`, value]),
    setTargetAtTime: (value: number) => calls.push([`${name}.target`, value]),
  });
  const node = (name: string, extra: object = {}) => ({
    name,
    connect: (to: { name: string }) => calls.push(["connect", name, to.name]),
    disconnect: () => undefined,
    ...extra,
  });
  const spatial = (name: string) =>
    legacy
      ? {
          setPosition: (...xyz: number[]) => calls.push([`${name}.setPosition`, ...xyz]),
          setOrientation: () => undefined,
        }
      : {
          positionX: param(`${name}.x`),
          positionY: param(`${name}.y`),
          positionZ: param(`${name}.z`),
          orientationX: param("o"),
          orientationY: param("o"),
          orientationZ: param("o"),
          forwardX: param("f"),
          forwardY: param("f"),
          forwardZ: param("f"),
          upX: param("u"),
          upY: param("u"),
          upZ: param("u"),
        };
  const context = {
    currentTime: 0,
    destination: node("destination"),
    listener: spatial("listener"),
    createGain: () => node("gain", { gain: param("gain") }),
    createPanner: () => node("panner", spatial("panner")),
    createBufferSource: () =>
      node("source", {
        playbackRate: param("rate"),
        detune: param("detune"),
        start: (...args: unknown[]) => calls.push(["start", ...args]),
        stop: () => calls.push(["stop"]),
      }),
    decodeAudioData: async (bytes: ArrayBuffer) => ({ duration: bytes.byteLength }),
  };
  return { calls, context };
}

function setup(legacy = false) {
  const { calls, context } = fakeContext(legacy);
  const audio = defineAudioClasses({
    Object3D: Object3D as never,
    Vector3,
    Quaternion: Object,
    read: async (url) => new TextEncoder().encode(url).buffer as ArrayBuffer,
  });
  audio.AudioContext.setContext(context as never);
  return { audio, calls };
}

describe("three's audio classes over an engine Object3D", () => {
  it("are engine objects whose listener feeds the destination", () => {
    const { audio, calls } = setup();
    const listener = new audio.AudioListener();
    const voice = new audio.PositionalAudio(listener);
    expect(listener).toBeInstanceOf(Object3D);
    expect(voice).toBeInstanceOf(audio.Audio);
    expect([listener, voice].map((object) => (object as unknown as { type: string }).type)).toEqual(
      ["AudioListener", "PositionalAudio"],
    );
    expect(calls).toContainEqual(["connect", "gain", "destination"]);
    expect(calls).toContainEqual(["connect", "panner", "gain"]);
  });

  it("push an attached listener and a playing voice to WebAudio each frame, never a detached one", () => {
    const { audio, calls } = setup();
    const listener = new audio.AudioListener();
    const voice = new audio.PositionalAudio(listener);
    voice.setBuffer({ duration: 1 } as AudioBuffer);
    engineSide(listener).world.set(1, 2, 3);
    engineSide(voice).world.set(7, 0, -4);
    audio.updateAudio();
    expect(calls.some(([name]) => name === "listener.x")).toBe(false);

    engineSide(listener).parent = {};
    engineSide(voice).parent = {};
    audio.updateAudio();
    expect(calls).toContainEqual(["listener.x", 1]);
    expect(calls).toContainEqual(["listener.z", 3]);
    expect(calls.some(([name]) => name === "panner.x")).toBe(false); // not playing: upstream skips it

    voice.play();
    expect(calls).toContainEqual(["start", 0, 0, undefined]);
    audio.updateAudio();
    expect(calls).toContainEqual(["panner.x", 7]);
    expect(calls).toContainEqual(["panner.z", -4]);
    expect(engineSide(voice).refreshed).toBeGreaterThan(0);

    engineSide(voice).parent = null;
    calls.length = 0;
    audio.updateAudio();
    expect(calls.some(([name]) => name === "panner.x")).toBe(false);
  });

  it("fall back to the legacy setPosition surface when AudioParams are absent", () => {
    const { audio, calls } = setup(true);
    const listener = new audio.AudioListener();
    engineSide(listener).parent = {};
    engineSide(listener).world.set(4, 5, 6);
    audio.updateAudio();
    expect(calls).toContainEqual(["listener.setPosition", 4, 5, 6]);
  });

  it("decode what the engine reads through the shared context", async () => {
    const { audio } = setup();
    const buffer = await new audio.AudioLoader().setPath("sfx/").loadAsync("boom.ogg");
    expect(buffer.duration).toBe("sfx/boom.ogg".length);
  });
});
