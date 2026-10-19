---
prd_contract: v1
---

# PRD-142 — Attaching anything to a bone is 50 lines of regex, scale-undo and guessed units

**Status: WITHDRAWN, 2026-08-18.** The current FPS source has no `Enemy.#equip` path: the enemy
asset already contains its rifle, so the required game rewrite and visibility playtest do not
exist to execute. The reusable skeleton helpers remain tested independently. See [batch
verification](../../verification/fps-friction-batch-2026-08-18.md).

**Outcome:** putting a rifle in a hand, a hat on a head or a trail on a blade is one call that
names a bone, and the framework — not the game — undoes the skeleton's world scale.

**Depends on:** nothing. Shares a root cause with
[PRD-150](PRD-150-asset-introspection.md) — neither the loader nor the tooling tells a game
anything about the model it just loaded.

**Blocks:** [PRD-144](PRD-144-ragdoll.md) would have reused whatever bone-resolution rule
this settles.

**Complexity: 4 → LOW-MEDIUM mode.** One resolver, one attach helper, one spec.

**Blast radius: 3 files.** `packages/core/src/animation.ts` or a new `packages/core/src/skeleton.ts`,
`packages/core/src/index.ts`, one new `__tests__` spec.

---

## 1. The defect

`sandbox/fps-framework/src/entities/Enemy.ts:167-216` — 50 lines whose entire job is "hold the
rifle". Four separate framework gaps stack up in it:

**(a) No bone lookup.** The game ships its own resolver, `Enemy.ts:65-71`:

```ts
function findBone(root: Object3D, pattern: RegExp): Object3D | undefined { ... }
const hand =
  model.getObjectByName("mixamorigRightHand") ??
  model.getObjectByName("RightHand") ??
  findBone(model, /right.*hand|hand.*r$|hand_r/i);
```

Three naming conventions guessed in one expression, because nothing reports what the skeleton
actually contains.

**(b) No socket concept, so the game undoes the skeleton's scale by hand.** `Enemy.ts:205-214`:

```ts
// The hand bone carries the model's own scale; undo it so the normalised size survives.
const handScale = new Vector3();
hand.getWorldScale(handScale);
const inverse = handScale.x === 0 ? 1 : 1 / handScale.x;
holder.scale.setScalar(normalise * inverse);
```

This is correct, and it is arithmetic no game should be doing. It also silently assumes uniform
scale — `handScale.x` alone — which is wrong for any non-uniformly scaled rig and would fail with
no error.

**(c) No unit information, so the game measures and normalises.** `Enemy.ts:178-183`:

```ts
// The rifle is authored in centimetres — its raw bounds are 8 x 30 x 112 — so it has to be
// normalised to a real weapon length before anything else, or attaching it to a hand makes
// a 112 metre AK. Nothing in the asset pipeline states a unit, so it is measured here.
```

`RIFLE_LENGTH = 1.02` is a game constant standing in for a loader fact.

**(d) No fallback contract.** When the bone is not found the game invents a floating offset
(`Enemy.ts:197-203`) and the weapon hangs in the air near the chest. Silently. That is the
fail-open pattern this repository exists downstream of.

**Name the layer. (a), (b) and (d) are engine bugs; (c) is
[PRD-150](PRD-150-asset-introspection.md).** A game cannot portably discover a skeleton's naming
convention or reason about a bone's accumulated world scale without reimplementing what the loader
already knows, and none of it decides how anything looks — the grip offset, the weapon and the
pose all stay the game's.

## 2. The surface

Godot's vocabulary is `BoneAttachment3D` with a `bone_name`, so:

```ts
/** Names of every bone in the skeleton, in traversal order. Empty for an unskinned model. */
export function skeletonBones(root: Object3D): readonly string[];

/**
 * Parent `child` to the named bone, cancelling the bone's accumulated world scale so `child`
 * keeps the size it was authored at. Throws when the bone does not exist.
 */
export function attachToBone(root: Object3D, boneName: string, child: Object3D): Object3D;
```

`attachToBone` **throws** on a missing bone. The message names the bone asked for and lists what
the skeleton has, because the whole failure in §1(d) is that nobody was told. Games that want a
fallback write `if (skeletonBones(m).includes(name))` — that is one line and it is explicit.

The `mixamorig` / `RightHand` / `hand_r` guessing in §1(a) is **not** absorbed. A framework that
maps a game's idea of "right hand" onto a rig's naming convention is inventing vocabulary and
picking sides between exporters; `skeletonBones()` returns the real names and the game picks. That
is the smaller, honest surface.

### 2.1 Shape constraints

Read the batch README's shape rules first. The specific risks here:

- **SRP.** Two free functions, one job each: *list bones*, *attach with scale cancelled*. No
  `BoneAttachment3D` class holding state, no per-frame sync — Three.js parenting already syncs.
- **DRY.** The bone-name resolution rule appears **once** and [PRD-144](PRD-144-ragdoll.md)
  imports it rather than growing a second traversal. If the ragdoll work re-implements
  `skeletonBones`, the split is wrong.
- **KISS.** No offset/rotation parameters. The caller sets `child.position` and `child.rotation`
  on the returned object exactly as it does today — that is the grip pose, and grip pose is feel.
  Adding `attachToBone(root, name, child, { offset, rotation })` moves a game decision into the
  framework and saves the game nothing.
- **Not a node.** These are functions, not a `Node3D` subclass. There is no lifecycle here and
  nothing to dispose; a class would be ceremony around two calls.

## 3. Acceptance

| # | Command | Required result |
| --- | --- | --- |
| 1 | `pnpm vitest run packages/core/__tests__/skeleton.spec.ts` | pass — `skeletonBones` returns every bone of a stub skeleton in traversal order and `[]` for an unskinned `Object3D` |
| 2 | same spec, scale row | a bone under a `0.01` world scale receives a child that keeps world size `1` — and the same holds for a **non-uniform** parent scale, which is where `handScale.x` alone is wrong today |
| 3 | same spec, failure row | `attachToBone(root, "NoSuchBone", child)` **throws**, and the message contains at least one real bone name |
| 4 | `pnpm typecheck && pnpm lint && pnpm test` | exit `0` |
| 5 | rewrite `Enemy.#equip` against this surface, then `pnpm tsx scripts/count-loc.ts` | **fewer** authored lines; `findBone`, the `handScale` inverse and the silent fallback all delete |
| 6 | a playtest with a `visibility` assertion on the attached weapon, run on web and `--target desktop` | pass on both |

Row 2 is the one that finds the real bug. Row 3 is the one that stops the next build shipping a
rifle floating beside a soldier's chest without knowing.

## 4. What this does not claim

Not that retargeting works — a clip authored for one skeleton played on another is untouched here.
Not that the model's units are known; that is [PRD-150](PRD-150-asset-introspection.md) and
`RIFLE_LENGTH = 1.02` stays a game constant until it lands. Not that anything is attached
correctly *in pose*: where on the grip the hand actually is remains measured by eye, and no gate
in this repository can tell a well-held rifle from a badly held one.
