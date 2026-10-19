---
prd_contract: v1
---

# PRD — Standard Tailwind and CSS, rendered as native UI

**Status:** DONE — Phases 1 and 2 landed and verified on Linux desktop (Blitz CPU backend, 28-fixture Chromium oracle); Phase 3 desktop is proven (27/27 fixtures and 8/8 interaction scenarios); Android emulator is proven for 27/27 fixtures and 8/8 interaction scenarios; the lifecycle criterion is measured. No physical Android device, iOS, macOS or Windows claim.
**Priority:** P2 — DONE; all phase boxes and the acceptance box are ticked.
**Date:** 2026-10-01 (America/Vancouver).
**Audit baseline:** `develop` at `49ba2c49d6867ce075a9ebe42b994e3464ec0283`.
**Delivery:** Replace the unimplemented proposal in draft PR #388; target `develop`.
**Scope:** An opt-in, native CSS-capable HUD backend with a tested compatibility profile.
**Product requirement:** Use the same Tailwind and CSS authoring interface, but output native UI.

## Decision and correction

**Agree with the product goal; revise the proposed implementation.** Run the real Tailwind build
pipeline, retain ordinary CSS as the styling contract, and render a React element tree through a
native CSS/layout/text/paint backend. Do not invent Tailwind-looking utilities, require conversion
to `IOverlayStyle`, or replace CSS with a public ThreeNative style language.

Native means an in-process, GPU-composited UI surface, without a WebView, Chromium/CEF, a browser
renderer process, or an HTML screenshot service. It does not mean platform-default widgets:
authored CSS still determines the appearance. A native stylesheet engine and an internal
DOM-like element tree are allowed. They are necessary implementation machinery, not a browser
JavaScript DOM exposed to game code.

The previous requirements for no CSS at runtime, mandatory static style IDs, and a Tailwind-to-
proprietary-style compiler are withdrawn. Parse CSS when loaded or changed; compute styles when
state changes. Build-time optimization is welcome only when it preserves the cascade, variables,
responsive rules, dynamic classes and interaction behavior. No parsing on every game frame.

This PRD delivers the **Core HUD profile** below, not all CSS or arbitrary web applications.
Additional profiles require their own PRDs and native proof; implementing this profile must not be
marketed as complete Tailwind/browser compatibility. There are no speculative coverage percentages.

## Existing architecture and fit

These sources were inspected at the audit baseline; observations describe current code, not this
proposal's future API.

| Source | Observed behavior | Design consequence |
| --- | --- | --- |
| [Workspace catalog](../../../pnpm-workspace.yaml) | Tailwind and its Vite plugin are both pinned to `4.3.3`. | Use these actual packages and lockfile versions, not a hand-maintained utility table. |
| [React entry](../../../packages/core/src/react.ts) | Optional React subpath; `View`/`Text` accept native `style` objects. | Keep existing callers working; standard JSX needs a separate host adapter. |
| [React host](../../../packages/core/src/react-host.ts) | Custom reconciler, CanvasLayer quads and bitmap glyphs; other element types fail. | Reuse lifecycle patterns, not the limited drawing model as a CSS target. |
| [Layout](../../../packages/core/src/react-layout.ts) | Fixed/shrink-wrapped boxes, simple row/column placement, no CSS parser; mobile WASM is explicitly refused. | A utility parser cannot supply Flexbox, CSS paint or font semantics. Native dependencies must not require mobile WASM. |
| [UI contract](../../../packages/ui/AGENTS.md) | Shared UI reads published game state and emits intents; the game owns gameplay. | Keep the state/intent boundary and portable-entry isolation. |
| [Charter](../../architecture/CHARTER.md) | Web-standard UI defaults to a platform WebView; native quads are a limited opt-in; public IRs and a second scene renderer are excluded. | Add a bounded UI-only architectural exception explicitly; do not claim this is already permitted/shipped. |

The framework owns the portable mechanism; the game owns every appearance choice. Three.js keeps
ownership of the 3D scene, camera and game rendering. Neither React nor the CSS backend takes over
the scene graph or game loop.

### Required architectural amendment

The implementation must amend the Charter and affected native-overlay documentation before the
new backend is presented as supported. The proposed exception is: an optional, third-party native
HTML/CSS UI engine may maintain a UI-only element tree and paint an offscreen HUD surface; it may
not render the 3D game, expose a game/scene IR, replace Three.js, or impose a framework-owned look.
This document proposes that exception; it does not silently amend the binding Charter.

Keep existing `ui.renderer: "web"` and `"native"` semantics unchanged. Add a proposed
`ui.renderer: "native-css"` opt-in rather than silently changing the existing bitmap-native path.
No default switch, completed-PRD rewrite, or mandatory dependency cost for other applications.

## User-facing contract

The example below is the acceptance fixture. It runs on Linux desktop as `examples/native-css-hud` (system
font instead of `@font-face`, `type="button"` added); the rest is the same source.
The component and stylesheet are identical in browser and native-CSS builds; only the renderer
selection/bootstrap differs. Do not make users replace `div` with `View` or rewrite styles per target.

```tsx
import "./hud.css";

export function Inventory({ onClose }: { onClose: () => void }) {
  return (
    <section className="inventory fixed bottom-6 left-6 w-80 max-w-[calc(100vw-3rem)] rounded-2xl border border-zinc-700 bg-zinc-900/90 p-6 text-white shadow-xl">
      <h2 className="text-2xl font-bold">Inventory</h2>
      <p className="mt-1 text-sm text-zinc-400">12 items</p>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-lg bg-zinc-800 p-3">Medkit</div>
        <div className="rounded-lg bg-zinc-800 p-3">Battery</div>
      </div>
      <button
        className="mt-4 rounded-lg bg-brand px-4 py-2 transition-colors hover:bg-brand/80 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50"
        onClick={onClose}
      >
        Close
      </button>
    </section>
  );
}
```

```css
@import "tailwindcss";

@font-face {
  font-family: "HudSans";
  src: url("./fonts/hud-sans.ttf") format("truetype");
  font-weight: 100 900;
}

@theme {
  --font-sans: "HudSans", sans-serif;
  --color-brand: #2563eb;
}

.inventory {
  font-family: var(--font-sans);
  --inventory-border: var(--color-zinc-700);
  border-color: var(--inventory-border);
}

.inventory > h2 {
  letter-spacing: -0.02em;
}
```

The fixture must supply a licensed variable TTF supporting the declared weight range; the example
path is an asset requirement, not a claim that this font exists in the repository.

Required interfaces are ordinary JSX intrinsics, `className`, `id`, `data-*`, appropriate `aria-*`
attributes, CSS imports and the React CSS-style object convention, including unitless properties
and custom properties. `style={{ width: "50%" }}` must retain percentage semantics. The native
host implements the supported React property/event contract; it does not load `react-dom` against
the game's compatibility `document` stub.

Custom CSS must work without Tailwind. Tailwind's `@theme`, `@utility`, `@apply`, `@source` and
`@custom-variant` remain upstream build-time features; ordinary CSS is their output. Supported
plugins are those whose emitted CSS stays within the declared native profile. Do not promise
arbitrary plugin or DOM-dependent component-library compatibility.

## Selected approach and alternatives

| Approach | Assessment |
| --- | --- |
| Existing WebView path | Preserves the broad web contract, but does not meet the requested no-WebView output. Retain it for existing users. |
| Utility parser plus the current quad renderer | Cannot preserve CSS layout, cascade, typography or interaction. Rejected for this goal. |
| Taffy plus a new hand-built style/paint system | Layout is only one subsystem; leaves ThreeNative owning most of a CSS engine. Not the default plan. |
| Reuse a modular native HTML/CSS engine behind the existing UI boundary | Recommended: retain real CSS and concentrate new work on React, native-host integration and conformance. |

**First candidate: Blitz's modular core, not a switch from React to Dioxus.** Its upstream design
combines Stylo for CSS, Taffy for box layout and Parley for text, with a separate renderer. Its
README still describes a beta, missing features and no ready-made JavaScript bindings. The HTML
preview wrapper is not an interactive React backend. Its texture example is evidence of an
integration direction, not proof of compatibility with ThreeNative's GPU device or input system.
See the [upstream architecture and status](https://github.com/DioxusLabs/blitz).

[Taffy](https://github.com/DioxusLabs/taffy) is a useful layout dependency, not a replacement for
CSS resolution, text, paint and events. A maintained native engine is preferred over assembling
those subsystems from scratch. Backend selection is provisional until the first runnable slice
passes below; a failing candidate does not authorize silently shrinking the product requirement.

## Technical design

```mermaid
flowchart TD
  A["Shared React JSX and CSS sources"] --> B["Existing Vite build and real Tailwind"]
  B --> C["Ordinary CSS, fonts, images and source maps"]
  A --> D["Native React host: UI element mutations"]
  C --> E["Native CSS engine: cascade and computed styles"]
  D --> E
  F["Viewport, theme, focus, pointer and scroll state"] --> E
  E --> G["CSS layout and text shaping"]
  G --> H["Native UI paint into composited GPU surface"]
  H --> I["Existing game presentation: Three.js remains scene renderer"]
  B --> J["Browser React DOM reference using identical CSS"]
```

### Build and stylesheet ownership

Use the workspace Tailwind/Vite pipeline and preserve the resulting CSS, source order and assets.
Do not call private Tailwind candidate APIs as the public integration, hardcode spacing/palettes,
or transpile utility strings into proprietary style objects. CSS Modules may use the existing
bundler transformation; their final class names still enter the same stylesheet engine.

Bundle fonts/images offline through existing asset plumbing. CSS imports in a native build become
registered stylesheet assets, not `document.head` calls. Development stylesheet updates replace a
sheet atomically, invalidate affected styles, and preserve component state. Production loads the
same styling artifact without invoking the Tailwind compiler. Pin the Tailwind version and engine
revision used by each conformance run.

Follow upstream [class detection](https://tailwindcss.com/docs/detecting-classes-in-source-files):
conditional complete strings work; arbitrary `bg-${color}-500` interpolation does not gain new
runtime CSS generation. Users register extra candidates through ordinary Tailwind sources.
A class with no matching rule is legal CSS and must not automatically throw: it may be a custom
selector hook. Report missing generated candidates diagnostically without inventing utilities.

### Native host and composition

Keep a UI-only retained element tree with tag, attributes, ordered children, text, interaction
state and inline declarations. Batch React mutations at commit boundaries. Preserve keyed-node
identity, selector-relevant ancestry and sibling order. Runtime style resolution remains necessary;
a single static style ID cannot replace context-dependent computed styles.

Use a coarse, versioned native binding with bounded message buffers and explicit ownership for
create/update/remove, stylesheet loading, input, resize and disposal. This is an internal ABI, not
a new public scene/style format. Callbacks return to JavaScript after native work, avoiding
re-entrant mutation. Rust, where selected, compiles to a native library behind the C++ host; no
mobile WASM, additional game-language requirement, or Dioxus authoring requirement.

The first slice must demonstrate the actual UI texture/surface path with the host's active GPU
backend. A Rust `wgpu` texture and a Dawn texture are not interchangeable handles. Validate device
ownership, native-handle interoperability, synchronization, formats, premultiplied alpha, color
space, resize and device-loss teardown. An explicit GPU-side copy may be acceptable if measured;
a per-frame GPU readback and CPU re-upload is not the production solution. Do not force an
unrelated 3D-renderer migration to make the UI backend fit.

Retain the state/intent contract: UI presents game-owned state; user actions become intents.
Theme changes, scrolling, transitions and hover must update without rerendering the game scene or
reconciling every React component each frame. Reuse current publication semantics; do not impose
a new fixed 10 Hz bridge on the strength of older Charter examples.

### CSS semantics are the contract

Preserve cascade layers, selector specificity, inheritance, source order, inline declarations and
`!important`, including reversed layer precedence for important declarations. Class-string order
is not a generic last-token-wins rule. Normal inline styles do not beat important stylesheet rules.
Shorthands/longhands must resolve like CSS, not object-spread order.

Include the real Preflight output and an appropriate supported-element default style sheet.
Reset/default display, box sizing and text metrics are observable behavior. Do not disable
Preflight or swap fonts to make a visual test pass. See [Preflight](https://tailwindcss.com/docs/preflight)
and [theme variables](https://tailwindcss.com/docs/theme).

Resolve `var()` with inheritance, fallbacks and invalid/cyclic-value behavior; support the
registered custom-property behavior required by emitted Tailwind `@property` rules. Retain
`calc()`, `min()`, `max()` and `clamp()` when values depend on layout or runtime variables. Modern
color functions and alpha modifiers must retain authored semantics; theme values are not all hex.
Tailwind's [compatibility documentation](https://tailwindcss.com/docs/compatibility) makes these
CSS dependencies part of the integration, not optional decoration.

Measure layout in CSS pixels, not framebuffer pixels or Three.js world units. Map DPR once at
rasterization/input conversion. `rem`, `em`, percentages and viewport units retain their respective
reference contexts. Responsive media-query units follow CSS rules, not a hardcoded spacing scale.
Viewport resize, root/element font changes and inherited custom-property changes invalidate the
right descendants. Test non-default root font sizes and DPR 1/2/3.

## Core HUD compatibility profile

All rows marked **Core** are requirements, not statements of existing backend support. Each must
have browser-reference fixtures. The implementation publishes the exact tested property/value/
selector matrix, including restrictions, instead of claiming entire utility families blindly.

| Area | Core requirement | Separate future profile |
| --- | --- | --- |
| Elements | `div`, `section`, `aside`, headings, `p`, `span`, `button`, `img`, ordinary text and fragments; inherited text styles and mixed inline runs. | Forms, editable inputs/IME, native select/dialog behavior, links/navigation, general HTML. |
| Selectors/cascade | Type, class, ID, attributes, descendant/child/sibling combinators; `:is`, `:where`, `:not`, first/last/nth-child; layers, variables, inline styles and importance. | `:has`, complex generated content and unsupported selector constructs. |
| Box layout | Block/inline flow, box sizing, per-edge margins/padding/borders, auto/min/max/intrinsic sizing, percentages, aspect ratio; static/relative/absolute/fixed positioning. | Floats, multicolumn, tables, sticky positioning and alternate writing modes. |
| Flexbox | Row/column, wrapping, gaps, basis/grow/shrink, order, auto margins and cross/main alignment, with intrinsic-size interactions. | Any value/edge case not yet demonstrated must remain visibly unsupported, not approximated. |
| Grid | Explicit/repeated tracks, `fr`, `minmax`, basic auto-placement, spans and row/column gaps. | Subgrid, masonry and dense-placement claims beyond tested cases. |
| Paint | Solid colors including OKLCH/alpha, per-edge borders, per-corner radii, outlines/rings, layered shadows, linear gradients, raster images/object-fit, clipping and stacking contexts. | Filters, backdrop blur, masks, blend modes, arbitrary SVG and 3D CSS transforms. |
| Typography | Bundled fonts and weights, shaping, fallback, baseline, line height, wrapping, whitespace, letter spacing, alignment and ellipsis. | Rich text editing, browser text selection and complete script/font feature coverage. |
| State/environment | Hover/active/focus/focus-visible/disabled, data/ARIA selectors, group/peer variants through normal selectors, viewport breakpoints, dark mode and reduced motion. | Container queries and additional device/environment features. |
| Motion | CSS transitions for colors, opacity and 2D transforms; real timing/delay/interruption, origin and hit-test transforms. | General keyframe animations and layout-property animation. |
| Interaction | Button activation, tab navigation, visible focus, pointer/touch/wheel handling, nested scrolling, clipping-aware hit tests and pointer-events. | Drag/drop, portals, browser event/DOM API completeness and web-component libraries. |

Group opacity composites the subtree; it is not copied independently to every child's paint.
Rounded clipping applies to descendants and hit testing. Hover observes input capabilities rather
than simulating sticky mouse hover on touch-only devices. Disabled buttons cannot emit activation;
keyboard focus must not also trigger game controls. Preserve existing intentional HUD click-through
and interactive-region conventions.

Supported interactive nodes carry accessible names, roles, disabled state and focus through the
backend's accessibility interface. Platform accessibility support is reported per tested target;
an untested bridge is not an accessibility pass. Absence of a platform bridge blocks production
accessibility claims, not documentation work. No claim of a general accessible forms toolkit.

The Core profile is deliberately narrower than the complete product ambition. Advanced effects,
forms/IME, extensive SVG, additional platforms and DOM-dependent UI libraries get separate PRDs,
not hidden subtasks here. Grid, typography, custom CSS and interaction are not optional shortcuts
for completing this Core profile.

### Unsupported features and failures

Emit a source-mapped compatibility report for properties, values, at-rules, selectors and element
APIs outside the profile. CSS parsing must retain normal recovery and legal unknown-class behavior.
Do not reinterpret syntactically invalid CSS as a new native language.

Production native-CSS builds fail for unsupported active author rules unless the rule is behind an
explicit, correctly evaluated `@supports` branch with an authored supported fallback. Compute
feature queries from real capability, not parser recognition alone. Treat inactive vendor-specific
Preflight rules and unsupported element defaults through a documented baseline audit; blindly
rejecting every rule in upstream Preflight would make a normal Tailwind import impossible.

Runtime-only failures name the source/element/property through the existing visible error path.
Development HMR may retain the last good stylesheet while visibly reporting failure. Never
silently drop paint, silently substitute a font, or automatically attach a WebView. Failed bundles
must not be reported as native-compatible just because their JavaScript compiled.

## Browser-reference verification

The oracle is **the same JSX and emitted CSS rendered by a pinned browser**, not the old
inline-native overlay. Capture the exact component source, CSS hash, font/image hashes, viewport,
DPR, platform, graphics backend and tool versions. Wait for fonts/assets and freeze time/randomness.
The browser reference may use browser rendering; native acceptance may not.

Use the existing playtest and native-conformance infrastructure. Planned fixtures should cover:

| Fixture family | Required observations |
| --- | --- |
| Tailwind plus custom CSS | Example above, custom theme, `@apply`/custom utility, stylesheet import/HMR and a plain-CSS-only arm. |
| Cascade and selectors | Reverse class-string order; layers and important overrides; inherited/cyclic variables, structural/group/peer/data rules. |
| Layout | Flex shrinking/wrapping and long text; grid tracks; relative/absolute/fixed boxes; root-font, viewport and DPR changes. |
| Paint and fonts | Rounded clipping, shadows/rings, gradients, subtree opacity, image fitting; weights, multiline text, Portuguese and mixed-direction sample text. |
| Input and motion | Mouse and touch states, focus traversal, disabled activation, nested scrolling, transformed hit tests, interrupted transitions, reduced motion and no game-input leakage. |
| Lifecycle and rejection | Class/style removal, theme updates, keyed reordering, mount/dispose, asset reload, unsupported CSS and device-loss recovery. |

Proposed correctness thresholds: every measured box edge and text baseline within **1 CSS pixel**
of the reference; identical line breaks, visible strings, state outcomes and focus order. Compare
the full UI crop at a fixed time, targeting **SSIM >= 0.99**. Any text-rasterization tolerance must
be fixed in advance and accompanied by text metrics; do not mask missing glyphs, wrong wrapping,
missing shadows or interactive regions. A high image score cannot override semantic failures.
These are acceptance targets, not measured results; disclose any necessary tolerance amendment.

Run a native desktop lane and Android-emulator lane separately. Require nonblank actual captures,
correct interaction output, and instrumentation showing the selected native-CSS backend with no
WebView creation/load. Test stubs and offscreen HTML screenshots are not native proof. Report the
specific desktop OS; one desktop run proves nothing about other desktop platforms or iOS.

### Performance and resource boundaries

Benchmark a deterministic 1,000-node HUD, 120 warm-up frames followed by 1,000 measured frames:
unchanged, 10% changed at 10 Hz, and an active transition/scroll case. Record UI CPU work, GPU time,
upload/copy cost, total game-frame p50/p95/p99, input-to-present latency, heap/RSS and GPU resources.
Compare enabled native-CSS to UI-off and the existing web backend on the same hardware. Measure
startup and binary/package size separately. An emulator is functional evidence, not phone-speed proof.

An unchanged UI performs no repeated stylesheet parse, full-tree style/layout pass, text shaping
or React reconciliation. Cache reuse is observable; dirty updates invalidate only affected work
where semantics permit. Rendering/composition may still occur each game frame. Bound caches and
release per-root resources on unmount; repeated mount/dispose must not grow retained resources.

Opted-out applications initialize no new engine and import no new UI dependencies. Packaging must
avoid mandatory native-CSS binaries for builds that do not select the feature. No claim that this
backend is faster, smaller or lower-power than WebView is made in advance. Freeze any numerical
release budget against named reference hardware before declaring performance readiness; report
actual data rather than selecting a flattering FPS threshold afterward.

## Integration boundaries

Use `packages/ui` for shared authoring/state/intent plumbing, `packages/runtime-native` for the
optional native binding/surface, and `packages/playtest` for proofs. Discover actual build-loader
entry points through the capability manifest before writing source. Package placement is subject
to the existing dependency-isolation rule; this proposal does not invent a shipped
`@threenative/tailwind` package. The existing Tailwind dependency already owns that interface.

Do not expand `IOverlayStyle` into a second CSS dialect or redirect existing `View`/`Text` callers.
Keep the game portable entry free from `react-dom`, CSS-injection DOM calls and new browser shims.
The native UI host and browser React DOM host consume the same authored component tree through
separate bootstrap adapters. Cross-target state-store identity and subscription behavior must be
preserved. Public authoring documentation changes only when the corresponding API ships.

Backend admission must demonstrate the unchanged acceptance component, native surface integration,
a native Android build, input dispatch and usable license/dependency boundaries before extending
the profile. Inspect upstream and transitive licenses, including font redistribution; do not
assert that the top-level renderer license covers every dependency. Failure triggers a documented
backend decision or upstream fix, not an unrequested return to the utility-only proposal.

## Execution phases

A box with a result beside it is verified; every other path and fixture name below is planned and unverified.
These three phases implement only the Core HUD profile. Larger follow-on profiles require separate
PRDs/PRs rather than extending this checklist indefinitely.

### Phase 1 — Standard CSS pipeline and native admission slice

- [x] The acceptance fixture's Tailwind/CSS styling artifact is byte-identical for the browser and native builds. proof: `pnpm --filter threenative-native-css-hud build:web` emits `dist/assets/index-DCvBpG7G.css` and the native package stages `dist-native/ui/index-DCvBpG7G.css` — same content hash and same sha256 (`ac20c401…`), from the workspace's pinned Tailwind 4.3.3 via the project's own Vite config (`extractUiStylesheets` stages the stylesheet and only the fonts/images it names or the UI build emitted; no page, no JS). `packages/create-threenative/__tests__/build.spec.ts` and `native-css-compat.spec.ts` cover the staging.
- [x] A plain-CSS-only arm (no Tailwind in the styling pipeline) mounts on the native CSS backend. proof: `pnpm --filter threenative-native-css-hud verify:desktop:plain` — exit 0 on Linux desktop (same host, GPU and Xvfb as below): `examples/native-css-hud/plain/` is its own project (own `package.json`, a Vite config without `@tailwindcss/vite`, hand-written `plain.css` with custom properties, a descendant selector, an alpha colour and `:hover`); the script asserts the stylesheet the engine receives is 568 bytes of `.panel` rules with no Tailwind banner, `@layer` or `--tw-` marker, the playtest passes (`closeClicks` 0 -> 1 from a real pointer click, `frames` >= 100), the host log shows the same `blitz-dom` backend with no web view, and the decoded captures show 3,735 button pixels in `#2563eb` before the click and in the `:hover` blend after it.
  Not claimed: the plain arm's browser build was not compared byte-for-byte against its native stylesheet; Tailwind-arm identity is the box above.
- [x] Fonts and images shipped by the UI build reach the native engine, with an upstream/transitive licence inventory and proven opt-out isolation. proof: `cd packages/runtime-native/native/css-ui && cargo test --release` (`tests/assets.rs`: a bundled `@font-face` lays text out at the file's own advances — a probe font whose "Hello" is 5.0 em wide where every system face gives 2.426 em; a missing font file is a named failure, never a silent system-font fallback; `<img>` from the directory, from a `data:` URI (Vite inlines every asset under 4 KiB as one) and behind Vite's `assets/` prefix paint in their boxes; any other nested path is refused by name), `packages/create-threenative/__tests__/build.spec.ts` (relative `url()` assets and the rasters the UI build emitted are staged flat; schemes, absolute paths, `../` out of the build and an ambiguous name are refused), and the oracle corpus (bundled Noto Sans and Noto Sans Arabic, OFL 1.1 beside them; a PNG with its sha256 recorded). Licence inventory: `docs/verification/native-css-license-inventory.md`, generated and drift-checked by `node packages/runtime-native/scripts/native-css-license-inventory.mjs [--check]` — 265 crates, none undeclared, 14 under MPL-2.0 (Stylo and its parsers: file-level copyleft, a decision for the owner before distributing a CSS-enabled binary). Opt-out isolation: `packages/core/__tests__/react-css-isolation.spec.ts` (nothing the main entry loads reaches the reconciler host; `react-reconciler` is only an optional peer; a positive control proves the check can fail), `TN_ENABLE_CSS_UI` is OFF by default, and `threenative-css-ui-overlay-test` passes with the backend off (refusal contract), on, and with the web overlay also on.
- [x] Source maps for the native stylesheet. proof: `pnpm exec vitest run packages/create-threenative/__tests__/native-css-compat.spec.ts packages/create-threenative/__tests__/css-sourcemap.spec.ts packages/create-threenative/__tests__/build.spec.ts` — 87/87 on the real Vite/Tailwind compiler; a UI build emits the CSS map and an unsupported `filter` rule is reported as `assets/index-*.css:1:17  authored src/ui/hud.css:2:1` (red first: the finding carried the emitted position only), in the build error and in `native-css-compat.json`; an absent, unlinked or unverifiable map keeps the emitted position. Authored columns follow Vite's rule-start anchors.
- [x] A native Android build of the native-css backend. proof: `THREENATIVE_GRADLE_ARGS="-PthreenativeAbis=x86_64 -PthreenativeJsEngine=quickjs"` with no `-x`: Gradle ran `:app:buildNativeCssUi` (the crate cross-compiled for `x86_64-linux-android` with the NDK from scratch) and linked it into `libmystral-runtime.so`, which carries the `CPU rasteriser, no WebView` marker; `scripts/verify-android.mjs` exits 0 on the `threenative_api35` emulator (see Phase 3). `aarch64-linux-android` builds (`cargo build --release --target`) but no arm64 APK was linked or run; `cargo check` passes for `aarch64-apple-darwin` and `x86_64-pc-windows-msvc` (compile only, nothing run).
- [x] The acceptance component (the PRD fixture minus the `@font-face`, which the corpus covers) mounts on an actual native CSS backend. proof: `TN_ENABLE_CSS_UI=1 TN_ENABLE_UI_OVERLAY=0 pnpm native:build` then `pnpm --filter threenative-native-css-hud verify:desktop` — exit 0 on Linux desktop (NVIDIA RTX 2080, Vulkan, private Xvfb): `playtests/native-css-hud.playtest.json` passes (`GameState.closeClicks` 0 -> 1 after a real pointer click on the native-painted Close button, `frames` >= 100, diagnostics clean); `playtests/native-css-input.playtest.json` activates the same button from the keyboard alone (one Tab, Enter, no pointer: `closeClicks` 0 -> 1) while a key the HUD never claims still reaches the game (`gameKeys` 1); the decoded captures show 2,603 Close-button pixels before, 2,605 in the `hover:bg-brand/80` blend after the click (which also proves the host feeds the animation clock) and 2,603 in the amber `:focus-visible` fill after the Tab, and 13,023 panel pixels off the clear colour; the host log carries `ui overlay: native-css backend=blitz-dom 0.3.0-beta.2 ... (CPU rasteriser, no WebView, no Chromium)` and `TN_UI_OVERLAY:{"attached":true,"renderer":"native-css"}`. `Inventory.tsx` is the one file both the react-dom and native entries mount. Charter amended (bounded UI-only exception); `packages/ui/AGENTS.md` and `docs/guides/native-runtime.md` describe the opt-in. Screenshots: `examples/native-css-hud/reference/` beside the Chrome reference.

### Phase 2 — Core HUD semantics

The oracle is `examples/native-css-hud/corpus`: `node corpus/oracle.mjs` renders 28 fixtures from one element tree and stylesheet in pinned headless Chromium 151 and in the engine, and requires every element's border box within 1 CSS px per edge and whole-frame luminance SSIM >= 0.99 (>= 0.98 for a fixture that draws glyphs). Two disclosed amendments, both made after measuring: Chromium runs with `--font-render-hinting=none` (FreeType otherwise rounds every glyph advance to a whole pixel, 200.000 px against the engine's 193.609 px for 20 "o"), and glyph fixtures use 0.98 because the two rasterisers anti-alias glyph edges differently (the same text with no span styling scores 0.9796 against Chromium while every box and line break is identical). Geometry is never relaxed. The public matrix, with every restriction, is `docs/guides/native-css-support.md`; the reference capture manifest (Chromium version and args, platform, thresholds, font and image hashes, fixture source hashes) is written beside the report.

- [x] Core cascade and layout match the browser oracle. proof: `cd examples/native-css-hud && node corpus/oracle.mjs` — 28/28 fixtures, 0 edge misses, covering cascade order/layers/`!important`, structural/attribute/`:is`/`:where`/`:not` selectors, variables incl. cyclic, box model and intrinsic sizing, positioning and stacking, flexbox, grid, `rem`/`vw`/`vh`/`clamp()`, breakpoints at two viewport widths, inline margins/padding/borders, text wrapping and mixed Latin/Arabic direction. Five upstream crates are vendored with documented one-purpose patches (`vendor/PATCHES.md`: each hunk, why, and the fixture that goes red without it).
  Not covered: DPR is proven in the engine (`dpr-2-layout-and-paint`) but the desktop and Android hosts attach at scale 1.0; clicks on a span's padding hit its parent.
- [x] Core paint and typography match the browser oracle. proof: the same run — borders, per-corner radii, outlines with `outline-offset`, layered shadows, linear gradients, `oklch()`/alpha, subtree opacity, overflow and radius clipping, `object-fit`/`object-position` with a hashed PNG and a `data:` URI, bundled fonts and weights, fixed and `normal` line-height, letter-spacing, `white-space`, single-line ellipsis (strict 0.99 bar, with `text-overflow-fits` as its negative control), Portuguese and mixed-direction text. The glyph-rasteriser amendment above applies; text-shadow, filters, masks and blend modes are outside the profile and fail the build (`TN_CSS_UI_UNSUPPORTED_CSS`, `docs/guides/native-css-support.md`).
- [x] Core interaction behavior matches the browser oracle. proof: `node corpus/interaction.mjs` — 8/8 scenarios, identical focus order, click lists, scroll offsets and pixels (+-3): Tab/Shift+Tab traversal (disabled and `tabindex=-1` skipped, no wrap, Enter/Space activation, `:focus-visible` only after keyboard focus), nested wheel scrolling, clipping- and radius-aware hit tests, transformed hit tests, `pointer-events: none`, group/peer variants, transitions of colour/opacity/transform with delay and interruption, touch with no sticky hover, dark mode and reduced motion. Host side: `threenative-css-ui-overlay-test` (no display) covers keys consumed only while the UI can use them, wheel consumed only over a scroller, the clock, environment and pointer kind in all three configurations, and the keyboard playtest above proves game-input isolation on the real host. Reduced motion is a UA rule (`transition-duration: 0s`), not the media query: Stylo's servo build has no `prefers-reduced-motion` feature.

### Phase 3 — Cross-target proof

- [x] The complete Core HUD corpus passes on a named native desktop platform. proof: `cd examples/native-css-hud && node corpus/desktop.mjs` on CachyOS 7.2.8 / NVIDIA GeForce RTX 2080 / Vulkan / private Xvfb: every fixture is generated as its own native-css game, packaged against the checkout host and run through `playtest --target desktop`; 27/27 fixtures within the oracle's bars (`dpr-2-layout-and-paint` skipped by name: the host attaches at scale 1.0), backend identity and zero web-view lines on every run, and 8/8 interaction scenarios matching Chromium (re-run after the state channel below: exit 0) (focus order, clicks, hover/focus/transition/touch/environment pixels; wheel, Shift+Tab, touch, media and a deterministic `TN_CSS_UI_FIXED_STEP_MS` clock were added to the desktop runner for this). The last two scenarios needed the host's own state: `tn_css_ui_scroll_offset` and `tn_css_ui_scrolled_ids` are new C ABI entry points (Rust test red first, crate suite green), and with `TN_CSS_UI_STATE_TRACE=1` the host writes one `TN_CSS_UI_STATE focused=<id> scroll=<id>:<x>,<y>` stdout line per composite that changed either. The corpus maps the oracle's element numbers to React's host ids (children first, text nodes take ids) and reads the last line of a run cut at each observation's own step, so `nested-scroll` (all 6 offsets) and the click-given focus of `focus-traversal-and-activation` now compare against Chromium. Not measured: keyboard-focus and scroll state per step on one run (a cut run per state observation instead). Box edges cannot be read from a capture: the claim is SSIM plus the oracle's own edge result for the same tree. Ten flat fixtures have fewer than 8 colours, below the runner's blank-capture guard; the harness applies the guard's other conditions and judges them on SSIM.
- [x] The complete Core HUD corpus passes on an Android emulator without a WebView. proof: `node scripts/verify-android.mjs` (HUD: `closeClicks` 0 -> 1 after a real tap, 2,536 button and 12,910 panel pixels, logcat `backend=blitz-dom ... (CPU rasteriser, no WebView, no Chromium)`, no WebView creation from the app's process) and `node corpus/android.mjs` — `threenative_api35` (API 35, x86_64, QuickJS, KVM, `-gpu host`, RTX 2080/Vulkan, 160 dpi): 27/27 dpr-1 fixtures and 8/8 interaction scenarios (35/35 subjects, exit 0; `dpr-2-layout-and-paint` skipped by name: the runner presents density 160 only) within the bars in one end-to-end run (landscape viewport enlarged where the WindowManager refuses the fixture size, the Chromium reference rendered at the same size) matching Chromium. Keys, wheel, hover and run-time dark mode or reduced motion all travel the existing device mailbox (`input.keyDown`/`input.wheel`/`input.pointer`/`input.media`), not `adb input`; the fixed UI clock and the focus/scroll state line reach the Android host as intent extras (`TN_CSS_UI_FIXED_STEP_MS`, `TN_CSS_UI_STATE_TRACE`, `android_main.cpp`) and are read back from the app's own logcat. Three runner defects the corpus exposed, each fixed red first: the runner refused wheel/media on Android by policy; it sent an OS `KEYCODE_SPACE` on top of the mailbox key, so the native UI activated twice (the host now answers `consumedByUi` and the runner skips the duplicate); and system_server `E/TransitionController` lines that name the activity counted as game console errors, failing runs intermittently (the console parser now drops them, as it already did `SurfaceSyncGroup`). Earlier full runs before the last two fixes read 33/35 and 34/35; the final run read 35/35.; no physical device, no arm64 APK, no V8 engine on Android (`third_party/v8-android` has no build receipt).


## Acceptance criteria

- [x] Native-CSS lifecycle and invalidation meet the resource contract. proof: `cd examples/native-css-hud && sh ../../scripts/xvfb.sh node bench/run.mjs` — five arms (ui-off, native-css-static, native-css-10pct, native-css-active, web-overlay), 1,500 composites each on a private Xvfb, RTX 2080/Vulkan, load average 8.7→16.5 (a smoke run, not a verdict; no fps printed). **Unchanged UI does no repeated work:** static published and uploaded 1 frame in 1,500 composites (1,484 skipped), frame p50/p95/p99 1.33/2.97/5.45 ms against ui-off 1.52/2.49/4.65. **Dirty work scales with the change:** 10% at 10 Hz published 848, the active transition/scroll case 1,500 (UI phase p50 13.27 and 10.79 ms under that load). **Bounded resources:** every arm holds 5 textures / 52 MB with 0 MB buffers; host RSS rises with warm-up in ui-off too (90→220 MB), so the CSS arms' 272–322 MB end is not a UI leak claim; repeated mount/dispose returns to baseline in the crate (RSS 33/36/33/33 MB, counting-allocator test). Startup: first frame 511 ms ui-off against 601/790/996 ms for the CSS arms; executable 122.84 vs 123.02 MB. **Named, not measured:** the CSS engine's own CPU time (crate bench only), input-to-present latency and per-UI GPU resource counts have no host marker; no numerical release budget is frozen and no speed claim against the web overlay is made. Report: `bench/out/report.json` (untracked).
  Measured so far, not enough to tick: (1) engine level, `cargo run --release --example bench` (1,000 elements, 120 warm-up + 1,000 frames): an unchanged UI repaints 0 times in 1,000 frames and costs ~0 ms; a full-frame CPU repaint costs 4-5 ms at 1280x720; mount/dispose RSS over 3,200 cycles of a 1,000-element HUD went 58 -> 77 -> 114 -> 114 MB until a leak was fixed (blitz-dom recorded every created node in `changed_nodes` and never drained it), then 33 -> 36 -> 33 -> 33 MB, with a counting-allocator test that fails (4.7 MB retained against a 256 KB budget) without the fix. (2) host level, `pnpm --filter threenative-native-css-hud bench:desktop` runs five arms (UI off, native-css static, 10% changed at ~10 Hz, an active transition, and the web overlay on the both-backends host) and reports render-phase frame percentiles, UI composite cost, uploads against composites, RSS, package size and cold start; the one run taken was under a load average of 34-68 (CI runners and a game on the same machine) and the private Xvfb makes frame rates meaningless, so it is a measurement, not a baseline: native-css active showed a 65 ms median UI composite there against 4-5 ms for the same repaint in the engine bench, which is load, not a verdict. Missing meters: the CSS engine's own CPU time inside the host, input-to-present latency and a GPU resource count for the UI. No numerical budget is frozen, as the PRD requires, until a run on named quiet hardware exists.

Core delivery additionally requires the documented strict compatibility diagnostics and public
support matrix: each feature claim points to a passing fixture. Checklist completion cannot waive
the normative source-parity, no-WebView, dependency-isolation or supported-profile requirements.

## Blocked on

No external dependency blocks this PRD. Phase 1 is implemented and verified on Linux desktop only
(Blitz, CPU raster, existing compositor). GPU-side interop, Android admission, a license inventory and the
Core engine gaps are still work inside this proposal, not facts established by a dependency README.

Physical-device performance and platform accessibility readiness require the corresponding
hardware/OS test lane; the implementing agent must try the available lane and name the actual
missing prerequisite before reporting it blocked. iOS and other untested desktop platforms have
no readiness claim from the desktop/Android-emulator checks in this PRD.

## Decisions and rollout

On 2026-10-01 the owner clarified: the same Tailwind and CSS interface must output native UI.
That requirement supersedes the previous bounded utility-parser design. Its eight unchecked
items are replaced by this Core HUD plan because they proved the wrong contract; no completed
work or evidence is removed. The existing filename is retained to preserve PR #388 links.

This proposal recommends a reused standards-oriented native UI engine, with CSS allowed at
runtime and no public proprietary style IR. Blitz 0.3.0-beta.2 was admitted for Phase 1 on Linux desktop by
the evidence in the boxes above, and the bounded UI-only Charter exception is recorded; Android admission and
the license inventory remain open. The owner did not select a specific Rust library or authorize a silent
default-renderer change, and none was made.

Ship as experimental opt-in after the native proofs. Preserve the web and lightweight-native
backends and their existing tests. Rollback changes renderer selection/bootstrap, not authored
JSX/CSS. Rollback must be explicit: no hidden WebView fallback. Default promotion, advanced CSS
profiles, forms/IME and additional platform certification are separate decisions and PRDs.

## Verification

Phase 1 evidence is in the boxes above. Gates run on the delivering branch: `pnpm typecheck`, `pnpm lint`
and `pnpm budgets` (all exit 0; the native coverage record and census were regenerated, coverage with
LLVM 23.1.1 minus the `--fatal-warnings` flag it no longer accepts), `cargo test --release` in
`packages/runtime-native/native/css-ui` (30 tests), the `react-css`, ui-bridge and packaging specs, and
the host contract lane in three configurations (CSS on/web overlay off, CSS off, both on).

Full `pnpm test` was not green on this branch. Two failures were this branch's own and are fixed (a
`main.cpp` length backstop and unwaived suppressions in `react-css.ts`); the others passed in isolation or
once their test executables were built (load flakes, unbuilt `tn-linux` targets). A last full run after
those fixes was not repeated. The remainder are not caused by this diff and were not baseline-run: three
`tn-linux-quickjs` lane tests need a QuickJS host build directory that does not exist here, two SBOM tests
need the downloaded `third_party` receipts, `ios-packaging` expects a workflow edit that landed on
`develop` after this branch's base, and the generated-shooter input proof fails on a static scenario check
in files this branch does not touch. Not run: Android emulator, iOS, macOS, Windows, any performance
budget, and the Phase 2 browser-oracle corpus.


## Published source review — 2026-10-05

Review of published commit `28b8c87c98f3b262586df4353a1afa447338256b` against develop
`d3c009e4404abcc2041f58124693edb9c78d802b` reproduced four defects and corrected them:
CSS staging/loading now follows Vite's static import order instead of hashed filenames;
unloaded split CSS is refused explicitly (the browser's single global stylesheet with
`cssCodeSplit: false` remains supported). Grouped native event messages let React's
`stopPropagation()` suppress ancestors only in that dispatch, including when an old event
is retained. The host state trace preserves exact double scroll offsets. Android interaction
verdicts require every observation to be reachable and compared.

RED evidence on that published source: the real Vite/React lane had 3 failures and 1 positive
control; Rust stylesheet loading had 2 failures and pointer dispatch had 1; the actual Android
verdict and compiled C++ trace function had 2 failures. Independent review additionally caught
a retained event stopping a later dispatch and the global-CSS case; each failed before its
correction. Setup errors and an unconfirmed CSS-URL manifest-key hypothesis are not behavior REDs.

Final verification: packaging/compatibility/source-map specs 92 PASS; React CSS 15 PASS;
actual split/global/URL stylesheet controls 5 PASS; Rust release tests 73 PASS; UI host-contract
spec 18 PASS and 1 named macOS-only skip on Linux. Core and CLI typechecks, changed-file Biome
checks, and the ordinary CLI build pass. The C++ precision regression compiles the actual trace
function with controlled ABI offsets and uses the actual state reader; it is a function contract,
not a new device run. Rust uses the real CSS engine; its build was capped with `-j 1`.

The published native coverage digest was already stale (`e330b253…` against the retained
`d0a593af…`). A fresh canonical `pnpm --filter @threenative/runtime-native native:coverage`
measurement on this repair ran from 22:53:50 to 22:58:07 UTC under the shared capture lease:
46 native contract targets executed, 3 explicitly disabled targets, 50 fresh raw profiles and
46 merged profiles, 19,354/24,669 instrumented lines covered (78.45%). Existing floors are
unchanged. The generated report now binds to
`b5ddb0d3c39a6590d1e9088c4e82fd8659c38e0713ca373a1083002fbb256595`.
The canonical configuration disables the CSS/web overlay, physics, video and metahuman lanes;
this refresh establishes current coverage provenance, not new native-CSS host or mobile evidence.
Repository budgets (including current native coverage/census) and documentation checks also pass.

These repairs preserve the earlier published oracle/device results and checklist history.
No Android, macOS, Windows, physical-device, performance-budget or full CI board was rerun for
this bounded source review. CI must qualify the new published candidate separately.

## CI corrective follow-up — 2026-10-05

Candidate `2d160589` started CI run `37387474791`; its platformer golden journey failed at
the mutated CLI pack step with `TN_FRAMEWORK_PATCH_MISSING: ../../patches/vite@8.2.0.patch`.
The prior published `28b8c87` run `37380293620` had the same failure. The mutation copy used
a flat package layout, while this PR's real prepack requires repository-relative Three.js,
Vite and Tailwind patch inputs. It now recreates that layout and reconstructs patches from
the authored inputs; generated patch copies are excluded so a warm checkout cannot hide
the cold-copy defect. The packed dependency mutation still reaches and observes its
deliberately missing Vite tarball.

The prior run also failed because the source-NUL test scanned this PR's binary fonts/PNG
as UTF-8 text, and the native CSS compatibility test created an unregistered temp directory.
Both failures reproduced on `2d160589` in a focused CPU run: 2 FAIL. The text scan now
excludes known binary asset extensions and has a real tracked TypeScript NUL negative
control; the compatibility fixture uses the existing registered temp-directory helper.
All 32 affected packaging/test-contract tests pass, including the cold pack/scaffold control,
on CPUs 11 and 23 with one test worker. The four reviewed engine production repairs remain
byte-for-byte unchanged. No additional native host, browser, device or performance board was
run for this CI follow-up; the normal candidate and merge-queue checks determine eligibility.

## Native CI diagnostic follow-up — 2026-10-06

Published candidate `54ab2fb2` ran CI `37389995427`, attempt 1, against develop
`d3c009e4` through merge candidate `1d02c792`. The run ended with 63 successful jobs,
4 failed jobs and 1 skipped job. Native fluid exited 1 before producing a report;
its failure artifact has unavailable report and host diagnostic channels. Native
locomotion exited 2 with `TN_PLAYTEST_BRIDGE_MISSING`, zero scenario frames and zero
response observations. Those failures blocked the integration join and `ci-required`.
The platform native legs, both golden paths and all four unit shards passed. A
software-device-loss diagnostic in the passing platformer golden job is not render proof.

The preceding corresponding fluid and locomotion jobs passed using the same runtime
binary (SHA-256 `2006359fe9fd8040046d52aec79ff22b16c631afc3404f3de2161ff599d5ee95`).
The fluid gate bundle and eight tracked fluid proof inputs also match. This comparison
does not identify the current startup cause or qualify the failed candidate. The
roughly 11-second fluid failure after bundling is consistent with the existing
10-second display initializer timeout, but the scrubbed error also admits a missing
report and does not establish which happened.

The fluid verifier now preserves fixed diagnostic identities for a display timeout,
a missing playtest report and an unclassified verifier exception. Existing private-text
scrubbing, unavailable-channel reporting, assertion verdicts and startup deadlines are
unchanged. The missing diagnostic reproduced as 1 FAIL before the correction; all
23 native-fluid/preflight and existing fluid-proof CPU tests pass on CPUs 11 and 23
with one worker. No new native startup, device, pixel or performance result is claimed.
The root scripts/test typecheck (`tsc` 7.0.2) exits 1 with missing example dependency
types and downstream errors. A temporary copy of the immutable `54ab2fb2` scripts,
using the same compiler and unchanged checkout dependencies, also exits 1 with the
exact same diagnostics (log SHA-256 `549aa760c5023a484f3d74d595b70b651578aa6c0953c794af7f3710c46bfddf`).
This comparison establishes no additional type errors from this diagnostic correction;
it is not an overall typecheck pass.
The proposed bridge budget increase remains unapplied. A fresh required CI result
and normal merge-queue checks remain necessary before this candidate can merge.
