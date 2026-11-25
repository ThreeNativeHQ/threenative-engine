# Networking

Open a message channel between a game client and a server, send ordered actions and unreliable
state, and keep replication in your own code. `connect` from `@threenative/core/net` is the whole
engine surface.

## Connect

```ts
import { connect } from "@threenative/core/net";

const connection = await connect("https://game.example/play", {
  applicationProtocol: "my-game/1",
  credential,
  channels: [
    { id: 1, delivery: "reliable-ordered" },
    { id: 2, delivery: "unreliable" },
  ],
});
```

| Option | Meaning |
| --- | --- |
| `applicationProtocol` | The protocol string the server must also declare |
| `credential` | Supplied by your game's own identity flow. The engine never issues one |
| `channels` | The channels you will use, each `"reliable-ordered"` or `"unreliable"` |
| `connectTimeoutMs`, `maxReliableMessageBytes`, `maxQueuedReliableBytes`, `maxQueuedDatagrams` | Named per-connection limits, validated before the connection opens |

The URL must be HTTPS. Channels, message sizes and queues are checked before WebTransport opens, so
a bad configuration is an error rather than a silently lossy channel.

## Send and poll

```ts
connection.send(1, actions);          // false when a reliable queue is full
const { messages, disconnected, reason } = connection.poll();
connection.getStats();                // rtt, queue depth, dropped datagrams
```

`poll()` is a drain, not an event stream: call it once per frame and handle every message. A
reliable send returns `false` when its queue is full; treat that as backpressure, not as a dropped
message. `getStats()` reports what the transport kept and what it dropped.

## What the engine does not ship

There is no replication, no state sync, no prediction and no snapshot interpolation. WebTransport
sits on QUIC/HTTP3 and this module adds validation, bounded queues, framing and delivery semantics.
Serialization, authority, tick rate, rollback and what a client may trust are your code, and so is
running deterministically enough to replay, which [Scenes and the game loop](core-concepts.md)
covers.

## Platforms

Browser and native share the one implementation. Native qualification depends on the installed
host's WebTransport bridge, and iOS is unverified.

## Source

- [net.ts](../../packages/core/src/net.ts)
- [net-session.ts](../../packages/core/src/net-session.ts)
