import { FluidParticles3D, type ICtx, Scene, type SceneFrame } from "@threenative/core";
import {
  Buoyancy3D,
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
} from "@threenative/physics";
import { BoxGeometry, Mesh, MeshBasicMaterial, SphereGeometry } from "three";
import { createPointsView } from "./render/points.js";
import { type IFluidParticlesState, INITIAL_STATE } from "./state.js";

/** The bodies fall ~6.6 m (about 70 steps) onto the pool; its rest level is read at step 55. */
const LEVEL_STEP = 55;
const WATER_DENSITY = 1000;

interface IBodySpec {
  readonly name: "sphere" | "boxLight" | "boxSmall";
  readonly density: number;
  readonly start: readonly [number, number, number];
  readonly half: readonly [number, number, number];
}

const SPHERE_RADIUS = 0.3;
const BODIES: readonly IBodySpec[] = [
  {
    name: "sphere",
    density: 1900,
    start: [-1, 8, 0],
    half: [SPHERE_RADIUS, SPHERE_RADIUS, SPHERE_RADIUS],
  },
  { name: "boxLight", density: 550, start: [1.2, 8.5, 0], half: [0.4, 0.4, 0.4] },
  { name: "boxSmall", density: 300, start: [1.2, 9.5, -0.8], half: [0.25, 0.25, 0.25] },
];

export class CouplingScene extends Scene<IFluidParticlesState, IPhysicsContext> {
  static override readonly initialState: IFluidParticlesState = INITIAL_STATE;

  override enter(
    ctx: ICtx<IFluidParticlesState, IPhysicsContext>,
  ): SceneFrame<IFluidParticlesState, IPhysicsContext> {
    const water = new FluidParticles3D({ capacity: 4000, readbackEvery: 1 });
    ctx.add(water);
    ctx.add(createPointsView(water, ctx.scene, ctx.camera));
    water.fill([-2.8, 0.1, -1.5], [2.8, 1.3, 1.5]);

    // The tank floor the bodies can rest on; its top is the water's floor.
    const floor = new RigidBody3D({
      collisionLayer: 1,
      physics: ctx.physics,
      position: { x: 0, y: -1, z: 0 },
      shape: CollisionShape3D.box(8, 2, 5),
      type: "fixed",
    });

    const bodies = BODIES.map((spec) => {
      const isSphere = spec.name === "sphere";
      const mesh = new Mesh(
        isSphere
          ? new SphereGeometry(spec.half[0], 20, 14)
          : new BoxGeometry(spec.half[0] * 2, spec.half[1] * 2, spec.half[2] * 2),
        new MeshBasicMaterial({ color: isSphere ? 0xf2a65a : 0xe8e0c8 }),
      );
      mesh.position.set(...spec.start);
      ctx.add(mesh);
      const volume = isSphere
        ? (4 / 3) * Math.PI * spec.half[0] ** 3
        : 8 * spec.half[0] * spec.half[1] * spec.half[2];
      const body = new RigidBody3D({
        collisionLayer: 1,
        mass: spec.density * volume,
        object: mesh,
        physics: ctx.physics,
        shape: isSphere
          ? CollisionShape3D.sphere(spec.half[0])
          : CollisionShape3D.box(spec.half[0] * 2, spec.half[1] * 2, spec.half[2] * 2),
      });
      const [hx, hy, hz] = spec.half;
      new Buoyancy3D({
        body,
        density: WATER_DENSITY,
        drag: isSphere ? 800 : 2500,
        gravity: 9.81,
        // One point at the centre: heave only. Points off-centre would feed surface noise into
        // torque, and Rapier angular damping is not on the body options.
        hullPoints: [{ position: [0, 0, 0] }],
        pointSpacing: hy * 2,
        surface: water,
        volume,
      });
      return { body, mesh, spec };
    });
    const sphere = bodies[0] as (typeof bodies)[number];
    const box = bodies[1] as (typeof bodies)[number];

    // Each fixed step the solver learns where the bodies are, so its particles flow around them.
    ctx.afterPhysics(() => {
      water.setColliders(
        bodies.map(({ mesh, spec }) =>
          spec.name === "sphere"
            ? {
                kind: "sphere",
                center: mesh.position.toArray() as [number, number, number],
                radius: spec.half[0],
              }
            : {
                kind: "box",
                center: mesh.position.toArray() as [number, number, number],
                halfExtents: spec.half,
                rotation: mesh.quaternion.toArray() as [number, number, number, number],
              },
        ),
      );
    });

    let level0 = 0;
    let disturbance = 0;
    return (frame) => {
      void floor; // the fixed floor body must outlive the scene
      const stats = water.stats;
      if (water.steps === LEVEL_STEP) level0 = water.heightAt(sphere.spec.start[0], 0);
      if (water.steps > LEVEL_STEP)
        disturbance = Math.max(
          disturbance,
          Math.abs(water.heightAt(sphere.spec.start[0], 0) - level0),
        );
      const surfaceAtBox = water.heightAt(box.mesh.position.x, box.mesh.position.z);
      const landed = stats !== undefined;
      frame.state.set({
        count: stats?.count ?? 0,
        steps: water.steps,
        meanCompression: stats?.meanCompression ?? 1,
        maxSpeed: stats?.maxSpeed ?? 99,
        staleFrames: stats?.staleFrames ?? 0,
        sphereY: sphere.mesh.position.y,
        sphereSpeed: Math.hypot(
          sphere.body.linearVelocity.x,
          sphere.body.linearVelocity.y,
          sphere.body.linearVelocity.z,
        ),
        surfaceRest: level0,
        boxY: box.mesh.position.y,
        boxSurfaceGap: landed ? Math.abs(box.mesh.position.y - surfaceAtBox) : 99,
        surfaceDisturbance: disturbance,
        surface: surfaceAtBox,
      });
    };
  }
}
