import { Object3D } from "three";
import { describe, expect, it } from "vitest";
import { captureRenderHook, restoreRenderHook } from "../src/engine-render-hook.js";

/**
 * `three-native` exposes `onBeforeRender` as a prototype getter/setter that reads `null` until a
 * function is set, so `Object.hasOwn` is false even with a hook installed. Missing that left the
 * engine's temporary borrow behind in C++ and pinned `TN_RENDER_PROJECTION` on `renderHook`
 * (stress&strata: 284 main draws instead of 46).
 */
class AccessorObject {
  writes: unknown[] = [];
}
for (const prop of ["onBeforeRender", "onAfterRender"] as const) {
  Object.defineProperty(AccessorObject.prototype, prop, {
    configurable: true,
    get(this: AccessorObject) {
      return hooksOf(this).get(prop) ?? null;
    },
    set(this: AccessorObject, value: unknown) {
      this.writes.push(value);
      if (value === null || value === undefined) hooksOf(this).delete(prop);
      else hooksOf(this).set(prop, value);
    },
  });
}
const hookMaps = new WeakMap<object, Map<string, unknown>>();
function hooksOf(object: object): Map<string, unknown> {
  let map = hookMaps.get(object);
  if (map === undefined) {
    map = new Map();
    hookMaps.set(object, map);
  }
  return map;
}

const borrow = () => {};

describe("render hook borrow on a prototype accessor (three-native)", () => {
  it("sees a hook set through the accessor and hands it back", () => {
    const object = new AccessorObject();
    const game = () => {};
    Reflect.set(object, "onBeforeRender", game);
    const captured = captureRenderHook(object, "onBeforeRender");
    expect(captured).toEqual({ hadOwn: true, own: game });
    Reflect.set(object, "onBeforeRender", borrow);
    restoreRenderHook(object, "onBeforeRender", captured.hadOwn, captured.own);
    expect(Reflect.get(object, "onBeforeRender")).toBe(game);
  });

  it("clears the borrow through the setter when there was no hook", () => {
    const object = new AccessorObject();
    const captured = captureRenderHook(object, "onAfterRender");
    expect(captured.hadOwn).toBe(false);
    Reflect.set(object, "onAfterRender", borrow);
    restoreRenderHook(object, "onAfterRender", captured.hadOwn, captured.own);
    expect(Reflect.get(object, "onAfterRender")).toBeNull();
    expect(object.writes.at(-1)).toBeNull();
  });
});

describe("render hook borrow on plain three", () => {
  it("deletes the borrow so the prototype no-op shows again", () => {
    const object = new Object3D();
    const prototypeHook = object.onBeforeRender;
    const captured = captureRenderHook(object, "onBeforeRender");
    expect(captured.hadOwn).toBe(false);
    object.onBeforeRender = borrow;
    restoreRenderHook(object, "onBeforeRender", captured.hadOwn, captured.own);
    expect(Object.hasOwn(object, "onBeforeRender")).toBe(false);
    expect(object.onBeforeRender).toBe(prototypeHook);
  });

  it("hands an own game hook back", () => {
    const object = new Object3D();
    const game = () => {};
    object.onBeforeRender = game;
    const captured = captureRenderHook(object, "onBeforeRender");
    object.onBeforeRender = borrow;
    restoreRenderHook(object, "onBeforeRender", captured.hadOwn, captured.own);
    expect(object.onBeforeRender).toBe(game);
  });
});
