import { type ICtx, InputMap } from "@threenative/core";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { PLAYTEST_CLOCK_GLOBAL, requestedPlaytestClockMode } from "@threenative/playtest/protocol";
import { Group, PerspectiveCamera } from "three";
import { expect, it, vi } from "vitest";
import { RiggingScene } from "../src/game.js";

it("preserves the existing fixed-step default for the exact-tick correctness ladder", async () => {
  vi.stubGlobal(PLAYTEST_CLOCK_GLOBAL, undefined);
  try {
    vi.resetModules();
    await import("../src/game.js");
    expect(requestedPlaytestClockMode()).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("preserves an explicitly requested live clock for a separate timing attempt", async () => {
  vi.stubGlobal(PLAYTEST_CLOCK_GLOBAL, "wall-clock");
  try {
    vi.resetModules();
    await import("../src/game.js");
    expect(requestedPlaytestClockMode()).toBe("wall-clock");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("routes a real KeyA edge through the actual scene into 120 accepted Rapier steps, then stops", async () => {
  class SpringInputScene extends RiggingScene {
    protected override readonly mode = "spring" as const;
  }
  const target = new EventTarget();
  const input = new InputMap(
    { moveAnchor: { keys: ["KeyA"] }, fastStop: { keys: ["KeyS"] } },
    target,
  );
  const plugin = rapier({ deterministicRestart: true });
  const scene = new SpringInputScene();
  const graph = new Group();
  const added: Group[] = [];
  const state: Record<string, unknown> = {};
  const memory = Object.fromEntries(
    [
      "storageAttributes",
      "storageAttributesSize",
      "readbackBuffers",
      "readbackBuffersSize",
      "attributes",
      "attributesSize",
      "geometries",
      "indexAttributes",
      "indexAttributesSize",
      "indirectStorageAttributes",
      "indirectStorageAttributesSize",
      "programs",
      "programsSize",
      "renderTargets",
      "textures",
      "texturesSize",
      "uniformBuffers",
      "uniformBuffersSize",
      "total",
    ].map((name) => [name, 0]),
  );
  const ctx = {
    input,
    physics: undefined,
    scene: graph,
    camera: new PerspectiveCamera(),
    renderer: { info: { memory }, render: () => undefined },
    state: {
      set: (patch: Record<string, unknown>) => Object.assign(state, patch),
      flush: () => undefined,
    },
    add: (object: Group) => {
      added.push(object);
      graph.add(object);
      return object;
    },
  } as unknown as Parameters<RiggingScene["load"]>[0];
  const key = (type: string, code: string) => {
    const event = new Event(type);
    Object.defineProperty(event, "code", { value: code });
    target.dispatchEvent(event);
  };
  await plugin.setup?.(ctx as unknown as ICtx<Record<string, unknown>, IPhysicsContext>);
  try {
    await scene.load(ctx);
    scene.enter(ctx);
    const mast = added[1];
    if (mast === undefined) throw new Error("actual scene mast was not added");
    key("keydown", "KeyA");
    key("keyup", "KeyA"); // A tap before a tick must still deliver its latched edge.
    for (let tick = 0; tick < 120; tick++) {
      const before = mast.position.x;
      input.tick();
      scene.update(ctx, 1 / 60);
      plugin.update?.(ctx, 1 / 60);
      expect((mast.position.x - before) * 60).toBeCloseTo(0.25, 4);
    }
    scene.render(ctx);
    expect(state.anchorX).toBeCloseTo(0.5, 5);
    expect(state.anchorMoveRequests).toBe(1);
    expect(state.anchorMoving).toBe(1);
    expect(state.requestedAnchorX).toBeCloseTo(0.5, 5);
    key("keydown", "KeyS");
    input.tick();
    scene.update(ctx, 1 / 60);
    plugin.update?.(ctx, 1 / 60);
    scene.render(ctx);
    expect(state.anchorX).toBeCloseTo(0.5, 5);
    expect(state.anchorMoving).toBe(0);
  } finally {
    scene.exit();
    plugin.dispose?.(ctx);
    input.dispose();
  }
});
