---
name: starter-kit-development
description: Build a ThreeNative starter kit that teaches one classic game's mechanics in depth, on minimal assets only (the humanoid mannequin GLB and the grey "test lab" metre-grid materials), with every constant taken from the reverse-engineering MCP's reference cards and every mechanic proven by a playtest. Use when asked to add, plan, review or fix a starter kit in `packages/create-threenative/templates/`, to pick which game or genre the next kit covers, or to run several kit lanes at once. Not for a game a user builds from a kit (the kit's own AGENTS.md covers that).
license: MIT
---

# Starter kit development

A starter kit is the answer to "make me a game like X". Its value is the **mechanics**: the rules, timings and
feel of the reference game, built small and proven. Art is not the point. Every kit uses the same two assets, so
a kit can only stand out by how deep and how right its mechanics are.

## The two rules

1. **Minimal assets, always.**
   - Every humanoid is `assets/mannequin-combat.glb` (Quaternius UAL, CC0). Tell roles apart with a material swap.
   - Every surface is the procedural metre-grid ("test lab") material from `src/render/materials.ts`, colours from
     `src/render/palette.ts`.
   - Vehicles, props, crops, doors, ships: procedural geometry on those materials.
   - The sky is the procedural atmosphere (`render/sky.ts`). No photo sky, no `sky.jpg`.
   - No other model, texture, HDRI or sound file. Generated sound (a WebAudio oscillator) is allowed, but the
     game must play muted.
2. **Mechanics come from the reverse-engineering MCP, with citations.**
   - Every borrowed constant, timing and formula cites its reference card (`file:line`) in a comment.
   - Borrow algorithms and numbers only. Copy no code, character names, level layouts or art.

## Workflow

### 1. Pick the game and the mechanics

- List what the MCP indexes: the `threenative-reverse-engineer-mcp` catalog (`data/catalog.json`, one card per
  game in `data/games/<id>.json`). Pick a genre that no kit in `templates/` answers yet.
- The game is missing from the index? Add it to the reverse-engineering MCP first (a card with pinned sources),
  release it, then build the kit. A kit without a card has nothing to cite.
- Write the mechanics table in the PRD before any code: one row per mechanic, each with the reference game, the
  rule, the constants to take from the card and the playtest that proves it. Five to eight mechanics is a kit.
  Fewer is a demo. Each one must be a rule a player can feel, not a feature list item.

### 2. Research each mechanic in depth (before you write it)

For each row, in this order:

1. `engine_search_references {"situation": "<game> <mechanic>"}`, then `engine_reference_detail` on each hit:
   the state machine, the pinned constants, frame timings, edge cases.
2. `engine_watch_reference {"query": "<game> <mechanic>"}`: a contact sheet of real gameplay, to see the feel.
3. `engine_search_capabilities`, then `engine_capability_detail`: reuse engine code (character bodies, vehicles,
   instancing, streaming budgets) instead of writing a new helper.
4. Any asset need: `asset_search` (provider `threenative`). A kit still ships only the mannequin, so this step
   normally confirms "none".

Outside an MCP session: `node packages/core/mcp/call.mjs threenative-engine <tool> '<json>'`.

Write the mechanic as the card describes it:

- Model it as a state machine with named states (patrol, suspicious, alert...). Put the transitions in one place.
- Convert frame counts to seconds at the game's tick rate, and keep the source number in the comment
  (`// 18 frames at 60 Hz, smash.c:412`).
- Implement the failure side too: what breaks, what resets, what the player loses. A mechanic with no failure
  state is not done.
- Keep the edge cases the card names (buffered input, coyote time, invulnerability after respawn, a stalled
  junction). Past kits failed on exactly these.

### 3. Build

- Copy the closest finished kit (`cp -r`) and replace the gameplay: `stealth`, `survival-horror` and
  `open-world` follow these rules. Keep its render stack, `conventions.ts`, `playtest-events.ts` and HUD pattern.
- `kit.json`: `name`, `title`, a short `blurb`, `genre`, and `aliases` with the reference game names as routing
  words, `"kit": true`.
- `AGENTS.md`: one line on what the game owns and one keys line. Run `pnpm sync:agents`. Do not hand-edit `CLAUDE.md`.
- Playtest stations: one key per mechanic sets up that mechanic in one tick, so a scenario proves it in seconds.
  Gate the keys with `(globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true`.
- Split a file near 400 lines by system (`systems/`, `entities/`, `ai/`, `render/`).

### 4. Prove

- **One fail-closed playtest per mechanic.** Red first: the scenario fails before the mechanic exists, or when
  you break it. Assert the state the rule produces (`components` on an entity's `debug()`, `resources` on game
  state), never only "no errors".
- **A `survives` scenario** driven with arrow keys, and **`performance.playtest.json`** with budgets from a
  measured run.
- Run: `TN_TEMPLATE_ONLY=<kit> TN_TEMPLATE_KEEP=1 pnpm exec tsx scripts/verify-template-playtests.ts`. It runs
  every playtest on headed WebGPU, then the kit contract (`packages/playtest/src/kit-contract.ts`). A contract
  opt-out needs a written reason.
- **Assets proof:** the kept scaffold's `assets/` holds only `mannequin-combat.glb`
  (`scripts/check-kit-assets.sh <kept root>`).
- **Look at the frames** (`artifacts/playtest/*/after.png`). A visual claim needs a visual check.
- **Over a performance budget?** Read the per-pass split in `TN_FRAME_BUDGET` (`passes.main` and
  `passes.shadow`, each with draws and triangles), and compare against the previous code on the same scaffold.
  Fix the cause. Raise a budget only with that measurement in the commit.

### 5. Review

- One Gemini review round per kit on the diff and the frames. Ask for `VERDICT: AUTHORIZE|REJECT`, then
  BLOCKING (breaks a mechanic or soft-locks) and POLISH. Verify each BLOCKING finding yourself before you fix it.
- A fresh judge reads the final frames: gameplay readable, nothing broken.

### 6. Register and ship

In one commit titled `register <kit>`:

- rows in `packages/create-threenative/conventions.json` and `packages/core/capabilities.json`
- the template count in `packages/create-threenative/__tests__/build.spec.ts`
- `pnpm scaffold:pin` and `pnpm sync:agents`

Then run `pnpm --filter create-threenative test` and push. The pre-push hook runs `pnpm ci:fast`.

## Several kits at once

- One worktree and one branch per kit (`.claude/worktrees/kit-<kit>`), branched from the PRD branch. Only the
  lead merges the lanes and redoes the registration once: counts and pins conflict across lanes.
- The GPU is shared. Wrap every headed run in `scripts/gpu-slot.sh`, which allows two runs at once.
- Give each lane the same brief: the two rules, the workflow above, its mechanics table and the reference card id.

## Gates that cost past kits a session

| Gate | What fails | Do this |
| --- | --- | --- |
| Word budget | `scripts/instruction-budget.ts` caps each kit's `AGENTS.md` at 1,271 words | Short blurb and hand lines. Do not raise the budget. |
| Look | `kit-look-defaults.spec.ts` | Core filmic tonemap with auto exposure. Do not set `tonemapMode: "aces"` or a fixed `exposure`. Do not join `LOOK_OVERRIDES`. |
| Visual structure | `scripts/visual-gate.ts` | `render/sky.ts` and `render/materials.ts` import `./palette.js`. |
| Extra assets | A photo-sky option made every scaffold copy `sky.jpg` | Procedural sky only. Run the assets proof. |
| Root lint | `pnpm exec biome check .` | Data keys in React lists, `<title>` in SVGs, a written reason on each `delete`. |
| Performance | Per-block draws and crowds in the shadow map broke a streaming kit's budget | Measure per pass. Merge flat static geometry, use shadow level of detail. |
| Contract `no-hitch` | Cheap kits had too few GPU samples on the counted clock | The row runs on the wall clock. Do not change it back. |
| Waiting on a run | Seven lanes idled 30 to 80 minutes after their run had ended: the waiter never fired | Before you wait, check whether the log already ends. Wait with `until grep -q "^exit\|TN_TEMPLATE_PLAYTESTS" <log>`. |
