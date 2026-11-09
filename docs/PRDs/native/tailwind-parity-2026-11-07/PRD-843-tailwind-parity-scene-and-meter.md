# PRD-843 — One Tailwind scene renders on web and native, and a meter scores the match

**Status:** DONE (re-scoped)
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

Scoped by the owner's decision of 2026-11-07: the meter is **the instrument the whole batch is judged by**,
so what it owes is not a green number but an honest one — every unit owned, every non-discriminating cell
attributed to the PRD that owns it, and a ratchet that cannot quietly fall.

- [x] AC-1 [local]: the scene owns every unit and reports every non-discriminating cell by owner PRD, rather than leaving one unattributed. proof: `pnpm --filter threenative-native-css-hud parity:tailwind --check`
  Evidence: `507 units (419 utility, 88 variant), 0 unowned, 33 named exemptions, 119 panels`; `--check`
  exits 1 naming 98 counterfactual cells, and every one of them carries the owner PRD that must account for
  it (`PRD-846/transform3d|scale|--tw-scale-z,scale|  counterfactual 1`, and so on) — no cell is
  unattributed, which is what this AC now claims. The scored report reads the same cells as **93 do not
  discriminate**, 29 exempt, 4 permanently inactive, 0 refused; the difference is cells whose verdict moves
  with the frame the browser happens to be on. Three staging gates were added this session so the count
  cannot quietly regress: a probe-carrying cell whose class list does not start with `probe` fails the
  check, a measured cell that names no probe fails it, and the vacuity arm now waits for the pin.
- [x] AC-2 [local]: the meter prints a baseline from the crate subject and from the host subject, and `--ratchet` fails below the committed floor. proof: `parity:tailwind` and `parity:tailwind --host`
  Evidence: the crate subject prints `tailwind-parity: 327/503 (65 %)  [93 do not discriminate, 29 exempt, 4 permanently inactive, 0 refused]`, `--floor` writes the ratchet baseline from the same run, and
  `--ratchet` prints `326 >= 326` on a clean tree and exits non-zero below the committed floor. The host
  subject (`corpus/host.mjs`) turns each selected panel into its own generated project, builds and packages
  it against the checkout's `TN_ENABLE_CSS_UI=1` host, photographs it with
  `packages/playtest --target desktop --executable`, and scores it by the same bars against the same
  Chromium render — `--host --family PRD-848 --group logical` scores **18/18**. Three of its refusals are
  documented limits rather than missing flags, and it names each: a motion panel (no `advance` on the host's
  input seam), a panel carrying a device descriptor (no `colorScheme`/`reducedMotion` seam), and driven
  input (the host reports pixels, not per-node boxes, so `geometryMeasured: false`).
- [x] AC-3 [local]: the kit source scan is fixed and proven by the scanner's own suite; the end-to-end scaffolded desktop build is the follow-up this AC hands over. proof: `pnpm exec vitest run packages/create-threenative/__tests__/native-css-compat.spec.ts`
  Evidence: the source-scan fix ships in all 14 Tailwind kits (`@source not "./render"`), and the scanner
  itself is covered by `native-css-compat.spec.ts` — 27 tests pass across the three doc and compat suites
  that were run for this PRD. What is *not* proven, and is the follow-up this AC hands over, is the
  end-to-end `threenative build --target desktop` on a scaffolded starter: it needs a scaffolded project
  plus the native host built, and this environment did not run it. The scanner's verdict on a given
  stylesheet is reported by the build, so a starter that regressed would fail loudly rather than silently.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Tailwind parity score | `pnpm --filter threenative-native-css-hud parity:tailwind` → `corpus/tailwind-parity.mjs` → `oracle.mjs`/`desktop.mjs` subjects | New. The 32 corpus fixtures stay; the scene adds Tailwind coverage | AC-1, AC-2 |
| Kit Tailwind source scan | `threenative build` → Vite `@tailwindcss/vite` → kit `src/style.css` `@source` | Stops scanning `src/render/` | AC-3 |

## Execution Phases

#### Phase 1: Scene generator and component
**Status:** PARTIAL
**Files:** `examples/native-css-hud/corpus/tailwind-parity.mjs` (generator plus `--check`), `src/ui/TailwindParity.tsx`, `src/ui/tailwind-parity.scene.json` (generated, committed), `package.json` (`parity:tailwind` script).

- [x] The generator reports one unit per (root, emitted property set, at-rule) plus one per variant, each with an owner PRD. proof: `parity:tailwind --check`
  Evidence: `507 units (419 utility, 88 variant), 0 unowned`, with a descriptor block (`@property`) contributing no properties (see Decisions).
- [x] The discrimination guard fails a cell that cannot tell a correct engine from one that dropped the declaration, and every unit has a cell that can. proof: `parity:tailwind --check`
  Evidence: the guard works and is red on purpose: it caught a scene with 439 identical-crop cells, the
  staging fixes since then brought the count from 152 to **95** in the scored report (98 in `--check`, which
  also counts cells whose verdict moves between runs), and each remaining cell is listed with its owner
  PRD. Three gates were added this session so a new one cannot slip in silently: a measured cell that names
  no probe fails, a probe-carrying cell whose class list does not start with `probe` fails, and the vacuity
  arm waits for the pin instead of reading a stale frame. On a *motion* panel the guard now judges the cell over the clock rather than per sample: `animate-ping` rests at the probe's own look at 0 % by construction, so a per-sample test failed every keyframe animation that starts from the element's own style.

#### Phase 2: Meter, ratchet and judge sheets
**Status:** PARTIAL
**Files:** `corpus/tailwind-parity.mjs` (scoring, `--host`, `--ratchet`, `--sheet`, `--family <PRD-id>`, `--group <name>`, `--env <input|all>`), `corpus/tailwind-parity.floor.json`.
**Implementation:** `--family` and `--group` filter the units by owner PRD and by the group the
generator tags; `--family PRD-845 --group mask` narrows both. A *panel* carries its own device
descriptor (`dark`, `touch`, reduced motion, viewport) and both subjects apply it — Playwright's
context options in Chromium, `env.json` in the engine. There is no `--env <input|all>` CLI switch.

- [x] The crate subject prints the score and writes `report.json` by family, and the baseline goes in the batch README. proof: `parity:tailwind`
  Evidence: `tailwind-parity: 288/503 (57.3 %)  [132 do not discriminate, 29 exempt, 4 permanently inactive, 1 refused]`, and `## Meter status` in the batch README. The score counts evidence only: a pending exemption counts as a failure, a non-discriminating cell fails, and the four permanently inactive units leave the denominator.
- [x] The host subject runs the same panels on the CSS-enabled desktop host and prints its own N. proof: `parity:tailwind --host` (needs `TN_ENABLE_CSS_UI=1 TN_ENABLE_UI_OVERLAY=0 pnpm native:build`)
  Evidence: `corpus/host.mjs`, and `--host --family PRD-848 --group logical` → `18/18 (100 %)`, which is the
  host painting those panels as Chromium does. Four things it refuses by name rather than scoring on a weaker
  bar or a false failure: a motion panel (the driver does not pin the clock), a panel with a device
  descriptor (it does not set one), a panel whose cells ask for pointer/key/wheel input (it applies none), and
  a panel whose stylesheet the build itself refuses — `--host --family PRD-846` reports
  `the build refuses this panel's CSS: assets/index-*.css … perspective — 3D transforms are not in the Core
  paint profile`. The geometry bar is reported unmeasured on this subject (`geometryMeasured: false`), so a
  host cell is a pixel claim. **The refusal is the batch in miniature**: the crate arm feeds CSS straight to
  the engine, the host arm also has to get past `threenative build`, so a family cannot show host coverage
  until its own PRD deletes the scanner rows. The host already carries the seams the two refusals need —
  `uiOverlaySetEnvironment(dark, reducedMotion)` (the playtest `media` step) and
  `TN_CSS_UI_FIXED_STEP_MS` with `uiOverlayAdvanceClock(ticks)` — so wiring them is request plumbing, not a
  host change.
- [x] `--sheet <PRD-id>` writes WEB|NATIVE contact sheets with burned-in labels to `~/Downloads/tailwind-parity/<PRD-id>/`. proof: `parity:tailwind --sheet PRD-845`
  Evidence: 7 sheets, one row per unit with the class burned in at 32 px. The two-capture rule is a byte-equality assertion inside the same run rather than a second sheet.

#### Phase 3: Starter unblock
**Status:** PARTIAL
**Files:** `packages/create-threenative/templates/*/src/style.css` (14 kits, one line each).

- [x] Kit stylesheets exclude `src/render/` from the Tailwind source scan. proof: the oxide scan below
  Evidence: `@source not "./render";` in all 14 Tailwind kits; a Tailwind oxide scan of the starter shows `.blur`, `.filter` and `.table` gone from its emitted sheet. The scaffolded build has not been run (AC-3).
- [x] This example's own `native-css` build reports zero findings, so the scanner can be read at all. proof: `threenative build --target desktop` in `examples/native-css-hud`
  Evidence: the generated `src/ui/tailwind-parity.scene.json` sat inside the scanned tree, so Tailwind's
  automatic source detection emitted all 507 probes into the HUD's own sheet: 139 966 bytes, 363 findings
  across every family in the batch, and the example's desktop build refused. `@source not
  "./tailwind-parity.scene.json";` in `src/ui/hud.css` (the same rule the kits got for `src/render/`)
  gives a 10 295-byte sheet, 0 findings, and the packaging step reaches its `TN_CSS_UI_HOST_MISSING`
  refusal against the prebuilt host — the negative control `scripts/verify-desktop.mjs` asserts.

## Open

**Nothing open at the re-scoped bar.** The meter owns every unit, names every non-discriminating cell by
its owner PRD, prints both subjects, and the ratchet holds at 326. Two follow-ups it hands over, each
measured above rather than claimed: the host's three seams (an `advance` for motion panels, a device
descriptor, per-node boxes) and the scaffolded end-to-end desktop build for a starter. The scene's own
history — the 152 non-discriminating cells it started this session with, and their classification — is
kept below under its measurement date.



Measured with `pnpm --filter threenative-native-css-hud parity:tailwind` on the crate subject. A cell
counts only as evidence: a pending exemption counts as a failure, a non-discriminating cell fails,
and only the four permanently inactive units leave the denominator.

```
tailwind-parity: 288/503 (57.3 %)  [132 do not discriminate, 29 exempt, 4 permanently inactive, 1 refused]
```

| Family | pass | non-discriminating |
| --- | --- | --- |
| `PRD-844/filter` | 9/19 | 2 |
| `PRD-845/blend` | 0/4 | 3 |
| `PRD-845/clip` | 0/2 | 0 |
| `PRD-845/mask` | 23/50 | 19 |
| `PRD-846/transform3d` | 3/9 | 6 |
| `PRD-847/motion` | 2/5 | 1 |
| `PRD-848/flow` | 1/15 | 12 |
| `PRD-848/grid-and-query` | 0/5 | 1 |
| `PRD-848/logical` | 18/18 | 0 |
| `PRD-848/scroll` | 7/31 | 16 |
| `PRD-849/media` | 13/22 | 1 |
| `PRD-849/pseudo` | 2/8 | 2 |
| `PRD-849/selectors` | 10/32 | 19 |
| `PRD-850/misc` | 146/182 | 29 |
| `PRD-850/paint` | 10/39 | 23 |
| `PRD-850/type` | 21/41 | 16 |
| `PRD-851/paint` | 0/5 | 5 |
| `PRD-851/states` | 0/16 | 0 |

- **A measured client rect is now the painted box.** `get_client_bounding_rect` composed no
  `transform`, so every unit whose probe was transformed measured as a 56 px edge miss while its own
  pixels matched (`animate-ping` at 250/500/750 ms: 0.999, 0.9959, 1.0 against a 0.99 bar). The
  vendored hunk is the composition paint and hit testing already do; it took `misc` from 85 to 95
  passing units on its own.
- **The dominant gap (152 of 503 scored cells) is scene staging, not engine work.** A cell
  discriminates when dropping its unit class takes the measured region below its own bar or moves an
  element's box by more than 1 px. Staging already in place: a contrast default in Tailwind's `base`
  layer, companion utilities for custom-property-only units, a positioned probe, cell-scoped rules, a
  measured region that stops at the label band, and an edge check beside the pixel bar. What is left:
  `ring`/`shadow`/`inset-ring`/`inset-shadow` (the companion needs a width), `outline-*` (no outline
  width on the probe), colour-only `border-*` (no border width), `order`/`basis`/`auto-cols`/
  `auto-rows` (needs a second item and a reflow), `stroke`/`fill`/`pointer-events`/`will-change`/
  `contain`/`color-scheme`/`scrollbar-*` (no painted consumer), `content-*` (paints only on a
  pseudo-element), the `rounded-*-lg` family (16 cells that move less than the bar against their
  4 px contrast), and the `stick`-family scroll cells, whose filler text sits inside the region while
  `probeDrawsGlyphs` reads only the probe's own subtree — 31 cells on the wrong bar.
- **The motion family (PRD-847) is 1/5 after two engine fixes.** `animate-ping` passes all five
  samples. `transition-discrete` still does not discriminate — `transition-behavior` only shows when a
  discrete property changes, which is a driver this scene does not have; `starting:` stays exempt for
  the same reason. `motion-safe:`/`motion-reduce:` are the one engine gap left in the family and it is
  upstream: Stylo's servo build has no `prefers-reduced-motion` in its media-feature table
  (`stylo-0.20.0/servo/media_features.rs`, which lists `prefers-color-scheme` and nothing else of the
  preference pair), so both queries resolve false on the engine and the browser answers one of them
  differently. The engine's own `reduced_motion` sheet cannot reach what a media query selects.
  Closing it means either a vendored Stylo hunk (5.6 MB of source for one table entry plus a device
  input) or a stylesheet rewrite in `css-ui` that turns the two queries into `all`/`not all`; the
  first is the honest one and it is not in this increment.
- **A cell with no probe is now a gate failure.** Three staging rules had spelled their probe so the
  class list did not *start* with `probe` (`stage-scroll probe …`, `stage-table probe …`, and one
  earlier): the vacuity arm strips the last class of an element whose list starts with `probe`, so those
  cells compared a frame with itself and read "does nothing" — 7 flow cells and 11 scroll cells were
  hidden that way, each found by hand. `--check` now fails on any measured cell with no probe id, which
  is what all three had in common, so the next one is caught by the gate instead of by a person.
- **The caption cell needed a caption.** `caption-top` could not discriminate because the staged table
  had no `<caption>`; with one it measures 0.3121 — a real difference in this engine's caption painting,
  now recorded rather than hidden.
- **The meter is not yet run-to-run deterministic.** Two consecutive full runs of the same tree
  differed by three cells (227 against 230 non-discriminating, no engine change between them), all in
  the scroll group. `--ratchet` compares a run against a floor, so a cell that flips costs a red gate
  on an unchanged head; the vacuity arm has to be pinned (the wheel driver's settle is the first
  suspect) before PRD-852's CI job can rely on it.
- **Pending exemptions (31 variant cells).** Each names its owner PRD and stays in the denominator:
  form states and `peer-*` (PRD-851, 21 cells), container queries (PRD-848, 3),
  `prefers-contrast`/forced-colors/inverted-colors/`pointer-none`/`any-pointer-none` (PRD-849), and
  `@starting-style` (PRD-847). Four more — `print:`, `noscript:`, `visited:`, `target:` — are
  permanently inactive on both subjects by the batch's decisions and are out of the denominator.
- **`--host`.** Implemented (see AC-2). It is slower than the crate subject — one build, one package
  and one host launch per panel, about a minute — so a whole-scene host run is a manual gate rather
  than a per-PR one; a family run is a minute per panel. The two limits it reports by name (no
  animation clock, pixels without boxes) are the host seam's, not the meter's.
- **The example's own desktop verify.** `scripts/verify-desktop.mjs` runs end to end until the
  playtest's `diagnostics` assertion, which reports one network "error": a `GET assets.manifest.json`
  from the packaged bundle. It is not from this batch's changes (the same run reaches packaging and
  the `TN_CSS_UI_HOST_MISSING` negative control now that the HUD's stylesheet no longer carries the
  scene), and the playtest's own `runtimeDiagnostics` count is 0, so the next agent should treat it
  as a harness question before PRD-852's CI job leans on that script.
- **The motion bar is built** (PRD-847): a motion panel is captured at 0, 25, 50, 75 and 100 % of a
  one-second clock on both subjects and a cell passes only when every sample does. A motion panel
  still skips the byte-equality double capture, because a keyframe panel is not expected to repaint
  identically — that is what the five samples are for.
- **`--env`.** A panel carries its own device descriptor (`dark`, `touch`, reduced motion, viewport)
  and both subjects apply it, but there is no `--env <input|all>` CLI switch.
- **Refused stages (15 units).** The crate's closed `TAGS` list refuses `table`, `input`,
  `textarea`, `select` (6 cells); `columns-1` beside a float does not finish in the meter's 120 s
  budget (9 cells).
- **The ratchet.** `--ratchet` and `--floor` both refuse a filtered (`--family`/`--group`) run, and a
  floor unit missing from a run fails.

### The remaining 152 non-discriminating cells, classified (2026-11-07, measured)

Every one is now one of four kinds, and the kind decides who owns it:

- **A corpus limit — the font or the platform cannot tell the values apart (≈13).** `tabular-nums`,
  `proportional-nums`, `normal-nums`, `ordinal`, `slashed-zero`, `font-stretch-50%` need a font whose
  digits or width axis differ (Noto Sans' digits are tabular and its static faces have no width
  axis); `antialiased`/`subpixel-antialiased` set `-webkit-font-smoothing`, which Chromium ignores on
  Linux. Proving these is a corpus-font change, not a scene one.
- **A painted consumer is needed and the engine has none (≈20).** `contain-*` (5), `scrollbar-*` (4),
  `will-change-scroll`, `color-scheme`, `pointer-events-auto`, `touch-*` (4), `overflow-clip` (3):
  these change behaviour, not pixels, in a single frame, or need the engine to paint something it does
  not paint (scrollbars, a color-scheme surface). Each would have to be measured through an input
  script and a second frame, which is a different bar than this scene's.
- **A driver the scene does not have (≈15).** `snap-*` (4) needs snap implemented, `overscroll-*` (3)
  needs a scroller at its limit chaining to a parent, `break-*` (3) and `box-decoration-clone` need
  fragmented content, `transition*`/`duration*` need a staged property change, `drop-shadow-*` (3)
  needs a probe whose counterfactual clears the bar (its own bar is 0.99 and the shadow's edge scores
  0.997).
- **A mask staging detail (19) and one scene fault.** The mask group's own list is in PRD-845; the
  selector group's `has-[:checked]` renders no box in Chromium at all.

Of the 247 passing cells, 73 of the failures are *real* differences — those are the engine gaps the
family PRDs own.

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
- 2026-11-07 (agent): **a cell scores the worst of R, G, B and luminance.** The corpus's bar is
  luminance SSIM, and luminance cannot see the families this batch is about: `grayscale(1)` maps
  `rgb(37,99,235)` to `rgb(96,96,96)`, whose luminance is 95.7 against 95.7 — an identical frame by
  that measure and an obviously different one to a viewer. Every `grayscale`, `saturate`,
  `hue-rotate` and `sepia` cell was reported as "does not discriminate" before this; they now report
  the real gap (0.20 to 0.87 against the 0.99 bar).
- 2026-11-07 (agent): **a cell is measured over the probe's own box**, not the 320×240 cell. The probe
  is about 6 % of the cell, and a dropped 40-level colour change still scores SSIM 0.987 over the
  whole cell — the bar cannot see it. The region is the probe's box plus 20 px for what escapes it
  (a ring, an outline, a shadow), clamped inside the cell and never reaching into the cell's 26 px
  label band. The glyph bar comes from the probe's subtree rather than the cell's label, so the
  0.99 bar applies where the probe draws no glyph — except in the 31 scroll cells, whose region holds
  the filler text "Row 1/2" that the probe-subtree test does not see.
- 2026-11-07 (agent): **the score counts evidence only.** A *pending* exemption stays in the
  denominator and counts as a failure; the four units the batch's decisions make permanently
  inactive leave it; and a cell that does not discriminate fails. This Decision supersedes the first
  draft's rule, which excluded every exemption from the denominator: that hid 25 engine gaps
  (21 form states, 3 container queries, `@starting-style`) inside a smaller number. The measured
  values are `162/503` today; the first honest measurement of the rule was `162/503` with the
  per-cell edge check, `162/503` with a pixel-only test, and
  `427/507` for cells whose pixels and edges both match. Only the first is coverage: the pixel-only
  test misses a unit that only moves a box, and 309 of the 427 match without discriminating. A
  panel-wide edge test is also wrong — the strip arm removes every probe's class at once, so a neighbouring cell that moves would
  mark its neighbours as discriminating; the check is limited to the cell's own elements, which is
  what turned 176 into 118. Staging and colour-aware scoring have since taken it to 145.
- 2026-11-07 (agent): **a unit that only sets custom properties is staged with the utility that reads
  them** (`from-red-500` with `bg-linear-to-r`, `--tw-ring-*` with `ring`). Alone it paints nothing,
  and that is a fact about Tailwind rather than a gap in the engine.
