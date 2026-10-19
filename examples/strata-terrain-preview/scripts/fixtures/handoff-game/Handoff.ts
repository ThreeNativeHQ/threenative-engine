// An ordinary game scene that adopts an exported world: the GLB is the one representation of the
// terrain, props and water; the baked heights register the ground's collision; the camera and the
// look are this game's own. Nothing here imports the terrain authoring package.
import { type ICtx, Scene } from "@threenative/core";
import { Heightfield } from "@threenative/core/world";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import {
  Box3,
  type Group,
  type InstancedMesh,
  type Light,
  Mesh,
  Object3D,
  type PerspectiveCamera,
  Vector3,
} from "three";
import { environment } from "../handoff/environment.js";
import { heights, resolution, size } from "../handoff/world.js";
import { bindEnvironment } from "../render/handoffEnvironment.js";
import { type GameState, initialState } from "../state.js";

type Ctx = ICtx<GameState, IPhysicsContext>;
type Binding = ReturnType<typeof bindEnvironment>;

export class Handoff extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = initialState;
  #world: Group | undefined;
  #terrain: Mesh | undefined;
  #binding: Binding | undefined;
  #ground: RigidBody3D | undefined;
  #frames = 0;

  override async load(ctx: Ctx): Promise<void> {
    const gltf = await ctx.assets.model<{ scene: Group; cameras: unknown[] }>("world.glb");
    this.#world = gltf.scene;
    let placements = 0;
    let meshes = 0;
    let lights = 0;
    gltf.scene.traverse((object) => {
      // The asset pipeline batches repeated placements into one instanced draw, so a placement is
      // either its own node or one instance of such a batch.
      if (typeof object.userData.placementId === "string") placements++;
      if ((object as InstancedMesh).isInstancedMesh) placements += (object as InstancedMesh).count;
      if ((object as Light).isLight) lights++;
      if (object instanceof Mesh) {
        meshes++;
        if (object.parent?.name === "terrain" || object.name === "terrain") this.#terrain = object;
      }
    });
    ctx.state.set({ placements, meshes, glbLights: lights, glbCameras: gltf.cameras.length });
  }

  override enter(ctx: Ctx): void {
    if (!this.#world || !this.#terrain) throw new Error("world.glb did not load a terrain");
    ctx.add(ctx.camera);
    ctx.add(this.#world);
    this.#binding = bindEnvironment(ctx, environment);
    // Collision from the baked heights, on the same grid the GLB's terrain was cut from.
    const field = new Heightfield({
      rows: resolution,
      columns: resolution,
      width: size,
      depth: size,
      origin: { x: 0, z: 0 },
      heights: Float32Array.from(heights),
    });
    // The collider belongs to an anchor at the world origin, not to the GLB's terrain mesh: the
    // asset pipeline may quantise that mesh and give it a local scale and offset of its own.
    const anchor = new Object3D();
    ctx.add(anchor);
    this.#ground = new RigidBody3D({
      object: anchor,
      physics: ctx.physics,
      type: "fixed",
      entity: "terrain",
      collisionLayer: 4,
      shape: CollisionShape3D.heightfield(field.rows, field.columns, field.toColliderHeights(), {
        x: size,
        y: 1,
        z: size,
      }),
    });
    // The camera is the game's: framed from the world's measured bounds, never from saved state.
    const bounds = new Box3().setFromObject(this.#world); // engine-override: frame the camera from full world bounds
    const at = bounds.getCenter(new Vector3());
    const radius = bounds.getSize(new Vector3()).length() / 2;
    const camera = ctx.camera as PerspectiveCamera;
    camera.fov = 60;
    camera.far = 5000;
    camera.position
      .copy(at)
      .add(
        new Vector3(0.7, 0.65, 1)
          .normalize()
          .multiplyScalar((radius / Math.sin(Math.PI / 6)) * 0.9),
      );
    camera.lookAt(at);
    camera.updateProjectionMatrix();
    const sun = this.#binding.sun;
    ctx.state.set({
      colliderRows: field.rows,
      colliderColumns: field.columns,
      sunIntensity: sun.intensity,
      sunElevation: (Math.asin(sun.position.clone().normalize().y) * 180) / Math.PI,
      fillIntensity: this.#binding.fill.intensity,
      exposure: this.#binding.raw.toneMappingExposure ?? 0,
      fogDensity: (ctx.scene.fog as { density?: number } | null)?.density ?? 0,
    });
  }

  override update(ctx: Ctx): void {
    this.#frames++;
    const terrain = this.#terrain;
    // The solver has to have run before the collider is in the space, so the contact is measured
    // a hundred frames in, inside the scenario: the physics ray and the drawn terrain must meet the ground at one height.
    if (this.#frames === 100 && terrain) {
      terrain.updateWorldMatrix(true, false);
      let worst = 0;
      for (const [x, z] of [
        [0, 0],
        [40, -30],
        [-100, 80],
        [120, 120],
        [-150, -140],
      ] as const) {
        const visual = ctx.raycast({
          origin: new Vector3(x, 500, z),
          direction: new Vector3(0, -1, 0),
          targets: [terrain],
        });
        const physical = ctx.physics.directSpaceState.intersectRay({
          collisionMask: 4,
          from: { x, y: 500, z },
          to: { x, y: -100, z },
        });
        if (!visual || !physical) throw new Error(`No ground contact at ${x}, ${z}`);
        worst = Math.max(worst, Math.abs(visual.point.y - physical.position.y));
      }
      console.info(`HANDOFF_GROUND_ERROR ${worst}`);
      ctx.state.set({ groundError: worst, groundMeasured: 1 });
    }
    ctx.state.set({ frames: this.#frames });
  }
}
