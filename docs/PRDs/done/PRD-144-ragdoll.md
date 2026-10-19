---
prd_contract: v1
---

# PRD-144 — A death is a frozen animation frame, because there is no ragdoll

**Status:** WITHDRAWN, 2026-08-18. The row-6 kill switch fired: the class-shaped usage is not
smaller than the hand-rolled `Joint3D` + `RigidBody3D` version.

**Outcome:** a character can hand its pose over to physics at the moment it dies, fall against the
world it was standing in, and settle — without the game hard-coding a clip length and stopping a
mixer.

**Depends on:** [PRD-143](./PRD-143-physics-joints.md) — unbuildable without
joints. [PRD-142](PRD-142-bone-sockets-and-attachment.md) — reuses its
bone resolution rather than growing a second one. [PRD-141](PRD-141-animation-one-shot-clips.md) is not a dependency but
overlaps: 141 makes the *fake* correct, this makes the fake unnecessary.

**Blocks:** nothing.

**Complexity: 8 → HIGH mode.** It is the largest item in this batch by a wide margin and the only
one that should not be started until its dependency has landed and been proved on desktop.

**Blast radius: 6 files.** `packages/physics/src/PhysicalBoneSimulator3D.ts` (new),
`packages/physics/src/PhysicalBone3D.ts` (new), `packages/physics/src/index.ts`, one new
`__tests__` spec, one playtest scenario, and the generated `AGENTS.md`.

---

## 1. What is happening today

`sandbox/fps-framework/src/entities/Enemy.ts:329-341`:

```ts
if (this.health <= 0) {
  this.phase = "dead";
  this.#play("DeathFront", 0.06);
  // Nothing in `AnimationPlayer` clamps a one-shot clip at its last frame, so
  // the ragdoll is held by stopping the mixer updates once it has played out.
  ctx.after(1.1, () => { this.#frozen = true; });
  ctx.after(RESPAWN_SECONDS, () => this.#respawn());
}
```

The comment says "the ragdoll". There is no ragdoll. There is a canned death clip, a hard-coded
`1.1` s, and a boolean that stops calling `mixer.update`. The consequences are visible in the
build:

| Symptom | Cause |
| --- | --- |
| The corpse always falls the same way | one authored clip, no reaction to where it was shot |
| It falls through or into geometry | the clip knows nothing about the barricade it died against |
| It ends at the same pose every time | there is no simulation to settle |
| A re-exported clip breaks it silently | `1.1` is a measured constant in gameplay code |

The build shot the enemy in the head for 4× damage and the corpse could not show it. The head
multiplier is real (`Play.ts:246`), and nothing on screen distinguishes it from a leg shot.

## 2. Is this the framework's job?

**Question (a): could the game write this portably itself?** No. A ragdoll is a set of bodies
constrained by joints, and joints only exist behind the backend seam that the
`threenative-native` export condition swaps. The game is specifically not allowed to know which
backend it got. Post-[PRD-143](./PRD-143-physics-joints.md) a game could in principle assemble one
by hand — and that is the honest risk in this PRD, addressed in §5.

**Question (b): does it decide how anything looks?** This is the one to be careful about, because
a ragdoll is extremely visible. The line: **the framework owns the mechanism — bodies from bones,
joints between them, the handover from animation to simulation, writing solved transforms back to
the skeleton. The game owns everything that shapes the result** — which bones are simulated, their
masses, the joint limits, the collision layers, the impulse applied at the moment of death, and
when the handover happens.

`GPUParticles3D` is the shape this follows: it owns buffers and dispatch and takes `material`,
`start` and `process` from the game. A `ragdoll: true` option, a built-in humanoid bone preset, or
a shipped set of "realistic" joint limits would all be the framework deciding how a death looks,
and all three are out of scope by rule. **A humanoid preset is the most likely thing to be
proposed during implementation and it is refused here in advance** — it is a preset system, and
preset systems are on the closed list.

## 3. The surface

Godot's names again — `PhysicalBone3D` and `PhysicalBoneSimulator3D`:

```ts
export class PhysicalBone3D {
  constructor(options: {
    readonly bone: string;                 // a name from skeletonBones(), PRD-142
    readonly shape: CollisionShape3D;      // the game's, not derived
    readonly mass?: number;
    readonly joint?: IPhysicalBoneJoint;   // pin or hinge, with limits — the game's
  });
}

export class PhysicalBoneSimulator3D {
  constructor(options: {
    readonly root: Object3D;
    readonly bones: readonly PhysicalBone3D[];
    readonly physics: IPhysicsContext;
  });
  /** Hand the current animated pose to physics. The skeleton is driven by the solver from here. */
  start(): void;
  /** Return control to the animation system. */
  stop(): void;
  dispose(): void;
}
```

`start()` reads the skeleton's **current world pose** and seeds each body from it, so the
transition is continuous — a ragdoll that snaps to a T-pose on death is the classic failure and it
is what row 2 of §4 exists to catch.

Writing solved transforms back to bones is the performance-critical half and it goes through the
existing bulk read (`readVisibleTransforms`, `simulation.ts:162`). **No per-bone frame call across
the JS→C++ boundary.** A 15-bone ragdoll at 60 Hz is 900 crossings a second per character if this
is got wrong, and the ABI was shaped coarse precisely to prevent that.

### 3.1 Shape constraints

Read the batch README's shape rules first. The specific risks here — this is the PRD in the batch
most likely to grow a second job:

- **SRP.** `PhysicalBoneSimulator3D` moves bones from physics. It does **not** decide when a
  character dies, does not apply death impulses, does not blend animation with simulation, does
  not respawn anything. Every one of those is gameplay and stays in `Enemy.ts`.
- **DRY.** Bone names resolve through `skeletonBones`/`attachToBone` from
  [PRD-142](PRD-142-bone-sockets-and-attachment.md). Joints are `Joint3D` from
  [PRD-143](./PRD-143-physics-joints.md), composed, not re-implemented. Transforms come back
  through `readVisibleTransforms`. **If this PRD adds a traversal, a joint type or a transform
  path that already exists, the layering is wrong and the review should reject it.**
- **KISS.** `start`, `stop`, `dispose`. No blend weights, no partial ragdoll, no
  animation-driven-then-physics-driven per-bone mix, no `getUpAnimation` — those are the features
  that turn a 300-line class into a 3,000-line one, and none has a game asking.
- **No presets.** No humanoid bone list, no default masses, no default joint limits, no
  `ragdoll: true`. The game supplies every one. See §2.
- **Kill switch.** The whole thing is deleted if a game assembling a ragdoll from bare
  `Joint3D` + `RigidBody3D` writes fewer lines. §4 row 6 measures that, and it is a real risk —
  see §5.

## 4. Acceptance

| # | Command | Required result |
| --- | --- | --- |
| 1 | `pnpm vitest run packages/physics/__tests__/ragdoll.spec.ts` | pass — a 5-bone chain seeded from a known pose stays connected across 300 steps and comes to rest |
| 2 | same spec, continuity row | on the first step after `start()`, every bone is within a small epsilon of its animated pose — **no snap** |
| 3 | same spec, lifetime rows | `stop()` returns the skeleton to the animation system; `dispose()` removes every body and joint; disposing mid-fall does not crash the next `step` |
| 4 | a playtest: shoot the enemy, advance 4 s, assert its head bone's Y is below its standing height and has stopped changing | pass on web |
| 5 | **the same scenario with `--target desktop`** | pass |
| 6 | build the same ragdoll twice — once with this class, once from bare `Joint3D` + `RigidBody3D` — and run `pnpm tsx scripts/count-loc.ts` | the class version is **smaller**, or this PRD is withdrawn |
| 7 | `pnpm budgets` | framework LOC trigger reported; if 15,000 is crossed, justified here with a kill-switch pass over what was added |

Row 2 is the one that separates a ragdoll from a physics explosion. Row 6 is the kill switch and it
is a genuine coin-flip — see §5.

## 5. The honest risk

**This PRD may not survive its own row 6.** Once [PRD-143](./PRD-143-physics-joints.md) ships,
assembling a ragdoll is: make a body per bone, joint them, copy transforms back. That is perhaps
80 lines of game code, and 80 lines of game code that the game fully controls is *exactly* what the
two questions say the framework should not absorb — question (a) would then be answered "yes, the
game could write this portably", and the answer to (a) is a gate, not a preference.

The counter-argument is the transform write-back: doing it through the bulk ABI without per-bone
crossings is not obvious, and a game that gets it wrong pays 900 boundary crossings a second with
no gate telling it. That is mechanism a game should not have to discover, and it is the strongest
part of the case.

**So the sequencing is deliberate: land PRD-143, build the hand-rolled ragdoll in a game first,
measure it, and only then decide whether this class exists.** Starting here instead would be
building the abstraction before knowing whether it earns its place, which is the failure mode the
kill switch exists for. That ordering is a requirement of this PRD, not a suggestion.

## 6. What this does not claim

Not that ragdolls look good — nobody has tuned a set of joint limits in this project and a badly
limited ragdoll looks worse than a canned clip. Not that they are affordable on a phone; 15 bodies
and 14 joints per character is a real cost that nobody has measured on target hardware. Not that
getting up from a ragdoll works — animation blending back from a settled pose is a separate and
harder problem and is explicitly out of scope. Not that the two backends agree: they are different
solvers and a scenario asserting exact bone positions on both will be flaky, so assert behaviour
and rest state, never coordinates.

## 7. Withdrawal record

PRD-143 was first landed and proved through the integrated desktop target. The required five-bone
comparison was then formatted with the repository's LOC instrument:

| Version | Raw non-empty lines | Normalised lines |
|---|---:|---:|
| hand-rolled `Joint3D` + `RigidBody3D` chain | 39 | 43 |
| proposed `PhysicalBone3D` + `PhysicalBoneSimulator3D` usage | 18 | 46 |

The class-shaped version is three normalised lines larger. `pnpm tsx scripts/count-loc.ts` also
completed successfully and reported the existing platformer template total of 1,559 LOC. Because
the proposed abstraction does not beat the code the game can write from the shipped physics
primitives, no ragdoll classes, playtest, or new framework package are added. The hand-rolled
version remains the correct application-level path if a game later needs a ragdoll.
