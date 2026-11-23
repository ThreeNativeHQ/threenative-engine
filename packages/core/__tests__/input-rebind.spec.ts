import { describe, expect, it } from "vitest";
import { type IInputAction, type InputBindings, InputMap } from "../src/input.js";

function keyEvent(type: string, code: string): Event {
  const event = new Event(type);
  Object.defineProperty(event, "code", { value: code });
  return event;
}

function wheelEvent(deltaY: number): Event {
  const event = new Event("wheel");
  Object.defineProperty(event, "deltaY", { value: deltaY });
  return event;
}

/** A field the type says is a string array, so a caller can hand the map something JSON produced. */
function asBinding(binding: unknown): IInputAction {
  return binding as IInputAction;
}

describe("InputMap key rebinding", () => {
  it("setBinding changes what pressed(action) reads on the next tick", () => {
    const target = new EventTarget();
    const input = new InputMap({ jump: { keys: ["Space"] } }, target);

    target.dispatchEvent(keyEvent("keydown", "KeyJ"));
    input.tick();
    expect(input.pressed("jump")).toBe(false);
    expect(input.justPressed("jump")).toBe(false);

    input.setBinding("jump", { keys: ["KeyJ"] });
    input.tick();
    expect(input.pressed("jump")).toBe(true);
    expect(input.justPressed("jump")).toBe(true);

    target.dispatchEvent(keyEvent("keyup", "KeyJ"));
    input.tick();
    expect(input.pressed("jump")).toBe(false);
    expect(input.justReleased("jump")).toBe(true);
    input.dispose();
  });

  it("setBinding on a wheel binding added after construction reads the next wheel", () => {
    const target = new EventTarget();
    const input = new InputMap({ zoom: { keys: ["KeyZ"] } }, target);

    input.setBinding("zoom", { scroll: true });
    target.dispatchEvent(wheelEvent(-30));
    input.tick();

    expect(input.axis("zoom")).toBeCloseTo(0.3);
    input.dispose();
  });

  it("a malformed binding throws the constructor's error from both entry points", () => {
    const target = new EventTarget();
    const malformed = asBinding({ keys: "Space" });

    let constructorError: unknown;
    try {
      new InputMap({ jump: malformed }, target);
    } catch (error) {
      constructorError = error;
    }
    expect(constructorError).toBeInstanceOf(Error);

    const input = new InputMap({ jump: { keys: ["Space"] } }, target);
    let setterError: unknown;
    try {
      input.setBinding("jump", malformed);
    } catch (error) {
      setterError = error;
    }
    expect(setterError).toBeInstanceOf(Error);
    expect((setterError as Error).message).toBe((constructorError as Error).message);
    expect((setterError as Error).message).toMatch(/TN_BINDING_INVALID/);
    expect((setterError as Error).message).toContain("jump");
    expect((setterError as Error).message).toContain("keys");
    input.dispose();
  });

  it("rejects a non-integer device index the same way", () => {
    const target = new EventTarget();
    const input = new InputMap({ jump: { keys: ["Space"] } }, target);

    expect(() => input.setBinding("jump", asBinding({ buttons: [0.5] }))).toThrow(
      /TN_BINDING_INVALID/,
    );
    expect(() => input.setBinding("jump", asBinding(null))).toThrow(/TN_BINDING_INVALID/);
    input.dispose();
  });

  it("refuses to rebind an action the game never declared", () => {
    const target = new EventTarget();
    const input = new InputMap({ jump: { keys: ["Space"] } }, target);

    expect(() => input.setBinding("fire", { keys: ["KeyF"] })).toThrow(/TN_BINDING_UNKNOWN/);
    expect(() => input.setBinding("fire", { keys: ["KeyF"] })).toThrow(/fire/);
    input.dispose();
  });

  it("bindings() round-trips through JSON and setBinding reproduces identical bindings", () => {
    const target = new EventTarget();
    const input = new InputMap(
      { jump: { buttons: [0], keys: ["Space"] }, zoom: { scroll: true } },
      target,
    );
    const saved = input.bindings();
    const parsed = JSON.parse(JSON.stringify(saved)) as InputBindings;

    const restored = new InputMap({ jump: { keys: [] }, zoom: {} }, target);
    for (const [action, binding] of Object.entries(parsed)) restored.setBinding(action, binding);
    expect(restored.bindings()).toEqual(saved);

    for (const [action, binding] of Object.entries(parsed)) input.setBinding(action, binding);
    expect(input.bindings()).toEqual(saved);

    input.dispose();
    restored.dispose();
  });

  it("bindings() hands back a copy that is not live", () => {
    const target = new EventTarget();
    const input = new InputMap({ jump: { keys: ["Space"] } }, target);
    const before = input.bindings();

    const copy = input.bindings() as Record<string, { keys?: string[] }>;
    (copy.jump as { keys?: string[] }).keys?.push("KeyJ");
    copy.jump = { keys: ["KeyF"] };

    expect(input.bindings()).toEqual(before);
    target.dispatchEvent(keyEvent("keydown", "KeyF"));
    input.tick();
    expect(input.pressed("jump")).toBe(false);
    input.dispose();
  });
});
