<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->

# AGENTS.md — @threenative/physics

Read `/AGENTS.md` first. This file covers only what is different here.

## Why this package exists

One reason: the Rapier and Recast WASM dependencies must not be inherited by games that do
not use physics or navigation. That is the whole justification, and it is the only kind that
creates a package here. Navigation is a `./navigation` subpath so the public APIs stay
separate. Native Rapier compiles into `@threenative/runtime-native`; it does not create
another package.

## These are bindings, not a simulation

`RigidBody3D` owns a backend handle and syncs its transform onto the `THREE.Object3D` you
handed it; a fixed collider with no visual can instead take an initial `position`. They are
not entities, components, or systems. The Godot names —
`RigidBody3D`, `Area3D`, `CharacterBody3D`, `CollisionShape3D`, `VehicleBody3D` — are fixed: a
sixth node type needs a PRD, and a name Godot does not use is rejected.

If a wrapper starts growing convenience methods Rapier already provides, delete them.

## Web and native: one class, one backend seam

The node classes are shared source. Only `PhysicsSimulation` names the backend, swapped by
the `threenative-native` export condition in `package.json`. Do not add a second copy of a
node, do not import `@threenative/physics-native`, and do not add per-object native calls.

- Both backends meet at `PhysicsSimulation.step()` and `readVisibleTransforms()`. Kinematic
  input and visible transforms use reusable typed-array records — keep the fixed-step
  crossing bulk-shaped, never per-object per-frame.
- A native shape or character option the ABI cannot honour **throws during construction**.
  Silently ignoring it produces a gameplay bug on one platform only.
- `raw` is an explicitly backend-specific escape hatch: a Rapier object on web, opaque on
  native. Code reaching through it is not portable, by contract.

```ts
ctx.physics.world.raw   // Rapier World on web
crate.body.raw          // Rapier RigidBody on web
crate.object            // THREE.Object3D
```

WASM Rapier is not shipped on native — that is why the native backend is compiled in. The original
reason was that Android ran QuickJS, which has no WebAssembly; **Android has defaulted to V8 since
2026-08-16 (PRD-130), and V8 does have WebAssembly.** The rule stands anyway: nobody has measured
Rapier-as-WASM on that path, iOS is still JSC, and the coarse bulk ABI was chosen for per-object call
cost too. See `docs/architecture/NATIVE-RUNTIME.md` and PRD-046 — and do not relax this because the
engine changed.

## Contracts to keep

- Every node exposes `dispose()`, and disposing removes its backend handle and detaches from
  the scene. The framework calls the plugin's scene-exit hook for nodes still registered with
  Rapier; callers still dispose a node explicitly when removing it during play.
- The fixed step is repeatable only within the pinned runtime that proves it.
  `__tests__/determinism.spec.ts` compares contact-rich `World.takeSnapshot()` bytes on the
  same machine and in a fresh worker; do not claim cross-browser, cross-OS or cross-version
  replay portability.
- `Area3D.on('bodyEntered', ...)` returns an unsubscribe function. Callers store it.
- `VehicleBody3D` extends `RigidBody3D` and adds ray-cast wheels, so a vehicle's lifetime is its
  chassis's: there is no vehicle removal call. `createVehicle`, `setVehicleInput`,
  `readVehicleState`, `resetVehicle` and `setVehicleWheelFriction` on `IPhysicsSimulation` are
  **optional** and carry plain numbers only. Both backends implement all five. A backend without
  the first four fails at construction, and one without the grip setter fails at the call, both
  with `TN_VEHICLE_NATIVE_UNAVAILABLE`. Three Rapier facts the node's unit tests
  pin, because all three are invisible in the API and wrong when assumed: the
  `suspensionStiffness` of `@dimforge/rapier3d-compat@0.19.3` is mass-normalised (a frequency
  squared, so sag is about `9.81 / (4 * stiffness)`), `currentVehicleSpeed()` is not the
  signed forward speed, which is why the seam computes that dot product itself, and a wheel ray
  must not hit the chassis it hangs from — Rapier `0.19.3` missed that ray and `0.30` reports a
  zero-distance hit, so the native controller excludes its own chassis from the ray filter.
- The parity gate must resolve web and native to genuinely different Rapier builds and assert
  both identities. `__tests__/parity.spec.ts` writes the web observation from Rapier `0.19.3`;
  `runtime-native/native/physics/tests/parity.rs` links the shipping Rust `Simulation` at
  Rapier `0.30.0` and enforces the shared scenario tolerances. A simulation-delegating fake is
  a self-comparison and is forbidden. `__tests__/native-contract.spec.ts` only proves shared
  class identity and TypeScript-side native ABI guards.

## Navigation

`NavigationRegion3D` bakes a solo Recast navmesh from the user's world-space meshes,
`NavigationAgent3D` computes a path and exposes the next position, and
`NavigationObstacle3D` supplies local crowd avoidance. The agent never moves its object;
gameplay writes the steering velocity and calls `CharacterBody3D.moveAndSlide()`.

Solo navmeshes are static. Obstacles affect local avoidance only; geometry that changes shape
requires an explicit re-bake and is outside this binding.
