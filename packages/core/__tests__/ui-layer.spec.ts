import { beforeEach, describe, expect, test } from "vitest";
import {
  HIT_REGIONS_MESSAGE,
  UI_BRIDGE_GLOBALS,
  UI_INTENT_MESSAGE,
  connectUiBridge,
} from "../src/ui-bridge.js";
import { INTERACTIVE_ATTRIBUTE, publishHitRegions } from "../src/ui-hit-regions.js";

type Scope = Record<string, unknown>;

interface IFakeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A DOM small enough to reason about and big enough to exercise every path the registry has:
 * a query, a rect per element, and the four listener families it installs. The unit suite runs
 * in the node environment on purpose — the registry must not need a browser to be provable.
 */
function fakeScope(rects: IFakeRect[][]): Scope & {
  fire: (type: string) => void;
  frames: (count: number) => void;
  rects: IFakeRect[][];
  move: (left: number) => void;
} {
  const listeners = new Map<string, Set<() => void>>();
  const pending: (() => void)[] = [];
  const state = { rects };
  const add = (type: string, listener: () => void): void => {
    const set = listeners.get(type) ?? new Set();
    set.add(listener);
    listeners.set(type, set);
  };
  const remove = (type: string, listener: () => void): void => {
    listeners.get(type)?.delete(listener);
  };
  const document = {
    querySelectorAll: (selector: string) => {
      // The registry asks twice: once for the marked rects it publishes, and once — in
      // development only — for pressable controls that carry no marker, to warn about them.
      // This fake owns only the first; the warning has its own scope below.
      if (selector !== `[${INTERACTIVE_ATTRIBUTE}]`) return [];
      return state.rects.map((element) => ({
        getClientRects: () => element,
        getBoundingClientRect: () => element[0] ?? { left: 0, top: 0, width: 0, height: 0 },
      }));
    },
    documentElement: { clientWidth: 400, clientHeight: 800 },
    addEventListener: add,
    removeEventListener: remove,
  };
  const scope: Scope = {
    document,
    innerWidth: 400,
    innerHeight: 800,
    addEventListener: add,
    removeEventListener: remove,
    requestAnimationFrame: (callback: () => void) => {
      pending.push(callback);
      return pending.length;
    },
    cancelAnimationFrame: () => undefined,
  };
  const first = (): IFakeRect => {
    const rect = state.rects[0]?.[0];
    if (rect === undefined) throw new Error("fake scope has no first rect to move");
    return rect;
  };
  return Object.assign(scope, {
    rects: state.rects,
    move: (left: number) => {
      first().left = left;
    },
    fire: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    frames: (count: number) => {
      for (let index = 0; index < count; index += 1) {
        const next = pending.shift();
        if (next === undefined) return;
        next();
      }
    },
  });
}

describe("the message bridge", () => {
  test("should connect both ends in one realm on the web target", () => {
    const scope: Scope = {};
    const game = connectUiBridge({ end: "game", scope });
    const ui = connectUiBridge({ end: "ui", scope });
    expect(game.transport).toBe("in-process");
    const seen: unknown[] = [];
    game.onMessage((message) => seen.push(message));
    ui.post({ type: UI_INTENT_MESSAGE, intent: "restart" });
    expect(seen).toEqual([{ type: UI_INTENT_MESSAGE, intent: "restart" }]);
  });

  test("should copy every frame through JSON so web and native behave the same", () => {
    const scope: Scope = {};
    const game = connectUiBridge({ end: "game", scope });
    const ui = connectUiBridge({ end: "ui", scope });
    const payload = { nested: { value: 1 } };
    let received: { nested?: { value: number } } | undefined;
    game.onMessage((message) => {
      received = message as { nested?: { value: number } };
    });
    ui.post({ type: "tn:test", ...payload });
    payload.nested.value = 2;
    expect(received?.nested?.value).toBe(1);
  });

  test("should use the injected host channel when one exists", () => {
    const sent: string[] = [];
    const scope: Scope = {
      [UI_BRIDGE_GLOBALS.uiHost]: { postMessage: (frame: string) => sent.push(frame) },
    };
    const ui = connectUiBridge({ end: "ui", scope });
    expect(ui.transport).toBe("host");
    ui.post({ type: UI_INTENT_MESSAGE, intent: "pause" });
    expect(sent).toEqual(['{"type":"tn:intent","intent":"pause"}']);

    const inbound: unknown[] = [];
    ui.onMessage((message) => inbound.push(message));
    (scope[UI_BRIDGE_GLOBALS.uiReceive] as (frame: string) => void)('{"type":"tn:state","hp":3}');
    expect(inbound).toEqual([{ type: "tn:state", hp: 3 }]);
  });

  test("should find the iOS and desktop host shapes through the same discovery", () => {
    const ios: string[] = [];
    const iosScope: Scope = {
      webkit: {
        messageHandlers: {
          [UI_BRIDGE_GLOBALS.uiHost]: { postMessage: (f: string) => ios.push(f) },
        },
      },
    };
    connectUiBridge({ end: "ui", scope: iosScope }).post({ type: "tn:test" });
    expect(ios).toEqual(['{"type":"tn:test"}']);

    const desktop: string[] = [];
    const desktopScope: Scope = { ipc: { postMessage: (f: string) => desktop.push(f) } };
    connectUiBridge({ end: "ui", scope: desktopScope }).post({ type: "tn:test" });
    expect(desktop).toEqual(['{"type":"tn:test"}']);
  });

  test("should fail closed on a message or a frame the protocol cannot carry", () => {
    const scope: Scope = { [UI_BRIDGE_GLOBALS.uiHost]: { postMessage: () => undefined } };
    const ui = connectUiBridge({ end: "ui", scope });
    expect(() => ui.post({} as never)).toThrow(/TN_UI_BRIDGE_MESSAGE_INVALID/u);
    expect(() => ui.post([] as never)).toThrow(/TN_UI_BRIDGE_MESSAGE_INVALID/u);
    const cyclic: Record<string, unknown> = { type: "tn:test" };
    cyclic.self = cyclic;
    expect(() => ui.post(cyclic as never)).toThrow(/TN_UI_BRIDGE_MESSAGE_INVALID/u);
    const deliver = scope[UI_BRIDGE_GLOBALS.uiReceive] as (frame: string) => void;
    expect(() => deliver("not json")).toThrow(/TN_UI_BRIDGE_FRAME_INVALID/u);
    expect(() => deliver('["array"]')).toThrow(/TN_UI_BRIDGE_FRAME_INVALID/u);
    expect(() => deliver('{"no":"type"}')).toThrow(/TN_UI_BRIDGE_FRAME_INVALID/u);
  });
});

describe("the interactive-rect registry", () => {
  let scope: ReturnType<typeof fakeScope>;
  let posted: { type: string; regions: unknown }[];

  const bridge = (): ReturnType<typeof connectUiBridge> => ({
    end: "ui" as const,
    transport: "host" as const,
    hasPeer: () => true,
    post: (message) => posted.push(message as { type: string; regions: unknown }),
    onMessage: () => () => undefined,
    close: () => undefined,
  });

  beforeEach(() => {
    posted = [];
  });

  test("should publish every marked rect normalized to the viewport", () => {
    scope = fakeScope([[{ left: 100, top: 400, width: 200, height: 80 }]]);
    publishHitRegions({ bridge: bridge(), scope });
    expect(posted).toEqual([
      { type: HIT_REGIONS_MESSAGE, regions: [{ x: 0.25, y: 0.5, width: 0.5, height: 0.1 }] },
    ]);
  });

  test("should drop a zero-area rect so a hidden control never eats a touch", () => {
    scope = fakeScope([[{ left: 0, top: 0, width: 0, height: 0 }]]);
    publishHitRegions({ bridge: bridge(), scope });
    expect(posted).toEqual([{ type: HIT_REGIONS_MESSAGE, regions: [] }]);
  });

  test("should republish every frame while a transition is live, and stop when it ends", () => {
    scope = fakeScope([[{ left: 0, top: 0, width: 40, height: 40 }]]);
    const registry = publishHitRegions({ bridge: bridge(), scope });
    expect(posted).toHaveLength(1);

    scope.fire("transitionstart");
    // The button slides: each frame it is somewhere new, and each frame must be published.
    for (let step = 1; step <= 3; step += 1) {
      scope.move(step * 40);
      scope.frames(1);
    }
    expect(posted.map((entry) => (entry.regions as { x: number }[]).at(0)?.x)).toEqual([
      0, 0.1, 0.2, 0.3,
    ]);

    scope.fire("transitionend");
    const settled = posted.length;
    scope.frames(4);
    expect(posted).toHaveLength(settled);
    registry.stop();
  });

  test("should count a browser transition once, not once per start event", () => {
    scope = fakeScope([[{ left: 0, top: 0, width: 40, height: 40 }]]);
    const registry = publishHitRegions({ bridge: bridge(), scope });
    expect(posted).toHaveLength(1);

    // What Chromium emits for one CSS transition, in order.
    scope.fire("transitionrun");
    scope.fire("transitionstart");
    scope.fire("transitionend");
    const settled = posted.length;
    scope.move(80);
    scope.frames(4);
    expect(posted).toHaveLength(settled);
    registry.stop();
  });

  test("should not republish an unchanged snapshot", () => {
    scope = fakeScope([[{ left: 0, top: 0, width: 40, height: 40 }]]);
    const registry = publishHitRegions({ bridge: bridge(), scope });
    registry.refresh();
    scope.fire("resize");
    expect(posted).toHaveLength(1);
    registry.stop();
  });

  test("should publish an empty set on stop so the host stops consuming touches", () => {
    scope = fakeScope([[{ left: 0, top: 0, width: 40, height: 40 }]]);
    const registry = publishHitRegions({ bridge: bridge(), scope });
    registry.stop();
    expect(posted.at(-1)).toEqual({ type: HIT_REGIONS_MESSAGE, regions: [] });
    expect(registry.regions()).toEqual([]);
  });

  test("should fail closed with no document and on the wrong bridge end", () => {
    expect(() => publishHitRegions({ bridge: bridge(), scope: {} })).toThrow(
      /TN_UI_HIT_REGIONS_NO_DOCUMENT/u,
    );
    scope = fakeScope([[{ left: 0, top: 0, width: 40, height: 40 }]]);
    const gameEnd = { ...bridge(), end: "game" as const };
    expect(() => publishHitRegions({ bridge: gameEnd, scope })).toThrow(
      /TN_UI_HIT_REGIONS_WRONG_END/u,
    );
  });

  test("should observe DOM mutation and element resize when the host provides them", () => {
    scope = fakeScope([[{ left: 0, top: 0, width: 40, height: 40 }]]);
    const observed: string[] = [];
    let mutationCallback: (() => void) | undefined;
    scope.MutationObserver = class {
      constructor(callback: () => void) {
        mutationCallback = callback;
      }
      observe(): void {
        observed.push("mutation");
      }
      disconnect(): void {}
    };
    scope.ResizeObserver = class {
      observe(): void {
        observed.push("resize");
      }
      disconnect(): void {}
    };
    publishHitRegions({ bridge: bridge(), scope });
    expect(observed).toEqual(["mutation", "resize"]);
    scope.move(80);
    mutationCallback?.();
    expect((posted.at(-1)?.regions as { x: number }[]).at(0)?.x).toBe(0.2);
  });
});

/**
 * A scope whose document answers both selectors: the marked-rect query the registry publishes
 * from, and the pressable-control query the development warning checks against it.
 */
function scopeWithControls(options: {
  readonly marked: readonly string[];
  readonly controls: readonly { readonly tag: string; readonly marked: boolean }[];
}): Record<string, unknown> & { readonly warnings: string[] } {
  const warnings: string[] = [];
  const rect = { left: 0, top: 0, width: 40, height: 40 };
  const element = (tag: string, isMarked: boolean) => ({
    getClientRects: () => [rect],
    getBoundingClientRect: () => rect,
    closest: (selector: string) =>
      selector === `[${INTERACTIVE_ATTRIBUTE}]` && isMarked ? {} : null,
    tagName: tag.toUpperCase(),
    id: "",
    className: "",
  });
  const document = {
    querySelectorAll: (selector: string) =>
      selector === `[${INTERACTIVE_ATTRIBUTE}]`
        ? options.marked.map((tag) => element(tag, true))
        : options.controls.map((control) => element(control.tag, control.marked)),
    documentElement: { clientWidth: 400, clientHeight: 800 },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return Object.assign(
    {
      document,
      innerWidth: 400,
      innerHeight: 800,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined,
      console: { warn: (message: string) => warnings.push(message) },
    },
    { warnings },
  );
}

describe("unmarked controls", () => {
  const bridge = (): ReturnType<typeof connectUiBridge> => ({
    end: "ui" as const,
    transport: "host" as const,
    hasPeer: () => true,
    post: () => undefined,
    onMessage: () => () => undefined,
    close: () => undefined,
  });

  test("should name a pressable control that publishes no hit region", () => {
    const scope = scopeWithControls({
      marked: ["button"],
      controls: [
        { tag: "button", marked: true },
        { tag: "button", marked: false },
      ],
    });
    publishHitRegions({ bridge: bridge(), scope });
    expect(scope.warnings).toHaveLength(1);
    expect(scope.warnings[0]).toContain("TN_UI_UNMARKED_CONTROLS");
    expect(scope.warnings[0]).toContain("1 control(s)");
    expect(scope.warnings[0]).toContain(INTERACTIVE_ATTRIBUTE);
  });

  test("should stay silent when every pressable control is marked", () => {
    const scope = scopeWithControls({
      marked: ["button"],
      controls: [{ tag: "button", marked: true }],
    });
    publishHitRegions({ bridge: bridge(), scope });
    expect(scope.warnings).toEqual([]);
  });
});
