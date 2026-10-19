---
prd_contract: v1
---

# PRD-146 — `holdFrames` and `waitFrames` are accepted, documented, and do nothing

**Status: DONE, 2026-08-18.** Deprecated frame aliases execute fixed ticks, canonical init output
uses ticks, and the runner/template gates pass. See [batch verification](../../verification/fps-friction-batch-2026-08-18.md).

**Outcome:** a scenario written the way the generated documentation tells you to write it either
works or is rejected. It never runs, passes schema validation, and advances the game by 5% of what
it asked for.

**Depends on:** nothing.

**Blocks:** nothing, but it is the first thing to fix in this batch's harness lane — every other
harness item is easier to verify once scenarios do what they say.

**Complexity: 3 → LOW mode.** One branch in the runner, or one rejection in the schema.

**Blast radius: 4 files.** `packages/playtest/src/runner/runner.ts`,
`packages/playtest/src/scenario.ts`, `packages/playtest/src/runner/init.ts`, and the generated
`AGENTS.md`.

---

## 1. The defect

The generated `AGENTS.md` says:

> Steps count frames, not milliseconds — `holdFrames`, `waitFrames`.

`packages/playtest/src/runner/runner.ts:844-857`:

```ts
const ticks = playtestStepHoldTicks(step, 0) + playtestStepWaitTicks(step);
const frames = (step.holdFrames ?? 0) + (step.waitFrames ?? 0);
if (ticks > 0 && bridge?.description.capabilities.includes("runtime.fixedStep") === true) {
  for (let index = 0; index < ticks; index += sampleTicks) {
    await bridge.advance(...);          // drives the game's fixed-step clock
  }
} else {
  await waitFrames(page, Math.max(frames, ticks, 1));   // requestAnimationFrame only
}
```

When the game exposes `runtime.fixedStep` — which every ThreeNative game does — the clock is
driven by `bridge.advance`. A step that supplies only `holdFrames` has `ticks === 0`, so it falls
to the `else` branch and waits on `requestAnimationFrame`, **which does not advance the fixed-step
clock at all**. The game sees a handful of ticks and the scenario sails past.

Measured by the PRD-137 builder:

| Scenario | Result |
| --- | --- |
| 198 ticks requested via `holdFrames`/`waitFrames` | game advanced **11 ticks (0.18 s)**; 2 of 3 keypresses never became `justPressed`; `KeyW` moved the player **0.001 m** |
| Identical scenario using `holdTicks`/`waitTicks` | 5.60 m moved, 3 shots, 1 reload |

Both are accepted by the schema (`scenario.ts:590-601` lists all four keys) and neither warns.
`packages/playtest/src/runner/init.ts:24` — the scenario `cli.js init` writes for a new user —
uses `holdFrames`. **The command that bootstraps a user's first scenario generates the broken
spelling.**

**Name the layer. This is an engine bug in the harness**, and the worst kind this repository
recognises: a check that reports success while asserting nothing. A scenario written this way
passes because the game never got far enough to fail.

## 2. The fix

Two defensible answers. **Pick one and say which in the commit message** — do not ship both.

**(a) Make `frames` mean ticks under a fixed-step bridge.** One line: include `frames` in the
`ticks` total when the bridge has `runtime.fixedStep`. Every existing scenario using the
documented spelling starts working. The cost is that the two vocabularies stay, meaning the same
thing, forever.

**(b) Reject `holdFrames`/`waitFrames` at schema load with a message naming the replacement.**
Honest, fails closed, and collapses the vocabulary to one pair. The cost is a breaking change for
any scenario in the wild using them — and since they never worked, "breaking" is generous.

**Recommendation: (b), plus a codemod line in the error message.** A harness whose stated principle
is fail-closed should not silently absorb a spelling it spent a year not honouring, and two names
for one concept is exactly the discovery cost the vocabulary rule exists to prevent. Whichever is
chosen, `runner/init.ts:24` and the generated `AGENTS.md` must agree with it in the same commit.

### 2.1 Shape constraints

Read the batch README's shape rules first. Specifics:

- **DRY.** One vocabulary for one concept. Path (a) preserves two spellings and is the weaker
  answer for exactly that reason. If (a) is chosen anyway, `holdFrames` must be documented as a
  deprecated alias in the same commit, not left as a peer.
- **KISS.** No `holdMs`, no `holdSeconds`, no unit suffix system. A fixed-step game counts ticks.
- **Fail closed.** Whichever path, a step that requests time and receives none must be an error,
  never a silent short run.

## 3. Acceptance

| # | Command | Required result |
| --- | --- | --- |
| 1 | `pnpm vitest run packages/playtest/src/scenario.test.ts` | pass — and updated: `scenario.test.ts:27` and `:66` currently assert `holdFrames`/`waitFrames` are **accepted**, which is the bug frozen into a test |
| 2 | reproduce the ledger measurement: a 198-tick scenario written with `holdFrames` | on path (a): the game advances ~198 ticks. On path (b): the run **fails to load** with a message naming `holdTicks` |
| 3 | the same scenario with `holdTicks` | unchanged — 5.6 m, and this must be shown to still work |
| 4 | `node packages/playtest/dist/runner/cli.js init` then run the scenario it wrote | exit `0`, and the game actually moved |
| 5 | `pnpm typecheck && pnpm lint && pnpm test && pnpm test:templates` | exit `0` |
| 6 | `grep -rn "holdFrames\|waitFrames" packages/ docs/` | every remaining hit is deliberate and named in the evidence file |

Row 1 is the important one. There is a passing test asserting the broken key is valid, which is
how this survived — a gate that locks in the defect.

## 4. What this does not claim

Not that the rest of the step vocabulary is right. `warmupFrames` (`runner.ts:240`) uses genuine
rAF frames and may be correct as-is; this PRD does not touch it, and whether it should also be
ticks is an open question named here. Not that the Android runner agrees:
`androidRunner.ts:238` sums `holdFrames + waitFrames` on its own path and that path is not covered
by any acceptance row above, because the Android emulator lane is red on this machine.
