import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEADER_BYTES,
  type INormalizedOptions,
  type IWebTransportLike,
  KIND_BIND,
  KIND_BOUND,
  KIND_DATA,
  KIND_HELLO,
  KIND_WELCOME,
  encodeFrame,
} from "../src/net-protocol.js";
import { openConnection } from "../src/net-session.js";

const textEncoder = new TextEncoder();
const SESSION_ID = "0123456789abcdef0123456789abcdef";

interface IPipe {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  written: Uint8Array[];
  enqueue(chunk: Uint8Array): void;
  error(reason: unknown): void;
}

function makePipe(
  onWrite?: (chunk: Uint8Array) => void,
  beforeWrite?: (chunk: Uint8Array) => Promise<void> | void,
): IPipe {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(startController) {
      controller = startController;
    },
  });
  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      await beforeWrite?.(chunk);
      written.push(chunk.slice());
      onWrite?.(chunk);
    },
  });
  return {
    readable,
    writable,
    written,
    enqueue: (chunk) => controller.enqueue(chunk),
    error: (reason) => controller.error(reason),
  };
}

interface IDecoded {
  kind: number;
  channel: number;
  payload: Uint8Array;
}

/** Each `writeAll` call carries exactly one complete frame, so decode the chunk alone. */
function decodeAll(buffer: Uint8Array): IDecoded[] {
  const frames: IDecoded[] = [];
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;
  while (offset + HEADER_BYTES <= buffer.length) {
    const length = view.getUint32(offset + 4);
    if (offset + HEADER_BYTES + length > buffer.length) break;
    frames.push({
      kind: buffer[offset + 1] ?? 0,
      channel: view.getUint16(offset + 2),
      payload: buffer.slice(offset + HEADER_BYTES, offset + HEADER_BYTES + length),
    });
    offset += HEADER_BYTES + length;
  }
  return frames;
}

interface IFakeConfig {
  welcome?: Record<string, unknown>;
  welcomeKind?: number;
  welcomeChannel?: number;
  boundKind?: number;
  boundChannel?: number;
  boundPayload?: Uint8Array;
  ready?: Promise<unknown>;
  maxDatagramSize?: number;
  omitMaxDatagramSize?: boolean;
  silent?: boolean;
  createStreamError?: unknown;
  datagramWriteError?: unknown;
  reliableWriteError?: unknown;
  datagramWriteGate?: () => Promise<void>;
  reliableWriteGate?: () => Promise<void>;
  streamGate?: () => Promise<void>;
}

interface IFakeServer {
  transport: IWebTransportLike;
  streams: IPipe[];
  stream(index: number): IPipe;
  datagramWritten: Uint8Array[];
  enqueueDatagram(bytes: Uint8Array): void;
  errorDatagrams(reason: unknown): void;
  dropWith(reason: unknown): void;
  rejectWith(reason: unknown): void;
  closeCalls: number;
}

function makeServer(config: IFakeConfig = {}): IFakeServer {
  let closeResolve!: (value: unknown) => void;
  let closeReject!: (reason: unknown) => void;
  const closed = new Promise<unknown>((resolve, reject) => {
    closeResolve = resolve;
    closeReject = reject;
  });
  const streams: IPipe[] = [];
  const datagramPipe = makePipe(
    undefined,
    config.datagramWriteError === undefined && config.datagramWriteGate === undefined
      ? undefined
      : async () => {
          await config.datagramWriteGate?.();
          if (config.datagramWriteError !== undefined) throw config.datagramWriteError;
        },
  );
  let closeCalls = 0;

  const handleStream = (pipe: IPipe, chunk: Uint8Array): void => {
    if (config.silent === true) return;
    for (const frame of decodeAll(chunk)) {
      if (frame.kind === KIND_HELLO) {
        const hello = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<
          string,
          unknown
        >;
        const welcome = {
          applicationProtocol: hello.applicationProtocol,
          sessionId: SESSION_ID,
          channels: hello.channels,
          maxReliableMessageBytes: hello.maxReliableMessageBytes,
          maxQueuedReliableBytes: hello.maxQueuedReliableBytes,
          maxQueuedDatagrams: hello.maxQueuedDatagrams,
          ...config.welcome,
        };
        pipe.enqueue(
          encodeFrame(
            config.welcomeKind ?? KIND_WELCOME,
            config.welcomeChannel ?? 0,
            textEncoder.encode(JSON.stringify(welcome)),
          ),
        );
      } else if (frame.kind === KIND_BIND) {
        pipe.enqueue(
          encodeFrame(
            config.boundKind ?? KIND_BOUND,
            config.boundChannel ?? frame.channel,
            config.boundPayload ?? new Uint8Array(0),
          ),
        );
      }
    }
  };

  const datagrams: IWebTransportLike["datagrams"] = {
    readable: datagramPipe.readable,
    writable: datagramPipe.writable,
  };
  if (!config.omitMaxDatagramSize) datagrams.maxDatagramSize = config.maxDatagramSize ?? 1200;

  const transport: IWebTransportLike = {
    ready: config.ready ?? Promise.resolve(),
    closed,
    datagrams,
    createBidirectionalStream() {
      if (config.createStreamError !== undefined) throw config.createStreamError;
      const create = (): {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      } => {
        const isControl = streams.length === 0;
        const beforeWrite =
          !isControl &&
          (config.reliableWriteError !== undefined || config.reliableWriteGate !== undefined)
            ? async (chunk: Uint8Array): Promise<void> => {
                if (decodeAll(chunk).some((frame) => frame.kind === KIND_DATA)) {
                  await config.reliableWriteGate?.();
                  if (config.reliableWriteError !== undefined) throw config.reliableWriteError;
                }
              }
            : undefined;
        const pipe = makePipe((chunk) => handleStream(pipe, chunk), beforeWrite);
        streams.push(pipe);
        return { readable: pipe.readable, writable: pipe.writable };
      };
      return config.streamGate === undefined ? create() : config.streamGate().then(create);
    },
    close() {
      closeCalls += 1;
      closeResolve({ reason: null });
    },
  };

  return {
    transport,
    streams,
    stream(index) {
      const pipe = streams[index];
      if (pipe === undefined) throw new Error(`stream ${index} was never created`);
      return pipe;
    },
    datagramWritten: datagramPipe.written,
    enqueueDatagram: (bytes) => datagramPipe.enqueue(bytes),
    errorDatagrams: (reason) => datagramPipe.error(reason),
    dropWith: (reason) => closeResolve({ reason }),
    rejectWith: (reason) => closeReject(reason),
    get closeCalls() {
      return closeCalls;
    },
  };
}

function install(transport: IWebTransportLike | undefined): void {
  (globalThis as Record<string, unknown>).WebTransport =
    transport === undefined
      ? undefined
      : function FakeWebTransportConstructor() {
          return transport;
        };
}

function normalized(overrides: Partial<INormalizedOptions> = {}): INormalizedOptions {
  return {
    applicationProtocol: "threenative-smoke/1",
    credential: "opaque-token",
    channels: [
      { id: 1, delivery: "unreliable" },
      { id: 2, delivery: "reliable-ordered" },
    ],
    signal: undefined,
    connectTimeoutMs: 1000,
    maxReliableMessageBytes: 65536,
    maxQueuedReliableBytes: 1048576,
    maxQueuedDatagrams: 256,
    ...overrides,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const microtasks = async (count = 12): Promise<void> => {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
};

afterEach(() => {
  (globalThis as Record<string, unknown>).WebTransport = undefined;
  vi.useRealTimers();
});

describe("openConnection", () => {
  it("reports an unavailable transport when WebTransport is missing", async () => {
    install(undefined);
    await expect(openConnection("https://example.test/game", normalized())).rejects.toThrow(
      /TN_NET_UNAVAILABLE/,
    );
  });

  it("rejects before connecting when the signal is already aborted", async () => {
    install(makeServer().transport);
    const controller = new AbortController();
    controller.abort();
    await expect(
      openConnection("https://example.test/game", normalized({ signal: controller.signal })),
    ).rejects.toThrow(/TN_NET_CANCELLED/);
  });

  it("surfaces a transport that never becomes ready", async () => {
    install(makeServer({ ready: Promise.reject(new Error("ready failed")) }).transport);
    await expect(openConnection("https://example.test/game", normalized())).rejects.toThrow(
      "ready failed",
    );
  });

  it("times out a transport that stays pending", async () => {
    vi.useFakeTimers();
    const server = makeServer({ ready: new Promise(() => {}) });
    install(server.transport);
    const pending = openConnection(
      "https://example.test/game",
      normalized({ connectTimeoutMs: 50 }),
    );
    const rejection = expect(pending).rejects.toThrow(/TN_NET_TIMEOUT/);
    await vi.advanceTimersByTimeAsync(60);
    await rejection;
    expect(server.closeCalls).toBeGreaterThan(0);
  });

  it("times out a transport whose handshake stream never opens and closes it", async () => {
    vi.useFakeTimers();
    const server = makeServer({ streamGate: () => new Promise(() => {}) });
    install(server.transport);
    const pending = openConnection(
      "https://example.test/game",
      normalized({ connectTimeoutMs: 20 }),
    );
    const rejection = expect(pending).rejects.toThrow(/TN_NET_TIMEOUT/);
    await vi.advanceTimersByTimeAsync(30);
    await rejection;
    expect(server.closeCalls).toBeGreaterThan(0);
  });

  it("cancels a stalled handshake when the caller aborts", async () => {
    const server = makeServer({ streamGate: () => new Promise(() => {}) });
    install(server.transport);
    const controller = new AbortController();
    const pending = openConnection(
      "https://example.test/game",
      normalized({ signal: controller.signal, connectTimeoutMs: 10_000 }),
    );
    const rejection = expect(pending).rejects.toThrow(/TN_NET_CANCELLED/);
    await microtasks();
    controller.abort();
    await rejection;
    expect(server.closeCalls).toBeGreaterThan(0);
  });

  it("rejects a WELCOME frame with the wrong kind or channel", async () => {
    for (const config of [{ welcomeKind: KIND_BIND }, { welcomeChannel: 3 }] as IFakeConfig[]) {
      const server = makeServer(config);
      install(server.transport);
      await expect(openConnection("https://example.test/game", normalized())).rejects.toThrow(
        /TN_NET_PROTOCOL: expected WELCOME/,
      );
      expect(server.closeCalls).toBeGreaterThan(0);
    }
  });

  it("rejects a WELCOME channel list that differs from the request", async () => {
    install(makeServer({ welcome: { channels: [{ id: 1, delivery: "unreliable" }] } }).transport);
    await expect(openConnection("https://example.test/game", normalized())).rejects.toThrow(
      /TN_NET_PROTOCOL: WELCOME channels mismatch/,
    );
  });

  it("reports datagram support missing when maxDatagramSize is absent or fractional", async () => {
    for (const config of [
      { omitMaxDatagramSize: true },
      { maxDatagramSize: 1200.5 },
    ] as IFakeConfig[]) {
      install(makeServer(config).transport);
      await expect(openConnection("https://example.test/game", normalized())).rejects.toThrow(
        /TN_NET_UNAVAILABLE: datagram support is missing/,
      );
    }
  });

  it("rejects a BOUND frame with the wrong kind, channel, or payload", async () => {
    for (const config of [
      { boundKind: KIND_DATA },
      { boundChannel: 9 },
      { boundPayload: new Uint8Array([1]) },
    ] as IFakeConfig[]) {
      install(makeServer(config).transport);
      await expect(openConnection("https://example.test/game", normalized())).rejects.toThrow(
        /TN_NET_PROTOCOL: (expected BOUND|BOUND carries payload)/,
      );
    }
  });
});

describe("net session", () => {
  it("bounds reliable sends and resumes once the queue flushes", async () => {
    const server = makeServer();
    install(server.transport);
    const connection = await openConnection(
      "https://example.test/game",
      normalized({ maxReliableMessageBytes: 6, maxQueuedReliableBytes: 10 }),
    );
    try {
      expect(() => connection.send(2, new Uint8Array(7))).toThrow(/TN_NET_MESSAGE_TOO_LARGE/);
      expect(connection.send(2, new Uint8Array(6))).toBe(true);
      expect(connection.send(2, new Uint8Array(6))).toBe(false);
      expect(connection.getStats().queuedReliableBytes).toBe(6);

      await tick();
      expect(connection.getStats().queuedReliableBytes).toBe(0);
      expect(connection.send(2, new Uint8Array(6))).toBe(true);
      await tick();

      const payloads = server
        .stream(1)
        .written.slice(1)
        .map((frame) => Array.from(frame.slice(HEADER_BYTES)));
      expect(payloads).toContainEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      await connection.close();
    }
  });

  it("rejects an oversized datagram", async () => {
    install(makeServer().transport);
    const connection = await openConnection("https://example.test/game", normalized());
    try {
      const limit = connection.getStats().maxDatagramPayload;
      expect(limit).toBe(1200 - HEADER_BYTES);
      expect(() => connection.send(1, new Uint8Array(limit + 1))).toThrow(
        /TN_NET_MESSAGE_TOO_LARGE/,
      );
    } finally {
      await connection.close();
    }
  });

  it("evicts the oldest queued datagram when the send queue is full", async () => {
    const server = makeServer();
    install(server.transport);
    const connection = await openConnection(
      "https://example.test/game",
      normalized({ maxQueuedDatagrams: 2 }),
    );
    try {
      expect(connection.send(1, new Uint8Array([1]))).toBe(true);
      expect(connection.send(1, new Uint8Array([2]))).toBe(true);
      expect(connection.send(1, new Uint8Array([3]))).toBe(true);
      expect(connection.getStats().droppedDatagrams).toBe(1);

      await tick();
      const payloads = server.datagramWritten.map((frame) => Array.from(frame.slice(HEADER_BYTES)));
      expect(payloads).toContainEqual([2]);
      expect(payloads).toContainEqual([3]);
      expect(payloads).not.toContainEqual([1]);
    } finally {
      await connection.close();
    }
  });

  it("drains received messages and reports a disconnect exactly once", async () => {
    const server = makeServer();
    install(server.transport);
    const connection = await openConnection("https://example.test/game", normalized());
    try {
      server.enqueueDatagram(encodeFrame(KIND_DATA, 1, new Uint8Array([7, 8])));
      await tick();
      const drained = connection.poll();
      expect(drained.disconnected).toBe(false);
      expect(drained.messages).toHaveLength(1);
      expect(drained.messages[0]?.channel).toBe(1);
      expect(Array.from(drained.messages[0]?.data ?? [])).toEqual([7, 8]);

      server.dropWith("peer gone");
      await tick();
      expect(connection.poll()).toMatchObject({ disconnected: true, reason: "peer gone" });
      expect(connection.poll()).toEqual({ messages: [], disconnected: false, reason: null });
    } finally {
      await connection.close();
    }
  });

  it("closes idempotently and clears queued work", async () => {
    install(makeServer().transport);
    const connection = await openConnection("https://example.test/game", normalized());
    connection.send(2, new Uint8Array([1, 2, 3]));
    connection.send(1, new Uint8Array([4]));
    expect(connection.getStats().queuedReliableBytes).toBe(3);
    expect(connection.getStats().queuedDatagrams).toBe(1);

    const first = connection.close();
    const second = connection.close();
    expect(first).toBe(second);
    await first;

    const stats = connection.getStats();
    expect(stats.state).toBe("closed");
    expect(stats.queuedReliableBytes).toBe(0);
    expect(stats.queuedDatagrams).toBe(0);
    expect(() => connection.send(1, new Uint8Array([9]))).toThrow(/TN_NET_CLOSED/);
  });

  it("reports the negotiated session and queue limits", async () => {
    install(makeServer().transport);
    const connection = await openConnection("https://example.test/game", normalized());
    try {
      expect(connection.getStats()).toMatchObject({
        transport: "webtransport",
        sessionId: SESSION_ID,
        maxDatagramPayload: 1200 - HEADER_BYTES,
        maxReliableMessageBytes: 65536,
        maxQueuedReliableBytes: 1048576,
        maxQueuedDatagrams: 256,
        state: "connected",
        queuedReliableBytes: 0,
        queuedDatagrams: 0,
        droppedDatagrams: 0,
        rttMs: null,
      });
    } finally {
      await connection.close();
    }
  });
});

describe("net session failure paths", () => {
  it("wraps a non-protocol handshake failure and reports a non-Error as unavailable", async () => {
    install(makeServer({ createStreamError: new Error("boom") }).transport);
    await expect(openConnection("https://example.test/game", normalized())).rejects.toThrow(
      "TN_NET_PROTOCOL: boom",
    );
    install(makeServer({ createStreamError: "plain" }).transport);
    await expect(openConnection("https://example.test/game", normalized())).rejects.toThrow(
      "TN_NET_UNAVAILABLE: handshake failed",
    );
  });

  it("rejects a handshake payload that exceeds the hello budget", async () => {
    install(makeServer().transport);
    await expect(
      openConnection("https://example.test/game", normalized({ credential: "x".repeat(5000) })),
    ).rejects.toThrow(/TN_NET_INVALID_ARGUMENT: handshake payload exceeds 4096 bytes/u);
  });

  it("distinguishes a reasonless close from a rejected transport", async () => {
    const silentReason = makeServer();
    install(silentReason.transport);
    const first = await openConnection("https://example.test/game", normalized());
    silentReason.dropWith(null);
    await microtasks();
    expect(first.poll()).toMatchObject({ disconnected: true, reason: null });
    await first.close();

    const reasonless = makeServer();
    install(reasonless.transport);
    const second = await openConnection("https://example.test/game", normalized());
    reasonless.dropWith(42);
    await microtasks();
    expect(second.poll()).toMatchObject({ disconnected: true, reason: "transport closed" });
    await second.close();

    const failing = makeServer();
    install(failing.transport);
    const third = await openConnection("https://example.test/game", normalized());
    failing.rejectWith(new Error("socket reset"));
    await microtasks();
    expect(third.poll()).toMatchObject({ disconnected: true, reason: "transport error" });
    await third.close();
  });

  it("disconnects on an unexpected reliable stream frame", async () => {
    const server = makeServer();
    install(server.transport);
    const connection = await openConnection("https://example.test/game", normalized());
    server.stream(1).enqueue(encodeFrame(KIND_DATA, 3, new Uint8Array([1])));
    await microtasks();
    expect(connection.poll()).toMatchObject({ disconnected: true, reason: "transport error" });
    await connection.close();
  });

  it("drops undecodable, wrong-kind, and wrong-channel datagrams", async () => {
    const server = makeServer();
    install(server.transport);
    const connection = await openConnection("https://example.test/game", normalized());
    server.enqueueDatagram(new Uint8Array([1, 2, 3]));
    server.enqueueDatagram(encodeFrame(KIND_BIND, 1, new Uint8Array(0)));
    server.enqueueDatagram(encodeFrame(KIND_DATA, 2, new Uint8Array([1])));
    server.enqueueDatagram(encodeFrame(KIND_DATA, 1, new Uint8Array([9])));
    await microtasks();
    const polled = connection.poll();
    expect(polled.messages.map((message) => Array.from(message.data))).toEqual([[9]]);
    expect(connection.getStats().droppedDatagrams).toBe(3);
    await connection.close();
  });

  it("evicts the oldest received datagram when the receive window is full", async () => {
    const server = makeServer();
    install(server.transport);
    const connection = await openConnection(
      "https://example.test/game",
      normalized({ maxQueuedDatagrams: 1 }),
    );
    server.enqueueDatagram(encodeFrame(KIND_DATA, 1, new Uint8Array([1])));
    server.enqueueDatagram(encodeFrame(KIND_DATA, 1, new Uint8Array([2])));
    await microtasks();
    expect(connection.poll().messages.map((message) => Array.from(message.data))).toEqual([[2]]);
    expect(connection.getStats().droppedDatagrams).toBe(1);
    await connection.close();
  });

  it("holds a reliable frame until the receive window has room and never reorders", async () => {
    const server = makeServer();
    install(server.transport);
    const connection = await openConnection(
      "https://example.test/game",
      normalized({ maxReliableMessageBytes: 6, maxQueuedReliableBytes: 10 }),
    );
    server.stream(1).enqueue(encodeFrame(KIND_DATA, 2, new Uint8Array([1, 1, 1, 1, 1, 1])));
    server.stream(1).enqueue(encodeFrame(KIND_DATA, 2, new Uint8Array([2, 2, 2, 2, 2, 2])));
    server.stream(1).enqueue(encodeFrame(KIND_DATA, 2, new Uint8Array([3, 3, 3])));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const first = connection.poll().messages;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rest = connection.poll().messages;
    expect([...first, ...rest].map((message) => Array.from(message.data))).toEqual([
      [1, 1, 1, 1, 1, 1],
      [2, 2, 2, 2, 2, 2],
      [3, 3, 3],
    ]);
    expect(connection.getStats().droppedDatagrams).toBe(0);
    await connection.close();
  });

  it("pauses reliable reads at saturation and stops on close", async () => {
    vi.useFakeTimers();
    const server = makeServer();
    install(server.transport);
    const connection = await openConnection(
      "https://example.test/game",
      normalized({ maxReliableMessageBytes: 6, maxQueuedReliableBytes: 6 }),
    );
    server.stream(1).enqueue(encodeFrame(KIND_DATA, 2, new Uint8Array(6)));
    server.stream(1).enqueue(encodeFrame(KIND_DATA, 2, new Uint8Array(6)));
    await vi.advanceTimersByTimeAsync(0);
    const closed = connection.close();
    await vi.advanceTimersByTimeAsync(20);
    await closed;
    expect(connection.getStats().state).toBe("closed");
  });

  it("disconnects when the datagram stream errors", async () => {
    const server = makeServer();
    install(server.transport);
    const connection = await openConnection("https://example.test/game", normalized());
    server.errorDatagrams(new Error("datagram boom"));
    await microtasks();
    expect(connection.poll()).toMatchObject({ disconnected: true, reason: "transport error" });
    await connection.close();
  });

  it("cancels the datagram stream when the session closes", async () => {
    const server = makeServer();
    install(server.transport);
    const connection = await openConnection("https://example.test/game", normalized());
    server.enqueueDatagram(encodeFrame(KIND_DATA, 1, new Uint8Array([5])));
    await connection.close();
    await microtasks();
    expect(connection.getStats().state).toBe("closed");
  });

  it("disconnects when a queued datagram write fails", async () => {
    const server = makeServer({ datagramWriteError: new Error("write failed") });
    install(server.transport);
    const connection = await openConnection("https://example.test/game", normalized());
    connection.send(1, new Uint8Array([1]));
    await microtasks();
    expect(connection.poll()).toMatchObject({ disconnected: true, reason: "transport error" });
    await connection.close();
  });

  it("disconnects when a queued reliable write fails", async () => {
    const server = makeServer({ reliableWriteError: new Error("write failed") });
    install(server.transport);
    const connection = await openConnection("https://example.test/game", normalized());
    connection.send(2, new Uint8Array([1]));
    await microtasks();
    expect(connection.poll()).toMatchObject({ disconnected: true, reason: "transport error" });
    await connection.close();
  });

  it("rejects sends on an unknown channel or with non-byte data", async () => {
    install(makeServer().transport);
    const connection = await openConnection("https://example.test/game", normalized());
    try {
      expect(() => connection.send(99, new Uint8Array([1]))).toThrow(/unknown channel/u);
      expect(() => connection.send(1, "nope" as never)).toThrow(/data must be bytes/u);
    } finally {
      await connection.close();
    }
  });

  it("closes the transport when the signal aborts before ready", async () => {
    const server = makeServer({ ready: new Promise(() => {}) });
    install(server.transport);
    const controller = new AbortController();
    const pending = openConnection(
      "https://example.test/game",
      normalized({ signal: controller.signal }),
    );
    const rejection = expect(pending).rejects.toThrow(/TN_NET_CANCELLED/u);
    await microtasks();
    controller.abort();
    await rejection;
    expect(server.closeCalls).toBeGreaterThan(0);
  });

  it("reports cancellation when the signal aborts as ready settles", async () => {
    let resolveReady!: () => void;
    const server = makeServer({
      ready: new Promise<void>((resolve) => {
        resolveReady = resolve;
      }),
    });
    install(server.transport);
    const controller = new AbortController();
    const pending = openConnection(
      "https://example.test/game",
      normalized({ signal: controller.signal }),
    );
    const rejection = expect(pending).rejects.toThrow(/TN_NET_CANCELLED/u);
    resolveReady();
    controller.abort();
    await rejection;
  });

  it("recounts queued reliable bytes when polling leaves messages behind", async () => {
    const server = makeServer();
    install(server.transport);
    const connection = await openConnection(
      "https://example.test/game",
      normalized({
        maxReliableMessageBytes: 6,
        maxQueuedReliableBytes: 100,
        maxQueuedDatagrams: 1,
      }),
    );
    for (const byte of [1, 2, 3])
      server.stream(1).enqueue(encodeFrame(KIND_DATA, 2, new Uint8Array([byte])));
    await microtasks();
    expect(connection.poll().messages).toHaveLength(2);
    expect(connection.getStats().state).toBe("connected");
    await connection.close();
  });

  it("reschedules a flush for work queued while a write was in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = makeServer({ reliableWriteGate: () => gate });
    install(server.transport);
    const connection = await openConnection("https://example.test/game", normalized());
    connection.send(2, new Uint8Array([1]));
    await microtasks();
    connection.send(1, new Uint8Array([2]));
    release();
    await microtasks(20);
    expect(connection.getStats().queuedDatagrams).toBe(0);
    await connection.close();
  });

  it("stops flushing datagrams once the transport drops mid-write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = makeServer({ datagramWriteGate: () => gate });
    install(server.transport);
    const connection = await openConnection("https://example.test/game", normalized());
    connection.send(1, new Uint8Array([1]));
    await microtasks();
    connection.send(1, new Uint8Array([2]));
    server.dropWith("gone");
    release();
    await microtasks(20);
    expect(connection.getStats().state).toBe("closed");
    await connection.close();
  });

  it("stops a reliable flush once the transport drops mid-write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = makeServer({ reliableWriteGate: () => gate });
    install(server.transport);
    const connection = await openConnection("https://example.test/game", normalized());
    connection.send(2, new Uint8Array([1]));
    await microtasks();
    connection.send(2, new Uint8Array([2]));
    server.dropWith("gone");
    release();
    await microtasks(20);
    expect(connection.getStats().state).toBe("closed");
    await connection.close();
  });

  it("reports cancellation when the signal aborts during the handshake", async () => {
    vi.useFakeTimers();
    install(makeServer({ silent: true }).transport);
    const controller = new AbortController();
    const pending = openConnection(
      "https://example.test/game",
      normalized({ signal: controller.signal, connectTimeoutMs: 50 }),
    );
    const rejection = expect(pending).rejects.toThrow(/TN_NET_CANCELLED/u);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(60);
    await rejection;
  });
});
