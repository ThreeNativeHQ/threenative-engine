import type { ICtx, IGameObservationContribution, IGamePluginRuntime } from "@threenative/core";
import { Object3D } from "three";
import { afterEach, describe, expect, it } from "vitest";
import "../src/index.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { RigidBody3D } from "../src/RigidBody3D.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";

const plugins: Array<ReturnType<typeof rapier>> = [];

async function physicsHarness() {
  const named = new Map<string, object>();
  let contribution: IGameObservationContribution | undefined;
  let tick = 0;
  const runtime: IGamePluginRuntime = {
    fixedStep: () => 0,
    observations: {
      contribute: (value) => {
        contribution = value;
        return () => {
          if (contribution === value) contribution = undefined;
        };
      },
      contributions: () => (contribution === undefined ? [] : [contribution]),
    },
    rapier: null,
    seed: 1,
    step: 1 / 60,
    tick: () => tick,
  };
  const ctx = {
    entities: {
      add: (id: string, entity: object) => {
        named.set(id, entity);
        return entity;
      },
      get: (id: string) => named.get(id),
      snapshot: () => Object.fromEntries([...named].map(([id]) => [id, {}])),
    },
    physics: undefined,
  } as unknown as ICtx<Record<string, unknown>, IPhysicsContext>;
  const plugin = rapier({ gravity: { x: 0, y: -9.81, z: 0 } });
  await plugin.setup?.(ctx, runtime);
  plugins.push(plugin);
  return {
    contribution: () => {
      if (contribution === undefined) throw new Error("rapier() did not contribute observations.");
      return contribution;
    },
    ctx,
    plugin,
    setTick: (value: number) => {
      tick = value;
    },
  };
}

afterEach(() => {
  for (const plugin of plugins.splice(0)) {
    plugin.dispose?.({} as ICtx<Record<string, unknown>, IPhysicsContext>);
  }
});

describe("rapier playtest capability", () => {
  it("should advertise runtime.physics when rapier is installed", async () => {
    const { contribution } = await physicsHarness();

    expect(contribution().capabilities).toEqual(["runtime.physics"]);
  });

  it("should emit one physicsDebugSeries sample per labelled step", async () => {
    const { contribution, ctx, plugin, setTick } = await physicsHarness();
    const object = new Object3D();
    object.position.y = 2;
    const body = new RigidBody3D({
      object,
      physics: ctx.physics,
      shape: CollisionShape3D.box(1, 1, 1),
    });
    const floor = new Object3D();
    floor.position.y = -0.5;
    new RigidBody3D({
      object: floor,
      physics: ctx.physics,
      shape: CollisionShape3D.box(10, 1, 10),
      type: "fixed",
    });
    ctx.entities.add("crate", { body, object });

    setTick(1);
    plugin.update?.(ctx, 1 / 60);
    contribution().sample({ include: ["physicsDebugSeries"], label: "first" });
    for (let step = 0; step < 300; step += 1) plugin.update?.(ctx, 1 / 60);
    setTick(2);
    const observations = contribution().sample({
      include: ["physicsDebugSeries"],
      label: "settled",
    }) as {
      physicsDebugSeries: Array<{
        label: string;
        snapshot: { artifact: { primitives: Array<Record<string, unknown>> } };
        tick: number;
      }>;
    };

    expect(observations.physicsDebugSeries.map(({ label, tick }) => ({ label, tick }))).toEqual([
      { label: "first", tick: 1 },
      { label: "settled", tick: 2 },
    ]);
    expect(observations.physicsDebugSeries[1]?.snapshot.artifact.primitives).toContainEqual({
      category: "sleep",
      entity: "crate",
      id: "sleep:crate",
      value: 1,
    });
  });

  it("should count one step per completed simulation.step, and count a step that never happened as none", async () => {
    const { contribution, ctx, plugin } = await physicsHarness();

    // Sampled with no `include` at all: the step count rides every observation, because a
    // lifecycle phase reads it at moments when nothing asked for the debug series.
    const steps = (): number =>
      (contribution().sample({}) as { physicsSteps: number }).physicsSteps;

    expect(steps()).toBe(0);
    for (let step = 0; step < 3; step += 1) plugin.update?.(ctx, 1 / 60);
    expect(steps()).toBe(3);

    // The counter is not the game loop's tick and not an attempt count: a step the backend
    // refused advances nothing, so a paused or failed frame cannot be read as simulation.
    const failing = ctx.physics.simulation;
    failing.step = () => {
      throw new Error("TN_TEST_STEP_REFUSED");
    };
    expect(() => plugin.update?.(ctx, 1 / 60)).toThrow("TN_TEST_STEP_REFUSED");
    expect(steps()).toBe(3);
  });

  it("should keep position-only body observations stable", async () => {
    const { contribution, ctx, plugin, setTick } = await physicsHarness();
    const anonymous = new RigidBody3D({
      physics: ctx.physics,
      position: { x: 0, y: 0, z: 0 },
      shape: CollisionShape3D.box(1, 1, 1),
      type: "fixed",
    });
    const named = new RigidBody3D({
      entity: "wall",
      physics: ctx.physics,
      position: { x: 2, y: 0, z: 0 },
      shape: CollisionShape3D.box(1, 1, 1),
      type: "fixed",
    });
    ctx.entities.add("unrelated", { object: undefined });

    setTick(1);
    plugin.update?.(ctx, 1 / 60);
    const observations = contribution().sample({
      include: ["physicsDebugSeries"],
      label: "position-only",
    }) as {
      physicsDebugSeries: Array<{
        snapshot: { artifact: { primitives: Array<Record<string, unknown>> } };
      }>;
    };
    const primitives = observations.physicsDebugSeries[0]?.snapshot.artifact.primitives;

    expect(primitives).toContainEqual({
      category: "sleep",
      entity: `physics.body.${anonymous.body.id}`,
      id: `sleep:physics.body.${anonymous.body.id}`,
      value: 0,
    });
    expect(primitives).toContainEqual({
      category: "sleep",
      entity: "wall",
      id: "sleep:wall",
      value: 0,
    });
    expect(primitives).not.toContainEqual(expect.objectContaining({ entity: "unrelated" }));
  });

  it("should report rather than silently truncate beyond the body bound", async () => {
    const { contribution, ctx, plugin, setTick } = await physicsHarness();
    for (let index = 0; index < 101; index += 1) {
      new RigidBody3D({
        object: new Object3D(),
        physics: ctx.physics,
        shape: CollisionShape3D.sphere(0.1),
        type: "fixed",
      });
    }
    setTick(1);
    plugin.update?.(ctx, 1 / 60);

    const observations = contribution().sample({
      include: ["physicsDebugSeries"],
      label: "bounded",
    }) as {
      physicsDebugSeries: Array<{
        snapshot: { artifact: { overflow: unknown; primitives: unknown[] } };
      }>;
    };
    const artifact = observations.physicsDebugSeries[0]?.snapshot.artifact;

    expect(artifact?.overflow).toEqual({ bodyLimit: 100, omittedBodies: 1, totalBodies: 101 });
    expect(artifact?.primitives).toHaveLength(200);
    expect(JSON.parse(JSON.stringify(observations))).toEqual(observations);
  });

  it("throws on duplicate sample label and when sample limit is reached", async () => {
    const { contribution, ctx, plugin, setTick } = await physicsHarness();
    setTick(1);
    plugin.update?.(ctx, 1 / 60);

    contribution().sample({ include: ["physicsDebugSeries"], label: "step-0" });
    expect(() =>
      contribution().sample({ include: ["physicsDebugSeries"], label: "step-0" }),
    ).toThrow(/TN_PHYSICS_DEBUG_LABEL_DUPLICATE/);

    // Fill up to PHYSICS_DEBUG_SAMPLE_LIMIT (100)
    for (let index = 1; index < 100; index += 1) {
      contribution().sample({ include: ["physicsDebugSeries"], label: `step-${index}` });
    }

    // 101st sample exceeds the sample limit
    expect(() =>
      contribution().sample({ include: ["physicsDebugSeries"], label: "overflow-step" }),
    ).toThrow(/TN_PHYSICS_DEBUG_SAMPLE_LIMIT/);
  });
});
