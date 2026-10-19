---
prd_contract: v1
---

# PRD-149 — The generated `AGENTS.md` describes a project that does not behave the way it says

**Status: DONE, 2026-08-18.** The documented resource contract, flush interval, canonical `state`
id and generated mirrors are verified. See [batch verification](../../verification/fps-friction-batch-2026-08-18.md).

**Outcome:** every factual claim in the generated `AGENTS.md` is either true or has a test that
makes it true, and the three places it is currently wrong stop costing every new builder an
investigation.

**Depends on:** [PRD-146](PRD-146-playtest-frames-vs-ticks.md) and
[PRD-148](PRD-148-scaffolded-project-cannot-run-its-own-gate.md) change what is true. This PRD
lands after them and records the settled state.

**Blocks:** nothing.

**Complexity: 4 → LOW-MEDIUM mode.** Mostly writing, plus one guard that makes the writing stay
true.

**Blast radius: 4 files.** The `AGENTS.md` template under `packages/create-threenative/templates/`,
`packages/core/src/playtest.ts`, one new guard spec, and the generated `CLAUDE.md` mirror.

---

## 1. What is wrong

The PRD-137 ledger's own summary says it best:

> Rows 4, 12, 17 and 18 are one defect in four places: **the generated `AGENTS.md` and the
> generated `package.json` describe a project that does not behave the way they say.**

Two of those four are fixed elsewhere in this batch. Three claims remain, and they are this PRD.

### 1.1 Two resource ids for one object, neither documented

`packages/core/src/playtest.ts:359-362`:

```ts
[
  ["GameState", value],
  ["state", value],
]
```

The starter's own scenarios assert against `GameState`. The sealed proof in the PRD-137 brief reads
`state`. **Nothing in the generated `AGENTS.md` mentions either.** The builder found out by reading
`node_modules/@threenative/core/dist/playtest.js`.

Requiring a new user to decompile a published bundle to learn which id to assert against is the
whole defect. Two ids for one object is also duplication with no owner — nobody can say which is
canonical, so nobody can remove either.

**Fix:** document one as canonical, keep the other as a documented alias with a stated removal
plan, and say both exist. **Recommendation: `state` is canonical** — it matches `ctx.state`, which
is the API the game actually calls, and `GameState` names a TypeScript type rather than a runtime
thing. Whichever is chosen, `templates/*/playtests/*.json` must all use it in the same commit.

### 1.2 `moveAndSlide` does not move anything when you call it

`packages/physics/src/CharacterBody3D.ts:147-157` records a desired translation and sets
`#sliding = true`. The solve happens in the plugin's bulk step and the transform is written
**after** the frame. So this, which is the obvious way to build an odometer, reads `0` forever:

```ts
const before = mesh.position.clone();
body.moveAndSlide(dt);
const moved = mesh.position.distanceTo(before);   // always ~0
```

Nothing fails. `typecheck` passes, the character moves on screen, the HUD renders, and the number
is zero. The build shipped it and found out from a playtest failure —
`TN_PLAYTEST_RESOURCE_STATE_STAGNATED` while the harness itself measured the subject moving 5.600
units.

The deferral is correct and deliberate: it is what lets the physics step batch every body through
one bulk ABI call, which is the design the native seam depends on. **The bug is that the name
promises otherwise and no doc corrects it.**

**Fix:** one paragraph in the generated `AGENTS.md` and a `@remarks` on the method saying the
transform lands after the step and giving the previous-frame comparison as the supported pattern.
Godot's `move_and_slide` is where the name is borrowed from and it applies immediately, so the
divergence from the borrowed vocabulary is exactly what needs stating.

Consider also `body.lastMotion` — the translation the solver actually applied, which is the number
the game wanted. **Only if it is free**: it is already computed inside the step, and exposing a
value the solver has is not new mechanism. If it turns out not to be free, document and stop.

### 1.3 "Never subscribe React to per-frame data" names no alternative

The generated `AGENTS.md` forbids it. `ctx.state` flushes on a 100 ms interval
(`packages/core/src/state.ts:14`, and `packages/core/CLAUDE.md` states it as a rule: *"the store
flushes on an interval so React never re-renders at 60Hz. Never flush per frame."*). So a hit
marker, a muzzle bloom or a damage flash — feedback measured in single frames — cannot go through
the only documented scene→HUD channel.

The build worked it out correctly and expensively: it stretched the hit marker's decay to 0.42 s so
the throttled sampler could not miss it, and kept everything genuinely per-frame in the scene as
Three.js objects.

**That is the right answer and the framework should say so.** This is a documentation defect, not a
missing API. Question (a) says the game can write per-frame feedback portably — it is Three.js
objects in a scene, which is the whole premise of the project. **An unthrottled subscribe channel
is explicitly refused here**: it would exist only to let games do the thing the same document tells
them not to do.

**Fix:** replace the bare prohibition with the rule and its consequence — per-frame visual feedback
lives in the scene; `ctx.state` carries values a human reads (score, ammo, health); anything
shorter than ~100 ms must not be routed through React, and the way to make an event visible in the
HUD is to give it a decay longer than one flush interval.

## 2. The guard

Documentation drifts back. One spec, in `packages/core/__tests__/`, asserting the mechanical
claims the generated `AGENTS.md` makes:

- the resource ids `stateResources()` registers are exactly the documented set;
- the state store's default flush interval is the documented number.

That is deliberately a short list — only claims a test can actually hold. Prose about *why*
`moveAndSlide` defers is not testable and does not get a fake test to look rigorous.

### 2.1 Shape constraints

Read the batch README's shape rules first. Specifics:

- **DRY.** The dual resource id in §1.1 is duplication in the runtime. Documenting it is the
  minimum; naming one canonical with a removal plan is the fix. Do not add a third.
- **SRP.** The guard spec checks documented constants. It is not a doc linter and does not parse
  Markdown.
- **KISS.** No new API in this PRD except the conditional `lastMotion` in §1.2, which ships only
  if it is already computed.

## 3. Acceptance

| # | Command | Required result |
| --- | --- | --- |
| 1 | `pnpm vitest run packages/core/__tests__/documented-contract.spec.ts` | pass — registered resource ids match the documented set; flush interval matches the documented number |
| 2 | change the flush interval in `state.ts` without touching the docs | row 1 **fails** |
| 3 | `grep -rn "GameState" packages/create-threenative/templates/*/playtests/` | every hit uses the canonical id chosen in §1.1 |
| 4 | build the odometer the naive way in a scaffolded project | the generated `AGENTS.md` contains the paragraph that predicts the zero, and a scenario asserting the correct pattern passes |
| 5 | `pnpm sync:agents --check` | exit `0` |
| 6 | `pnpm typecheck && pnpm lint && pnpm test && pnpm test:templates` | exit `0` |

Row 2 is the one that matters. A guard nobody has seen fail is a guard nobody has tested.

## 4. What this does not claim

Not that the generated `AGENTS.md` is correct everywhere — this PRD fixes three claims a real build
tripped over and does not audit the document. A full audit against a cold build is
[PRD-137](PRD-137-the-agent-test-on-a-real-game.md)'s instrument, and running it again is a
round, not a day. Not that `lastMotion` ships; §1.2 makes it conditional on being free. Not that
the HUD story is complete — §1.3 documents the existing design and refuses to widen it, which is a
decision that could be revisited if a second game hits the same wall differently.
