import { describe, expect, it } from "vitest";
import { UI_BRIDGE_GLOBALS, connectUiBridge } from "../src/ui-bridge.js";

/** A host scope: the game end finds `__tnUiPost`, so it takes the platform transport. */
function hostScope(): Record<string, unknown> {
  return { [UI_BRIDGE_GLOBALS.gamePost]: () => undefined };
}

function deliverFromHost(scope: Record<string, unknown>, message: object): void {
  (scope[UI_BRIDGE_GLOBALS.gameReceive] as (frame: string) => void)(JSON.stringify(message));
}

describe("ui bridge inbound global", () => {
  it("gives every connection on one end the host's frame", () => {
    const scope = hostScope();
    const first: string[] = [];
    const second: string[] = [];
    connectUiBridge({ end: "game", scope }).onMessage((m) => first.push(m.type));
    connectUiBridge({ end: "game", scope }).onMessage((m) => second.push(m.type));

    deliverFromHost(scope, { type: "click", id: 7 });

    expect(first).toEqual(["click"]);
    expect(second).toEqual(["click"]);
  });

  it("keeps the survivor connected when one closes", () => {
    const scope = hostScope();
    const survivor: string[] = [];
    const closing = connectUiBridge({ end: "game", scope });
    connectUiBridge({ end: "game", scope }).onMessage((m) => survivor.push(m.type));

    closing.close();
    deliverFromHost(scope, { type: "click", id: 1 });
    expect(survivor).toEqual(["click"]);

    const last = connectUiBridge({ end: "game", scope });
    last.close();
    expect(scope[UI_BRIDGE_GLOBALS.gameReceive]).toBeTypeOf("function");
  });

  it("keeps delivering to the other receivers when one throws, then rethrows", () => {
    const scope = hostScope();
    const received: string[] = [];
    connectUiBridge({ end: "game", scope }).onMessage(() => {
      throw new Error("TN_TEST_RECEIVER_THREW");
    });
    connectUiBridge({ end: "game", scope }).onMessage((m) => received.push(m.type));

    expect(() => deliverFromHost(scope, { type: "click", id: 3 })).toThrow(
      "TN_TEST_RECEIVER_THREW",
    );
    expect(received).toEqual(["click"]);
  });

  it("removes the host global once the last connection closes", () => {
    const scope = hostScope();
    const only = connectUiBridge({ end: "game", scope });
    expect(scope[UI_BRIDGE_GLOBALS.gameReceive]).toBeTypeOf("function");
    only.close();
    expect(scope[UI_BRIDGE_GLOBALS.gameReceive]).toBeUndefined();
  });
});

describe("ui bridge loopback over a message port (PRD-752)", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("carries state and intents over an async port when the page asks for ?tnUiLoopback=1", async () => {
    const scope: Record<string, unknown> = { location: { search: "?tnUiLoopback=1" } };
    const ui = connectUiBridge({ end: "ui", scope });
    const game = connectUiBridge({ end: "game", scope });
    const seenByUi: unknown[] = [];
    const seenByGame: unknown[] = [];
    ui.onMessage((message) => seenByUi.push(message));
    game.onMessage((message) => seenByGame.push(message));

    expect([ui.transport, game.transport]).toEqual(["host", "host"]);
    expect(game.hasPeer()).toBe(true);
    game.post({ type: "tn:state", state: { score: 3 } });
    ui.post({ type: "tn:intent", name: "pause" });
    // A worker delivers a task later, never inside the post: the loopback must too.
    expect([seenByUi, seenByGame]).toEqual([[], []]);
    await tick();
    expect(seenByUi).toEqual([{ type: "tn:state", state: { score: 3 } }]);
    expect(seenByGame).toEqual([{ type: "tn:intent", name: "pause" }]);

    ui.close();
    game.close();
    (scope.__tnUiLoopback as { close(): void }).close();
  });

  it("keeps the in-process broker without the flag", () => {
    const scope: Record<string, unknown> = { location: { search: "" } };
    expect(connectUiBridge({ end: "ui", scope }).transport).toBe("in-process");
  });
});
