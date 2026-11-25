# Physics and movement

Add Rapier bodies, a controllable character and trigger areas that run the same on web and native
builds.

## Setup

Add the `rapier()` plugin and pass `IPhysicsContext` as the second type parameter. Scenes then get
the physics service as `ctx.physics`.

```ts
import { rapier, type IPhysicsContext } from "@threenative/physics";

const game = defineGame<GameState, IPhysicsContext>({
  plugins: [rapier()],
  // scenes, start, ...
});
```

`rapier()` accepts `gravity` and `deterministicRestart`. With `deterministicRestart: true`, each
scene gets a fresh simulation, so a restarted scene settles exactly like the first run. It frees
the backend world at scene exit, so any `raw` reference from the old scene becomes invalid.

## Nodes

The node names follow Godot.

| Class | Use it for |
| --- | --- |
| `RigidBody3D` | Crates, balls and platforms. `type` is `"dynamic"` (default), `"fixed"` or `"kinematic"`. |
| `CharacterBody3D` | Player or enemy movement with collision. Set `velocity`, then call `moveAndSlide(dt)`. |
| `Area3D` | Triggers such as pickups, checkpoints and doorways. |
| `CollisionShape3D` | The contact shape: `box`, `sphere`, `capsule` or `fromMesh`. |

This is how the minimal template builds its floor, player and pickup:

```ts
new RigidBody3D({
  object: floor,
  physics: ctx.physics,
  shape: CollisionShape3D.fromMesh(floor),
  type: "fixed",
});

const body = new CharacterBody3D({
  autostep: { maxHeight: 0.4, minWidth: 0.2 },
  object: mesh,
  physics: ctx.physics,
  shape: CollisionShape3D.capsule(0.2, 0.3),
});

const pickup = new Area3D({
  physics: ctx.physics,
  position: { x: 1.5, y: 0.5, z: 0 },
  shape: CollisionShape3D.box(1, 1, 1),
});
pickup.on("bodyEntered", (entered) => {
  if (entered === body) ctx.state.set((state) => ({ score: state.score + 1 }));
});
```

Each step, the player sets `body.velocity` from input and calls `body.moveAndSlide(dt)`. Read
`body.grounded` to allow a jump. Call `dispose()` on a body when its scene ends. `Area3D.on`
returns a function that removes the handler.

## More node types

These follow the same lifecycle: build with the physics context, add through `ctx.add`, dispose at
scene exit.

| Class | Use it for |
| --- | --- |
| `VehicleBody3D` | A car, truck or bike on ray-cast suspension. Write `engineForce`, `brake` and `steering` every physics update; a car with no input does not move. `suspensionStiffness` is a frequency squared, not newtons per metre: 100 is a road car, 20 bottoms out. |
| `Buoyancy3D` | Float a rigid body on a height source — `WaveField`, `SpectralOcean`, a fluid's surface. Supply hull points, density, drag and the source; forces are applied in fixed-step order. |
| `Joint3D` | A Godot-style joint: `Joint3D.hinge(options)`, `Joint3D.pin(options)` or `Joint3D.fixed(options)`. Both bodies must belong to the same physics context. |
| `SoftBody3D` | Cloth and deformable bodies, optionally skinned to a mesh. It needs WebGPU compute. A teleport or an extreme deformation resets it, printing `TN_SOFTBODY_RESET` with the cause. |

Two helpers build collision you would otherwise hand-place. `buildStaticColliders(ctx, level, {
predicate })` turns the meshes you authored in a scene root into fixed trimesh bodies, and throws when
the predicate selects nothing. `ScatterColliders` makes streamed or instanced props solid near a
followed point: it measures each instance's solid part, so a slender base becomes a trunk capsule,
the rest an 18-DOP hull, and pieces under 0.25 m get none. Call `update()` every frame; it rescans
only after the follow point moves a quarter of `radius`.

## Navigation

`@threenative/physics/navigation` is a separate subpath with its own plugin. Add it after `rapier()`:

```ts
import { rapier } from "@threenative/physics";
import { NavigationAgent3D, NavigationRegion3D, recast } from "@threenative/physics/navigation";

const game = defineGame<GameState, IPhysicsContext>({
  plugins: [rapier(), recast()],
});

const region = new NavigationRegion3D({ navigation: ctx.physics.navigation, meshes: [floor] });
ctx.add(region);
const agent = new NavigationAgent3D({ navigation: ctx.physics.navigation, object: enemy.mesh });
```

`NavigationRegion3D` bakes walkable geometry, so bake before creating agents or obstacles.
`NavigationAgent3D` follows a path with the crowd; `NavigationObstacle3D` keeps a path around
something that moves.

Navigation is Recast through WebAssembly, so it is web-only today: a native build has no navmesh, and
an enemy that walks around a wall is a web feature. It also requires `rapier()` earlier in the
plugins array, and throws a named error when it is missing.

## Web and native

Browser builds run Rapier through WebAssembly. Desktop and Android builds use the native runtime's
Rapier. ThreeNative picks the backend for the target, so the node API stays the same. Navigation is
the exception: Recast is WebAssembly only, so it runs on the web and not on a native build. See
[Native runtime](native-runtime.md) for platform support.

## Raw access

`world.raw`, `body.raw`, `collider.raw` and `CollisionShape3D.raw` expose the backend object. On
the web this is a Rapier object. In a native build it is an opaque handle. Code that reads `raw` is
not portable. Keep it apart from shared gameplay and check which backend it expects.

For a low-level integration, `ctx.physics.simulation` batches per-frame work. `step()` takes body
input in reusable typed arrays and `readVisibleTransforms()` returns visible transforms in bulk.
This moves many bodies per call instead of one platform call per body.

## Tests and replays

Use playtests to check interactions: the character reaches a platform, a crate comes to rest, a
trigger adds a point. Run them on every release target.

Physics replays and snapshots repeat only on the exact runtime that recorded them. They do not
carry across web and native, Rapier versions, operating systems or CPU architectures. Use gameplay
scenarios for checks that must pass on every platform.

## Source

- [physics README](../../packages/physics/README.md)
- [plugin.ts](../../packages/physics/src/plugin.ts)
- [minimal template Play.ts](../../packages/create-threenative/templates/minimal/src/scenes/Play.ts)
