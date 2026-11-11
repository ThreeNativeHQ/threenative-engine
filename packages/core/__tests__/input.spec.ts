import { describe, expect, it, vi } from "vitest";
import { InputMap, type InputPlatformSource } from "../src/input.js";

function keyEvent(type: string, code: string): Event {
  const event = new Event(type);
  Object.defineProperty(event, "code", { value: code });
  return event;
}

function pointerEvent(
  type: string,
  id: number,
  x: number,
  y: number,
  buttons = type === "pointerup" || type === "pointercancel" ? 0 : 1,
): Event {
  return Object.assign(new Event(type), { buttons, clientX: x, clientY: y, pointerId: id });
}

function wheelEvent(deltaY: number, deltaMode = 0): Event {
  const event = new Event("wheel");
  Object.defineProperties(event, {
    deltaMode: { value: deltaMode },
    deltaY: { value: deltaY },
  });
  return event;
}

describe("InputMap", () => {
  it("browser negative DOM deltaY toward the user produces positive zoom intent", () => {
    const target = new EventTarget();
    const input = new InputMap({ zoom: { scroll: true } }, target);

    target.dispatchEvent(wheelEvent(-30));
    input.tick();

    expect(input.axis("zoom")).toBeCloseTo(0.3);
    expect(input.axis("zoom")).toBeGreaterThan(0);
    input.dispose();
  });

  it("browser positive DOM deltaY away from the user produces negative zoom intent", () => {
    const target = new EventTarget();
    const input = new InputMap({ zoom: { scroll: true } }, target);

    target.dispatchEvent(wheelEvent(30));
    input.tick();

    expect(input.axis("zoom")).toBeCloseTo(-0.3);
    expect(input.axis("zoom")).toBeLessThan(0);
    input.dispose();
  });

  it("should reset the axis to zero on the next tick with no further input", () => {
    const target = new EventTarget();
    const input = new InputMap({ zoom: { scroll: true } }, target);

    target.dispatchEvent(wheelEvent(-30));
    input.tick();
    expect(input.axis("zoom")).toBeCloseTo(0.3);

    input.tick();

    expect(input.axis("zoom")).toBe(0);
    input.dispose();
  });

  it("should normalise line-mode and pixel-mode wheel deltas to the same axis value", () => {
    const pixelTarget = new EventTarget();
    const lineTarget = new EventTarget();
    const pixelInput = new InputMap({ zoom: { scroll: true } }, pixelTarget);
    const lineInput = new InputMap({ zoom: { scroll: true } }, lineTarget);

    pixelTarget.dispatchEvent(wheelEvent(-32, 0));
    lineTarget.dispatchEvent(wheelEvent(-2, 1));
    pixelInput.tick();
    lineInput.tick();

    expect(lineInput.axis("zoom")).toBeCloseTo(pixelInput.axis("zoom"));
    pixelInput.dispose();
    lineInput.dispose();
  });

  it("should read a bound gamepad axis through the same scalar input", () => {
    const target = new EventTarget();
    const input = new InputMap({ zoom: { gamepadAxes: [3] } }, target, target, () => [
      { axes: [0, 0, 0, 1], buttons: [] },
    ]);

    input.tick();

    expect(input.axis("zoom")).toBe(1);
    input.dispose();
  });

  it("dead-zones an idle stick, rescales what is past it, and publishes raw axes at 0", () => {
    const target = new EventTarget();
    const axes = [0.1, 0, 0, 0];
    const input = new InputMap(undefined, target, target, () => [{ axes, buttons: [] }]);

    input.tick();
    expect(input.vector("move").length()).toBe(0);

    axes[0] = 0.6;
    input.tick();
    expect(input.vector("move").x).toBeCloseTo(0.5);

    input.gamepadDeadZone = 0;
    axes[0] = 0.1;
    input.tick();
    expect(input.vector("move").x).toBeCloseTo(0.1);
    input.dispose();
  });

  it("keeps the pad the player last used, not the first slot the browser lists", () => {
    const target = new EventTarget();
    const idleButton = { pressed: false };
    const heldButton = { pressed: false };
    const idle = { axes: [0, 0, 0, 0], buttons: [idleButton] };
    const held = { axes: [0, 0, 0, 0], buttons: [heldButton] };
    const input = new InputMap({ jump: { buttons: [0] } }, target, target, () => [idle, held]);

    input.tick();
    expect(input.pressed("jump")).toBe(false);

    heldButton.pressed = true;
    input.tick();
    expect(input.pressed("jump")).toBe(true);

    // The release is read from the pad that pressed, not from the idle slot 0 that a first-pad
    // rule would have sampled — and `raw.gamepad` is that pad's, normalized, not slot 0's.
    heldButton.pressed = false;
    input.tick();
    expect(input.pressed("jump")).toBe(false);
    input.dispose();
  });

  it("keeps the pad being played when another pad drifts in a higher slot", () => {
    const target = new EventTarget();
    // The pad in the player's hands holds the right stick; the pad in slot 1 is a worn stick resting
    // just past the dead zone. A "last slot with input" rule hands the input to slot 1 every tick.
    const played = { axes: [0, 0, 0, 0.6], buttons: [] };
    const drifting = { axes: [0.3, 0, 0, 0], buttons: [] };
    const input = new InputMap(undefined, target, target, () => [played, drifting]);

    input.tick();
    expect(input.vector("move").x).toBe(0);

    // The player's pad is released. The drifter has rested past the dead zone the whole time, so it
    // has no new edge to claim: an idle pad does not lose the input to a stick that never moved.
    played.axes[3] = 0;
    input.tick();
    expect(input.vector("move").x).toBe(0);

    // A pad that genuinely moves does take over: the drifter re-centres and comes back past the zone.
    drifting.axes[0] = 0;
    input.tick();
    drifting.axes[0] = 0.3;
    input.tick();
    expect(input.vector("move").x).toBeCloseTo(0.125);
    input.dispose();
  });

  it("takes the slot back when the player touches a pad the drifter took at boot", () => {
    const target = new EventTarget();
    // At boot the player's pad is idle and the worn stick in slot 1 already rests past the dead zone,
    // so slot 1 owns the input. Its stick never leaves that band, so only a rising edge on the
    // player's own pad can hand it back — a level check would leave slot 1 in charge for the session.
    const playedButton = { pressed: false };
    const played = { axes: [0, 0, 0, 0], buttons: [playedButton] };
    const drifting = { axes: [0.3, 0, 0, 0], buttons: [{ pressed: false }] };
    const input = new InputMap({ jump: { buttons: [0] } }, target, target, () => [
      played,
      drifting,
    ]);

    input.tick();
    expect(input.vector("move").x).toBeCloseTo(0.125);

    played.axes[0] = -1;
    input.tick();
    expect(input.vector("move").x).toBe(-1);

    // Held down, the player's pad keeps the slot; the drifter never rises again.
    input.tick();
    expect(input.vector("move").x).toBe(-1);

    playedButton.pressed = true;
    input.tick();
    expect(input.pressed("jump")).toBe(true);
    input.dispose();
  });

  it("publishes raw axes at a zero dead zone, and refuses a dead zone it cannot honour", () => {
    const target = new EventTarget();
    // 0.6 on both axes is inside the unit circle only after clamping: a dead zone of 0 must not rescale.
    const input = new InputMap(
      undefined,
      target,
      target,
      () => [{ axes: [0.6, 0.6, 0, 0], buttons: [] }],
      "suppress",
      { gamepadDeadZone: 0 },
    );
    input.tick();
    expect(input.raw.gamepad.axes[0]).toBeCloseTo(0.6);
    expect(input.raw.gamepad.axes[1]).toBeCloseTo(0.6);
    input.dispose();

    for (const gamepadDeadZone of [Number.NaN, -0.1, 1.5]) {
      expect(
        () => new InputMap(undefined, target, target, () => [], "suppress", { gamepadDeadZone }),
      ).toThrow(/gamepadDeadZone must be a number from 0 through 1/);
    }
  });

  it("reads a standard, an 8BitDo and a Steam Deck through one mapping", () => {
    const target = new EventTarget();
    const reports: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((line: string) => {
      reports.push(line);
    });
    const xboxButton = { pressed: true };
    const eightBitDoButton = { pressed: true };
    const deckButton = { pressed: true };
    const xbox = {
      id: "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)",
      mapping: "standard",
      axes: [0, 0, 0, 0],
      buttons: [xboxButton],
    };
    const eightBitDoAxes = [0, 0, 0, 0, 0, 1];
    const eightBitDo = {
      id: "8BitDo Ultimate 2C Wireless Controller (Vendor: 2dc8 Product: 301b)",
      mapping: "",
      // The row's own order: the left trigger is raw axis 5, the sticks are 0..3.
      axes: eightBitDoAxes,
      buttons: [eightBitDoButton],
    };
    const deck = {
      id: "28de-1205-Steam Deck Controller",
      mapping: "",
      axes: [0, 0, 0, 0],
      buttons: [deckButton],
    };
    let pads = [xbox];
    const input = new InputMap(
      { crouch: { buttons: [6, 7] }, jump: { buttons: [0] } },
      target,
      target,
      () => pads,
    );

    input.tick();
    expect(input.pressed("jump")).toBe(true);
    expect(input.pressed("crouch")).toBe(false);

    xboxButton.pressed = false;
    pads = [xbox, eightBitDo];
    input.tick();
    expect(input.pressed("jump")).toBe(true);
    expect(input.pressed("crouch")).toBe(true);

    eightBitDoButton.pressed = false;
    eightBitDoAxes[5] = 0;
    pads = [xbox, eightBitDo, deck];
    input.tick();
    expect(input.pressed("jump")).toBe(true);
    expect(reports.map((line) => JSON.parse(line.slice("TN_GAMEPAD ".length)).mapping)).toEqual([
      "standard",
      "table",
      "table",
    ]);
    info.mockRestore();
    input.dispose();
  });

  it("ignores an unmapped pad and reports it once", () => {
    const target = new EventTarget();
    const reports: string[] = [];
    const info = vi.spyOn(console, "info").mockImplementation((line: string) => {
      reports.push(line);
    });
    const input = new InputMap({ jump: { buttons: [0] } }, target, target, () => [
      {
        id: "Generic Wheel (Vendor: 1234 Product: 5678)",
        mapping: "",
        axes: [0, 0, 0, 0],
        buttons: [{ pressed: true }],
      },
    ]);

    input.tick();
    input.tick();

    expect(input.pressed("jump")).toBe(false);
    expect(input.raw.gamepad.buttons).toHaveLength(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("TN_GAMEPAD");
    expect(reports[0]).toContain('"mapping":"unmapped"');
    info.mockRestore();
    input.dispose();
  });

  it("should ignore a wheel that landed on a game HUD overlay", () => {
    const canvas = new EventTarget();
    const listeners = new Map<string, Array<(event: Event) => void>>();
    const host = {
      addEventListener(type: string, listener: (event: Event) => void) {
        const set = listeners.get(type) ?? [];
        set.push(listener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: (event: Event) => void) {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
        );
      },
      dispatchEvent() {
        return true;
      },
      fire(event: Event) {
        for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
      },
    };
    const input = new InputMap({ zoom: { scroll: true } }, host, canvas);
    const hud = { id: "settings-list" };

    const overHud = wheelEvent(-30);
    Object.defineProperty(overHud, "target", { value: hud });
    host.fire(overHud);
    input.tick();
    expect(input.axis("zoom")).toBe(0);

    const overCanvas = wheelEvent(-30);
    Object.defineProperty(overCanvas, "target", { value: canvas });
    host.fire(overCanvas);
    input.tick();
    expect(input.axis("zoom")).toBeCloseTo(0.3);
    input.dispose();
  });

  it("should keep the axis at zero when its scroll binding is removed", () => {
    const target = new EventTarget();
    const input = new InputMap({ zoom: { scroll: true } }, target);
    input.dispose();

    target.dispatchEvent(wheelEvent(-30));
    input.tick();

    expect(input.axis("zoom")).toBe(0);
  });

  it("should keep the axis at zero when scroll is not bound", () => {
    const target = new EventTarget();
    const input = new InputMap({ zoom: {} }, target);

    target.dispatchEvent(wheelEvent(-30));
    input.tick();

    expect(input.axis("zoom")).toBe(0);
    input.dispose();
  });

  it("should report a positive pinch axis when two pointers move apart", () => {
    const target = new EventTarget();
    const input = new InputMap({ zoom: { pinch: true } }, target);

    target.dispatchEvent(pointerEvent("pointerdown", 1, 40, 100));
    target.dispatchEvent(pointerEvent("pointerdown", 2, 60, 100));
    input.tick();
    target.dispatchEvent(pointerEvent("pointermove", 1, 39, 100));
    target.dispatchEvent(pointerEvent("pointermove", 2, 61, 100));
    input.tick();

    expect(input.axis("zoom")).toBeCloseTo(0.1);
    input.dispose();
  });

  it("should report zero pinch while only one pointer is down", () => {
    const target = new EventTarget();
    const input = new InputMap({ zoom: { pinch: true } }, target);

    target.dispatchEvent(pointerEvent("pointerdown", 1, 40, 100));
    input.tick();
    target.dispatchEvent(pointerEvent("pointermove", 1, 80, 100));
    input.tick();

    expect(input.axis("zoom")).toBe(0);
    input.dispose();
  });

  it("should ignore a third pointer when deriving pinch", () => {
    const target = new EventTarget();
    const input = new InputMap({ zoom: { pinch: true } }, target);

    target.dispatchEvent(pointerEvent("pointerdown", 1, 40, 100));
    target.dispatchEvent(pointerEvent("pointerdown", 2, 60, 100));
    input.tick();
    target.dispatchEvent(pointerEvent("pointerdown", 3, 300, 300));
    target.dispatchEvent(pointerEvent("pointermove", 3, 500, 500));
    input.tick();

    expect(input.axis("zoom")).toBe(0);
    input.dispose();
  });

  it("should not jump when the second finger lifts mid-pinch", () => {
    const target = new EventTarget();
    const input = new InputMap({ zoom: { pinch: true } }, target);

    target.dispatchEvent(pointerEvent("pointerdown", 1, 40, 100));
    target.dispatchEvent(pointerEvent("pointerdown", 2, 60, 100));
    input.tick();
    target.dispatchEvent(pointerEvent("pointermove", 1, 39, 100));
    target.dispatchEvent(pointerEvent("pointermove", 2, 61, 100));
    input.tick();
    expect(input.axis("zoom")).toBeCloseTo(0.1);

    target.dispatchEvent(pointerEvent("pointerup", 2, 61, 100));
    input.tick();

    expect(input.axis("zoom")).toBe(0);
    input.dispose();
  });

  it("should reuse one vector when the same action is sampled", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target);

    const first = input.vector("move");
    const second = input.vector("move");

    expect(second).toBe(first);
    input.dispose();
  });

  it("should keep move and aim vectors independent", () => {
    const target = new EventTarget();
    const input = new InputMap(
      {
        aim: { right: ["ArrowRight"] },
        move: { up: ["KeyW"] },
      },
      target,
    );

    const move = input.vector("move");
    const aim = input.vector("aim");

    expect(aim).not.toBe(move);
    target.dispatchEvent(keyEvent("keydown", "KeyW"));
    expect(move.toArray()).toEqual([0, 0]);
    expect(input.vector("move").toArray()).toEqual([0, 1]);
    expect(aim.toArray()).toEqual([0, 0]);
    input.dispose();
  });

  it("should keep unknown action vectors stable and distinct", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target);

    const firstUnknown = input.vector("first-unknown");
    const secondUnknown = input.vector("second-unknown");

    expect(input.vector("first-unknown")).toBe(firstUnknown);
    expect(secondUnknown).not.toBe(firstUnknown);
    expect(firstUnknown.toArray()).toEqual([0, 0]);
    expect(secondUnknown.toArray()).toEqual([0, 0]);
    input.dispose();
  });

  it("uses the first connected gamepad after empty browser slots", () => {
    const target = new EventTarget();
    const gamepads = [null, { axes: [0, 0, 0, 1], buttons: [] }] as ReturnType<InputPlatformSource>;
    Object.defineProperty(gamepads, "find", {
      configurable: true,
      value: () => {
        throw new Error("InputMap must scan gamepad slots without the array find method.");
      },
    });
    const input = new InputMap({ zoom: { gamepadAxes: [3] } }, target, target, () => gamepads);

    input.tick();

    expect(input.axis("zoom")).toBe(1);
    input.dispose();
  });

  it("should report (-1, 0) when KeyA is held", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target);

    target.dispatchEvent(keyEvent("keydown", "KeyA"));

    expect(input.vector("move").toArray()).toEqual([-1, 0]);
    input.dispose();
  });

  it("should return +y when the up binding is held", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target);

    target.dispatchEvent(keyEvent("keydown", "KeyW"));

    expect(input.vector("move").y).toBe(1);
    input.dispose();
  });

  it("should return +y for a forward gamepad stick", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target, target, () => [{ axes: [0, -1], buttons: [] }]);

    input.tick();

    expect(input.vector("move").y).toBe(1);
    input.dispose();
  });

  it("should clear held keys on window blur", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target);
    target.dispatchEvent(keyEvent("keydown", "KeyA"));
    target.dispatchEvent(pointerEvent("pointerdown", 7, 12, 34));

    target.dispatchEvent(new Event("blur"));

    expect(input.vector("move").toArray()).toEqual([0, 0]);
    expect(input.raw.pointer.position.toArray()).toEqual([0, 0]);
    expect(input.raw.pointers.size).toBe(0);
    input.dispose();
  });

  it("reports held pointers in arrival order and moves only the matching pointer", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target);

    target.dispatchEvent(pointerEvent("pointerdown", 7, 10, 20));
    target.dispatchEvent(pointerEvent("pointerdown", 3, 80, 90));
    target.dispatchEvent(pointerEvent("pointermove", 3, 81, 92));

    expect([...input.raw.pointers.keys()]).toEqual([7, 3]);
    expect(input.raw.pointers.get(7)?.position.toArray()).toEqual([10, 20]);
    expect(input.raw.pointers.get(3)?.position.toArray()).toEqual([81, 92]);
    expect(input.raw.pointer).toMatchObject({ buttons: 1, down: true });
    expect(input.raw.pointer.position.toArray()).toEqual([10, 20]);
    input.dispose();
  });

  it("does not capture an untrusted pointer event injected by a browser proof", () => {
    const target = new EventTarget() as EventTarget & {
      setPointerCapture: (id: number) => void;
    };
    target.setPointerCapture = () => {
      throw new Error("synthetic pointer capture must not be requested");
    };
    const input = new InputMap(undefined, target);

    expect(() => target.dispatchEvent(pointerEvent("pointerdown", 7, 10, 20))).not.toThrow();
    expect(input.raw.pointers.size).toBe(1);
    input.dispose();
  });

  it("keeps input alive when pointer capture is refused during pointer lock", () => {
    const target = new EventTarget() as EventTarget & {
      setPointerCapture: (id: number) => void;
    };
    target.setPointerCapture = () => {
      const error = new Error("pointer is no longer capturable");
      error.name = "InvalidStateError";
      throw error;
    };
    const input = new InputMap(undefined, target);
    const event = pointerEvent("pointerdown", 7, 10, 20);
    Object.defineProperty(event, "isTrusted", { value: true });

    expect(() => target.dispatchEvent(event)).not.toThrow();
    expect(input.raw.pointers.size).toBe(1);
    input.dispose();
  });

  it("releases one pointer without disturbing the other and promotes the next primary", () => {
    const target = new EventTarget();
    const input = new InputMap({ fire: { pointer: true } }, target);
    target.dispatchEvent(pointerEvent("pointerdown", 7, 10, 20));
    target.dispatchEvent(pointerEvent("pointerdown", 3, 80, 90));

    target.dispatchEvent(pointerEvent("pointerup", 7, 12, 22));

    expect([...input.raw.pointers.keys()]).toEqual([3]);
    expect(input.raw.pointer.down).toBe(true);
    expect(input.raw.pointer.position.toArray()).toEqual([80, 90]);
    expect(input.pressed("fire")).toBe(true);
    target.dispatchEvent(pointerEvent("pointerup", 3, 80, 90));
    expect(input.raw.pointers.size).toBe(0);
    expect(input.raw.pointer.down).toBe(false);
    input.dispose();
  });

  it("releases a cancelled pointer and leaves other held pointers active", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target);
    target.dispatchEvent(pointerEvent("pointerdown", 7, 10, 20));
    target.dispatchEvent(pointerEvent("pointerdown", 3, 80, 90));

    target.dispatchEvent(pointerEvent("pointercancel", 3, 80, 90));

    expect([...input.raw.pointers.keys()]).toEqual([7]);
    expect(input.raw.pointer.position.toArray()).toEqual([10, 20]);
    input.dispose();
  });

  it("latches pointer edges by id through the next input tick", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target);

    target.dispatchEvent(pointerEvent("pointerdown", 7, 10, 20));
    target.dispatchEvent(pointerEvent("pointerup", 7, 12, 22));
    input.tick();

    expect(input.raw.pointerEdges.get(7)).toMatchObject([
      { buttons: 1, id: 7, position: { x: 10, y: 20 }, type: "down" },
      { buttons: 0, id: 7, position: { x: 12, y: 22 }, type: "up" },
    ]);
    input.tick();
    expect(input.raw.pointerEdges.size).toBe(0);
    input.dispose();
  });

  it("preserves cancellation as a distinct pointer edge", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target);

    target.dispatchEvent(pointerEvent("pointercancel", 7, 12, 22));
    input.tick();

    expect(input.raw.pointerEdges.get(7)).toMatchObject([
      { buttons: 0, id: 7, position: { x: 12, y: 22 }, type: "cancel" },
    ]);
    input.dispose();
  });

  it("updates legacy hover position only when no pointer is held", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target);
    target.dispatchEvent(pointerEvent("pointermove", 1, 5, 6, 0));
    expect(input.raw.pointer.position.toArray()).toEqual([5, 6]);
    target.dispatchEvent(pointerEvent("pointerdown", 7, 10, 20));
    target.dispatchEvent(pointerEvent("pointermove", 1, 50, 60, 0));
    expect(input.raw.pointer.position.toArray()).toEqual([10, 20]);
    input.dispose();
  });

  it("should report justPressed and justReleased on one transition frame", () => {
    const target = new EventTarget();
    const input = new InputMap({ jump: { down: ["Space"] } }, target);

    target.dispatchEvent(keyEvent("keydown", "Space"));
    input.tick();
    expect(input.justPressed("jump")).toBe(true);
    expect(input.justReleased("jump")).toBe(false);

    input.tick();
    input.tick();
    expect(input.justPressed("jump")).toBe(false);

    target.dispatchEvent(keyEvent("keyup", "Space"));
    input.tick();
    expect(input.justReleased("jump")).toBe(true);
    input.tick();
    expect(input.justReleased("jump")).toBe(false);
    input.dispose();
  });

  it("should not report a bound action when an unbound gamepad button is down", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        getGamepads: () => [
          {
            axes: [],
            buttons: [{ pressed: false }, { pressed: true }],
          } as unknown as Gamepad,
        ],
      },
    });
    const input = new InputMap({ jump: { buttons: [0] } }, new EventTarget());

    try {
      input.tick();
      expect(input.pressed("jump")).toBe(false);
    } finally {
      input.dispose();
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  // `keys` exists because `down` reads as "the keys that press this action" while it means
  // "the −y direction of the axis". A build bound `jump: { down: ["Space"] }`, which worked,
  // then found `pressed("move")` true whenever ArrowDown was held. See the round 9 friction
  // ledger, docs/verification/sweep-platformer-2026-08-16.md.
  it("should press a button action bound with keys", () => {
    const target = new EventTarget();
    const input = new InputMap({ jump: { keys: ["Space"] } }, target);

    target.dispatchEvent(keyEvent("keydown", "Space"));
    input.tick();

    expect(input.pressed("jump")).toBe(true);
    expect(input.justPressed("jump")).toBe(true);
    input.dispose();
  });

  it("should keep keys out of the action vector", () => {
    const target = new EventTarget();
    const input = new InputMap({ aim: { keys: ["KeyS", "ArrowDown"] } }, target);

    target.dispatchEvent(keyEvent("keydown", "ArrowDown"));

    expect(input.vector("aim").toArray()).toEqual([0, 0]);
    expect(input.pressed("aim")).toBe(true);
    input.dispose();
  });

  it("should still press an action bound the older way, with down", () => {
    const target = new EventTarget();
    const input = new InputMap({ jump: { down: ["Space"] } }, target);

    target.dispatchEvent(keyEvent("keydown", "Space"));

    expect(input.pressed("jump")).toBe(true);
    input.dispose();
  });

  // A cold build of an FPS bound `fire: { buttons: [0] }` meaning the left mouse button, because
  // that is what `[0]` reads like. `buttons` is the gamepad, so on a machine with no gamepad the
  // binding was accepted and silently never fired: the game's own HUD advertised "Mouse 1 Fire"
  // and clicking did nothing. Every assertion still passed, because the sealed proof only ever
  // pressed keys.
  it("should press an action bound to the left mouse button", () => {
    const target = new EventTarget();
    const input = new InputMap({ fire: { mouseButtons: [0] } }, target);

    target.dispatchEvent(pointerEvent("pointerdown", 1, 10, 10, 1));

    expect(input.pressed("fire")).toBe(true);
    input.dispose();
  });

  it("should distinguish the right mouse button from the left", () => {
    const target = new EventTarget();
    const input = new InputMap({ aim: { mouseButtons: [2] }, fire: { mouseButtons: [0] } }, target);

    // PointerEvent.buttons numbers the right button 2, while MouseEvent.button numbers it 2 and
    // the middle one 1 — the two schemes disagree, so this is the case that catches a naive shift.
    target.dispatchEvent(pointerEvent("pointerdown", 1, 10, 10, 2));

    expect(input.pressed("aim")).toBe(true);
    expect(input.pressed("fire")).toBe(false);
    input.dispose();
  });

  it("keeps a held mouse button held through a button-less move while the pointer is locked", () => {
    const target = Object.assign(new EventTarget(), { requestPointerLock: () => undefined });
    const input = new InputMap({ block: { mouseButtons: [2] } }, target, target);
    input.captureMouse();
    target.dispatchEvent(pointerEvent("pointerdown", 1, 10, 10, 2));
    // Chromium's pointer-locked move: no button changed, and `buttons` reads 0 with right held.
    target.dispatchEvent(Object.assign(pointerEvent("pointermove", 1, 12, 10, 0), { button: -1 }));
    input.tick();
    expect(input.pressed("block")).toBe(true);
    target.dispatchEvent(pointerEvent("pointerup", 1, 12, 10));
    input.tick();
    expect(input.pressed("block")).toBe(false);
    input.dispose();
  });

  it("takes the lock state a worker host forwards with pointerlockchange, where no document exists (PRD-752)", () => {
    const canvas = Object.assign(new EventTarget(), { requestPointerLock: () => undefined });
    const input = new InputMap({ look: { pointerRelative: true } }, canvas, canvas);
    input.captureMouse();
    expect(input.raw.pointer.captured).toBe(true);
    // Escape on the page: the host forwards the change with the page's verdict.
    canvas.dispatchEvent(Object.assign(new Event("pointerlockchange"), { captured: false }));
    expect(input.raw.pointer.captured).toBe(false);
    input.dispose();
  });

  it("releases a held mouse button on a button-less move while the pointer is free", () => {
    // Released outside the window, no pointerup arrives: the next move is what clears it.
    const target = new EventTarget();
    const input = new InputMap({ block: { mouseButtons: [2] } }, target, target);
    target.dispatchEvent(pointerEvent("pointerdown", 1, 10, 10, 2));
    target.dispatchEvent(Object.assign(pointerEvent("pointermove", 1, 12, 10, 0), { button: -1 }));
    input.tick();
    expect(input.pressed("block")).toBe(false);
    input.dispose();
  });

  it("should press an action bound to the middle mouse button", () => {
    const target = new EventTarget();
    const input = new InputMap({ melee: { mouseButtons: [1] } }, target);

    target.dispatchEvent(pointerEvent("pointerdown", 1, 10, 10, 4));

    expect(input.pressed("melee")).toBe(true);
    input.dispose();
  });

  it("should not press a mouse binding from a gamepad button, or the reverse", () => {
    const target = new EventTarget();
    const input = new InputMap({ fire: { mouseButtons: [0] } }, target, target, () => [
      { axes: [0, 0], buttons: [{ pressed: true }] },
    ]);

    input.tick();

    expect(input.pressed("fire")).toBe(false);
    input.dispose();
  });

  it("should release a mouse binding when the button goes up", () => {
    const target = new EventTarget();
    const input = new InputMap({ fire: { mouseButtons: [0] } }, target);

    target.dispatchEvent(pointerEvent("pointerdown", 1, 10, 10, 1));
    target.dispatchEvent(pointerEvent("pointerup", 1, 10, 10, 0));

    expect(input.pressed("fire")).toBe(false);
    input.dispose();
  });

  // Right-click over a game canvas is a binding, not a menu. Suppressing it is the default
  // rather than something each game remembers to do, because forgetting it makes a right-click
  // binding silently unusable and every game here would have had to write the same three lines.
  it("should suppress the browser context menu on the game surface by default", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target);

    const event = new Event("contextmenu", { cancelable: true });
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    input.dispose();
  });

  it("should restore the browser context menu when a game asks for it", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target, target, undefined, "allow");

    const event = new Event("contextmenu", { cancelable: true });
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    input.dispose();
  });

  it("should stop suppressing the context menu once disposed", () => {
    const target = new EventTarget();
    const input = new InputMap(undefined, target);
    input.dispose();

    const event = new Event("contextmenu", { cancelable: true });
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });
  // A mouse click is normally shorter than one frame at 60Hz. Sampling device state once per
  // tick therefore dropped it entirely: down and up both landed between two ticks, `pressed`
  // was false at both samples, and `justPressed` never fired. In the FPS build that read as
  // "clicking does nothing", intermittently, while holding the button worked.
  it("should report justPressed for a click that starts and ends inside one frame", () => {
    const target = new EventTarget();
    const input = new InputMap({ fire: { mouseButtons: [0] } }, target);
    input.tick();

    target.dispatchEvent(pointerEvent("pointerdown", 1, 10, 10, 1));
    target.dispatchEvent(pointerEvent("pointerup", 1, 10, 10, 0));
    input.tick();

    expect(input.justPressed("fire")).toBe(true);
    expect(input.pressed("fire")).toBe(false);
    input.dispose();
  });

  it("should report justPressed for a keypress that starts and ends inside one frame", () => {
    const target = new EventTarget();
    const input = new InputMap({ jump: { keys: ["Space"] } }, target);
    input.tick();

    target.dispatchEvent(keyEvent("keydown", "Space"));
    target.dispatchEvent(keyEvent("keyup", "Space"));
    input.tick();

    expect(input.justPressed("jump")).toBe(true);
    input.dispose();
  });

  it("should release a latched tap on the following frame rather than sticking down", () => {
    const target = new EventTarget();
    const input = new InputMap({ fire: { mouseButtons: [0] } }, target);
    input.tick();

    target.dispatchEvent(pointerEvent("pointerdown", 1, 10, 10, 1));
    target.dispatchEvent(pointerEvent("pointerup", 1, 10, 10, 0));
    input.tick();
    input.tick();

    expect(input.justPressed("fire")).toBe(false);
    expect(input.justReleased("fire")).toBe(true);
    input.tick();
    expect(input.justReleased("fire")).toBe(false);
    input.dispose();
  });

  it("should fire justPressed once per tap, not once per frame while held", () => {
    const target = new EventTarget();
    const input = new InputMap({ fire: { mouseButtons: [0] } }, target);
    input.tick();

    target.dispatchEvent(pointerEvent("pointerdown", 1, 10, 10, 1));
    input.tick();
    expect(input.justPressed("fire")).toBe(true);
    input.tick();
    expect(input.justPressed("fire")).toBe(false);
    input.dispose();
  });
});
