import * as RAPIER from "@dimforge/rapier3d-compat";
import { type ICtx, WaveField } from "@threenative/core";
import { BoxGeometry, Mesh } from "three";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/index.js";
import { Buoyancy3D } from "../src/Buoyancy3D.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { RigidBody3D } from "../src/RigidBody3D.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";

type PhysicsCtx = ICtx<Record<string, unknown>, IPhysicsContext>;

const plugins: Array<ReturnType<typeof rapier>> = [];

beforeAll(async () => {
  await RAPIER.init();
});

function flatSurface() {
  return { sample: () => ({ height: 0, normal: { x: 0, y: 1, z: 0 } }) };
}

async function setup(): Promise<{ ctx: PhysicsCtx; plugin: ReturnType<typeof rapier> }> {
  const plugin = rapier({ gravity: { x: 0, y: -9.81, z: 0 } });
  const ctx = { physics: undefined } as unknown as PhysicsCtx;
  await plugin.setup?.(ctx);
  plugins.push(plugin);
  return { ctx, plugin };
}

describe("Buoyancy3D", () => {
  it("settles a box at the analytic flat-waterline and remains there for 600 fixed steps", async () => {
    const { ctx, plugin } = await setup();
    const mesh = new Mesh(new BoxGeometry(2, 2, 2));
    mesh.position.y = 1.5;
    const body = new RigidBody3D({
      // The two hull points displace 500 kg at the analytic half-submerged waterline, so this
      // explicit mass is the body's total mass. It used to be added to the collider's 8 kg.
      mass: 500,
      object: mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.box(2, 2, 2),
    });
    const buoyancy = new Buoyancy3D({
      body,
      density: 1_000,
      drag: 1_200,
      hullPoints: [
        { position: [0, -1, 0], volume: 0.5 },
        { position: [0, 1, 0], volume: 0.5 },
      ],
      surface: flatSurface(),
    });

    for (let step = 0; step < 600; step += 1) plugin.update?.(ctx, 1 / 60);

    expect(mesh.position.y).toBeCloseTo(0, 2);
    expect(buoyancy.submergedFraction).toBeCloseTo(0.5, 2);
    const settled = mesh.position.y;
    for (let step = 0; step < 600; step += 1) plugin.update?.(ctx, 1 / 60);
    expect(mesh.position.y).toBeCloseTo(settled, 2);
  });

  it("keeps measuring submerged fraction when the convention is disabled", async () => {
    const { ctx } = await setup();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1));
    const body = new RigidBody3D({
      mass: 1,
      object: mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.box(1, 1, 1),
    });
    const buoyancy = new Buoyancy3D({
      body,
      buoyancy: false,
      hullPoints: [{ position: [0, -0.5, 0], volume: 1 }],
      surface: flatSurface(),
    });
    expect(body.buoyancy).toBe(buoyancy);
    expect(buoyancy.submergedFraction).toBeGreaterThan(0);
  });

  it("applies asymmetric hull-point forces at their world positions and produces torque", async () => {
    const { ctx, plugin } = await setup();
    const mesh = new Mesh(new BoxGeometry(2, 2, 2));
    const body = new RigidBody3D({
      mass: 1,
      object: mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.box(2, 2, 2),
    });
    new Buoyancy3D({
      body,
      density: 1,
      drag: 0,
      gravity: 9.81,
      hullPoints: [{ position: [1, 0, 0], spacing: 1, volume: 1 }],
      surface: flatSurface(),
    });

    plugin.update?.(ctx, 1 / 60);

    expect(Math.abs(mesh.quaternion.z)).toBeGreaterThan(1e-6);
  });

  it("keeps a hull within one point spacing of a moving WaveField across 600 steps", async () => {
    const { ctx, plugin } = await setup();
    const field = new WaveField({
      waves: [
        { amplitude: 0.24, direction: [1, 0.2], wavelength: 4, speed: 0.7 },
        { amplitude: 0.08, direction: [-0.3, 1], wavelength: 2.5, speed: -0.4 },
      ],
    });
    const mesh = new Mesh(new BoxGeometry(2, 2, 2));
    mesh.position.y = 1;
    const body = new RigidBody3D({
      mass: 492,
      object: mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.box(2, 2, 2),
    });
    const spacing = 2;
    const buoyancy = new Buoyancy3D({
      body,
      density: 1_000,
      drag: 1_200,
      hullPoints: [
        { position: [0, -1, 0], volume: 0.5, spacing },
        { position: [0, 1, 0], volume: 0.5, spacing },
      ],
      surface: field,
    });

    let maximumPenetration = 0;
    for (let step = 0; step < 600; step += 1) {
      plugin.update?.(ctx, 1 / 60);
      const surfaceHeight = field.sample(mesh.position.x, mesh.position.z, buoyancy.time).height;
      maximumPenetration = Math.max(maximumPenetration, surfaceHeight - (mesh.position.y - 1));
    }

    expect(maximumPenetration).toBeLessThanOrEqual(spacing);
  });

  it("rejects a body with no hull points", async () => {
    const { ctx } = await setup();
    const body = new RigidBody3D({
      object: new Mesh(new BoxGeometry(1, 1, 1)),
      physics: ctx.physics,
      shape: CollisionShape3D.box(1, 1, 1),
    });
    expect(() => new Buoyancy3D({ body, hullPoints: [], surface: flatSurface() })).toThrow(
      /hullPoints/i,
    );
  });
});
