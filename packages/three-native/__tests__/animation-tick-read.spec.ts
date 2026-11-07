/**
 * PRD-828: `tn_anim_tick` advances a whole frame's rigs inside the engine. The values it writes must be
 * the values the next JS read sees — `AnimationAction.time`/`timeScale`/`weight` and `AnimationMixer.time`
 * are engine-memory fields on this back end (`fastGetter` over `runtime.readDoubles`), not a JS mirror, so
 * a batched tick needs no invalidation and a read after it is the engine's answer by construction. This
 * pins that, because the alternative — a mirror that survives the call — would integrate the next frame's
 * pose at this frame's rate and slide the feet, and nothing else in the suite could see it: the node parity
 * spec runs plain three objects with no back end at all.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";

const registry = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "packages", "three-native", "api", "native-registry.json"),
    "utf8",
  ),
) as IRegistryDump;

/**
 * The engine's animation state, as the real back end reads it: one `Float64` per field at the object's
 * address plus the field's offset, served by `readDoubles`. A test can move a value and then read it
 * back, which is exactly the contract `tn_anim_tick` has to keep.
 */
function animationRuntime() {
  /** 8 doubles per object: offsets 0 (`time`), 1 (`timeScale`), 2 (`weight`). */
  const heap = new Float64Array(256);
  let next = 0;
  /** The object's address in engine memory, eight doubles apart, as the back end's `__address` reports. */
  const base = (self: IEngineRef) => Number((self.key ?? "").split(":")[1] ?? 0) * 64;
  /** A field's `Float64` index in the fake heap, from a byte address and the registry's field offset. */
  const lane = (self: IEngineRef, offset: number) => (base(self) + offset) / 8;
  const runtime: IBrowserRuntime = {
    typeId: () => 1,
    construct: (name) => ({ key: `${name}:${next++}`, type: 1 }),
    invoke: () => null,
    get(self, property) {
      if (property === "__address") return base(self);
      if (property === "children") return [];
      if (property === "parent") return null;
      if (property === "visible") return true;
      if (property === "name") return "";
      if (property === "stats") return {};
      return 0;
    },
    set: () => undefined,
    release: () => undefined,
    setCallback: () => undefined,
    readDoubles: (address, count) => (count === 1 ? (heap[address / 8] ?? 0) : 0),
    readByte: () => 0,
  };
  // The engine's side of `tn_anim_tick`: it advances the mixer, the action's playhead, and the scale the
  // stride rule chose.
  runtime.animTick = (batch) => {
    const mixer = batch.mixers[0] as IEngineRef;
    const action = batch.actions[0] as IEngineRef;
    heap[lane(mixer, 0)] = 0.5;
    heap[lane(action, 0)] = 0.25;
    heap[lane(action, 8)] = 1.5;
  };
  return { runtime, heap, lane };
}

type IMixer = { readonly time: number; readonly timeScale: number; readonly weight: number };

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__tnAnimationTick");
});

describe("the animation tick batch on the browser back end (PRD-828)", () => {
  it("answers a read after the batched tick from the engine, not from a JS copy of it", () => {
    const { runtime, heap, lane } = animationRuntime();
    const { classes } = defineBrowserClasses(registry, runtime);
    const Group = classes.Group as new () => object;
    const root = new Group();
    const Mixer = classes.AnimationMixer as new (root: object) => IMixer & IEngineRef;
    const mixer = new Mixer(root);
    const action = new Mixer(root);
    const tick = (globalThis as { __tnAnimationTick?: unknown }).__tnAnimationTick as
      | ((rigs: readonly object[], status: Float64Array) => void)
      | undefined;
    expect(tick).toBeInstanceOf(Function);
    // Prime both mirrors the way the player does, one frame before the tick.
    expect(mixer.time).toBe(0);
    expect(action.time).toBe(0);
    expect(action.timeScale).toBe(0);
    // The engine advances them inside the call; a mirror that survived would answer 0 again.
    const rig = {
      mixer,
      action,
      strideRoot: null,
      dt: 0.1,
      elapsed: 0.1,
      step: true,
      reset: false,
      lastRate: 1,
      clipGroundSpeed: 10,
      strideSync: true,
    };
    tick?.([rig], new Float64Array(3));
    expect(mixer.time).toBe(0.5);
    expect(action.time).toBe(0.25);
    expect(action.timeScale).toBe(1.5);
    // A second read is the engine's answer again: nothing cached the first one.
    expect(mixer.time).toBe(0.5);
  });
});
