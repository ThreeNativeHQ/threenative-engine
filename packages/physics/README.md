# @threenative/physics

Godot-shaped physics nodes backed by Rapier: `RigidBody3D`, `Area3D`,
`CharacterBody3D`, `CollisionShape3D`, `VehicleBody3D`, `Buoyancy3D`, `Joint3D`, `SoftBody3D`, plus
`buildStaticColliders`, `ScatterColliders` and `PhysicsDirectSpaceState3D`. Navmesh pathfinding ships
on the `@threenative/physics/navigation` subpath, which is Recast through WebAssembly and therefore
web-only today.

## Backend portability

Browser builds use Rapier WASM `0.19.3`. Native desktop, Android, and iOS builds select the
ThreeNative runtime's native Rapier `0.30.0` adapter through the `threenative-native` export
condition. Physics replays and snapshots are repeatable only within the exact pinned runtime
that recorded them; they are not portable between web and native builds,
Rapier versions, operating systems, or architectures.

`world.raw`, `body.raw`, `collider.raw`, and `CollisionShape3D.raw` are backend-specific.
They expose Rapier objects on web and opaque handles on native, so code that uses `raw` is
not portable. Per-frame movement belongs in `PhysicsSimulation.step()`'s reusable typed-array
input; visible transforms are returned in bulk through `readVisibleTransforms()`.
