---
prd_contract: v1
---

# PRD-139 — `ctx.raycast` cannot express a hitscan shot, so every shooter reimplements it in plain Three.js

**Status: DONE, 2026-08-18.** The FPS call sites use `ctx.raycast` and `ctx.raycastAll`, the
line-count gate is favorable, and the web and desktop fire scenarios pass. See [batch
verification](../../verification/fps-friction-batch-2026-08-18.md).

**Outcome:** `ctx.raycast` either covers the ray queries games actually make — arbitrary world
rays, an exclusion, more than the nearest hit — or it is deleted and the docs say "use
`THREE.Raycaster`". Both are acceptable; shipping a picking API that games route around is not.

**Depends on:** nothing.

**Blocks:** nothing. Do it before [PRD-140](PRD-140-scene-collapse-breaks-picking.md), because
140's regression test is written against whatever surface this PRD settles on.

**Complexity: 4 → LOW-MEDIUM mode** for the widen path, **2** for the delete path.

**Blast radius: 4 files** on the widen path — `packages/core/src/picking.ts`,
`packages/core/src/scene.ts`, one `__tests__` spec, and the generated `AGENTS.md` line that
describes it. On the delete path, those four minus the spec, plus every template that calls it.

---

## 1. The defect

`packages/core/src/picking.ts:13-19` is the entire option surface:

```ts
export interface IRaycastOptions {
  /** Screen point in canvas pixels. Defaults to the current pointer position. */
  readonly screen?: Vector2;
  /** What to test. Defaults to the whole scene. */
  readonly targets?: Object3D | readonly Object3D[];
}
```

and `raycast` returns `Intersection | undefined` — the nearest hit, always
(`picking.ts:62-81`). Three things follow, all of them observed in the PRD-137 build:

1. **A hitscan weapon is not a screen pick.** It is a ray from the eye along the camera's forward
   axis. `screen` cannot express it — the muzzle is not the pointer, and on a locked pointer there
   *is* no pointer. There is no `origin`/`direction`.
2. **The default target is unusable in first person.** `targets` defaults to the whole scene, the
   viewmodel is a child of `ctx.camera`, and `ctx.camera` is in the scene — so every shot hits your
   own rifle at 0.3 m. The build maintained an explicit `hittable` array
   (`sandbox/fps-framework/src/scenes/Play.ts:155`) purely to work around the default.
3. **Nearest-hit-only cannot do occlusion.** A line-of-sight test has to ignore thin dressing —
   target plates, decals, glass — and take the first *solid* hit. With one `Intersection` back
   there is nothing to filter.

The build used plain `THREE.Raycaster` for both the shot and the enemy's sight test
(`Play.ts:131-173`). `ctx.raycast` was never called.

**Name the layer.** This is an engine bug of the kill-switch kind, not a game bug. The game's
workaround was correct and cost it nothing; what is wrong is that the framework ships an
abstraction its own genre benchmark routes around. `scripts/count-loc.ts` will not catch it,
because the cost shows up as an unused export rather than as extra lines — and `ScenePicker` and
`IRaycastOptions` are both in the PRD-137 ledger's **unused exports** list.

## 2. The two questions, honestly

Question (a): **could the game write this portably itself?** Yes. It did, in ten lines of
`THREE.Raycaster`, and that code runs unchanged on native. By the rule as written, the framework
does not get to own ray queries on portability grounds.

What justifies `ctx.raycast` existing at all is the second sentence of `picking.ts`: it is
BVH-accelerated, the acceleration is invisible, and no `three` prototype is patched. That is
mechanism, not appearance, and it is a real thing a game should not have to write. **So the
abstraction is defensible only while games actually use it.** They currently do not.

That makes this a decision, not a bug fix, and the decision is the owner's:

| Path | What ships | Cost |
| --- | --- | --- |
| **Widen** | `origin`/`direction`, `exclude`, `all`, `far` on `IRaycastOptions` | ~40 lines in `picking.ts`, and games get the BVH for free on every query |
| **Delete** | `ScenePicker`, `IRaycastOptions`, `ctx.raycast` removed; docs say use `THREE.Raycaster` | −250 lines of framework, and every game pays full cost on large static scenes |

**Recommendation: widen.** The BVH is the only thing here a game genuinely should not write, the
widening is small, and deleting it makes [PRD-140](PRD-140-scene-collapse-breaks-picking.md)
worse rather than better — a game picking against a scene the framework silently merged has no
framework-side place left to be told so.

## 3. The widened surface

```ts
export interface IRaycastOptions {
  /** Screen point in canvas pixels. Mutually exclusive with `origin`/`direction`. */
  readonly screen?: Vector2;
  /** World-space ray origin. Requires `direction`. */
  readonly origin?: Vector3;
  /** World-space ray direction; normalised by the caller. Requires `origin`. */
  readonly direction?: Vector3;
  /** Maximum distance. Defaults to unbounded. */
  readonly far?: number;
  /** What to test. Defaults to the whole scene. */
  readonly targets?: Object3D | readonly Object3D[];
  /** Subtrees never hit, whatever `targets` says. The camera's children belong here. */
  readonly exclude?: Object3D | readonly Object3D[];
}
```

plus one method, not an option:

```ts
raycastAll(options?: IRaycastOptions): readonly Intersection[];   // sorted near to far
```

Supplying both `screen` and `origin` **throws**. Supplying `direction` without `origin` throws.
Fail closed: an ambiguous ray that silently picks one interpretation is the class of defect this
repository exists downstream of.

### 3.1 Shape constraints

Read the batch README's shape rules first. The specific risks here:

- **SRP.** `ScenePicker` answers ray queries. It does not know about weapons, damage, teams,
  hit reactions or `userData` conventions. `exclude` takes `Object3D`s, not a predicate, not a
  tag string, not a layer name the framework invents — Three.js already has `Layers` and a
  fourth naming scheme would be vocabulary invention.
- **DRY.** `raycast` becomes `raycastAll(...)[0]`, not a second traversal. One `#collect` path,
  one sort, one BVH cache. If the two methods end up with parallel bodies, the refactor is wrong.
- **KISS.** No `IRaycastResult` wrapper type around `Intersection` — Three.js's shape is the
  borrowed vocabulary and re-wrapping it costs every reader a translation. No spread, no
  penetration, no "hitscan" helper: those are the game's, and they are feel.
- **Kill-switch.** After the widening, `count-loc` must show a game using `ctx.raycast` writing
  *fewer* lines than the `THREE.Raycaster` equivalent. Acceptance row 5 measures exactly that.
  If it does not, take the delete path.

## 4. Acceptance

| # | Command | Required result |
| --- | --- | --- |
| 1 | `pnpm vitest run packages/core/__tests__/picking.spec.ts` | pass — world ray hits a known box at a known distance; `far` bounds it; `exclude` on a parent removes its whole subtree; `raycastAll` returns hits sorted near→far |
| 2 | same spec, ambiguity rows | `screen` + `origin` together **throws**; `direction` without `origin` **throws** |
| 3 | `pnpm typecheck && pnpm lint && pnpm test` | exit `0` |
| 4 | a playtest scenario firing a world-ray shot and asserting a score change | pass |
| 5 | port the PRD-137 build's `fire()` and `lineOfSight()` from `THREE.Raycaster` to `ctx.raycast`, then `pnpm tsx scripts/count-loc.ts` | **fewer** authored lines than the Three.js version, and the scenario in row 4 still passes |
| 6 | the same scenario with `--target desktop` | pass |

Row 5 is the kill switch made executable. If the ported version is not smaller, this PRD's answer
is the delete path and the widening is reverted — that is a legitimate outcome and it gets written
up rather than quietly abandoned.

## 5. What this does not claim

Not that BVH acceleration is faster for these queries — nobody has measured a world ray against a
BVH versus stock `Raycaster` on a scene this size, and the BVH is built lazily on first use so a
single shot may well be slower. Not that skinned meshes pick correctly; `picking.ts:96-110` already
falls back to the stock path for them and this PRD does not touch that. Not that the units question
in the ledger is fully closed — §3 documents `screen` as canvas pixels, which is what the code
does, but nobody has checked that against a device-pixel-ratio other than 1.
