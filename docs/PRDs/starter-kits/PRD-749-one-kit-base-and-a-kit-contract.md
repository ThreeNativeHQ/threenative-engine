# PRD-749: One kit base and a kit contract — fix a bug once, prove it on every kit

**Status:** NOT STARTED
**Priority:** P1 — a bug found in one starter kit still has to be found and fixed again in each of 16 kits (all phases open)
**PR:** #574 (owner rule: one PR for related work)
**Owner ask (2026-10-26):** "im seeing this trap of having to fix all starter kits once i discover a bug in one. Do you propose any change? ... maybe some base defaults abstraction ? Or something better?", then "remember, these are flexibel", then "go" / "just write it".

## Why

The 16 kits hold 663 source files and 100,401 lines (measured 2026-10-26 at 321f6ceaa). `camera.ts`, `lighting.ts`, `materials.ts`, `quality.ts`, `sky.ts`, `game.ts` and `Hud.tsx` exist in every kit as separately edited copies, so a fix in one never reaches the others. Seven environment and backlight files are byte-identical in 12 kits, so one fix is twelve edits. Bugs found in one kit this week (PRD-747) — the camera hiding the player, debug text in the HUD, damage applied before the swing lands, a roll clip cut short, legs that slide — are behaviours every kit can get wrong, and nothing checks them across kits.

## Shape

- **Kits stay flexible (owner: "these are flexibel").** The base is copied source, not a runtime dependency: a generated game owns every file and may edit or delete any of it. Contract rows check what a player sees, not how the code does it. Each row has a per-kit opt-out with a stated reason, reported the way conventions report overrides.
- **Engine nodes are building blocks with defaults**, in Godot vocabulary. A kit may skip a node; the contract still checks the behaviour.
- **Look stays generated source** in `src/render/` (repo rule). The base carries plumbing and the shared look defaults; each kit keeps its own overrides, gameplay and level.

## Phases

### Phase 1 — The kit contract runs on every kit

- [x] A kit contract suite runs every row on all 16 kits from `pnpm test:templates`, each row a playtest assertion with a per-kit opt-out that needs a reason. proof: a spec in `packages/playtest/__tests__` for the opt-out rule, and the suite listing 16 kits.
  Done (2026-10-27): `kit-contract.spec.ts` rejects an opt-out without a written reason, for an unknown row, and a stale one; the headed sweep on pr563-followup 6ef214594 (`TN_KIT_CONTRACT_ONLY=1` of `pnpm test:templates`) lists all 16 kits, 8 rows each.
- [ ] Seed rows from PRD-747's confirmed bugs, each red on the commit that shipped it: the camera never hides the player, retry resets state, no debug text in the shipped HUD, HUD text contrast, a hit lands inside its clip's contact window, foot slip under the PRD-735 bound, a one-shot clip (roll, attack) reaches its end, and no hitch (PRD-748's gate). proof: per row, the red commit and the green run on all 16 kits.
  Progress (2026-10-27, open): the 6ef214594 sweep is green on every row of every kit except platformer `camera-sees-subject` (5 of 205 samples, 2.4% against 2%: the fox falls into the non-solid rock body, Stage.ts:105; a game-feel call, not tuned). The row is chaotic on this kit: the seeded explorer takes another path when the fox's motion changes, and three kit experiments (kill plane at the stage floor minus 6 m, a rock-face wall below each cap, a chest-height lens pivot) read 6 to 12 blocked on two headed runs each, never under 5, so none shipped. The contract runs locally and in the weekly template rotation, not in PR CI. Red on 11d0ff38a: 12 rows on 10 kits. Fixes: sight-line observer skips cutouts, depth-less effects and ropes (spec red to green); spring-arm pull-in in starter, platformer and adventure; puzzle and action-rpg near walls cut down; restart bounds with `lte` and a platformer `R` binding; explore judged by path length; `assert.animation` `atStep` and the action-rpg swing fitted to its clip.

### Phase 2 — Engine nodes for the repeated mechanics

- [ ] `SpringArm3D`: a camera boom that pulls in along a physics cast and ignores its own body. proof: a spec in `packages/core/__tests__`, and the minimal kit's camera row green with its hand-written probe deleted.
- [ ] `AnimationPlayer` method tracks (call at clip time, as Godot's call-method track and Unreal's AnimNotify do) and per-play speed. proof: a spec, and the action RPG's sword hit and roll rows green on the node.
- [ ] A speed-driven locomotion blend (`BlendSpace1D`, Godot `AnimationTree` vocabulary) that sets the stride rate from ground speed. proof: a spec, and the foot-slip row green on two kits.

### Phase 3 — One kit base

- [ ] The byte-identical environment and backlight files and the common plumbing move to `template-assets/base/`, and the scaffolder copies them into each kit. proof: `packages/create-threenative/__tests__` scaffold specs, and the generated trees byte-identical to before.
- [ ] Each kit's copies of the shared files are cut to its deltas (overrides and gameplay only). proof: the LOC drop across templates (`pnpm tsx scripts/count-loc.ts`), the contract green on all 16 kits, and a judge NEUTRAL per kit.

- [ ] The agent docs describe the structure (owner, 2026-10-26: "add on this PRD instructions to tweak CLAUDE.md AGENTS.md informing about these starter kit structures"): the templates' `AGENTS.md` that every scaffold receives, `packages/create-threenative/AGENTS.md` and the root `AGENTS.md` "Where a change goes" table say what lives in the base, what a kit owns, how a contract row and its opt-out work, which engine defaults (PRD-748) a game gets without asking, and the rule "a bug found in one kit is fixed in the base, an engine node or a contract row, never only in that kit". Edit each `AGENTS.md`, then `pnpm sync:agents` for the `CLAUDE.md` mirrors. proof: `pnpm sync:agents --check`, `scripts/__tests__/primary-docs.spec.ts` and the prose-only doc lane.

## Acceptance criteria

- [ ] A bug fixed in the base or an engine node reaches every kit with no per-kit edit. proof: one Phase 3 fix shown landing in all 16 scaffolds.
- [ ] A new bug found in one kit becomes one contract row that reports every affected kit in one run. proof: the Phase 1 seed rows.

## Decisions

- 2026-10-26 (owner): copied shared source plus a cross-kit contract, over a runtime kit-framework package (that hides code from the agent and takes the look away from the game).
