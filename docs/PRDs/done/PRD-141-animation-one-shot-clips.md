---
prd_contract: v1
---

# PRD-141 — `AnimationPlayer` hides the one-shot playback `AnimationMixer` already has

**Status: DONE, 2026-08-18.** The FPS death path uses `mode: "once"` and `finished`; web and
desktop death playtests pass. See [batch verification](../../verification/fps-friction-batch-2026-08-18.md).

**Outcome:** a death animation stops on its last frame and a fire clip returns to idle, without the
game owning a mixer-stopping timer.

**Depends on:** nothing.

**Blocks:** nothing.

**Complexity: 3 → LOW mode.** Two options on an existing method, one signal, one spec.

**Blast radius: 3 files.** `packages/core/src/animation.ts`, one new `__tests__` spec, the
generated `AGENTS.md` line describing `AnimationPlayer`.

---

## 1. The defect

`packages/core/src/animation.ts` is a 96-line wrapper over `THREE.AnimationMixer`. Its whole
public play surface is:

```ts
export interface IAnimationPlayOptions {
  readonly fade?: number;
}
```

`THREE.AnimationAction` has `setLoop(THREE.LoopOnce, 1)`, `clampWhenFinished = true`, and the
mixer emits a `finished` event. The wrapper exposes **none of the three**, and because it owns the
`AnimationAction` objects privately (`#actions`, line 14) a game cannot reach them either — the
only public escape is `player.mixer`, which is the raw mixer, not the actions.

So the wrapper is strictly less capable than the thing it wraps, on the exact axis a
non-looping clip needs. The PRD-137 build hit both halves:

```ts
// sandbox/fps-framework/src/entities/Enemy.ts:334-339 — the death clip
this.#play("DeathFront", 0.06);
// Nothing in `AnimationPlayer` clamps a one-shot clip at its last frame, so
// the ragdoll is held by stopping the mixer updates once it has played out.
ctx.after(1.1, () => { this.#frozen = true; });
```

```ts
// sandbox/fps-framework/src/entities/Rifle.ts:203-208 — the fire clip
this.#shootFor = Math.max(0, this.#shootFor - dt);
if (this.reloading) this.#play("Reload");
else if (this.#shootFor > 0) this.#play("Shoot", 0.02);
else if (moving > 0.6) this.#play("Run");
```

The `1.1` is a hand-measured clip length hard-coded in game logic. If the artist re-exports the
clip a frame longer, the corpse twitches and no gate reports it. `#shootFor = 0.12` is the same
number for the rifle. Both are the game reimplementing "this clip has finished", badly, because
the framework threw the answer away.

**Name the layer. This is an engine bug**, and specifically a kill-switch finding: an abstraction
that costs the game more code than plain Three.js would have. `new AnimationMixer(root)` plus
`action.setLoop(LoopOnce, 1); action.clampWhenFinished = true` is three lines and needs no timer at
all.

## 2. The surface

```ts
export interface IAnimationPlayOptions {
  readonly fade?: number;
  /** `"loop"` (default) repeats; `"once"` plays through and holds the last frame. */
  readonly mode?: "loop" | "once";
}
```

plus one read, which is what both game workarounds were actually asking for:

```ts
/** True when a `"once"` clip has reached its end and is holding. */
get finished(): boolean;
```

`mode: "once"` maps to `setLoop(LoopOnce, 1)` and `clampWhenFinished = true`. `finished` reads the
mixer's `finished` event for the current action. That is the entire change.

### 2.1 Shape constraints

Read the batch README's shape rules first. The specific risks here:

- **SRP.** `AnimationPlayer` plays clips and blends between them. It does not become a state
  machine. No `queue()`, no `playThen(name, next)`, no transition graph, no per-clip callback
  registry — deciding *which* clip plays when is gameplay, permanently the game's, and both
  workarounds in §1 are correct at that level once `finished` exists to drive them.
- **DRY.** `mode` maps onto `AnimationAction`'s existing loop settings. Do not add a
  ThreeNative-named enum (`AnimationLoopMode.Once`) beside Three.js's `LoopOnce`; the vocabulary
  is borrowed, and a second spelling is a discovery cost for every model.
- **KISS.** One option value and one getter. A `finished` **callback** is deliberately not in
  scope: a getter polled in `update()` is what a fixed-step game loop already does every frame,
  and a callback adds a lifetime and an unsubscribe nobody asked for.
- **Kill switch.** After this lands, the game version must be smaller. Acceptance row 4 measures
  it: `ctx.after(1.1, ...)` and `#shootFor` both delete, and nothing replaces them.

## 3. Acceptance

| # | Command | Required result |
| --- | --- | --- |
| 1 | `pnpm vitest run packages/core/__tests__/animation.spec.ts` | pass — a `"once"` clip advanced past its duration holds its last frame; `finished` is `false` before the end and `true` after; a `"loop"` clip's `finished` is never `true` |
| 2 | same spec, regression row | default `play(name)` with no `mode` still loops — existing games must not change behaviour |
| 3 | `pnpm typecheck && pnpm lint && pnpm test` | exit `0` |
| 4 | rewrite the PRD-137 build's `Enemy.hurt` death path and `Rifle.update` clip selection against the new surface, then `pnpm tsx scripts/count-loc.ts` | **fewer** authored lines, `ctx.after(1.1, …)` and `#shootFor` both gone |
| 5 | a playtest scenario: kill the enemy, advance 3 s, assert the corpse's animation is not advancing | pass |
| 6 | the same scenario with `--target desktop` | pass |

Row 2 is the one that matters for anything already shipped. Row 5 is the assertion the current
build cannot make at all, because "has the clip finished" is not observable from outside the game.

## 4. What this does not claim

Not that animation blending is good — `#fadeFrom`/`#fadeElapsed` is a single crossfade slot and a
game blending three clips at once still cannot. Not that root motion works; nothing in this
package reads it. Not that retargeting or clip-name conventions are solved: the PRD-137 build's
`findBone(model, /right.*hand|hand.*r$|hand_r/i)` (`Enemy.ts:65-71`) is a separate gap, in
[PRD-142](PRD-142-bone-sockets-and-attachment.md). **Not that a corpse holding its last frame is
a ragdoll** — it is a frozen pose, and the real thing needs joints; see
[PRD-144](PRD-144-ragdoll.md).
