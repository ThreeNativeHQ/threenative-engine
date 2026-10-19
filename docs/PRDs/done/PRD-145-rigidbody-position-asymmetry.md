---
prd_contract: v1
---

# PRD-145 — `RigidBody3D` takes no `position` while `Area3D` does, so every static collider allocates a throwaway `Object3D`

**Status: DONE, 2026-08-18.** Position-only fixed bodies and ambiguity failures are covered, and
the FPS desktop scenario passes. See [batch verification](../../verification/fps-friction-batch-2026-08-18.md).

**Outcome:** a static collider that has no mesh of its own is one call, and the two classes in the
same package stop disagreeing about how a body is placed.

**Depends on:** nothing.

**Blocks:** nothing.

**Complexity: 2 → LOW mode.** One optional field and the constructor branch behind it.

**Blast radius: 3 files.** `packages/physics/src/RigidBody3D.ts`, one `__tests__` spec, and the
`AGENTS.md` line for the class.

---

## 1. The defect

Two option interfaces, same package, same concept:

```ts
// packages/physics/src/Area3D.ts:19-30
export interface IArea3DOptions {
  readonly shape: CollisionShape3D;
  readonly position?: Pick<Vector3, "x" | "y" | "z">;   // <- present
  ...
}

// packages/physics/src/RigidBody3D.ts:10-23
export interface IRigidBody3DOptions {
  readonly object: Object3D;                            // <- required, and the only way to place it
  readonly shape: CollisionShape3D;
  ...
}
```

A static collision box in a level has no mesh — the wall is one merged mesh, the colliders are a
list of AABBs. So the PRD-137 build allocated an `Object3D` per collider purely to carry three
numbers (`sandbox/fps-framework/src/scenes/Play.ts:104-130`):

```ts
const carrier = new Object3DClass();
carrier.position.set(centreX, centreY, centreZ);
new RigidBody3D({ object: carrier, physics: ctx.physics, shape: ..., type: "fixed" });
```

The carriers are never rendered, never referenced again, and never disposed. On that level it is a
dozen orphan objects; on a real level it is hundreds.

**Name the layer. This is an engine bug** — a small one, but the kind that reads as carelessness:
a builder who has just used `Area3D` reasonably expects the sibling class to work the same way, and
the asymmetry costs a paragraph of the ledger to explain. Nothing about it decides how anything
looks.

## 2. The fix

```ts
export interface IRigidBody3DOptions {
  /** The transform this body drives. Omit for a collider with no visual — supply `position`. */
  readonly object?: Object3D;
  /** Initial world position. Only for a body with no `object`. */
  readonly position?: Pick<Vector3, "x" | "y" | "z">;
  ...
}
```

Supplying both, or neither, **throws** — the same fail-closed rule that governs the ambiguous ray
in [PRD-139](PRD-139-raycast-world-ray-or-delete.md). A body created with `position` and no
`object` writes its solved transform nowhere, which is exactly right for a `type: "fixed"` body
and is a documented error for a dynamic one. **Decide which:** either reject `position` without
`object` for non-fixed types at construction, or accept it and document that the body simulates
invisibly. The first is more consistent with "a backend that cannot honour an option throws";
take it unless implementation finds a reason not to, and record the reason if so.

### 2.1 Shape constraints

Read the batch README's shape rules first. Specifics:

- **DRY.** `Area3D` already resolves `position`-or-transform. Extract that resolution to one
  shared helper used by both classes rather than writing the branch twice — two copies of this
  logic is how the two interfaces drifted apart in the first place.
- **KISS.** One optional field. No `transform`, no quaternion option, no `basis`. `setBodyTransform`
  already exists on the simulation (`simulation.ts:149`) for anything beyond placement at birth.
- **SRP.** `RigidBody3D` stays a body. This is not the place for a level-loading helper.

## 3. Explicitly rejected: a "static level collision" helper

The ledger's other physics row asks for it:

> There is no "add this mesh as static collision" helper and no compound/heightfield path for a
> level, so a 34 m yard's collision is hand-fed box by box from my own AABB list.

**Refused, and the reason is question (a): the game can write this portably, and it did.** The
loop at `Play.ts:121-130` is nine lines, runs unchanged on native, and the same `colliders` array
does double duty as the enemy's blocker test (`Enemy.ts:232-245`) — a framework helper that
swallowed it would have taken that second use away. `CollisionShape3D.fromMesh` already exists for
the case where a mesh *is* the collider.

Recorded here so it is not rediscovered as an obvious win. What made that loop annoying was the
carrier `Object3D`, and that is what §2 fixes.

## 4. Acceptance

| # | Command | Required result |
| --- | --- | --- |
| 1 | `pnpm vitest run packages/physics/__tests__/rigidbody.spec.ts` | pass — a fixed body created from `position` alone occupies the expected place and a character collides with it |
| 2 | same spec, ambiguity rows | both `object` and `position` **throws**; neither **throws** |
| 3 | same spec, regression row | existing `{ object }` construction is unchanged |
| 4 | `pnpm typecheck && pnpm lint && pnpm test` | exit `0` |
| 5 | rewrite `Play.ts`'s `staticBody` against the new option and re-run the build's own playtests | pass, with the carrier allocation gone |
| 6 | `--target desktop` on one of those scenarios | pass |

## 5. What this does not claim

Not that level collision authoring is solved — §3 refuses that on purpose. Not that compound
shapes or heightfields exist; they do not, and no game here has asked. Not that orphan carrier
objects were causing a measurable problem: nobody profiled it, and the case for the change is
consistency and the ledger row, not performance.
