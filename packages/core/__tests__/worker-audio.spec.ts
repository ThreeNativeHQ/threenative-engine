import { Object3D, AudioContext as ThreeAudioContext } from "three";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AudioBus } from "../src/audio.js";
import { createRemoteAudioContext, serveRemoteAudio } from "../src/worker-audio.js";

// PRD-752: a worker has no AudioContext. The worker gets a stand-in whose nodes are handles; each
// call and property write crosses a port, and the page runs the real Web Audio graph. These tests
// put a recording fake where the page's AudioContext would be.

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function param(value = 1) {
  return {
    linearRampToValueAtTime: vi.fn(function (this: unknown) {
      return this;
    }),
    setTargetAtTime: vi.fn(function (this: unknown) {
      return this;
    }),
    setValueAtTime: vi.fn(function (this: unknown) {
      return this;
    }),
    value,
    defaultValue: value,
    minValue: -2,
    maxValue: 2,
    cancelScheduledValues: vi.fn(),
  };
}

function fakePage() {
  const destination = { name: "destination" };
  const node = () => ({
    connect: vi.fn((target: unknown) => target),
    disconnect: vi.fn(),
  });
  const created: Record<string, unknown>[] = [];
  const events = new EventTarget();
  const context = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    createBufferSource: vi.fn(() => {
      const sourceEvents = new EventTarget();
      const source = {
        addEventListener: sourceEvents.addEventListener.bind(sourceEvents),
        end: () => {
          source.onended?.();
          sourceEvents.dispatchEvent(new Event("ended"));
        },
        ...node(),
        buffer: null as unknown,
        detune: param(0),
        loop: false,
        onended: null as null | (() => void),
        playbackRate: param(1),
        start: vi.fn(),
        stop: vi.fn(),
      };
      created.push(source);
      return source;
    }),
    createGain: vi.fn(() => {
      const gain = { ...node(), gain: param(1) };
      created.push(gain);
      return gain;
    }),
    currentTime: 4,
    decodeAudioData: vi.fn(async (bytes: ArrayBuffer) => ({
      duration: bytes.byteLength / 1000,
      length: bytes.byteLength,
      numberOfChannels: 2,
      sampleRate: 48_000,
    })),
    destination,
    listener: { positionX: param(0) },
    resume: vi.fn(async () => {
      context.state = "running";
      events.dispatchEvent(new Event("statechange"));
    }),
    suspend: vi.fn(async () => {
      context.state = "suspended";
      events.dispatchEvent(new Event("statechange"));
    }),
    close: vi.fn(async () => {
      context.state = "closed";
      events.dispatchEvent(new Event("statechange"));
    }),
    sampleRate: 48_000,
    state: "suspended",
  };
  return { context, created, destination };
}

function connect() {
  const page = fakePage();
  const { port1, port2 } = new MessageChannel();
  const set = vi.spyOn(Map.prototype, "set");
  const stop = serveRemoteAudio(port2, page.context as unknown as BaseAudioContext);
  const objects = set.mock.contexts[
    set.mock.calls.findIndex(([id, value]) => id === 0 && value === page.context)
  ] as Map<number, unknown>;
  set.mockRestore();
  const remote = createRemoteAudioContext(port1, { sampleRate: 48_000, currentTime: 4 });
  onTestFinished(() => {
    stop();
    port1.close();
  });
  return {
    ...page,
    objects,
    remote,
    stop: () => {
      stop();
      port1.close();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("remote audio for a worker game (PRD-752)", () => {
  it("runs a gain node's calls on the page's real node", async () => {
    const { created, remote, stop } = connect();
    const gain = remote.createGain();
    gain.gain.setTargetAtTime(0.5, 0, 0.1);
    await tick();
    const real = created[0] as { gain: ReturnType<typeof param> };
    expect(real.gain.setTargetAtTime).toHaveBeenCalledWith(0.5, 0, 0.1);
    stop();
  });

  it("connects remote nodes to the page's real nodes, the destination included", async () => {
    const { created, destination, remote, stop } = connect();
    const source = remote.createBufferSource();
    const gain = remote.createGain();
    source.connect(gain);
    gain.connect(remote.destination);
    await tick();
    const [realSource, realGain] = created as { connect: ReturnType<typeof vi.fn> }[];
    expect(realSource?.connect).toHaveBeenCalledWith(realGain);
    expect(realGain?.connect).toHaveBeenCalledWith(destination);
    stop();
  });

  it("decodes on the page and hands the worker a buffer it can play and measure", async () => {
    // three's AudioLoader calls decodeAudioData(data, onSuccess) and also chains the promise.
    const { created, remote, stop } = connect();
    const onSuccess = vi.fn();
    const buffer = await remote.decodeAudioData(new ArrayBuffer(2000), onSuccess);
    expect(buffer.duration).toBe(2);
    expect(buffer.numberOfChannels).toBe(2);
    expect(onSuccess).toHaveBeenCalledWith(buffer);
    const source = remote.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.start(0, 0.5);
    await tick();
    const real = created[0] as { buffer: { duration: number }; loop: boolean; start: unknown };
    expect(real.buffer.duration).toBe(2);
    expect(real.loop).toBe(true);
    expect(real.start).toHaveBeenCalledWith(0, 0.5);
    expect(source.loop).toBe(true);
    stop();
  });

  it("calls the worker's onended when the page's source ends", async () => {
    const { created, remote, stop } = connect();
    const source = remote.createBufferSource();
    const ended = vi.fn();
    source.onended = ended;
    await tick();
    (created[0] as { onended: () => void }).onended();
    await tick();
    expect(ended).toHaveBeenCalledTimes(1);
    stop();
  });

  it("runs a worker 'ended' listener when the page's source ends", async () => {
    const { created, remote, stop } = connect();
    const ended = vi.fn();
    remote.createBufferSource().addEventListener("ended", ended);
    await tick();
    (created[0] as { end: () => void }).end();
    await tick();
    expect(ended).toHaveBeenCalledTimes(1);
    stop();
  });

  it("moves the listener through the page's real listener", async () => {
    const { context, remote, stop } = connect();
    remote.listener.positionX.linearRampToValueAtTime(3, 4.1);
    await tick();
    expect(context.listener.positionX.linearRampToValueAtTime).toHaveBeenCalledWith(3, 4.1);
    stop();
  });

  it("sends one message per task, however many calls the frame made", async () => {
    // AudioListener moves nine AudioParams every frame; nine messages per frame would cost more
    // than the work they carry.
    const page = fakePage();
    const { port1, port2 } = new MessageChannel();
    const sent = vi.spyOn(port1, "postMessage");
    const stop = serveRemoteAudio(port2, page.context as unknown as BaseAudioContext);
    const remote = createRemoteAudioContext(port1, { sampleRate: 48_000, currentTime: 4 });
    for (let index = 0; index < 9; index += 1)
      remote.listener.positionX.linearRampToValueAtTime(index, 4.1);
    await tick();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(page.context.listener.positionX.linearRampToValueAtTime).toHaveBeenCalledTimes(9);
    stop();
    port1.close();
  });

  it("rejects a failed page resume and keeps the actual suspended state", async () => {
    const { context, remote } = connect();
    const rejected = Promise.reject(new Error("gesture required"));
    void rejected.catch(() => undefined);
    context.resume.mockImplementation(() => rejected);
    await expect(remote.resume()).rejects.toThrow("gesture required");
    expect(remote.state).toBe("suspended");
  });

  it.each(["resume", "suspend", "close"] as const)(
    "waits for the page's %s result and actual state",
    async (method) => {
      const { context, remote } = connect();
      await tick();
      let finish: (() => void) | undefined;
      context[method].mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = () => {
              context.state =
                method === "resume" ? "running" : method === "close" ? "closed" : "suspended";
              resolve();
            };
          }),
      );
      const settled = vi.fn();
      const pending = remote[method]().then(settled);
      await tick();
      expect(settled).not.toHaveBeenCalled();
      expect(remote.state).toBe("suspended");
      finish?.();
      await pending;
      expect(remote.state).toBe(context.state);
    },
  );

  it("reads numeric AudioParam defaults, preserves writes, and rejects unknown properties", async () => {
    const { remote } = connect();
    const gain = remote.createGain().gain;
    expect(gain.value).toBe(1);
    expect(gain.defaultValue).toBe(1);
    gain.value = 0.75;
    await tick();
    expect(gain.value).toBe(0.75);
    expect(gain.minValue).toBe(-2);
    expect(gain.maxValue).toBe(2);
    expect(() => Reflect.get(gain, "missingScalar")).toThrow(/unknown.*missingScalar/i);
  });

  it("runs AudioBus fades through the proxy with a numeric starting gain", async () => {
    const { remote, created } = connect();
    vi.spyOn(ThreeAudioContext, "getContext").mockReturnValue(remote);
    const bus = new AudioBus({ camera: new Object3D(), source: () => undefined });
    onTestFinished(() => bus.dispose());
    bus.setVolume(0.25, 0.5);
    await tick();
    const gain = (created[0] as { gain: ReturnType<typeof param> }).gain;
    expect(gain.setValueAtTime).toHaveBeenCalledWith(1, 4);
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.25, 4.5);
  });

  it("keeps the handle table constant across 10,000 fluent AudioParam calls", async () => {
    const { remote, objects } = connect();
    const gain = remote.createGain().gain;
    await tick();
    const before = objects.size;
    let returned: AudioParam | undefined;
    for (let i = 0; i < 10_000; i += 1) returned = gain.setValueAtTime(i, 4);
    await tick(30);
    expect(objects.size).toBe(before);
    expect(returned).toBe(gain);
  });

  it("releases overwritten, cleared and fired one-shot callback handles", async () => {
    const { remote, created } = connect();
    const source = remote.createBufferSource();
    const first = vi.fn();
    const set = vi.spyOn(Map.prototype, "set");
    source.onended = first;
    const functions = set.mock.contexts[
      set.mock.calls.findIndex(([id, value]) => typeof id === "number" && value === first)
    ] as Map<number, unknown>;
    set.mockRestore();
    source.onended = vi.fn();
    expect(functions.size).toBe(1);
    source.onended = null;
    expect(functions.size).toBe(0);
    const ended = vi.fn();
    source.onended = ended;
    await tick();
    (created[0] as { end(): void }).end();
    await tick();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(functions.size).toBe(0);
  });

  it("releases ended source handles and their params without dropping reusable gains", async () => {
    const { remote, created, objects } = connect();
    const gain = remote.createGain();
    gain.gain.setValueAtTime(1, 4);
    await tick();
    const before = objects.size;
    const source = remote.createBufferSource();
    source.playbackRate.setValueAtTime(1, 4);
    source.connect(gain);
    await tick();
    const real = created[1] as { end(): void; disconnect: ReturnType<typeof vi.fn> };
    expect([...objects.values()]).toContain(real);
    real.end();
    await tick();
    expect([...objects.values()]).not.toContain(real);
    expect(real.disconnect).toHaveBeenCalledTimes(1);
    expect(objects.size).toBe(before);
    gain.disconnect();
    gain.connect(remote.destination);
    await tick();
    expect([...objects.values()]).toContain(created[0]);
  });

  it("freezes while suspended and re-anchors to page state changes and batches", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { context, remote } = connect();
    await tick();
    expect(remote.currentTime).toBe(4);
    now += 10_000;
    expect(remote.currentTime).toBe(4);
    await remote.resume();
    await tick();
    expect(remote.state).toBe("running");
    expect(remote.currentTime).toBe(4);
    now += 1000;
    expect(remote.currentTime).toBe(5);
    context.currentTime = 4.25;
    remote.createGain();
    await tick();
    expect(remote.currentTime).toBe(4.25);
    context.state = "suspended";
    context.dispatchEvent(new Event("statechange"));
    await tick();
    now += 10_000;
    expect(remote.currentTime).toBe(4.25);
    expect(remote.state).toBe("suspended");
    expect(remote.sampleRate).toBe(48_000);
  });
});
