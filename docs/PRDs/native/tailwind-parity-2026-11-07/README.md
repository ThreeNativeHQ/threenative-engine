# Tailwind parity batch, 2026-11-07

Goal: every Tailwind CSS 4.3.3 utility and variant renders the same on `ui.renderer: "native-css"`
as in Chromium, proven by one test scene that both renderers draw from one React component.

Trigger: the PS4 lane parked the starter HUD because its Tailwind output hit rules outside the
native-css Core profile (`docs/guides/native-css-support.md`). The owner asked for all of Tailwind,
not a smaller HUD.

## What is left (exploration, 2026-11-07)

Method: Tailwind 4.3.3's own design system (`__unstable__loadDesignSystem`, `getClassList()`,
`getVariants()`) compiled every class, and the repository scanner
(`packages/create-threenative/src/native-css-compat.ts`) read the output. Scripts and raw output
are in the session scratchpad and are not tracked. The unit counts below are the batch denominator.

| Fact | Value |
| --- | --- |
| Tailwind classes / utility roots / variants | 23 286 / 169 / 88 |
| Coverage units (root x emitted property set x at-rule, see Meter) | 419 utility units + 88 variants = **507** (the 2026-11-07 exploration's 402 + 88 is not reproducible from that method; the generator in PRD-843 is now the denominator) |
| CSS properties Tailwind emits | 276 |
| Properties the oracle corpus proves (`examples/native-css-hud/corpus/`) | 56 of 276 |
| Properties neither proven nor refused by the build scanner | 200 (examples: `text-shadow`, `-webkit-line-clamp`, `list-style-type`, logical insets and borders, `scale`/`rotate`/`translate`, conic and radial `background-image`) |
| Utility classes the build scanner refuses | 6 594 (`mask-image` 6 265, `backdrop-filter` 74, `filter` 60, `columns` 26, `mix-blend-mode` 18, `background-blend-mode` 16, tables 10, `perspective` 6, floats 4, keyframes 4, scroll snap 8, sticky, subgrid, `clip-path` 2, 3D transform 2) |
| Kits whose real Tailwind build has findings | 14 of 14 (1 to 12 each) |

Engine facts behind the gaps:

- **Every filter is dropped today.** blitz-paint maps `filter` and `backdrop-filter` into anyrender,
  but `native/css-ui/Cargo.toml` builds `anyrender_vello_cpu` without its `filters` feature. With
  the feature on, vello_cpu still takes one filter node only (Tailwind always emits a 9-function
  chain), has blur, drop-shadow, offset and flood but no colour-matrix filters, disables filters under
  `multithreading`, and ignores the backdrop filter argument (`_backdrop_filter`).
- **Blend modes have no mapping** in blitz-paint (`mix-blend-mode`, `background-blend-mode`).
- **Masks and clip-path exist upstream but are unproven.** `render/mask.rs` is alpha-only
  (`mask-mode: luminance` falls back), `render/clip_path.rs` has no radius on `inset()`.
- **3D transforms**: vello is a 2D affine rasterizer. `perspective`, `preserve-3d` and
  `backface-visibility` need a projective path.
- **Keyframes**: Stylo's `DocumentAnimationSet` already runs `@keyframes`. The build refuses them
  only because no fixture proves them.
- **Layout**: blitz-dom has `layout/table.rs`, float handling and multicolumn code. It has no
  `position: sticky` and no `-webkit-line-clamp`. Subgrid, container queries and `:has()` are unproven.
- **Media**: Stylo's servo build has no `prefers-reduced-motion` feature, so `motion-safe:` and
  `motion-reduce:` are wrong today. `prefers-contrast`, `forced-colors`, `inverted-colors`, `print`,
  orientation and `pointer` are unproven.
- **Form controls**: the engine has no text input, IME or `<select>`. About 20 units style form
  controls only.
- **The starter failure is partly incidental.** Tailwind's source scan reads `src/render/*.ts`
  comments ("blur", "filter") and `style.css` ("table"), and emits real `.blur`, `.filter` and
  `.table` rules. This scan found 3 starter findings. The PS4 session reported 9; the cause of the
  difference is unverified.

## Meter status (measured 2026-11-07, crate subject)

```
tailwind-parity: 176/503 (35.0 %)  [253 do not discriminate, 31 exempt, 4 permanently inactive, 15 refused]
```

A cell is evidence only when it discriminates (see Meter, item 3). The 313
non-discriminating cells are the scene's own staging gaps; the 31 pending exemptions are unproven
units their owner PRD removes; the 15 refused stages are the engine's closed `TAGS` list and a
multicolumn panel it does not finish. The `117` of an earlier draft, and the `480` an unconditional
"cells whose pixels match" comparison reported, both overstate or understate what is proven:
`176/503` is what this meter can defend.

## PRDs

Every one of the 507 units has exactly one owner PRD. The generator in PRD-843 tags each unit, and
`--check` fails when a unit has no owner.

| PRD | Owns | Priority |
| --- | --- | --- |
| [PRD-843](PRD-843-tailwind-parity-scene-and-meter.md) | The scene, the meter, the judge sheets, the ratchet, the starter source-scan fix | P1 |
| [PRD-844](PRD-844-native-css-filters-and-backdrop-filter.md) | `filter`, `backdrop-filter` | P1 |
| [PRD-845](PRD-845-native-css-blend-masks-and-clip.md) | blend modes, `mask-*`, `clip-path`, isolation | P1 |
| [PRD-846](PRD-846-native-css-3d-transforms.md) | `perspective`, `transform-style`, `backface-visibility`, x/y/z rotate, z translate and scale | P2 |
| [PRD-847](PRD-847-native-css-keyframes-and-motion-media.md) | `animate-*`, `@keyframes`, `starting:`, `motion-safe:`/`motion-reduce:`, `transition-behavior` | P1 |
| [PRD-848](PRD-848-native-css-layout-families.md) | tables, floats, columns and breaks, sticky, subgrid, line clamp, container queries, scroll snap and scroll box, logical properties | P1 |
| [PRD-849](PRD-849-native-css-selectors-pseudo-elements-and-media.md) | structural, relational and state variants, pseudo-elements, media and `supports-*` variants | P2 |
| [PRD-850](PRD-850-native-css-paint-and-typography-families.md) | the 200 unproven paint and typography properties, inline SVG `fill`/`stroke`, cursor, scrollbars | P2 |
| [PRD-851](PRD-851-native-css-form-controls-and-text-input.md) | form controls, text input and every form variant | P2 |
| [PRD-852](PRD-852-tailwind-parity-reaches-503.md) | 503 of 503, the denylist deleted, all 14 kits build clean, the CI ratchet | P1 |

Order: PRD-843 first. PRD-844 to PRD-851 are independent and can run in parallel. PRD-852 closes.

## Meter (the objective measure)

One command: `pnpm --filter threenative-native-css-hud parity:tailwind`
(`examples/native-css-hud/corpus/tailwind-parity.mjs`, built in PRD-843).

1. **Denominator from Tailwind, not from us.** The generator loads Tailwind's design system and
   groups every class into units by root, emitted CSS property set and at-rule. It adds one unit per
   variant. 4.3.3 gives 507. A Tailwind upgrade that adds a utility adds a unit, and `--check` fails
   until the scene has a cell for it.
2. **One scene, one component.** `src/ui/TailwindParity.tsx` renders the generated
   `tailwind-parity.scene.json` as panels of cells. react-dom mounts it in pinned Chromium.
   `createCssUiRoot()` mounts the same component on native.
3. **Discrimination guard.** In Chromium, each cell renders with and without its unit class. A cell
   proves something only when dropping the class takes its measured region below its own SSIM bar
   *or* moves an element's box by more than 1 px. A cell that does neither cannot tell a correct
   engine from one that dropped the declaration, so it fails rather than counting as coverage.
   A **pending** exemption (a device input or control its owner PRD has not landed yet) stays in the
   denominator and counts as a failure; the four the batch's decisions make permanently inactive —
   `print:`, `noscript:`, `visited:`, `target:` — leave it, because the renderers must agree the rule
   never fires and no measurement of them can distinguish anything.
4. **Pass bars per unit** (the existing corpus bars, not relaxed):
   - geometry: each element's border box is within 1 CSS px on each edge;
   - pixels: cell luminance SSIM is at least 0.99, or 0.98 when the cell draws glyphs;
   - motion: the same two bars at 0, 25, 50, 75 and 100 % of the duration, on a stepped clock;
   - state: the existing interaction scripts (`corpus/interactions.mjs`) drive hover, focus, active
     and touch before the capture.
5. **Two native subjects.** The default run uses the crate's headless `oracle` example (the same
   engine, CPU raster, every unit). `--host` runs the same panels on the real desktop host
   (`corpus/desktop.mjs` path). A family box ticks only when both subjects pass.
6. **Output**: `tailwind-parity: N/503 (P %)`, plus `report.json` with each failing unit by family,
   element and edge. `--ratchet` fails when the score falls below `corpus/tailwind-parity.floor.json`
   or when a unit that passed before fails. Each PRD raises the floor in the commit that turns its
   units green.

## Visual judge (required, owner rule 2026-10-09 and this batch's request)

A pixel bar is not a verdict. Every family box also needs a fresh, read-only visual judge.

- `parity:tailwind --sheet <PRD-id>` writes contact sheets: WEB on the left, NATIVE on the right,
  one row per cell, the unit class and the labels burned in large. It writes two capture runs per
  side, to `~/Downloads/tailwind-parity/<PRD-id>/`.
- Set the criteria before judging: same geometry, same colour, same effect presence and strength,
  same text and line breaks, and the same frame at each motion sample.
- The judge is a fresh subagent (model opus, effort high) that did not write the change. It returns
  SAME or DIFFERENT per cell and overall.
- A family box ticks only when the meter passes every unit of the family **and** the judge returns
  SAME for every cell. When the meter passes but the judge says DIFFERENT, the bar missed a real
  difference: fix the engine or tighten the bar, then judge again.
- Record the verdict on the box. Post the sheets on the PR (orphan `<prd>-screenshots` branch).

## Scope limits

- Platforms: the meter runs on Linux (crate and desktop host). PS4 (PRD-784), Android and iOS
  consume the same crate. Each platform's own native-css bring-up is outside this batch.
- Version: Tailwind 4.3.3, the workspace `catalog:` version. An upgrade re-runs `--check`.
