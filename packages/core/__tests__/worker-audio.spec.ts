import { describe, expect, it, vi } from "vitest";
import { createRemoteAudioContext, serveRemoteAudio } from "../src/worker-audio.js";

// PRD-752: a worker has no AudioContext. The worker gets a stand-in whose nodes are handles; each
// call and property write crosses a port, and the page runs the real Web Audio graph. These tests
// put a recording fake where the page's AudioContext would be.

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function param(value = 1) {
  return {
    linearRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
    value,
  };
}

function fakePage() {
  const destination = { name: "destination" };
  const node = () => ({
    connect: vi.fn((target: unknown) => target),
    disconnect: vi.fn(),
  });
  const created: Record<string, unknown>[] = [];
  const context = {
    createBufferSource: vi.fn(() => {
      const source = {
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
    resume: vi.fn(async () => undefined),
    sampleRate: 48_000,
    state: "suspended",
  };
  return { context, created, destination };
}

function connect() {
  const page = fakePage();
  const { port1, port2 } = new MessageChannel();
  const stop = serveRemoteAudio(port2, page.context as unknown as BaseAudioContext);
  const remote = createRemoteAudioContext(port1, { sampleRate: 48_000, currentTime: 4 });
  return {
    ...page,
    remote,
    stop: () => {
      stop();
      port1.close();
    },
  };
}

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

  it("keeps its own clock from the page's start time and resumes the page's context", async () => {
    const { context, remote, stop } = connect();
    const first = remote.currentTime;
    expect(first).toBeGreaterThanOrEqual(4);
    await tick(30);
    expect(remote.currentTime).toBeGreaterThan(first);
    expect(remote.sampleRate).toBe(48_000);
    await remote.resume();
    await tick();
    expect(context.resume).toHaveBeenCalledTimes(1);
    stop();
  });
});
