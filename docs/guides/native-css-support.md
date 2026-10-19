# native-css: the supported CSS profile

`ui.renderer: "native-css"` paints your `src/ui/` with an in-process Rust CSS engine (Stylo +
Taffy + Parley, CPU raster), with no WebView and no Chromium. It is opt-in, experimental, and
**Linux desktop only** so far. This page is the public support matrix: every row names the fixtures
that prove it against pinned headless Chromium, and every restriction is stated.

How a row is proven: `node corpus/oracle.mjs` (run from `examples/native-css-hud`) renders each fixture
in Chromium and in the engine from one element tree and one stylesheet, then requires **every
element's border box within 1 CSS px on each edge** and **luminance SSIM ≥ 0.99** (≥ 0.98 for a
fixture that draws glyphs; a fixture marked strict keeps 0.99). `node corpus/interaction.mjs` replays
input scripts in both and requires identical focus order, click lists, scroll offsets and pixels
(±3 per channel). Chromium is pinned to `--font-render-hinting=none`, because it otherwise rounds
every glyph advance to a whole pixel and the engine does not.

## Core profile

| Area | Proven | Fixtures |
| --- | --- | --- |
| Elements | `div`, `section`, `aside`, `header`, `footer`, `main`, `nav`, `article`, `h1`–`h6`, `p`, `span`, `button`, `img`, `ul`/`ol`/`li`, `a`, inline emphasis tags, text and mixed inline runs | `ua-defaults`, `inline-runs`, `images-object-fit` |
| Selectors and cascade | type, class, id, attribute, descendant/child/sibling combinators; `:is`, `:where`, `:not`, `:first-child`, `:last-child`, `:nth-child`; `@layer`; `!important`; custom properties incl. `calc()` and cyclic references; inline styles | `cascade-order-and-importance`, `selectors-structural`, `variables-and-inheritance` |
| Box layout | block and inline flow, box-sizing, per-edge margin/padding/border, auto/min/max/percentage/`fit-content`/`min-content`/`max-content` sizing, `aspect-ratio`, negative and auto margins, static/relative/absolute/fixed positioning, `z-index` stacking, `rem`/`vw`/`vh`/`clamp()`/`min()`/`max()` | `box-model-and-sizing`, `positioning`, `units-rem-vw-vh-calc`, `intrinsic-sizing-and-margins` |
| Flexbox | row/column, wrap, gap, basis/grow/shrink, order, auto margins, alignment, intrinsic interactions | `flex-shrink-wrap-align`, `intrinsic-sizing-and-margins` |
| Grid | explicit and repeated tracks, `fr`, `minmax()`, `auto-fill`, spans, row/column gaps, auto-placement | `grid-tracks-and-placement`, `breakpoints-wide`, `breakpoints-narrow` |
| Paint | solid and `oklch()`/alpha colours, per-edge borders, per-corner radii, outlines with `outline-offset`, layered `box-shadow`, linear gradients, subtree opacity, overflow and radius clipping, raster images with `object-fit`/`object-position` | `paint-radius-border-shadow`, `paint-gradient-opacity-alpha`, `images-object-fit` |
| Typography | bundled fonts (`@font-face` from the UI build), weights, wrapping, `line-height` fixed and `normal`, letter-spacing, alignment, `white-space`, single-line `text-overflow: ellipsis`, Portuguese text, mixed Latin/Arabic direction | `text-wrap-weights-spacing`, `text-ellipsis`, `text-overflow-fits`, `text-line-height-normal`, `text-mixed-direction`, `dpr-2-layout-and-paint` |
| State and environment | `:hover`, `:focus-visible`, `:disabled`, `aria-*`/`data-*` selectors, group/peer variants through normal selectors, `min-width` breakpoints, dark mode, reduced motion (below), `(hover: hover)` per input device | `state-selectors-and-environment`, `button-centring`, `group-and-peer-variants`, `touch-hover-and-environment` |
| Motion | transitions of colour, opacity and 2D transforms with delay, duration, linear/ease timing and interruption/reversal | `transitions-timing-and-interruption`, `transform-transition` |
| Interaction | button activation by pointer, Tab/Shift+Tab traversal (no wrap), Enter/Space, visible focus, wheel scrolling of nested scrollers, clipping- and radius-aware hit tests, transformed hit tests, `pointer-events: none`, touch with no sticky hover | `focus-traversal-and-activation`, `nested-scroll`, `clipped-hit-test`, `transform-hit-test-and-pointer-events`, `touch-hover-and-environment` |

## Restrictions you will hit

- **Stylesheet loading.** Native packaging preserves the Vite UI entry's static stylesheet order in
  `ui/stylesheets.json`, keeping emitted CSS and maps unchanged. CSS emitted only for a lazy chunk
  is refused with `TN_CSS_UI_LAZY_STYLESHEET_UNSUPPORTED`; import those styles statically from
  `src/ui/main.tsx`. A hand-staged directory without an order manifest loads CSS alphabetically.
- **Reduced motion is a rule, not a media query.** Stylo's servo build has no `prefers-reduced-motion`
  feature, so `@media (prefers-reduced-motion: reduce)` never matches. When reduced motion is
  requested the engine instead forces `transition-duration: 0s`; any other thing you hang on that media
  query will not happen.
- **Fonts.** Only fonts your UI build ships (and whatever the machine resolves for names it does not)
  are used; there is no network. A missing `url()` file fails the build and a missing font file fails
  attach by name, rather than falling back silently.
- **Text anti-aliasing differs from Chromium's** (FreeType vs vello_cpu); boxes and line breaks are
  identical, glyph edges are not. That is why the whole-frame bar for a glyph fixture is 0.98.
- **DPR** is proven in the engine (`dpr-2-layout-and-paint`); the desktop host currently attaches at 1.0.
- `text-overflow: ellipsis` is single-line only (`nowrap` + clipping `overflow`); no string values.
- A `<button>` whose content is a block box stays top-aligned.
- An inline box's own horizontal margin is applied twice by upstream blitz-dom (a `<span style="margin-left:20px">`
  lands at the wrong x). Not fixed; avoid it or use padding.
- Touch is one pointer kind per UI, not per event. No text input, IME, `<select>`, dialogs or links.
- Wheel has no desktop playtest injector; it is proven in the engine and the contract test.

## Outside the profile: the build fails

`threenative build` rejects an **active** rule that uses a feature in the table below, listing every
finding as `file:line:column` in the emitted stylesheet, followed by `authored <file:line:column>` in your source when the build's verified CSS map places it (without a map the emitted position stands alone)
and writing `.threenative/build/native-css-compat.json` (empty when clean):

| Feature | Why |
| --- | --- |
| `filter`, `backdrop-filter`, `mask*`, `mix-blend-mode`, `background-blend-mode`, `clip-path`, `shape-outside` | not in the Core paint/layout profile |
| `float` other than `none`, `columns`/`column-*`, `display: table*`, `position: sticky`, `writing-mode` other than `horizontal-tb`, `subgrid`, `masonry` | not in the Core layout profile |
| `animation`/`animation-name`/`@keyframes` | keyframes are not Core (transitions are) |
| `perspective`, `transform-style: preserve-3d`, 3D transform functions | not in the Core paint profile |
| `scroll-snap-*`, `@container`, `:has()`, `@page`, `@namespace`, `@counter-style` | not in the Core profile |

`@supports` is **not trusted**: the engine answers it by parse-ability, not by what it paints, so a
listed feature fails the build even inside an `@supports` branch. A property absent from the table is
not thereby supported, only not known to be unsupported; the fixtures above are the support claim.
Custom properties, comments and strings are ignored by the scan. Real Tailwind v4 output of the
acceptance fixture produces no findings.

## Licences

The engine is Rust crates linked statically only when the host is built with `TN_ENABLE_CSS_UI=1`.
`docs/verification/native-css-license-inventory.md` lists all of them with their declared licences.
Stylo and its parsers are MPL-2.0 (file-level copyleft): a distributed CSS-enabled binary must make the
source of those files available and keep their notices. Five upstream crates are vendored with patches
under `packages/runtime-native/native/css-ui/vendor/` (`PATCHES.md`: each hunk, why, and the fixture that
proves it).
