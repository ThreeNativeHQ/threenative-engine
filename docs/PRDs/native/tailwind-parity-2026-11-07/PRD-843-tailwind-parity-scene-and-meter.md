# PRD-843 — One Tailwind scene renders on web and native, and a meter scores the match

**Status:** NOT STARTED
**Priority:** P1 — every other PRD in the batch measures against this scene and meter, and the starter HUD stays parked on PS4 until AC-3 lands.
**Complexity:** 7 (HIGH) — 4 implementation files (+1), new module (+2), Rust crate plus TS build boundary (+2), interaction state (+2).
**Owner:** ThreeNative maintainers
**Depends on:** None (builds on the done [native-css PRD](../../done/PRD-native-overlay-utility-styling.md))
**Batch:** [Tailwind parity, 2026-11-07](README.md)

## Context

The native-css oracle corpus (`examples/native-css-hud/corpus/`) proves 32 hand-written fixtures
against Chromium. It covers 56 of the 276 properties Tailwind emits. "Supported" therefore means
"a fixture proves it", and nothing measures all of Tailwind. The batch README has the gap
inventory and the meter and judge contract.

## Solution

- `corpus/tailwind-parity.mjs` loads Tailwind 4.3.3's design system and groups classes into 490
  units. For each unit it picks the probe class and the wrapper template (flex child, grid child,
  table cell, scroller, form control). It tags the unit with its owner PRD and writes
  `src/ui/tailwind-parity.scene.json`.
- `src/ui/TailwindParity.tsx` renders the scene as 1280x720 panels of labelled cells. A `panel`
  prop selects the panel. The web entry and the native entry mount the same component.
- The meter reuses `corpus/shared.mjs` (numbering, staging, SSIM, bars), `corpus/oracle.mjs`
  (crate subject) and `corpus/desktop.mjs` (host subject). No new comparison code.
- Kits: add `@source not "./render";` to each kit `src/style.css`, so Tailwind stops reading shader
  comments. This is the root cause of the incidental starter findings.

## Acceptance Criteria

- [ ] AC-1 [local]: the scene has a non-vacuous cell for each of the 490 units, and each unit has one owner PRD. proof: `pnpm --filter threenative-native-css-hud parity:tailwind --check` — Evidence: pending.
- [ ] AC-2 [local]: the meter prints a baseline score from the crate subject and from the host subject, and `--ratchet` fails below the committed floor. proof: `parity:tailwind` and `parity:tailwind --host` — Evidence: pending.
- [ ] AC-3 [local]: the starter kit builds for `ui.renderer: "native-css"` with zero findings. proof: `threenative build --target desktop` on a scaffolded starter with `ui.renderer: "native-css"`, then an empty `.threenative/build/native-css-compat.json` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Tailwind parity score | `pnpm --filter threenative-native-css-hud parity:tailwind` → `corpus/tailwind-parity.mjs` → `oracle.mjs`/`desktop.mjs` subjects | New. The 32 corpus fixtures stay; the scene adds Tailwind coverage | AC-1, AC-2 |
| Kit Tailwind source scan | `threenative build` → Vite `@tailwindcss/vite` → kit `src/style.css` `@source` | Stops scanning `src/render/` | AC-3 |

## Execution Phases

#### Phase 1: Scene generator and component
**Status:** NOT STARTED
**Files:** `examples/native-css-hud/corpus/tailwind-parity.mjs` (generator plus `--check`), `src/ui/TailwindParity.tsx`, `src/ui/tailwind-parity.scene.json` (generated, committed), `package.json` (`parity:tailwind` script).

- [ ] The generator reports 490 units from Tailwind 4.3.3, each with an owner PRD. proof: `parity:tailwind --check` prints `490 units, 0 unowned`
- [ ] The vacuity guard fails a cell whose class changes nothing in Chromium. Seed one vacuous cell, see the red, remove it. proof: `parity:tailwind --check`

#### Phase 2: Meter, ratchet and judge sheets
**Status:** NOT STARTED
**Files:** `corpus/tailwind-parity.mjs` (scoring, `--host`, `--ratchet`, `--sheet`, `--family <PRD-id>`, `--group <name>`, `--env <input|all>`), `corpus/tailwind-parity.floor.json`.
**Implementation:** `--family` and `--group` filter the units by owner PRD and by the group the generator tags. `--env` sets one emulated environment input (reduced motion, contrast, forced colours, orientation, pointer) on both sides: CDP media emulation in Chromium, and the `css-ui` device descriptor on native.

- [ ] The crate subject prints `tailwind-parity: N/490` and writes `report.json` by family. The baseline N goes in the batch README. proof: `parity:tailwind`
- [ ] The host subject runs the same panels on the CSS-enabled desktop host and prints its own N. proof: `parity:tailwind --host` (needs `TN_ENABLE_CSS_UI=1 TN_ENABLE_UI_OVERLAY=0 pnpm native:build`)
- [ ] `--sheet <PRD-id>` writes WEB|NATIVE contact sheets with burned-in labels, two runs per side, to `~/Downloads/tailwind-parity/<PRD-id>/`. proof: `parity:tailwind --sheet PRD-850`, then open the sheet

#### Phase 3: Starter unblock
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/style.css` (14 kits, one line each).

- [ ] Kit stylesheets exclude `src/render/` from the Tailwind source scan, and the starter build has zero findings. proof: AC-3
