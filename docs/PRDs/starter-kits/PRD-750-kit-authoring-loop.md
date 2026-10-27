# PRD-750 — Kit authoring loop: build a genre kit, cold-build a game from it, learn, repeat

**Status:** PARTIAL — Phase 1 done
**Priority:** P1 — "make me a game like X" is the primary workflow before the release; the measure step exists, but no iteration has run (Phases 2-3 open)
**Complexity:** 3 (LOW) — 1–5 files +1, new module (the loop script) +2; risk override: none
**Owner:** João Paulo Furtado
**Depends on:** PRD-735 (reverse-engineer references at scale), PRD-749 (one kit base and a kit contract), PRD-751 (one dashboard)
**PR:** one epic PR for the loop and every kit it builds (owner, 2026-10-26), merged at the release

## Context

The owner wants the release to invest in the authoring layer: a user asks "make me a game like X",
an agent starts from the matching starter kit, and the first build is good on few tokens
(root `AGENTS.md`: "A request that names a game or genre a kit covers starts from that kit").

Today:

- 16 kits ship in `packages/create-threenative/templates/`. Only three (collectathon, adventure, kart;
  PRD-732/733/734) were built to the current bar, with `kit.json` `aliases` and pinned reference
  citations.
- The reverse-engineer tools (`engine_search_references`, `engine_reference_detail`,
  `engine_save_reference` in `packages/engine-mcp/src/references.ts`) shipped in #563, but the data
  release holds one Tier-1 game (SM64). PRD-735 fills it.
- Nothing measures what a cold user agent pays to build from a kit, or what friction it hits. Each
  kit lane learned alone, and the next lane did not read it.
- Harnesses exist and are reused here, not rebuilt: `pnpm sandbox` (user-like install),
  `pnpm sweep:measure` (`scripts/measure-sandbox.ts`), the `build-on-sandbox` and
  `score-build-experience` skills, the playtest runner and the visual judge rule.

## Solution

One **iteration** builds one row of the genre list below:

```mermaid
flowchart LR
  R[Reference: engine_search_references<br/>-> pinned decomp cards] --> A[Author: in-repo agent<br/>writes or revamps kit N on the kit base]
  A --> C[Cold build: fresh agent in pnpm sandbox<br/>prompt 'make me a game like X']
  C --> M[Measure: 4 KPIs<br/>from transcripts + gates + judge]
  M --> L[Retro row in docs/kit-loop/ledger.json<br/>worked / failed / top 3 frictions]
  L --> F[Fix: top frictions in the authoring layer<br/>before iteration N+1]
  F --> R
```

- **Author step.** An in-repo agent takes the genre row, reads the reference cards through the MCP,
  and writes (or revamps) the kit on the PRD-749 kit base with its own short PRD in
  `docs/PRDs/starter-kits/`. Mechanics borrow constants with `file:line` citations; art, names and
  layouts stay original.
- **Cold build.** A fresh agent in a `pnpm sandbox` folder gets only the user prompt
  ("make me a game like <reference game>"). It must find the kit by alias, build, and pass the kit's
  gates. It gets no repo `AGENTS.md` chain.
- **Measure.** `scripts/kit-loop.mjs` (the only new module) reads the cold-build transcript and the
  gate outputs and appends one ledger row. It measures; it does not drive agents.
- **Retro.** The coordinator reads both transcripts (author and cold), writes three lists into the
  ledger row (worked, failed, top 3 frictions with the transcript line), and the next iteration fixes
  the top frictions first. **Fix scope** (owner, 2026-10-26): the whole authoring layer — MCP tools,
  `capabilities.json`, template `AGENTS.md`, skills, scaffolder, and small shared helpers that several
  kits need. New engine systems are out of scope.
- **Dashboard.** The ledger is a tab of the single `pnpm dashboard` (PRD-751).

### KPIs (owner, 2026-10-26)

Each one is a field of every ledger row. Iteration 1 sets the baseline; targets are relative to it.

| KPI | Definition | Source | Target by the last iteration |
| --- | --- | --- | --- |
| K1 cold-build cost | tokens (input + output + cache writes), wall minutes and turns, from the prompt to the first build whose gates pass | cold transcript (`claude -p --output-format json` usage) | -40% tokens vs baseline |
| K2 first-build quality | share of kit playtest scenarios green on the first cold build with no human edit; `TN_FRAME_BUDGET` presented p95 within budget; visual judge verdict against the reference image | playtest exit codes, `TN_FRAME_BUDGET`, judge | 100% scenarios, budget met, judge CLOSE or better |
| K3 friction count | capability-search misses + hand-written duplicates of an installed system + wrong-API errors + retries of the same failing command | `score-build-experience` rows and the cold transcript | -50% vs baseline |
| K4 AI play grade | a fresh Opus judge plays the cold build (free play with real input, then the scenario captures) and grades feel and mechanics 1–5 against the reference cards | judge report | 4 or higher |

**Stop rule** (owner, 2026-10-26): the loop runs without the owner and stops when the genre list is
done, or when two iterations in a row improve none of K1–K4 by 5% or more. After each kit, the
owner gets one ping with the dashboard tab and the ledger row.

### Genre list (ranked; owner reviews it in the PR)

Ranked by user demand, then by reference availability. "Revamp" rebuilds an existing kit on the kit
base to the PRD-732/733/734 bar; "new" adds a kit. PRD-746 already owns the shooter revamp, so it is
not a row here. The reference for each row is a candidate until PRD-735 lands its cards.

| # | Genre (aliases) | Kind | Candidate reference |
| --- | --- | --- | --- |
| 1 | 3D platformer — calibration row (mario, sm64) | revamp collectathon | `sm64` (Tier 1 today) |
| 2 | Boomer shooter / arena FPS (doom, quake) | new | id Software GPL sources |
| 3 | Open-world third-person action (gta) | new | `re3` |
| 4 | RTS (command and conquer, red alert) | revamp rts | OpenRA |
| 5 | Metroidvania (metroid, castlevania) | new | Super Metroid disassembly |
| 6 | Arena fighter (smash) | new | SSB64 decomp |
| 7 | Voxel survival / crafting (minecraft) | new | Luanti (Minetest) |
| 8 | Arcade racer (need for speed, ridge racer) | revamp racing | to be scouted (PRD-735 Phase 3) |
| 9 | Tower defense (bloons, kingdom rush) | revamp tower-defense | to be scouted |
| 10 | Endless runner (subway surfers, temple run) | revamp runner | to be scouted |

Row 1 runs first on purpose: its reference already exists, so it calibrates the loop and sets the
KPI baseline while PRD-735 scouts the next references.

## Acceptance Criteria

See the phase boxes. Each box names its proof.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Kit-loop ledger row | `pnpm kit:loop record <cold-build dir>` → `scripts/kit-loop.mjs` → `docs/kit-loop/ledger.json` | new | AC-1 |
| Kit KPI tab | `pnpm dashboard` → kit-loop tab reads the ledger | new tab in the PRD-751 hub | AC-2 |
| Kit found by genre words | cold agent → `engine_search_capabilities` / `--genre <alias>` → kit | unchanged path, measured | AC-4 |

## Decisions

- 2026-10-26 (owner): an iteration is an in-repo author step plus a cold sandbox build; both transcripts are inspected.
- 2026-10-26 (owner): fix scope is the whole authoring layer; new engine systems stay out.
- 2026-10-26 (owner): KPIs are K1–K4 above; the play grade comes from an AI judge, not the owner.
- 2026-10-26 (owner): a ranked mix of revamps and new kits; PRD-735 (references at scale) lands before the loop runs past row 1.
- 2026-10-26 (owner): one epic PR for the loop and every kit; it merges at the release.
- 2026-10-26 (owner): target-plus-plateau stop rule, autonomous, one ping per kit.
- 2026-10-26 (agent): the retro lives in the ledger row, not in a file per iteration, so the dashboard shows it and nothing drifts.

## Execution Phases

#### Phase 1: The ledger and the measure step

**Status:** DONE
**Files:** `scripts/kit-loop.mjs` (new), `scripts/__tests__/kit-loop.spec.ts` (new), `docs/kit-loop/ledger.json` (new), `package.json` (`kit:loop`).

- [x] AC-1 [local]: `pnpm kit:loop record <dir>` turns a cold-build transcript and its gate outputs into one ledger row with K1–K4, and a missing input fails closed (no zero, no pass). proof: `pnpm exec vitest run scripts/__tests__/kit-loop.spec.ts` — red (module missing), then 4/4 green; `pnpm kit:loop record /nonexistent ...` exits 1 with `transcript.json is missing`; the dir contract (five files) is in the script header (2026-10-26)
- [x] AC-2 [local]: the PRD-751 dashboard shows the kit-loop tab with each KPI against its baseline and target. proof: `pnpm exec vitest run scripts/__tests__/perf-live.spec.ts -t kit-loop` — green, see PRD-751 AC-4 (2026-10-26)

#### Phase 2: Iteration 1 — calibration on row 1 (3D platformer)

**Status:** PARTIAL — baseline row 1 recorded; AC-3 waits for the PRD-749 kit base, AC-4 for a quiet-host performance run
**Files:** the row-1 kit PRD, the collectathon kit, the ledger row.

- [ ] AC-3 [local]: the author step revamps the collectathon kit on the kit base, with SM64 card citations, and its own kit PRD is green. proof: the kit PRD's gates
  - Open (2026-10-26): the kit base is not on `pr563-followup`; only PRD-749 Phase 1 (the kit contract, `9d1a848a0`) landed. On collectathon the contract reads `explore-clean` ok, `camera-sees-subject` FAIL (`TN_PLAYTEST_SIGHT_LINE_BLOCKED`), `hud-clean` FAIL (`TN_PLAYTEST_HUD_CONTRAST`), `no-hitch` ok, `foot-slip` ok, three rows opted out. Both reds belong to PRD-749's per-kit red list (its rule: fix in the base, an engine node or a contract row), so this step waits for PRD-749 Phases 2–3.
- [ ] AC-4 [local]: a cold sandbox agent prompted "make me a game like Super Mario 64" picks the collectathon kit and reaches a gate-green build; the ledger holds the baseline row with K1–K4 and the retro lists. proof: `pnpm kit:loop record <sandbox dir>`, ledger row 1
  - Open (2026-10-26): ledger row 1 is recorded as the baseline on today's kit (no revamp): K1 97,840 tokens, 37 turns, 19 min; K2 21/22 scenarios (95%), presented p95 17.7 ms against 16.7 ms, judge CLOSE; K3 7; K4 4 (fresh Opus judge, evidence-based). The cold agent picked the kit with `--genre mario` on its first call, but the build is not gate-green: the performance gate failed on a loaded host (load 12–30, two foreign Playwright GPU processes), and the agent cut the high tier's look to chase it. The box stays open until one quiet-host run of the performance gate (declared in advance, one run) settles it. Isolation: `claude -p --setting-sources project` plus `claudeMdExcludes` for the global CLAUDE.md; an earlier run that read it is discarded.

#### Phase 3: Iterations 2..N to the stop rule

**Status:** IN PROGRESS — row 1's top two retro fixes landed (a4d5345ef, 42cbf971c + c5bc052e7); row 2's author step runs on tarballs built after them
**Files:** one kit PRD per row, the authoring-layer fixes each retro names, the ledger.

- [ ] AC-5 [local]: each later iteration lands its top retro fixes before its author step, and its ledger row names them. proof: ledger rows 2..N, the fix commits
  - Open (2026-10-26): row 1 fixes landed, row 2 not yet recorded. (1) a cost bound failed beside foreign Chromium GPU processes names them and says to rerun before changing the game (a4d5345ef, red-green `frame-budget.spec.ts`, 1893/1893 playtest tests). (2) the scaffold's last line says to start the agent in the project so `.mcp.json` loads the engine MCP, and `engine.mjs <tool> '<json>'` answers one call without it (42cbf971c, c5bc052e7, red-green `scaffold.spec.ts` and `server.spec.ts`; the shim answered the mario search with collectathon, exit 0, and a bad tool with exit 1). Friction 3 (the 45 KB `CLAUDE.md` + `AGENTS.md` pair read twice) is not fixed: an agent started in the project loads `CLAUDE.md` itself, so fix 2 removes the reason to read both.
- [ ] AC-6 [local]: the loop stops by the rule: the list is done, or two rows in a row gain under 5% on all of K1–K4. proof: the ledger, the stop line in this PRD
- [ ] AC-7 [local]: K1–K4 meet their targets at the last row, or the gap per KPI is recorded with its cause. proof: dashboard kit-loop tab, the last ledger row
