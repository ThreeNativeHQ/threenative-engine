---
prd_contract: v1
---

# PRD-140 — Scene collapse removes the meshes a game picks against, and nothing tells the game

**Status: DONE, 2026-08-18.** Collapse regression tests and the 250-mesh picking scenario pass
on web and desktop. See [batch verification](../../verification/fps-friction-batch-2026-08-18.md).

**Outcome:** a game whose scoring is picking either keeps working when the collapse pass fires, or
is told in a way it cannot miss that it will not. Today it silently stops scoring at the 200th
mesh.

**Depends on:** [PRD-139](PRD-139-raycast-world-ray-or-delete.md) settles the pick surface this
PRD writes a regression test against. If 139 takes the delete path, this PRD's test is written
against `THREE.Raycaster` instead and the fix is unchanged.

**Blocks:** nothing. It is the only item in this batch that is a **latent** defect — nobody has hit
it yet, which is exactly why it is here.

**Complexity: 6 → MEDIUM-HIGH mode.** The pass is 1,700 lines and the fix is a behavioural
promise, not a patch.

**Blast radius: 3 files.** `packages/core/src/collapse.ts`, one new `__tests__` spec, and the
generated `AGENTS.md`.

---

## 1. The defect

`packages/core/src/collapse.ts:25-27` promises:

> It is deliberately invisible to the game: nothing here reads a `userData` flag, and a game that
> does nothing gets the same picture it had before.

**"The same picture" is not the same scene.** Line 1662:

```ts
for (const entry of bakedFrom) entry.parent.remove(entry.mesh);
```

and line 1673:

```ts
this.#scene.remove(child);
```

The original meshes are removed from the graph and replaced by merged geometry. Everything hung on
them goes with them:

| What a game loses at collapse | Why it matters |
| --- | --- |
| The mesh is no longer reachable by any raycast | `ctx.raycast` and `THREE.Raycaster` both traverse the live graph |
| `mesh.userData` is unreachable through a hit | This is how the PRD-137 build scored: `hit.object.userData.target` (`Play.ts:229`) and `hit.object.userData.enemy` (`Play.ts:243`) |
| A held `Object3D` reference points at an orphan | Setting `.visible`, `.position` or a material on it does nothing visible |

The threshold is `minMeshes = 200` (`collapse.ts:693`). Under it the pass declines and logs
`TN_SCENE_COLLAPSE` — "fewer than 200 meshes so far; still watching" — on every boot, which is
exactly what the PRD-137 builder saw, and what they wrote in the ledger:

> There is no documentation of what collapsing does to a mesh's raycastability or to `userData`
> carried on it — which matters when picking is how scoring works. I could not find out, so I never
> crossed the 200-mesh line to test it.

So the shipped FPS scores by picking, boots one log line away from a pass that would break its
scoring, and nobody has crossed the line. `grep -rn "raycast" packages/core/src/collapse.ts`
returns **nothing**, and no test in the tree covers a raycast after a collapse.

**Name the layer. This is an engine bug**, and the most dangerous kind: a performance
optimisation that changes gameplay semantics, in a repository whose stated failure mode is a check
that reports green while asserting nothing. A game hitting it sees no error — targets simply stop
registering hits somewhere past the 200th prop.

## 2. Measure it before fixing it

The claim above is read from the source. **Step 1 of the work is to make it fail on purpose**,
because a defect nobody has watched happen is a defect nobody has characterised:

1. Take the PRD-137 build (or the `starter` template).
2. Add 200+ static meshes so the pass fires; confirm `TN_SCENE_COLLAPSE` reports a collapse rather
   than a decline.
3. Fire at a target that scored before. Record what `hit.object` is now, whether `userData`
   survives anywhere, and whether the merged mesh is hit at all.

Paste that output into the evidence file. If picking turns out to survive — if the pass keeps
originals raycastable in some path this reading missed — say so and close this PRD as
**not a defect, documentation only**. That is a legitimate outcome and cheaper than the fix.

## 3. The fix, in preference order

### 3.1 Preferred — the pass declines on any mesh a game could pick

The pass already has a decline path with a reason code (`#decline`, `collapse.ts:1210`) and already
declines for transparency, sprites, render order and missing normals (§`collapse.ts:361-362`,
`1387-1629`). Add one more reason: **a mesh carrying non-empty `userData` is not baked.**

This is the smallest change that keeps the promise on line 25 literally true, it uses the
mechanism that is already there, and it is opt-out by construction — a game that hangs nothing on
its walls still gets them merged. The cost is that a game hanging `userData` on all 2,000 props
gets no collapse at all, which is the correct trade: correctness over frame rate, loudly.

**This contradicts line 25's "nothing here reads a `userData` flag".** Update that sentence in the
same commit. Reading `userData` to decide *whether to bake* is not the thing that sentence was
protecting against — that was a game annotating its scene graph to satisfy the framework, which
this does not require.

### 3.2 Fallback — collapse is observable and refusable

If §3.1 measures as declining on scenes that should collapse, the pass instead:

- reports the collapse through the existing `TN_SCENE_COLLAPSE` channel **at `warn` severity when
  any baked mesh carried `userData`**, naming the count; and
- accepts `collapse: false` in `defineGame` so a picking game can turn it off in one line.

A `warn` a game can see is worse than not breaking it, and this is the fallback for that reason.

### 3.3 Rejected — a `userData` opt-out flag the game sets per mesh

`{ userData: { noCollapse: true } }` on every pickable object is the game annotating its scene
graph to work around a framework pass. The project's rules call that "an engine bug wearing a
game-code costume". Recorded here so it is not rediscovered as a clever idea.

### 3.4 Shape constraints

Read the batch README's shape rules first. The specific risks here:

- **SRP.** The collapse pass decides *what to bake*. It does not become a picking registry, does
  not maintain an id→original map, and does not grow a `resolveOriginal(hit)` API. That would be a
  second job and a second source of truth for the scene graph.
- **DRY.** §3.1 adds one entry to the **existing** decline table and one reason code. If the
  implementation grows a parallel "pickability" traversal beside the existing eligibility walk,
  it is wrong.
- **KISS.** One rule — non-empty `userData` means no bake — beats a configurable predicate, a
  layer mask, and an allowlist. It is explainable in one sentence, which is the bar for something
  that silently changes what a game's raycast can see.

## 4. Acceptance

| # | Command | Required result |
| --- | --- | --- |
| 1 | the reproduction in §2 | output pasted into the evidence file, with the pre-fix behaviour stated plainly |
| 2 | `pnpm vitest run packages/core/__tests__/collapse-picking.spec.ts` | pass — 250 meshes, 5 of them carrying `userData`; after the pass, all 5 are still in the graph and still raycastable, and the other 245 are baked |
| 3 | same spec, negative row | 250 meshes with **no** `userData` still collapse — the fix must not disable the pass |
| 4 | `pnpm test` | exit `0` |
| 5 | a playtest scenario: a picking game with 250 static meshes scores a hit | pass |
| 6 | the same scenario with `--target desktop` | pass — this pass exists for native and is where it actually fires |

Rows 2 and 3 are the pair. Row 2 alone is satisfied by disabling collapse entirely, which is the
forbidden fix; row 3 proves the optimisation still runs.

## 5. What this does not claim

Not that the collapse pass is otherwise correct — this PRD touches the eligibility rule and
nothing else. Not that the 200-mesh threshold is right; it is unmeasured on current hardware and
this PRD does not move it. Not that games hitting the decline path get acceptable performance:
a picking-heavy scene that now declines to collapse is slower than one that does, and whether that
is acceptable on a Pixel 8 is an open measurement, named here so its absence is a decision.
