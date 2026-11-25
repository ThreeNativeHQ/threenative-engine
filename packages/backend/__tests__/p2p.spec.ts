/**
 * The switchover barrier, without a browser: a fake socket into the room and a fake
 * `RTCPeerConnection` whose data channel this spec opens, sends on and feeds.
 *
 * PRD-100's rule is that nothing a player sent before the switch may be delivered after a message
 * that took the channel, in either direction. A stopwatch cannot prove that and neither can a real
 * pair on a fast loopback, so this spec drives the frames and the channel events itself.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IRtcOptions } from "../src/p2p.js";
import { P2P_SWITCH } from "../src/p2p.js";
import { Room } from "../src/rooms.js";

/** One frame this client put on its room socket. */
interface IFrame {
  readonly t: string;
  readonly to?: string;
  readonly data?: unknown;
}

/** The room socket: records what the room sent, and delivers what the room's DO would. */
class FakeSocket {
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.#emit("close", {});
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  /** What the Durable Object would hand this socket. */
  deliver(frame: unknown): void {
    this.#emit("message", { data: JSON.stringify(frame) });
  }

  get frames(): IFrame[] {
    return this.sent.map((text) => JSON.parse(text) as IFrame);
  }

  #emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

/** The one ordered channel between two peers, driven by this spec rather than by real ICE. */
class FakeChannel {
  readonly label: string;
  readonly sent: string[] = [];
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(label: string) {
    this.label = label;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = "closed";
    this.onclose?.();
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  /** What the other peer would put on the channel. */
  deliver(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ d: data }) });
  }
}

/** A connection that negotiates nothing: the channel is the only part the switchover needs. */
class FakeConnection {
  static readonly all: FakeConnection[] = [];
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  #channel: FakeChannel | undefined;

  constructor() {
    FakeConnection.all.push(this);
  }

  get channel(): FakeChannel | undefined {
    return this.#channel;
  }

  createDataChannel(label: string): FakeChannel {
    this.#channel = new FakeChannel(label);
    return this.#channel;
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(description: { type: string; sdp: string }): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = description;
  }

  async addIceCandidate(): Promise<void> {}

  close(): void {
    this.#channel?.close();
  }
}

const SELF = "peer-a";
const OTHER = "peer-b";

beforeEach(() => {
  FakeConnection.all.length = 0;
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    value: FakeConnection,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "RTCPeerConnection");
});

/** One client in a room whose other members are `peers`, with every message it delivers recorded. */
function room(peers: readonly string[], rtc?: IRtcOptions) {
  const socket = new FakeSocket();
  const value = new Room(
    "ABCDEF",
    socket as unknown as WebSocket,
    { t: "welcome", peerId: SELF, peers: [...peers], state: {} },
    rtc,
  );
  const received: unknown[] = [];
  value.on("message", (data) => received.push(data));
  return { socket, value, received };
}

/** Lets the offer's promise chain settle: `createOffer` and `setLocalDescription` await. */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function channelOf(index = 0): FakeChannel {
  const channel = FakeConnection.all[index]?.channel;
  if (channel === undefined) throw new Error("no data channel was created");
  return channel;
}

describe("the offerer rule", () => {
  it("offers from the smaller peer id only, so two peers never offer at once", async () => {
    const { socket, value } = room([OTHER]);
    await settled();
    expect(socket.frames).toEqual([
      { t: "signal", to: OTHER, data: { k: "offer", sdp: { type: "offer", sdp: "offer-sdp" } } },
    ]);
    expect(channelOf().label).toBe("tn");
    expect(value.transport(OTHER)).toBe("relay");

    // The larger peer id waits for the offer instead of sending one of its own.
    const other = new Room(
      "ABCDEF",
      new FakeSocket() as unknown as WebSocket,
      { t: "welcome", peerId: OTHER, peers: [SELF], state: {} },
      {},
    );
    await settled();
    expect(FakeConnection.all).toHaveLength(1);
    expect(other.transport(SELF)).toBe("relay");
  });
});

describe("the switchover barrier", () => {
  it("puts the barrier on the relay before the first channel message, counting the relay sends", async () => {
    const { socket, value } = room([OTHER]);
    await settled();

    value.send({ i: 0 }, OTHER);
    expect(socket.frames.at(-1)).toEqual({ t: "send", to: OTHER, data: { i: 0 } });

    channelOf().open();
    expect(socket.frames.at(-1)).toEqual({
      t: "send",
      to: OTHER,
      data: { [P2P_SWITCH]: "switch", seq: 1 },
    });
    expect(value.transport(OTHER)).toBe("p2p");

    value.send({ i: 1 }, OTHER);
    expect(channelOf().sent).toEqual([JSON.stringify({ d: { i: 1 } })]);
    expect(value.deliveries(OTHER)).toEqual({ p2p: 0, relay: 0 });
  });

  it("delivers everything relayed before the barrier ahead of everything the channel carried", async () => {
    const { socket, value, received } = room([OTHER]);
    await settled();
    const channel = channelOf();

    // The relay is fast and the channel slower, which is the only order that can break.
    socket.deliver({ t: "message", from: OTHER, data: { i: 0 } });
    socket.deliver({ t: "message", from: OTHER, data: { i: 1 } });
    channel.deliver({ i: 2 });
    channel.deliver({ i: 3 });
    expect(received).toEqual([{ i: 0 }, { i: 1 }]);

    socket.deliver({ t: "message", from: OTHER, data: { [P2P_SWITCH]: "switch", seq: 2 } });
    expect(received).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }]);
    expect(value.deliveries(OTHER)).toEqual({ p2p: 2, relay: 2 });

    // And the relay still carries messages after the switch: a game may deliberately use it.
    socket.deliver({ t: "message", from: OTHER, data: { i: 4 } });
    expect(received.at(-1)).toEqual({ i: 4 });
    expect(value.deliveries(OTHER)).toEqual({ p2p: 2, relay: 3 });
  });

  it("never hands the barrier to a message handler", async () => {
    const { socket, received } = room([OTHER]);
    await settled();
    socket.deliver({ t: "message", from: OTHER, data: { [P2P_SWITCH]: "switch", seq: 0 } });
    expect(received).toEqual([]);
  });

  it("goes back to the relay when the channel closes", async () => {
    const { socket, value } = room([OTHER]);
    await settled();
    channelOf().open();
    expect(value.transport(OTHER)).toBe("p2p");

    channelOf().close();
    expect(value.transport(OTHER)).toBe("relay");
    value.send({ i: 2 }, OTHER);
    expect(socket.frames.at(-1)).toEqual({ t: "send", to: OTHER, data: { i: 2 } });
  });
});

describe("when a channel cannot be used", () => {
  it("stays on the relay in a runtime with no RTCPeerConnection", () => {
    Reflect.deleteProperty(globalThis, "RTCPeerConnection");
    const { socket, value } = room([OTHER]);
    value.send({ i: 0 }, OTHER);
    expect(socket.frames).toEqual([{ t: "send", to: OTHER, data: { i: 0 } }]);
    expect(value.transport(OTHER)).toBe("relay");
    expect(value.deliveries(OTHER)).toEqual({ p2p: 0, relay: 0 });
  });

  it("opens no connection in a room of nine players", async () => {
    const peers = Array.from({ length: 8 }, (_, index) => `peer-${index}`);
    const { value } = room(peers);
    await settled();
    expect(FakeConnection.all).toHaveLength(0);
    expect(value.transport("peer-0")).toBe("relay");
  });

  it("keeps the relay when the pair cannot connect inside the timeout", async () => {
    const { value } = room([OTHER], { connectTimeoutMs: 5 });
    await settled();
    expect(FakeConnection.all).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(value.transport(OTHER)).toBe("relay");
    // A late open is refused: the pair already settled on the relay, and a switch now would
    // reorder against messages that went through it.
    channelOf().open();
    expect(value.transport(OTHER)).toBe("relay");
  });
});
