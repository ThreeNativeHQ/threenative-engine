---
prd_contract: v1
---

# PRD-241 — The game brings its own curve

*(filed under the batch's original title "a sequence is one cancellable object"; the reading below
retired most of that scope before it was written — see "What the survey asked for, and what
survived")*

**Status: DONE, 2026-08-29.** Implemented in `affb48e8` (`feat(core): allow game-owned tween
easing`) and closed here after an audit that ran every negative control the document names. Three of
the four reproduced red exactly as written. The fourth did not, and the reason is a defect in the
guard rather than in this feature — see "Closure audit" at the end. Evidence:
`docs/verification/prd-241-easing-closure-2026-08-29.md`.

Sources read at depth 1 on 2026-08-28:
[`agargaro/three.ez`](https://github.com/agargaro/three.ez) `src/tweening/` (1 069 lines, MIT) and
[`pmndrs/timeline`](https://github.com/pmndrs/timeline) (MIT). **Both are refused as dependencies,
and most of what they offer is refused as scope**, on evidence from this repository.

Parent batch: feature-mining.

**Complexity:** +1 touches 3 files, +1 the surface is public and versioned, +1 timing sits in the
frame budget = **3 → LOW mode.** Minimal template.

## What the survey asked for, and what survived contact with the code

The survey proposed absorbing a composable sequencing system — timelines, parallel branches,
scoped cancellation. Reading `packages/core/src/schedule.ts` and `packages/core/src/game.ts`
removed three of the four reasons to want one:

| Asked for | Already true at HEAD | Evidence |
| --- | --- | --- |
| Sequencing | `ctx.tween` returns a promise. `await a; await b;` **is** a sequence, and `Promise.all` is a parallel branch. A timeline DSL would be a second, worse way to write what the language already does. | `packages/core/src/schedule.ts:49-92` |
| Cancellation on scene change | Done, and done correctly: `goto` calls `scheduler.clear()`, every entry's `onCancel` runs, and a pending tween's promise **settles** rather than hanging a caller forever. | `game.ts:527`, `game.ts:1057`, `schedule.ts:115-116`, `schedule.ts:71-76` |
| Vector targets | `ctx.tween(mesh.position, { x: 5, z: 2 }, 0.4)` already works — `position` is an object with finite numeric fields, which is exactly what the tween accepts. | `schedule.ts:52-63` |
| Easing | **Missing.** Every tween in every game is linear, and there is no way to pass a curve. | `schedule.ts:84` — `start + (end - start) * progress` |

So the whole of this PRD is the fourth row.

## The question, and why the answer is a parameter rather than a library

Rule 3 lists what the framework must never own: *"geometry, material, colour, texture, **curve and
timing** come from the game."* An easing library is a menu of curves — `easeOutCubic`,
`easeInOutQuint`, `easeOutElastic` — and shipping that menu is shipping a look decision, in the same
way that shipping a particle colour ramp would be. three.ez ships 147 lines of exactly that
(`src/tweening/Easings.ts`).

The mechanism, though, is unambiguously the framework's and already is: a per-frame driver that
advances progress in the fixed-step loop, settles a promise, and is cancelled by a scene change.

The split follows `GPUParticles3D`: **mechanism here, curve from the game.**

```ts
// today — linear, and no way to say otherwise
await ctx.tween(door.position, { y: 2.4 }, 0.5);

// proposed — one optional callback; the curve is the game's, written in the game
await ctx.tween(door.position, { y: 2.4 }, 0.5, { ease: (t) => 1 - (1 - t) ** 3 });
```

No easing names ship. No curve ships. The doc comment shows one inline cubic so an agent reading the
manifest can copy it, and the templates that want a feel put their curves in
`src/render/` beside their other look decisions.

## What the sources actually contain

| Claim | Evidence |
| --- | --- |
| three.ez's tweening is 1 069 lines, of which 147 are a curve menu and ~600 are a runner this repository already has | `src/tweening/Easings.ts` (147), `RunningTween.ts` (341), `TweenManager.ts` (140), `Tween.ts` (230), `Actions.ts` (211) |
| Its genuinely interesting part is typed motion over `Vector`, `Quaternion`, `Euler` and `Color`, not over numbers | `src/tweening/Actions.ts:1-15` |
| `pmndrs/timeline` composes async generators into sequential/parallel graphs | `packages/timeline/src/sequential.ts`, `parallel.ts`, `scope.ts` |
| Both MIT | `LICENSE` in each clone |

**Refused, with reasons:** the curve menu (rule 3); the runner (already exists, and a second one
inside the frame budget is a regression waiting to happen); the timeline DSL (`await` and
`Promise.all` already express it, so it fails "could the game write this portably itself"). The
`Quaternion` case is the one part worth reconsidering later — spherical interpolation is not
expressible as per-component numeric tweening — and it is deliberately **not** in this PRD, because
no template needs it today and a surface added for a hypothetical caller is dead by construction.

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| `Scheduler.tween` — `packages/core/src/schedule.ts:49-92` | **The thing being changed.** No new module, no second tween. |
| `ctx.tween` — `game.ts:746` | Signature gains one optional argument. Every existing call keeps compiling and keeps behaving identically. |
| `packages/core/__tests__/frame-budget-steady-alloc.spec.ts` | The guard: an easing callback must not put an allocation in the steady-state frame. |

## Integration Ledger

| # | Changed thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `ease` option on `Scheduler.tween` | `packages/core/src/game.ts:746` forwards it | linear-only interpolation | yes — linear becomes the default `ease`, not a parallel branch | pass `t => t*t` and assert the midpoint is **not** the linear midpoint; drop the option and it reds |
| 2 | Updated capability doc tags | `capabilities.json` via `pnpm build` | today's tags | yes | remove `@example` → `pnpm budgets` fails |
| 3 | One template uses a non-linear curve for something visible | a `templates/*/src/render/*.ts` curve + its caller | a linear move | yes | revert the curve → the template's visual baseline shifts |

## Execution Phase (one, because it is one change)

### Phase 1 — a curve the game supplies, proven by a game

**Files (4):** `packages/core/src/schedule.ts` (EDIT), `packages/core/src/game.ts` (EDIT — forward
the option), `packages/core/__tests__/schedule.spec.ts` (EDIT),
one `templates/*/src/render/*.ts` + its caller (EDIT).

- [x] `ease?: (t: number) => number`, called with `t` in `[0, 1]`, result used as the interpolation
      factor. No clamping of the output — an overshooting curve (`back`, `elastic`) is a legitimate
      thing for a game to write, and clamping it silently would make those curves impossible.
- [x] Default is the identity, so existing behaviour is unchanged bit for bit.
- [x] `t === 1` is delivered exactly once and the end value is assigned exactly, not
      `ease(1) * (end - start)` — a curve that does not return exactly 1 at 1 must not leave the
      target short of its destination.
- [x] No allocation per frame: the callback is stored once, not wrapped per tick.

| Test file | Test name | Assertion | Negative control (must be observed red) |
| --- | --- | --- | --- |
| `schedule.spec.ts` | `should reach the exact end value when the curve does not return 1 at t=1` | strict equality to `end` | multiply by `ease(1)` at the end → short by the curve's error, reds |
| `schedule.spec.ts` | `should interpolate by the supplied curve at the midpoint` | midpoint ≠ linear midpoint | ignore the option → equal, reds |
| `schedule.spec.ts` | `should behave identically to a linear tween when no curve is given` | matches the pre-change values | make the default anything but identity → reds |
| `frame-budget-steady-alloc.spec.ts` | `should allocate nothing per frame while a curved tween runs` | zero steady-state allocation | wrap the callback per tick → reds |

**Revert check:** remove the `ease` forwarding in `game.ts:746` → the template's visual baseline
and the midpoint test both fail.

## Acceptance criteria (consumer-scoped)

- [x] Something in a shipped template moves with a non-linear feel a player can see, and the curve
      that produces it lives in that template's `src/render/`, not in `packages/`.
- [x] Every existing `ctx.tween` call in the repository compiles and behaves identically, shown by
      the unchanged pre-existing tests.
- [x] An overshooting curve overshoots and still lands exactly on the end value.
- [x] `packages/` contains no named easing function, no curve table, and no easing menu — grep
      pasted.
- [x] The frame still allocates nothing *that this feature added* while a curved tween runs — pinned
      deterministically. The stronger reading of this line is **not** established and never was; the
      guard that claimed it could not fail. See "Closure audit".

## Kill switch, and the honest recommendation

This is roughly ten lines of framework code. `count-loc.ts` will not distinguish it from writing
`ctx.every((dt) => …)` by hand, which is a real alternative a game can already write portably.

**Recommendation: file it, and build it only after 237 and 239 land.** It is the least valuable item
in the batch by a wide margin, and its main worth is that this document now records *why* the
composable-timeline idea was not built — so nobody re-proposes it in three months and re-derives
that `await` already did the job.

---

## Closure audit — 2026-08-29

Run against `affb48e8`'s implementation, on `main`. Every negative control this document names was
executed; nothing below is inferred.

| Gate | Mutation applied | Result |
| --- | --- | --- |
| `should reach the exact end value when the curve does not return 1 at t=1` | assign `start + (end - start) * ease(1)` on the landing frame instead of `end` | **RED**, that test only |
| `should interpolate by the supplied curve at the midpoint` | `easedProgress = progress` (ignore the option) | **RED**, plus 3 siblings |
| `should behave identically to a linear tween when no curve is given` | default `progress * progress` instead of identity | **RED**, plus 1 sibling |
| `should allocate nothing per frame while a curved tween runs` | wrap the callback per tick | **GREEN — the control does not reproduce** |

**The fourth control's failure is the guard's, not the feature's.**
`frame-budget-steady-alloc.spec.ts` counted GC events from a `PerformanceObserver` across 1.2M
frames and required the list to be empty, but V8 delivers GC entries through the event loop and the
test disconnected the observer without ever yielding. `events` was `[]` whatever the frame did.
Pushing 1.2M *escaping* closures through the tween left it green; a capability probe in the same
environment reported 0 events synchronously and 42 after one `setTimeout(…, 0)`.

Repairing the yield turned the window red at 22–130 events — so the fixed-step frame is **not**
allocation-free, which is a pre-existing engine defect this PRD neither caused nor owns. One source
was found and fixed on the way through (`FrameBudget.endFrame` built a phase sample every frame that
`stepFrame` discarded whenever `collectMetrics` was false; observed red = 240 built samples across
240 frames). The remainder is unowned and recorded in `docs/verification/runtime-perf-state.md`
§1.4.1, along with the finding that the GC-event count is dominated by warm-up order (~135 first
window, ~70 second, same configurations) and therefore cannot carry a pass/fail bar at all.

The spec file now pins this PRD's actual claims deterministically: the curve is evaluated exactly
once per tick, `t === 1` is delivered exactly once and is not used for the landing assignment, and
no phase sample is built per frame while a curved tween runs with metrics off. All three reproduce
red under their named mutations.

**Scope note:** `packages/core/src/schedule.ts` is unchanged by this audit. One candidate edit — skip
evaluating the curve on the landing frame, since its result is discarded — was written, tested, and
**reverted**: this document requires that `t === 1` be delivered exactly once, and the existing test
pins it. The contract wins over the micro-optimisation.
