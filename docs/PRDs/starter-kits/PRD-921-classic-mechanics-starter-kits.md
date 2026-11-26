---
prd_contract: v1
---

# PRD-921 — Three classic-mechanics starter kits: survival horror, open-world crime, stealth

**Status:** PARTIAL — survival-horror and stealth done; open-world and Phase 4 integration in progress
**Priority:** P1 — owner goal, 2026-11-26
**Complexity:** 8 (HIGH) — three new kits in `packages/create-threenative/templates/`, their contract rows, kit notes and pins
**Owner:** João
**Depends on:** none. The reference cards come from `ThreeNativeHQ/threenative-reverse-engineer-mcp` (release v0.6 adds classic games in parallel).

## Context

The owner, 2026-11-26: "revamp the threenative reverse engineer mcp to contain more classic games like resident
evil, GTA, etc. then create on the engine starter kits only with minimal assets (humanoid glb and that gray
'lab texture') - focus deeply on the mechanics. Ask gemini 4 neon high to review so its really good. At least 3
polished starter kits".

The shipped kits cover platformer, collectathon, kart, racing, shooter (first person), action RPG, adventure,
RTS, tower defense, puzzle, runner and sailing. No kit answers "make me a game like Resident Evil", "like GTA"
or "like Metal Gear Solid". Each new kit is the answer to that request (`/AGENTS.md`: a request that names a
game or genre a kit covers starts from that kit).

Asset rule for all three kits: `assets/mannequin-combat.glb` (Quaternius UAL, CC0) for every humanoid, and the
minimal kit's procedural metre-grid materials (`src/render/materials.ts`) for every surface. Vehicles, doors,
items and props are procedural geometry on those materials. No other texture, model or sound.

Mechanics borrow algorithms and defaults from the pinned reference cards (`engine_search_references`), never
code, names, levels or art.

## Kits

| Kit | Reference games | Core mechanics |
| --- | --- | --- |
| `survival-horror` | Resident Evil 1-3, Silent Hill | fixed camera zones that cut, tank controls with quick turn, aim stance with high/low aim and auto-target, scarce ammo and reload, zombies that shamble, grab and bite, condition Fine/Caution/Danger slows the walk, six-slot inventory, herbs, key and locked door, save typewriter with ink ribbons, item box |
| `open-world` | GTA III / Vice City / San Andreas, Driver | third-person on foot, enter/exit and carjack, ray-cast suspension car (`VehicleBody3D`), lane-graph traffic that stops for obstacles, pedestrians that wander and flee, wanted level 0-5 with police pursuit and line-of-sight evasion, busted/wasted respawn, a timed delivery mission, radar |
| `stealth` | Metal Gear Solid, Splinter Cell, Tenchu | guard patrol routes, vision cones with distance and crouch falloff, suspicion meter, alert phases (patrol, suspicious, alert, evasion, caution), noise from running and a wall knock, takedown from behind, bodies found raise the alarm, security camera sweep, radar with cones jammed in alert, keycard objective and extraction |

## Phases

### Phase 0 — base and plan

- [x] PRD filed, worktree `.claude/worktrees/classic-kits` on `feat/classic-starter-kits` from `origin/develop`, draft PR open — evidence: draft PR #748.
- [x] Baseline: `TN_TEMPLATE_ONLY=minimal TN_KIT_CONTRACT=0 pnpm test:templates` green in the worktree — evidence: exit 0, "minimal: scaffolded playtests passed" (after rebuilding the Wasm engine).

### Phase 1 — survival-horror kit

- [x] `templates/survival-horror/` builds, typechecks, lints; only mannequin + grid materials — evidence: scaffold run 2026-11-26 typecheck, eslint, biome format clean; template structure check clean (fog colour routed through `palette.ts`).
- [x] One fail-closed playtest per mechanic, all green with `TN_TEMPLATE_ONLY=survival-horror pnpm test:templates` — evidence: 19 of 19 scenarios pass on headed WebGPU (NVIDIA), run 2026-11-26 after the playtest-key gate (`verify-template-playtests.ts`, the script `test:templates` wraps).
- [x] Kit contract row in `template-playtests/contract.json`, kit notes `agent-docs/references/kit-survival-horror.md` — evidence: contract run green (explore-clean, camera-sees-subject, hud-clean, no-hitch, restart-resets, action-clip-completes; 3 opt-outs with reasons). no-hitch is flaky on Xvfb (`TN_PLAYTEST_PERF_FEW_GPU_SAMPLES`, 2 of 4 runs; GPU p95 2.4 ms).

### Phase 2 — open-world kit

- [ ] `templates/open-world/` builds, typechecks, lints; only mannequin + grid materials
- [ ] One fail-closed playtest per mechanic, all green with `TN_TEMPLATE_ONLY=open-world pnpm test:templates`
- [ ] Kit contract row, kit notes `agent-docs/references/kit-open-world.md`

### Phase 3 — stealth kit

- [x] `templates/stealth/` builds, typechecks, lints; only mannequin + grid materials — evidence: typecheck, eslint, biome clean on every run of the review loop.
- [x] One fail-closed playtest per mechanic, all green with `TN_TEMPLATE_ONLY=stealth pnpm test:templates` — evidence: 9 of 9 scenarios (camera alarm, choke break-free, run/crouch noise, drag + body found once, keycard/door/extract, cone to alert, survives, takedown, wall knock) pass on headed WebGPU after review round 4. Red-green: the drag scenario failed on the dropped director events before the `director.changes` fix.
- [x] Kit contract row, kit notes `agent-docs/references/kit-stealth.md` — evidence: contract green (explore-clean, camera-sees-subject, hud-clean, no-hitch, restart-resets; 4 opt-outs with reasons). camera-sees-subject went from 20.5% blocked to 0% with the steeper camera.

### Phase 4 — integration and review

- [ ] `pnpm scaffold:pin`, `pnpm sync:agents`, `pnpm --filter create-threenative test` green
- [ ] Gemini 4 Neon High review (`agy --model gemini-4-neon-high`) of each kit: findings that hold up are fixed, verdict recorded here
- [ ] Headed WebGPU capture of each kit reviewed by a fresh judge (gameplay readable, nothing broken)
- [ ] Kit contract green for the three kits: `TN_KIT_CONTRACT_ONLY=1 TN_TEMPLATE_ONLY=survival-horror,open-world,stealth pnpm test:templates`
