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

- `corpus/tailwind-parity.mjs` loads Tailwind 4.3.3's design system and groups classes into 419
  utility units plus 88 variant units (507 total). For each unit it picks the probe class and the wrapper
  template (flex child, grid child, table cell, scroller, form control), tags it with its owner PRD,
  and writes `src/ui/tailwind-parity.scene.json`.
- `src/ui/TailwindParity.tsx` renders the scene as 1280x720 panels of labelled cells. A `panel`
  prop selects the panel. The web entry and the native entry mount the same component.
- The meter reuses `corpus/shared.mjs` (numbering, staging, SSIM, bars, `edgeMisses`) and the
  crate's `oracle` example as the subject. What is new is the subject driver — `env.json` and
  `drive.json` in the example, one step list executed by both subjects — and the per-cell
  measurement, which crops the probe's own region.
- Kits: add `@source not "./render";` to each kit `src/style.css`, so Tailwind stops reading shader
  comments. This is the root cause of the incidental starter findings.

## Acceptance Criteria

- [ ] AC-1 [local]: the scene has a non-vacuous cell for each unit, and each unit has one owner PRD.
  proof: `pnpm --filter threenative-native-css-hud parity:tailwind --check` — Evidence: 507 units
  (419 utility, 88 variant), 0 unowned, 0 duplicated, 0 uncompilable probes, scene fresh. NOT met: the
  vacuity guard is red on 291 cells (see `## Open`), and 35 variant cells name an exemption owned by
  PRD-847/848/849/851.
- [ ] AC-2 [local]: the meter prints a baseline score from the crate subject and from the host subject, and `--ratchet` fails below the committed floor.
  proof: `parity:tailwind` and `parity:tailwind --host` — Evidence: the crate subject prints
  `tailwind-parity: 136/472 (28.8 %)  [291 vacuous, 35 exempt, 507 cells]`, and
  `--floor` wrote the ratchet baseline. NOT met: `--host` exits `TN_PARITY_HOST_UNSUPPORTED` — there is
  no host subject, and a flag that silently scored the crate instead would be worse than none.
- [ ] AC-3 [local]: the starter kit builds for `ui.renderer: "native-css"` with zero findings.
  proof: `threenative build --target desktop` on a scaffolded starter with `ui.renderer: "native-css"`, then an empty
  `.threenative/build/native-css-compat.json` — Evidence: NOT run. The source-scan fix is in all 14 Tailwind
  kits and a Tailwind oxide scan shows the starter's incidental `.blur`, `.filter` and `.table` rules gone,
  but the scaffolded build itself was not executed.

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
  proof: `parity:tailwind --check` prints `507 units (419 utility, 88 variant), 0 unowned` — Evidence: measured, with a descriptor block (`@property`) contributing no properties and `root` being the class name's first
  segment (see Decisions).
- [ ] The vacuity guard fails a cell whose class changes nothing in Chromium, and every unit has a cell that changes.
  proof: `parity:tailwind --check` — Evidence: the guard works — it caught a scene with 439 vacuous cells and the
  staging fixes brought it to 291 — but it is still red; `## Open` names what is left.

#### Phase 2: Meter, ratchet and judge sheets
**Status:** PARTIAL
**Files:** `corpus/tailwind-parity.mjs` (scoring, `--host`, `--ratchet`, `--sheet`, `--family <PRD-id>`, `--group <name>`, `--env <input|all>`), `corpus/tailwind-parity.floor.json`.
**Implementation:** `--family` and `--group` filter the units by owner PRD and by the group the
generator tags; `--family PRD-845 --group mask` narrows both. A *panel* carries its own device
descriptor (`dark`, `touch`, reduced motion, viewport) and both subjects apply it — Playwright's
context options in Chromium, `env.json` in the engine. There is no `--env <input|all>` CLI switch.

- [x] The crate subject prints the score and writes `report.json` by family. The baseline goes in the batch README.
  proof: `parity:tailwind` — Evidence: `tailwind-parity: 136/472 (28.8 %)`, and `## Meter status` in the
  batch README. The score counts evidence only: exempt cells are excluded, vacuous cells fail.
- [ ] The host subject runs the same panels on the CSS-enabled desktop host and prints its own N. proof: `parity:tailwind --host` (needs `TN_ENABLE_CSS_UI=1 TN_ENABLE_UI_OVERLAY=0 pnpm native:build`)
- [x] `--sheet <PRD-id>` writes WEB|NATIVE contact sheets with burned-in labels to `~/Downloads/tailwind-parity/<PRD-id>/`.
  proof: `parity:tailwind --sheet PRD-845` — Evidence: 7 sheets, one row per unit with the class burned in at 32 px.
  The two-capture rule is a byte-equality assertion inside the same run rather than a second sheet.

#### Phase 3: Starter unblock
**Status:** PARTIAL
**Files:** `packages/create-threenative/templates/*/src/style.css` (14 kits, one line each).

- [x] Kit stylesheets exclude `src/render/` from the Tailwind source scan.
  proof: AC-3 — Evidence: `@source not "./render";` in all 14 Tailwind kits; a Tailwind oxide scan of the starter
  shows `.blur`, `.filter` and `.table` gone from its emitted sheet. The scaffolded build has not been run.

## Open

Measured with `pnpm --filter threenative-native-css-hud parity:tailwind` on the crate subject. A cell
counts only as evidence: an exempt cell is excluded from the denominator, and a vacuous cell fails.

```
tailwind-parity: 136/472 (28.8 %)  [291 vacuous, 35 exempt, 507 cells]
```

| Family | pass | vacuous |
| --- | --- | --- |
| `PRD-844/filter` | 3/19 | 11 |
| `PRD-845/blend` | 0/4 | 3 |
| `PRD-845/clip` | 1/2 | 0 |
| `PRD-845/mask` | 24/50 | 25 |
| `PRD-846/transform3d` | 0/9 | 8 |
| `PRD-847/motion` | 0/4 | 2 |
| `PRD-848/flow` | 0/15 | 0 |
| `PRD-848/grid-and-query` | 0/2 | 1 |
| `PRD-848/logical` | 10/18 | 8 |
| `PRD-848/scroll` | 1/31 | 30 |
| `PRD-849/media` | 13/16 | 1 |
| `PRD-849/pseudo` | 2/5 | 3 |
| `PRD-849/selectors` | 10/30 | 19 |
| `PRD-850/misc` | 54/182 | 117 |
| `PRD-850/paint` | 8/39 | 30 |
| `PRD-850/type` | 10/41 | 28 |
| `PRD-851/paint` | 0/5 | 5 |

- **Vacuity is the dominant gap (291 of 472 scored cells), and it is scene work, not engine work.**
  The staging already in place — a contrast default in Tailwind's `base` layer, companion utilities
  for custom-property-only units, a positioned probe, cell-scoped rules — took the count from 439 to
  291. What is left: `ring`/`shadow`/`inset-ring`/`inset-shadow` (the companion needs a width),
  `outline-*` (no outline width on the probe), colour-only `border-*` (no border width),
  `order`/`basis`/`auto-cols`/`auto-rows` (needs a second item and a reflow), `stroke`/`fill`/
  `pointer-events`/`will-change`/`contain`/`color-scheme`/`scrollbar-*` (no painted consumer), and
  `content-*` (paints only on a pseudo-element). The `mask-*` family renders an unclipped box on
  *both* subjects, so its 24 passes will move once a mask is staged the way the units need.
- **Named exemptions (35 variant cells).** Each names its owner PRD and why it cannot be staged yet:
  form states and `peer-*` (PRD-851), container queries (PRD-848),
  `prefers-contrast`/forced-colors/inverted-colors/`pointer-none` (PRD-849), `@starting-style`
  (PRD-847), and the batch's own `print`/`noscript`/`visited`/`target` decisions. They are listed in
  `tailwind-parity.scene.json` under `exemptions` and never count toward the score.
- **`--host`.** Not implemented; the flag exits non-zero rather than silently scoring the crate.
- **The motion bar.** Not built: no stepped clock at 0/25/50/75/100 %, and a panel whose sheet carries
  `animation`/`transition`/`@starting-style` skips the byte-equality double capture instead of being
  sampled at fixed times. PRD-847 owns both.
- **Refused stages (15 units).** The crate's closed `TAGS` list (`native/css-ui/src/lib.rs`)
  refuses `table`, `input`, `textarea` and `select`; and `columns-1` beside a float does not finish in
  the meter's 60 s budget. A stage that needs one gets a panel to itself, so the refusal is that
  cell's result rather than eleven innocent neighbours.

## Decisions

- 2026-11-07 (agent): **the denominator is measured, not the exploration's 490.** The stated method —
  group every class by root, emitted property set and at-rule, root being the class name up to its
  first `-` — yields 419 utility units, which with Tailwind's 88 variants is 507. The 402+88 = 490 in the batch
  README came from a scratch script that is not tracked and cannot be re-derived from that method;
  the generator is now the single source of the number and `--check` prints it, so a Tailwind upgrade
  moves the denominator and the scene together. Two choices are written down in the code because they
  move the count: a descriptor block (`@property --tw-*`) contributes no properties, and `root` is
  the first segment rather than the registered utility name (419 versus 423).
- 2026-11-07 (agent): **a contrast default, not a contrast class.** Tailwind sorts its own output by
  property and value, so `m-1` and `m-0` are emitted in an order no caller controls and a contrast
  *class* lost to its own unit half the time. The contrast is a `:where(.cN) .probe` rule emitted in
  Tailwind's `base` layer, before the utilities: a utility class's specificity, and always beaten by
  the unit's rule in `@layer utilities`. The cell furniture went into the same layer, so it no longer
  beats every `w-*` unit. The classes the contrast values came from are emitted with the panel, so a
  `var(--spacing)` contrast makes Tailwind write `--spacing`.
- 2026-11-07 (agent): **a cell is measured over the probe's own box**, not the 320×240 cell. The probe
  is about 6 % of the cell, and a dropped 40-level colour change still scores SSIM 0.987 over the
  whole cell — the bar cannot see it. The region is the probe's box plus 20 px for what escapes it
  (a ring, an outline, a shadow), clamped inside the cell; the glyph bar comes from the probe's
  subtree rather than the cell's label, so the 0.99 bar applies where nothing draws glyphs.
- 2026-11-07 (agent): **the score counts evidence only.** An exempt cell is left out of the
  denominator; a cell whose unit class changes nothing is a scene defect and fails. The first honest
  measurement of that rule is 136/472, not the 427/507 that counting every pixel match
  would have reported.
- 2026-11-07 (agent): **a unit that only sets custom properties is staged with the utility that reads
  them** (`from-red-500` with `bg-linear-to-r`, `--tw-ring-*` with `ring`). Alone it paints nothing,
  and that is a fact about Tailwind rather than a gap in the engine.
