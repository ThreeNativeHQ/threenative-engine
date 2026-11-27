---
prd_contract: v1
---

# PRD-922 — Five more classic-mechanics starter kits: platform fighter, rail shooter, rhythm, farming, flight

**Status:** PARTIAL — 2026-11-26. Shipped in #749: `farming`, `rail-shooter`, `board-party`, the `starter-kit-development` skill and the per-kit authoring-layer test.
**Blocker:** owner, 2026-11-26: "push whatever is done to the repo" (token budget). The other seven kits are pushed as `kit/<name>` branches, not merged: platform-fighter (30/30 before Gemini fixes, rerun pending), tomb-explorer (16/16, camera row fixed, rerun pending), rhythm (registered, final sweep unconfirmed), flight (13/16 on FlightModel), rpg (camera fix not run), military-shooter (reruns pending), car-combat (no full run).
**Priority:** P1 — owner request, 2026-11-26
**Complexity:** 9 (HIGH) — five new kits in `packages/create-threenative/templates/`, contract rows, pins
**Owner:** João
**Depends on:** PRD-921 (PR #748, the classic-kit pattern and the wall-clock `no-hitch` row). This branch stacks on it.

## Context

The owner, 2026-11-26: "add other starter kits, pick more threenative reverse engineer mechanics for popular
games" and "at least 5 more starter kits please".

The reverse-engineering MCP indexes 56 games. Genres it covers that no kit answers yet: platform fighting (Super
Smash Bros.), on-rails space combat (Star Fox 64), rhythm (PaRappa the Rapper 2), farming life sim (Harvest Moon
64) and flight (Pilotwings 64).

Asset rule, as PRD-921: `assets/mannequin-combat.glb` for every humanoid and the procedural metre-grid materials
for every surface. Ships, gliders, crops and props are procedural geometry on those materials. No other texture,
model or sound file. Mechanics borrow algorithms and defaults from the pinned reference cards
(`engine_search_references`, `engine_reference_detail`), never code, names, levels or art.

## Kits

| Kit | Reference games | Core mechanics |
| --- | --- | --- |
| `platform-fighter` | Super Smash Bros. | damage percent, knockback that scales with percent and weight, hitstun, jump and double jump, fast fall, ledge grab, shield and dodge, ring-out stocks, one CPU opponent |
| `rail-shooter` | Star Fox 64 | ship on a rail path with a reticle-steered offset, boost and brake, barrel roll that deflects shots, charged lock-on shot, enemy waves on splines, shield gauge, hit count, a boss |
| `rhythm` | PaRappa the Rapper 2 | call and response lines on a beat clock, timing windows (cool, good, bad, miss), a rating meter that moves a level up or down per line, a performer that animates on the beat |
| `farming` | Harvest Moon 64 | day clock and sleep, till, plant, water, crops that grow only when watered, stamina, a shipping bin paid out overnight, tool switching, a calendar of seasons |
| `flight` | Pilotwings 64; flight model from Midway (engine `FlightModel`, owner 2026-11-26) | glider with lift, drag and stall, thermals that climb, rings to pass, a landing pad scored on distance and impact, a time and score card |

### Wave 2 (owner /goal 2026-11-26: run the starter-kit-development skill in a loop over the common genres)

Same rules, same PR (#749). Each pick is a common genre that no kit answers and that a reference card covers.

| Kit | Reference cards | Core mechanics |
| --- | --- | --- |
| `military-shooter` | Call of Duty 4 (`call-of-duty-4-modern-warfare-kisakcod`), Halo CE (`halo-combat-evolved-opence`) | stance (stand, crouch, prone) speeds, sprint as a time budget, aim-down-sights spread, recoil, regenerating shield over health, grenades with a fuse, cover that blocks fire |
| `board-party` | Mario Party (`mario-party-1`) | board spaces in a chain with junctions, dice roll and space-by-space move, landed-space coin effects, turn rotation over four players (three CPU), a star bought at a moving space, a minigame round after each turn |
| `rpg` | KOTOR (`star-wars-knights-of-the-old-republic-reone`), Morrowind (`the-elder-scrolls-iii-morrowind-openmw`) | combat rounds with an action queue, d20 attack roll against defense with critical threat, a party leader and followers, a conversation tree with a skill check, stats and skills that rise with use, a quest log |
| `tomb-explorer` | Tomb Raider I-II (`tomb-raider-i-ii`) | run with a turn ramp, standing and running jumps on a block grid, mid-air ledge grab, hang, shimmy and climb, swimming with an air meter, fall damage, a pickup in reach, a trap |
| `car-combat` | Carmageddon (`carmageddon`) | tyre grip on a friction ellipse, engine torque and gearbox, per-panel damage and repair, impact damage dealt to rival cars, checkpoints with a time bonus, a win by wrecking all rivals or by laps |

### Loop stop rule

- **Done:** wave 2 lands in #749 under the same gates, and each genre in the waves has a kit.
- **Next wave:** genres the MCP index does not cover yet (one-on-one fighting, sports, roguelike, survival
  crafting, metroidvania, turn-based tactics) need a reference card first (add it to the reverse-engineering MCP,
  release it). That is a separate decision for the owner.
- **Stop early:** a lane that fails the same gate twice for the same cause stops, and its genre moves to the report.

## Phases

### Phase 1 — Kits (one lane per kit)

- [ ] `platform-fighter`: builds, typechecks, lints; one fail-closed playtest per mechanic; kit contract green.
- [x] `rail-shooter`: builds, typechecks, lints; one fail-closed playtest per mechanic; kit contract green.
- [ ] `rhythm`: builds, typechecks, lints; one fail-closed playtest per mechanic; kit contract green.
- [x] `farming`: builds, typechecks, lints; one fail-closed playtest per mechanic; kit contract green.
- [ ] `flight`: builds, typechecks, lints; one fail-closed playtest per mechanic; kit contract green.
- [ ] `military-shooter`: builds, typechecks, lints; one fail-closed playtest per mechanic; kit contract green.
- [x] `board-party`: builds, typechecks, lints; one fail-closed playtest per mechanic; kit contract green.
- [ ] `rpg`: builds, typechecks, lints; one fail-closed playtest per mechanic; kit contract green.
- [ ] `tomb-explorer`: builds, typechecks, lints; one fail-closed playtest per mechanic; kit contract green.
- [ ] `car-combat`: builds, typechecks, lints; one fail-closed playtest per mechanic; kit contract green.

### Phase 2 — Registration and review

- [ ] `conventions.json`, `capabilities.json`, `build.spec` count, `pnpm scaffold:pin`, `pnpm sync:agents`, word budgets; `pnpm --filter create-threenative test` green.
- [ ] Headed WebGPU capture of each kit reviewed by a fresh judge (gameplay readable, nothing broken).

## Acceptance criteria

- [ ] Ten new kits (two waves), each on the minimal assets only: each scaffolded project's `assets/` holds only `mannequin-combat.glb`.
- [ ] Every mechanic is proven by a fail-closed playtest, the kit contract is green, and the performance scenario holds its budget.
- [ ] Each kit's AGENTS.md says which reference games it borrows from, and its routing words match a request that names one.
- [ ] Each kit is usable through the authoring layer: `create-threenative --genre <reference game>` scaffolds it,
  `engine_search_capabilities` with "make a game like <reference game>" returns it in `starterKits`, and the
  per-kit doctor test (`scaffold.spec.ts`, "stamps the <kit> authoring layer it wrote") passes. The same holds for
  the three PRD-921 kits (verified 2026-11-26: `gta`, `driver` → open-world; `resident-evil`, `silent-hill` →
  survival-horror; `metal-gear-solid`, `splinter-cell` → stealth; doctor test green on all 19 kits).
- [ ] Studio lists all eight classic kits: after the `create-threenative` release that ships them, Studio bumps
  the package and adds them to `hosting/cloudflare/src/kits.ts` (`KITS`, checked by `kits.spec.ts`). Until then
  Studio refuses a project on these kits ("Choose one of the starter kits").
