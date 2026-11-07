# PRD-843 — One Tailwind scene renders on web and native, and a meter scores the match

**Status:** PARTIAL
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

- `corpus/tailwind-parity.mjs` loads Tailwind 4.3.3's design system and groups classes into
  423 utility units plus 88 variant units (511 total). For each unit
  it picks the probe class and the wrapper template (flex child, grid child, table cell,
  scroller, form control), tags it with its owner PRD, and writes
  `src/ui/tailwind-parity.scene.json`.
- `src/ui/TailwindParity.tsx` renders the scene as 1280x720 panels of labelled cells. A `panel`
  prop selects the panel. The web entry and the native entry mount the same component.
- The meter reuses `corpus/shared.mjs` (numbering, staging, SSIM, bars), `corpus/oracle.mjs`
  (crate subject) and `corpus/desktop.mjs` (host subject). No new comparison code.
- Kits: add `@source not "./render";` to each kit `src/style.css`, so Tailwind stops reading shader
  comments. This is the root cause of the incidental starter findings.

## Acceptance Criteria

- [ ] AC-1 [local]: the scene has a non-vacuous cell for each unit, and each unit has one owner PRD.
  proof: `pnpm --filter threenative-native-css-hud parity:tailwind --check` — Evidence: 511 units
  (423 utility, 88 variant), 0 unowned, 0 duplicated, 0 uncompilable probes,
  scene fresh. NOT met on vacuity: the guard is red on the cells listed in `## Open`, and
  35 variant cells name an exemption owned by PRD-847/848/849/851.
- [ ] AC-2 [local]: the meter prints a baseline score from the crate subject and from the host subject, and `--ratchet` fails below the committed floor.
  proof: `parity:tailwind` and `parity:tailwind --host` — Evidence: the crate subject prints
  `tailwind-parity: 479/511 (93.7 %)`; `--ratchet` and `--sheet` are implemented. NOT met: `--host` is not
  implemented, so the host subject prints nothing yet.
- [ ] AC-3 [local]: the starter kit builds for `ui.renderer: "native-css"` with zero findings.
  proof: `threenative build --target desktop` on a scaffolded starter with `ui.renderer: "native-css"`, then an empty
  `.threenative/build/native-css-compat.json` — Evidence: NOT run. The source-scan fix (`@source not "./render";`
  in all 14 Tailwind kits) is in, but the scaffolded build was not executed in this session.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Tailwind parity score | `pnpm --filter threenative-native-css-hud parity:tailwind` → `corpus/tailwind-parity.mjs` → `oracle.mjs`/`desktop.mjs` subjects | New. The 32 corpus fixtures stay; the scene adds Tailwind coverage | AC-1, AC-2 |
| Kit Tailwind source scan | `threenative build` → Vite `@tailwindcss/vite` → kit `src/style.css` `@source` | Stops scanning `src/render/` | AC-3 |

## Execution Phases

#### Phase 1: Scene generator and component
**Status:** PARTIAL
**Files:** `examples/native-css-hud/corpus/tailwind-parity.mjs` (generator plus `--check`), `src/ui/TailwindParity.tsx`, `src/ui/tailwind-parity.scene.json` (generated, committed), `package.json` (`parity:tailwind` script).

- [x] The generator reports one unit per (root, emitted property set, at-rule) plus one per variant, each with an owner PRD.
  proof: `parity:tailwind --check` prints `511 units (423 utility, 88 variant), 0 unowned`
  Evidence: measured 511, 0 unowned, 0 duplicated, 0 uncompilable probes. The exploration's 490 is not
  reproducible from its own stated method (see Decisions).
- [ ] The vacuity guard fails a cell whose class changes nothing in Chromium, and every unit has a
  cell that changes. proof: `parity:tailwind --check` — Evidence: the guard works (it caught a scene with
  439 vacuous cells and the staging fixes brought it down), but it is still red; see `## Open`.

#### Phase 2: Meter, ratchet and judge sheets
**Status:** PARTIAL
**Files:** `corpus/tailwind-parity.mjs` (scoring, `--host`, `--ratchet`, `--sheet`, `--family <PRD-id>`, `--group <name>`, `--env <input|all>`), `corpus/tailwind-parity.floor.json`.
**Implementation:** `--family` and `--group` filter the units by owner PRD and by the group the generator tags. `--env` sets one emulated environment input (reduced motion, contrast, forced colours, orientation, pointer) on both sides: CDP media emulation in Chromium, and the `css-ui` device descriptor on native.

- [x] The crate subject prints `tailwind-parity: N/511` and writes `report.json` by family. The baseline N goes in the batch README.
  proof: `parity:tailwind` — Evidence: `tailwind-parity: 479/511 (93.7 %)`, `corpus/out-parity/report.json`
  with each failing unit by family, element and edge.
- [ ] The host subject runs the same panels on the CSS-enabled desktop host and prints its own N. proof: `parity:tailwind --host` (needs `TN_ENABLE_CSS_UI=1 TN_ENABLE_UI_OVERLAY=0 pnpm native:build`)
- [x] `--sheet <PRD-id>` writes WEB|NATIVE contact sheets with burned-in labels, two runs per side, to `~/Downloads/tailwind-parity/<PRD-id>/`.
  proof: `parity:tailwind --sheet PRD-845` — Evidence: 7 sheets at `~/Downloads/tailwind-parity/PRD-845/`,
  one row per cell with the unit class burned in at 32 px; the double capture is a byte-equality
  assertion inside the same run.

#### Phase 3: Starter unblock
**Status:** PARTIAL
**Files:** `packages/create-threenative/templates/*/src/style.css` (14 kits, one line each).

- [ ] Kit stylesheets exclude `src/render/` from the Tailwind source scan, and the starter build has zero findings. proof: AC-3

## Open

Measured with `pnpm --filter threenative-native-css-hud parity:tailwind`:

```
tailwind-parity: 479/511 (93.7 %)
PRD-844 15/19, PRD-845 55/56, PRD-846 8/9, PRD-847 5/5, PRD-848 55/70, PRD-849 66/66, PRD-850 254/265, PRD-851 21/21
```

- **Vacuity (AC-1).** The guard is red on cells whose stage cannot yet make the unit's declaration
  visible: colour-only `border-*` (no border width), `ring`/`shadow`/`inset-*` (a companion needs a
  width), `order`/`basis`/`auto-cols` (needs a second item and a reflow), `outline-*` (no outline
  width), `stroke`/`fill`/`pointer-events`/`will-change`/`contain`/`scheme`/`scrollbar-*` (no
  painted consumer on the probe), and `content-*` (paints only on a pseudo-element). Each needs a
  staging decision in this file, not an engine change.
- **Named exemptions.** 35 variant cells cannot be staged until their owner PRD
  lands the device input or the control: form states and `peer-*` (PRD-851), container queries
  (PRD-848), `prefers-contrast`/forced-colors/inverted-colors/`pointer-none` (PRD-849),
  `@starting-style` (PRD-847), and the batch's own `print`/`noscript`/`visited`/`target` decisions.
- **Refused stages.** The crate's closed `TAGS` list (`native/css-ui/src/lib.rs`) refuses `table`,
  `input`, `textarea` and `select`. A stage that needs one gets a panel to itself, so the refusal is
  that cell's reported failure instead of eleven innocent neighbours. 15 units report it today:
  six table stages (`create: unsupported tag "table"`), and nine where the engine did not finish in
  a minute (`columns-1` with a float).
- **`--host`.** Not implemented: the meter has no host subject yet, so AC-2's second half is open.
- **The failing families, measured.** PRD-848/flow 0/15 (the engine's closed `TAGS` list has no
  `table`; `columns-1` with a float does not finish in a minute), PRD-844/filter 15/19,
  PRD-845/blend 3/4, PRD-846/transform3d 8/9, PRD-850/misc 176/185, PRD-850/paint 37/39. Every
  other family is green on the crate subject — 479 of 511 units already match Chromium at 1 px per
  edge and the corpus's SSIM bars, which is the number PRD-844…851 now raise.

## Decisions

- 2026-11-07 (agent): **the denominator is measured, not the exploration's 490.** The stated method
  — group every class by root, emitted property set and at-rule, root being the class name up to its
  first `-` — yields 423 utility units, which with Tailwind's 88 variants is
  511. The 402+88 = 490 in the batch README came from a scratch script that is not
  tracked and cannot be re-derived from that method; the generator is now the single source of the
  number and `--check` prints it, so a Tailwind upgrade moves the denominator and the scene together.
- 2026-11-07 (agent): **a contrast default, not a contrast class.** Tailwind sorts its own output by
  property and value, so `m-1` and `m-0` are emitted in an order no caller controls and a contrast
  *class* lost to its own unit half the time. The contrast is therefore a `:where(.cN) .probe` rule
  emitted in Tailwind's `base` layer, before the utilities: a utility class's specificity, and always
  beaten by the unit's rule in `@layer utilities`. The cell furniture went into the same layer, so
  the probe furniture no longer beats every `w-*` unit.
- 2026-11-07 (agent): **a unit that only sets custom properties is staged with the utility that reads
  them** (`from-red-500` with `bg-linear-to-r`, `--tw-ring-*` with `ring`). Alone it paints nothing
  and that is a fact about Tailwind, not a gap in the engine.
