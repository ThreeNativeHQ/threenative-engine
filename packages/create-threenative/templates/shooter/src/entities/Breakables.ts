import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import {
  type BufferGeometry,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Vector2,
  Vector3,
} from "three";

/**
 * Props that come apart when you shoot them.
 *
 * ## Why this is worth having
 *
 * A world where every round lands on something immovable teaches the player that shooting has
 * no consequence outside the scoreboard. One pot that bursts into shards which then bounce down
 * the steps does more for how a weapon feels than any amount of tuning on the weapon itself.
 *
 * ## The two halves
 *
 * `BreakableField` owns mechanism: intact props, the shard pool, the physics bodies, and the
 * lifetime that returns a shard to the pool. `KIND_STYLES` below is this game's content and can
 * be replaced wholesale — a different game keeps the field and writes its own pots.
 *
 * ## Real bodies, borrowed briefly
 *
 * Shards are actual dynamic Rapier bodies, so they land on the steps and pile against walls
 * instead of falling through the world. But a dynamic body is a permanent cost in the
 * simulation, and a round is a hundred-odd seconds of shooting — so a shard's body exists only
 * while the shard is moving. `SHARD_SECONDS` after the break, the body is disposed and the mesh
 * goes back to the pool. That keeps the live-body count bounded by `maxLiveShards` however many
 * pots the player shoots.
 *
 * The shard meshes themselves are allocated once, up front, at zero opacity and in the scene —
 * building a mesh mid-round is the WebGPU pipeline stall recorded in `Rifle` and `gunfx`.
 */

export type BreakableKind = "pot" | "jar" | "bottle";

type KindStyle = {
  /** Lathe profile in metres: the silhouette that gets turned about the Y axis. */
  readonly profile: readonly [number, number][];
  readonly colour: number;
  readonly roughness: number;
  readonly metalness: number;
  readonly shardColour: number;
  readonly shardCount: number;
  /** Half-extents of the raycast box that stands in for this prop, in metres. */
  readonly hitHalf: readonly [number, number, number];
  /** How hard the pieces leave, in metres per second. */
  readonly burst: number;
};

/**
 * Three vessels with clearly different silhouettes. Reading which one you are looking at from
 * across the plaza matters more than any of their surface detail: a row of identical pots is
 * scenery, and three different ones is a place where people live.
 */
const KIND_STYLES: Readonly<Record<BreakableKind, KindStyle>> = {
  // Tall amphora: narrow foot, full shoulder, pinched neck, flared lip.
  pot: {
    profile: [
      [0.0, 0.0],
      [0.09, 0.0],
      [0.1, 0.03],
      [0.14, 0.14],
      [0.2, 0.3],
      [0.19, 0.44],
      [0.12, 0.56],
      [0.1, 0.62],
      [0.13, 0.66],
      [0.12, 0.68],
    ],
    colour: 0xa8592f,
    roughness: 0.85,
    metalness: 0.02,
    shardColour: 0x9c5330,
    shardCount: 9,
    hitHalf: [0.2, 0.35, 0.2],
    burst: 3.4,
  },
  // Squat storage jar: wide, low, straight-sided.
  jar: {
    profile: [
      [0.0, 0.0],
      [0.13, 0.0],
      [0.17, 0.05],
      [0.19, 0.18],
      [0.17, 0.3],
      [0.14, 0.34],
      [0.15, 0.36],
    ],
    colour: 0xc4a074,
    roughness: 0.9,
    metalness: 0.02,
    shardColour: 0xb08f66,
    shardCount: 8,
    hitHalf: [0.19, 0.19, 0.19],
    burst: 3.0,
  },
  // Glass bottle: thin, tall neck, and it goes further when it lets go.
  bottle: {
    profile: [
      [0.0, 0.0],
      [0.055, 0.0],
      [0.06, 0.02],
      [0.06, 0.16],
      [0.035, 0.24],
      [0.028, 0.3],
      [0.034, 0.32],
    ],
    colour: 0x2f5f4a,
    roughness: 0.18,
    metalness: 0.05,
    shardColour: 0x3f7a60,
    shardCount: 7,
    hitHalf: [0.07, 0.17, 0.07],
    burst: 4.2,
  },
};

/** Seconds a shard keeps its physics body before it is recycled. */
const SHARD_SECONDS = 5.5;
/** Seconds of that life spent fading, so nothing blinks out of existence. */
const SHARD_FADE_SECONDS = 1.1;

type Prop = {
  readonly kind: BreakableKind;
  readonly group: Group;
  readonly hitMesh: Mesh;
  readonly origin: Vector3;
  broken: boolean;
};

type Shard = {
  readonly mesh: Mesh;
  body: RigidBody3D | undefined;
  age: number;
  live: boolean;
};

/**
 * The material the renderer draws this shard with, read at the moment of use. Never cache it:
 * `createMaterialLighting` swaps every mesh in the scene to a converted copy, so a reference taken
 * at construction soon points at a material nothing draws.
 */
function drawn(shard: Shard): MeshStandardMaterial {
  return shard.mesh.material as MeshStandardMaterial;
}

const scratchDirection = new Vector3();
const scratchOffset = new Vector3();

/** The vessel silhouette, turned about Y. `LatheGeometry` is why a pot costs six lines. */
function latheFrom(profile: readonly [number, number][], segments: number): BufferGeometry {
  return new LatheGeometry(
    profile.map(([x, y]) => new Vector2(x, y)),
    segments,
  );
}

export class BreakableField {
  readonly #scene: Object3D;
  readonly #physics: IPhysicsContext;
  readonly #rng: () => number;
  readonly #props: Prop[] = [];
  readonly #shards: Shard[] = [];
  readonly #shardGeometry: BufferGeometry;
  #shardCursor = 0;
  #broken = 0;
  #liveShards = 0;
  /** Dead shards stop being submitted once their pipeline exists. See `settle`. */
  #settled = false;

  constructor(
    scene: Object3D,
    physics: IPhysicsContext,
    rng: () => number,
    options: { maxLiveShards?: number } = {},
  ) {
    this.#scene = scene;
    this.#physics = physics;
    this.#rng = rng;
    // One angular solid, scaled per shard. Pottery does not break into spheres, and an
    // icosahedron at detail 0 has the flat facets that catch the key light like a broken edge.
    this.#shardGeometry = new IcosahedronGeometry(1, 0);
    const capacity = options.maxLiveShards ?? 27;
    for (let index = 0; index < capacity; index += 1) {
      const material = new MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0.02,
        opacity: 0,
        roughness: 0.85,
        transparent: true,
      });
      const mesh = new Mesh(this.#shardGeometry, material);
      // Present from the first frame at a size nothing can see, so the pipeline for this
      // material is built during loading rather than on the frame a pot bursts.
      mesh.scale.setScalar(0.0001);
      mesh.visible = true;
      // Flying shards are centimetres wide and short-lived; submitting each to
      // the town-wide sun map costs a draw for a sub-pixel silhouette.
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.#shards.push({ mesh, body: undefined, age: 0, live: false });
    }
  }

  /** Props broken this round. The playtest gate for "a shot vessel actually comes apart". */
  get broken(): number {
    return this.#broken;
  }

  /** Shards currently carrying a physics body — bounded by the pool, never by the round length. */
  get liveShards(): number {
    return this.#liveShards;
  }

  /**
   * Stand a vessel at `position`. The returned mesh is the raycast proxy, not the visible
   * geometry: a lathe with a hollow interior gives a raycast an inside face to hit, and the
   * player would watch rounds pass through the near wall and mark the far one.
   */
  add(kind: BreakableKind, position: { x: number; y: number; z: number }, yaw = 0): Mesh {
    const style = KIND_STYLES[kind];
    const group = new Group();
    group.position.set(position.x, position.y, position.z);
    group.rotation.y = yaw;
    const shell = new Mesh(
      latheFrom(style.profile, 20),
      new MeshStandardMaterial({
        color: style.colour,
        metalness: style.metalness,
        roughness: style.roughness,
      }),
    );
    // The vessels are small moving props. Keep their lit volume and received
    // town shadows, but leave the 2048 px sun pass to architectural casters.
    shell.castShadow = false;
    shell.receiveShadow = true;
    group.add(shell);

    const [hx, hy, hz] = style.hitHalf;
    const hitMesh = new Mesh(this.#shardGeometry, new MeshStandardMaterial({ visible: false }));
    hitMesh.scale.set(hx, hy, hz);
    hitMesh.position.y = hy;
    hitMesh.visible = true;
    group.add(hitMesh);
    this.#scene.add(group);

    const prop: Prop = {
      kind,
      group,
      hitMesh,
      origin: new Vector3(position.x, position.y, position.z),
      broken: false,
    };
    // The raycast hands back the struck object; this is how the scene gets from a hit to the
    // prop without a lookup table that can fall out of step with the scene graph.
    hitMesh.userData.breakable = prop;
    this.#props.push(prop);
    return hitMesh;
  }

  /** Every raycast proxy, for the scene's `hittable` list. */
  hittable(): Object3D[] {
    return this.#props.map((prop) => prop.hitMesh);
  }

  /**
   * Take a prop apart. Returns the world point the break happened at, or undefined when the
   * object struck was not an intact breakable — so a caller can branch on one call.
   */
  shatter(struck: Object3D, at: Vector3, direction: Vector3): Vector3 | undefined {
    const prop = struck.userData.breakable as Prop | undefined;
    if (prop === undefined || prop.broken) return undefined;
    prop.broken = true;
    this.#broken += 1;
    prop.group.visible = false;
    const style = KIND_STYLES[prop.kind];
    scratchDirection.copy(direction).normalize();
    for (let index = 0; index < style.shardCount; index += 1) {
      this.#launchShard(prop, style, index);
    }
    return at;
  }

  /** Age every live shard, fade the dying ones, and hand settled bodies back to the simulation. */
  update(dt: number): void {
    for (const shard of this.#shards) {
      if (!shard.live) continue;
      shard.age += dt;
      if (shard.age >= SHARD_SECONDS) {
        this.#retire(shard);
        continue;
      }
      const remaining = SHARD_SECONDS - shard.age;
      drawn(shard).opacity =
        remaining >= SHARD_FADE_SECONDS ? 1 : Math.max(0, remaining / SHARD_FADE_SECONDS);
    }
  }

  /**
   * Stop submitting the shards that are not flying.
   *
   * Every shard is resident from frame one at a size nothing can see, so its pipeline compiles
   * during loading; the cost is a draw per dead shard forever, and on a phone the draw call is the
   * expensive part, not the triangles. Once compiled the pipeline is cached, so `#launchShard`
   * re-showing a shard is free.
   */
  settle(): void {
    this.#settled = true;
    for (const shard of this.#shards) {
      if (!shard.live) shard.mesh.visible = false;
    }
  }

  /**
   * Registered as an entity so a scenario can assert a shot vessel came apart and cleaned up.
   * `drawnShards` counts the flying shards whose material, as the renderer holds it right now, is
   * opaque and shown: a body can be live while nothing of it reaches the screen.
   */
  debug(): {
    broken: number;
    drawnShards: number;
    liveShards: number;
    props: number;
    shardCapacity: number;
  } {
    let drawnShards = 0;
    for (const shard of this.#shards) {
      if (shard.live && shard.mesh.visible && drawn(shard).opacity > 0.5) drawnShards += 1;
    }
    return {
      broken: this.#broken,
      drawnShards,
      liveShards: this.#liveShards,
      props: this.#props.length,
      shardCapacity: this.#shards.length,
    };
  }

  dispose(): void {
    for (const shard of this.#shards) {
      shard.body?.dispose();
      drawn(shard).dispose();
      shard.mesh.removeFromParent();
    }
    this.#shards.length = 0;
    for (const prop of this.#props) {
      prop.group.traverse((object) => {
        const mesh = object as Mesh;
        if (mesh.isMesh === true) {
          mesh.geometry.dispose();
          (mesh.material as Material).dispose();
        }
      });
      prop.group.removeFromParent();
    }
    this.#props.length = 0;
    this.#shardGeometry.dispose();
  }

  #launchShard(prop: Prop, style: KindStyle, index: number): void {
    const shard = this.#shards[this.#shardCursor % this.#shards.length];
    this.#shardCursor += 1;
    if (shard === undefined) return;
    // Stealing a still-flying shard is how the pool stays bounded: the newest break is the one
    // the player is looking at, and an older pile losing a piece is not something they can see.
    if (shard.live) this.#retire(shard);

    const rng = this.#rng;
    // Pottery breaks into a few big pieces and a lot of small ones, not into uniform flakes. The
    // cube here is what produces that spread: most draws stay small, a few come out as a shoulder
    // or a base you can recognise from across the plaza. Shards are plates rather than pebbles —
    // wide and thin, so they tumble on landing instead of rolling away.
    const size = 0.045 + rng() ** 3 * 0.075;
    const thickness = size * (0.3 + rng() * 0.25);
    shard.mesh.scale.set(size, thickness, size * (0.75 + rng() * 0.7));
    shard.mesh.visible = true;
    // Spread the pieces around the vessel's own body rather than all from the bullet's entry —
    // a pot that comes apart only where it was hit reads as a decal, not a break.
    const around = (index / style.shardCount) * Math.PI * 2;
    const height = rng() * (style.hitHalf[1] ?? 0.2) * 2;
    scratchOffset.set(
      Math.cos(around) * (style.hitHalf[0] ?? 0.2) * 0.8,
      height,
      Math.sin(around) * (style.hitHalf[2] ?? 0.2) * 0.8,
    );
    shard.mesh.position.copy(prop.origin).add(scratchOffset);
    shard.mesh.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    // A fired vessel is not one colour: the glazed outside, the raw clay core and the shadowed
    // inside all show once it opens up. A little spread per shard is what stops the pile reading
    // as confetti cut from a single sheet.
    const material = drawn(shard);
    material.color.setHex(style.shardColour);
    material.color.multiplyScalar(0.72 + rng() * 0.5);
    material.opacity = 1;

    const body = new RigidBody3D({
      object: shard.mesh,
      physics: this.#physics,
      shape: CollisionShape3D.box(size * 2, thickness * 2, size * 2),
      mass: 0.09,
      type: "dynamic",
    });
    // Outward from the vessel's axis, carried along by the round, and lifted: a break that only
    // pushes along the bullet leaves every piece in one flat fan.
    body.linearVelocity = {
      x: (scratchOffset.x * 5 + scratchDirection.x * 1.6 + (rng() - 0.5)) * style.burst * 0.32,
      y: (1.1 + rng() * 1.5) * style.burst * 0.32,
      z: (scratchOffset.z * 5 + scratchDirection.z * 1.6 + (rng() - 0.5)) * style.burst * 0.32,
    };
    shard.body = body;
    shard.age = 0;
    shard.live = true;
    this.#liveShards += 1;
  }

  #retire(shard: Shard): void {
    shard.body?.dispose();
    shard.body = undefined;
    shard.live = false;
    shard.age = 0;
    drawn(shard).opacity = 0;
    shard.mesh.scale.setScalar(0.0001);
    if (this.#settled) shard.mesh.visible = false;
    this.#liveShards = Math.max(0, this.#liveShards - 1);
  }
}
