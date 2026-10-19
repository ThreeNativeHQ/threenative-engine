# PRD-293 — gameplay and compute agree about when startup ends

**Status: PROPOSED, filed 2026-08-30 at `d4770823`.** Found while stabilising CI, verified in the
source, and deliberately not fixed there: the change has blast radius across every template's tick
accounting and CI was mid-repair.

**Priority:** P1 — Unfinished: one startup signal for gameplay, compute and bridge, with tick accounting re-measured.
## The split

`packages/core/src/game.ts`, inside one `onUpdate`:

```ts
else if (this.#sceneEntered && scene !== undefined) scene.update(ctx, dt);   // :1016
…
const computeBlockedByStartup =
  !worldRendered && canvasLayer.opaque &&
  (this.#config.warmUp === undefined || this.#config.warmUp === false);      // :1020
if (this.#renderer !== undefined && this.#sceneEntered && !computeBlockedByStartup)
  this.#computeDriven.process(this.#renderer);                               // :1024
```

**While the loading screen is up, a game's gameplay runs and its compute does not.** Both sit in the
same tick, three lines apart, and they disagree about whether the game has started.

## Why this is worth a PRD rather than a comment

It is the common root of two defects that took a day to chase, and they point in *opposite*
directions, which is what made each one look like its own bug:

| Defect | What was observed | Which half caused it |
| --- | --- | --- |
| `flagSteps` ([`4a73a5f5`](../../verification/)) | `SoftBody3D.steps` was 0 when the scenario asserted on it | compute **frozen** behind the loading screen while the run's ticks were spent |
| the navigator ([`d4770823`](../../verification/)) | `pathLength 8.19` against a floor of `8.5` in CI, `8.82` on a workstation | gameplay **running** behind the loading screen, so the first stretch of the route was walked before anything observed it |

Twelve template scenarios captured the loading screen as the game's frame in the same session, for
the same reason: what "the game has started" means is answered differently depending on which part
of the frame is asking.

Both defects were fixed at their own call sites, correctly. Neither fix removes the disagreement.

## What Done looks like

1. One signal decides whether a tick counts as gameplay, and gameplay, compute and the playtest
   bridge all read it. `ctx.startup.phase === "ready"` is the candidate: the loading screen already
   closes on it, and both fixes above now key off it.
2. Choosing to hold gameplay during startup, or to run compute during it, is a decision made once
   and written down — not two defaults that never met.
3. A red-green case in `packages/core/__tests__/` that fails if the two halves diverge again: step a
   game with an opaque canvas layer and assert gameplay and compute agree about whether that tick
   counted.
4. Tick accounting is re-measured for every template, because whichever way the split closes, the
   number of gameplay ticks inside a fixed scenario budget changes. **This is the blast radius** —
   any scenario asserting a distance, a count or an accumulation over ticks can move.
5. `warmUp` keeps working: it is already an explicit opt-out of the compute block and must remain a
   deliberate override rather than the thing that hides the inconsistency.

## What not to do

Do not fix this by lowering a threshold or lengthening a wait in whichever scenario reds next. Five
separate failures in one session shared the shape *an assertion whose truth depends on how long boot
took*, and every one of them was cured by making the measurement observe the right window — never by
padding it.

## Evidence to reproduce the pair

`d4770823`'s message records the navigator across repeats with `firstTick` varying and the
measurement no longer following it: `firstTick` 20/13/10/10 against `pathLength` 9.384/9.443/9.563/
9.502, where the failing CI run had `firstTick 28` and `8.19`. The margin over the floor went from
0.32 to about 0.9 by observing the whole route rather than by moving the floor.
