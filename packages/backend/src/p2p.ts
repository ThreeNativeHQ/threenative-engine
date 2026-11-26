/**
 * Peer to peer for room messages: one ordered data channel per pair of players, plus the
 * switchover barrier that keeps the room's order across the change of transport.
 *
 * Signaling rides the room's own WebSocket — the Durable Object relays a `signal` frame to exactly
 * one peer — so a room needs no second connection to negotiate. The smaller peer id offers, so two
 * players never offer to each other at once. Only `room.send()` traffic takes the channel: `join`,
 * `leave`, `state` and signaling keep the room's order.
 *
 * Ordering is the whole problem. A sender that finished relaying and starts sending on the channel
 * has two paths, and the channel may overtake the relay. So the moment a channel opens, the sender
 * puts a barrier on the relay (`{ __tn: "switch", seq }`, where `seq` counts the relay sends it has
 * made to that peer) and only then uses the channel; the receiver holds everything the channel
 * carries until that barrier arrives, then delivers it in order. No handler ever sees a barrier.
 *
 * A runtime with no `RTCPeerConnection` (Node, the native host) stays on the relay with no error,
 * and so does a pair whose channel fails or does not open within `connectTimeoutMs`, and a room
 * over `P2P_PLAYERS_MAX` members.
 */

/** Cloudflare's public STUN server: the only one, because this package ships no TURN relay. */
export const P2P_ICE_SERVERS: readonly RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
/** How long one pair may spend connecting before it settles on the relay. */
export const P2P_CONNECT_TIMEOUT_MS = 5_000;
/** A mesh of n players is n(n-1)/2 connections: past this many, the room stays on the relay. */
export const P2P_PLAYERS_MAX = 8;
/** The one ordered channel between two players. */
export const P2P_CHANNEL_LABEL = "tn";
/** The key that marks a switchover barrier, which no message handler ever sees. */
export const P2P_SWITCH = "__tn";

/** How a room upgrades its messages, and how a test forces the relay. */
export interface IRtcOptions {
  /** ICE servers for the data channels: public STUN by default, no TURN. */
  readonly iceServers?: readonly RTCIceServer[];
  /** `"relay"` keeps only relayed candidates, which needs a TURN server; the default `"all"` does not. */
  readonly iceTransportPolicy?: RTCIceTransportPolicy;
  /** How long one pair may spend connecting before it settles on the relay. */
  readonly connectTimeoutMs?: number;
}

/** A signal frame's body, as the other peer reads it. */
type SignalData =
  | { readonly k: "offer"; readonly sdp: RTCSessionDescriptionInit }
  | { readonly k: "answer"; readonly sdp: RTCSessionDescriptionInit }
  | { readonly k: "ice"; readonly c: RTCIceCandidateInit };

/** What one pair has: one connection, one channel, and the barrier's accounting. */
interface IPeerLink {
  connection: RTCPeerConnection | undefined;
  channel: RTCDataChannel | undefined;
  /** The channel opened and the barrier went out: sends take the channel from here on. */
  live: boolean;
  /** Relay sends of room messages to this peer so far: the `seq` the barrier carries. */
  sent: number;
  /** Channel messages that arrived before this peer's barrier. */
  pending: unknown[];
  /** The peer's barrier arrived: what the channel carried may now be delivered. */
  switched: boolean;
  /** Undefined once the pair is settled, so a late open cannot switch after the fact. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** One queue per peer, so an ICE candidate can never be handled before its offer. */
  queue: Promise<void>;
  /** Messages delivered from this peer, by path: a debug counter, never game state. */
  counts: { p2p: number; relay: number };
}

/** What one client in a room gives the link layer: its socket, and where its messages go. */
export interface IPeerLinkHost {
  /** This client's peer id: the tie-break for which side offers. */
  readonly self: string;
  /** Puts a signal on the room socket; the room relays it to exactly this peer. */
  signal(to: string, data: unknown): void;
  /** Puts a room message on the socket when the channel is not carrying it. */
  relay(to: string, data: unknown): void;
  /** Hands a peer's message to the room's message handlers, in order. */
  deliver(from: string, data: unknown): void;
}

/** A value a room may carry: JSON, exactly what the relay carries. */
function carried(data: unknown): { readonly d: unknown } {
  return { d: data };
}

/** The message a channel frame carries, or `undefined` when it is not one. */
function carriedData(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { d?: unknown }).d
      : undefined;
  } catch {
    return undefined;
  }
}

/** The barrier a peer sent, or `undefined` for an ordinary message. */
function switchOf(data: unknown): { readonly seq: number } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const frame = data as Record<string, unknown>;
  if (frame[P2P_SWITCH] !== "switch") return undefined;
  return { seq: typeof frame.seq === "number" ? frame.seq : 0 };
}

/** The signal a peer sent, or `undefined` when a frame is not one this client speaks. */
function signalOf(data: unknown): SignalData | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const frame = data as Record<string, unknown>;
  if (frame.k === "ice") {
    const candidate = frame.c as RTCIceCandidateInit | undefined;
    return candidate === undefined ? undefined : { k: "ice", c: candidate };
  }
  if (frame.k === "offer" || frame.k === "answer") {
    const sdp = frame.sdp as RTCSessionDescriptionInit | undefined;
    if (sdp === undefined) return undefined;
    return { k: frame.k, sdp };
  }
  return undefined;
}

/** `RTCPeerConnection` in this runtime: the page has it, Node and the native host do not. */
function rtcAvailable(): boolean {
  return typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === "function";
}

/**
 * The links a room has to its peers, if the runtime and the pair allow one.
 *
 * Room supplies the socket; this class owns the connection state, the barrier and the counters.
 */
export class PeerLinks {
  readonly #links = new Map<string, IPeerLink>();
  readonly #host: IPeerLinkHost;
  readonly #options: IRtcOptions;

  constructor(host: IPeerLinkHost, options: IRtcOptions = {}) {
    this.#host = host;
    this.#options = options;
  }

  /** Offers to this peer when this client is the smaller id; the larger id waits for the offer. */
  add(peerId: string): void {
    const link = this.#link(peerId);
    if (!rtcAvailable() || link.connection !== undefined) return;
    // The smaller id offers: with both sides applying that rule, exactly one side does.
    if (this.#host.self >= peerId) return;
    this.#offer(peerId, link);
  }

  /** The peer left: nothing it sent can be delivered, and the connection goes with it. */
  remove(peerId: string): void {
    this.#settle(peerId);
    this.#links.delete(peerId);
  }

  /** The room is too large for a mesh or is closing: every pair goes back to the relay. */
  reset(): void {
    for (const peerId of [...this.#links.keys()]) this.#settle(peerId);
  }

  /** "p2p" once this pair's channel is open and carrying messages, "relay" otherwise. */
  transport(peerId: string): "relay" | "p2p" {
    return this.#links.get(peerId)?.live === true ? "p2p" : "relay";
  }

  /** How many messages from this peer arrived over the channel, and how many over the relay. */
  deliveries(peerId: string): { readonly p2p: number; readonly relay: number } {
    const link = this.#links.get(peerId);
    return link === undefined ? { p2p: 0, relay: 0 } : { ...link.counts };
  }

  /** True while any pair is carrying messages, which is when a broadcast has to go per peer. */
  anyLive(): boolean {
    for (const link of this.#links.values()) if (link.live) return true;
    return false;
  }

  /** A room message to one peer: the channel when it is carrying, the relay otherwise. */
  send(peerId: string, data: unknown): void {
    const link = this.#link(peerId);
    const channel = link.live ? link.channel : undefined;
    if (channel !== undefined && channel.readyState === "open") {
      channel.send(JSON.stringify(carried(data)));
      return;
    }
    link.sent += 1;
    this.#host.relay(peerId, data);
  }

  /** A signal from one peer, handled in arrival order behind that peer's earlier signals. */
  receive(from: string, data: unknown): void {
    const link = this.#link(from);
    link.queue = link.queue
      .then(() => this.#signal(from, link, signalOf(data)))
      .catch(() => this.#settle(from));
  }

  /**
   * A message the room relayed. The barrier is order, not traffic: everything the relay carried
   * before it goes out before what the channel already holds, and the barrier itself goes nowhere.
   */
  receiveRelay(from: string, data: unknown): void {
    const link = this.#link(from);
    const barrier = switchOf(data);
    if (barrier !== undefined && !link.switched) {
      link.switched = true;
      const pending = link.pending;
      link.pending = [];
      for (const message of pending) {
        link.counts.p2p += 1;
        this.#host.deliver(from, message);
      }
      return;
    }
    link.counts.relay += 1;
    this.#host.deliver(from, data);
  }

  #link(peerId: string): IPeerLink {
    const existing = this.#links.get(peerId);
    if (existing !== undefined) return existing;
    const link: IPeerLink = {
      channel: undefined,
      connection: undefined,
      counts: { p2p: 0, relay: 0 },
      live: false,
      pending: [],
      queue: Promise.resolve(),
      sent: 0,
      switched: false,
      timer: undefined,
    };
    this.#links.set(peerId, link);
    return link;
  }

  #config(): RTCConfiguration {
    return {
      iceServers: [...(this.#options.iceServers ?? P2P_ICE_SERVERS)],
      ...(this.#options.iceTransportPolicy === undefined
        ? {}
        : { iceTransportPolicy: this.#options.iceTransportPolicy }),
    };
  }

  #timeout(): number {
    return this.#options.connectTimeoutMs ?? P2P_CONNECT_TIMEOUT_MS;
  }

  #offer(peerId: string, link: IPeerLink): void {
    const connection = new RTCPeerConnection(this.#config());
    link.connection = connection;
    this.#watch(peerId, link, connection);
    this.#arm(peerId, link);
    const channel = connection.createDataChannel(P2P_CHANNEL_LABEL, { ordered: true });
    this.#watchChannel(peerId, link, channel);
    link.queue = (async () => {
      await connection.setLocalDescription(await connection.createOffer());
      const description = connection.localDescription;
      if (description !== null) {
        this.#host.signal(peerId, {
          k: "offer",
          sdp: { type: description.type, sdp: description.sdp },
        });
      }
    })();
    link.queue = link.queue.catch(() => this.#settle(peerId));
  }

  /** A signal from the peer, in the order its sender produced them. */
  async #signal(from: string, link: IPeerLink, signal: SignalData | undefined): Promise<void> {
    if (signal === undefined || link.connection === undefined) {
      if (signal?.k !== "offer") return;
      this.#answer(from, link, signal.sdp);
      return;
    }
    if (signal.k === "answer") {
      await link.connection.setRemoteDescription(signal.sdp);
      return;
    }
    if (signal.k === "ice") await link.connection.addIceCandidate(signal.c);
  }

  /** The offer's other half: one connection, the channel it carries, then an answer. */
  #answer(from: string, link: IPeerLink, sdp: RTCSessionDescriptionInit): void {
    const connection = new RTCPeerConnection(this.#config());
    link.connection = connection;
    this.#watch(from, link, connection);
    this.#arm(from, link);
    connection.ondatachannel = (event) => {
      if (event.channel.label !== P2P_CHANNEL_LABEL) return;
      this.#watchChannel(from, link, event.channel);
    };
    link.queue = (async () => {
      await connection.setRemoteDescription(sdp);
      await connection.setLocalDescription(await connection.createAnswer());
      const description = connection.localDescription;
      if (description !== null) {
        this.#host.signal(from, {
          k: "answer",
          sdp: { type: description.type, sdp: description.sdp },
        });
      }
    })();
    link.queue = link.queue.catch(() => this.#settle(from));
  }

  #watch(peerId: string, link: IPeerLink, connection: RTCPeerConnection): void {
    connection.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (candidate === null) return;
      this.#host.signal(peerId, {
        k: "ice",
        c: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        },
      });
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        this.#settle(peerId);
      }
    };
  }

  #watchChannel(peerId: string, link: IPeerLink, channel: RTCDataChannel): void {
    link.channel = channel;
    channel.onopen = () => this.#open(peerId, link, channel);
    channel.onmessage = (event) => this.#receive(peerId, link, event.data);
    channel.onclose = () => this.#settle(peerId);
    channel.onerror = () => this.#settle(peerId);
  }

  /** The switchover: the barrier goes on the relay, and only then does anything use the channel. */
  #open(peerId: string, link: IPeerLink, channel: RTCDataChannel): void {
    if (link.live || link.channel !== channel || link.timer === undefined) return;
    clearTimeout(link.timer);
    link.timer = undefined;
    link.live = true;
    const seq = link.sent;
    link.sent += 1;
    this.#host.relay(peerId, { [P2P_SWITCH]: "switch", seq });
  }

  #receive(peerId: string, link: IPeerLink, text: unknown): void {
    const data = carriedData(text);
    if (!link.switched) {
      link.pending.push(data);
      return;
    }
    link.counts.p2p += 1;
    this.#host.deliver(peerId, data);
  }

  /** Starts the connect deadline: an open after it is refused, so order cannot break late. */
  #arm(peerId: string, link: IPeerLink): void {
    link.timer = setTimeout(() => this.#settle(peerId), this.#timeout());
  }

  /** Gives up on this pair's channel: back to the relay, and whatever it carried is delivered. */
  #settle(peerId: string): void {
    const link = this.#links.get(peerId);
    if (link === undefined) return;
    if (link.timer !== undefined) clearTimeout(link.timer);
    link.timer = undefined;
    link.live = false;
    link.channel = undefined;
    const connection = link.connection;
    link.connection = undefined;
    connection?.close();
    const pending = link.pending;
    link.pending = [];
    for (const message of pending) {
      link.counts.p2p += 1;
      this.#host.deliver(peerId, message);
    }
  }
}
