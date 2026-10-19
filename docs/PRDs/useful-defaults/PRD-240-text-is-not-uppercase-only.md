---
prd_contract: v1
---

# PRD-240 — Text is not uppercase-only

**Status: PROPOSED, 2026-08-28. Nothing below has been executed.**

**Priority:** P2 — Open boxes build a deterministic font atlas and metrics table, failing on missing glyphs.
Source of the borrowed architecture: [`pmndrs/glyph`](https://github.com/pmndrs/glyph), MIT, cloned
at depth 1 on 2026-08-28. **The package is refused as a runtime dependency, on evidence read from
that clone.** What is mined is its build-time/runtime split, which is the whole insight.

Parent batch: [useful-defaults](./README.md), mined under feature-mining.

**Complexity:** +2 new subsystem, +2 multi-package (`assets` build pass, `core` runtime), +2 complex
state (atlas residency, layout, batching), +1 new artifact format, +1 asset pipeline change =
**8 → HIGH mode. Mandatory checkpoint after every phase.**

## The question

`packages/core/src/react-glyphs.ts` draws HUD text with a 5×7 bitmap grid, one instanced quad per
lit pixel, and it says why:

> It needs no font file, no texture, no `document`, and no rasteriser, which is why it is the only
> text path that works identically in a browser and inside the native host.

That is true and it was the right call. It also means, at HEAD:

- **There is no lowercase.** `react-glyphs.ts` upper-cases input before lookup, because no
  lowercase form is legible in a 5×7 cell.
- **There is no accented Latin, no Cyrillic, no Greek, no CJK.** An unmapped character raises
  `TN_REACT_UNKNOWN_GLYPH` (`react-host.ts:195`) rather than drawing a hole — good failure, still a
  failure. A game shipping in French, Portuguese or Japanese cannot render its own HUD.
- **There is no world-space text at all.** `grep -ri "TextGeometry|troika|msdf|sdf"` over
  `packages/*/src` and every template returns nothing. A floating damage number, a nameplate, a
  sign on a wall, a tutorial label pinned to a door — none of these have a supported path.
- Since PRD-217 a game can render `src/ui/` through the platform's browser-class renderer, which
  gets real fonts in the HUD **on the targets and configurations where that overlay is on**. It is
  not the world-space answer, and it is not the `ui.renderer: "native"` answer.

Two questions, per the charter:

- **(a) Could the game write this portably itself?** No. Text needs a rasterised or distance-field
  atlas, and producing one at runtime needs `document`, `OffscreenCanvas` 2D, or a WASM shaper —
  the first two are shimmed only as far as `createImageBitmap` needs, and the third does not exist
  on iOS. Producing it at **build** time needs a pipeline the game does not own.
- **(b) Does it decide how anything looks?** The font does, and the material does — so **the font
  file and the material stay the game's**, exactly as `GPUParticles3D` takes its geometry and
  material from the game. What ships here is the atlas format, the layout, and the batching.

## What the source actually contains — and the fact that reshapes this PRD

| Claim | Evidence |
| --- | --- |
| Shaping and layout run in **WebAssembly** at runtime | `packages/glyph/src/shaper.ts:89-92` (`WebAssembly.instantiate`), `:207` (`fetch(new URL('./text-shaper.wasm', import.meta.url))`); `src/core/host.ts` — publication "bytes point into Wasm memory" |
| Fonts are **baked ahead of time** by a CLI into a GLB carrying strikes, atlases and curves; runtime baking is opt-in and separately chunked | `packages/glyph/bin/glyph.js bake`; `src/bake.ts`, `src/runtime-bake.ts`, `src/font-baker/wasm-url.ts` |
| It targets three.js WebGPU and ships TSL node graphs | `packages/glyph/package.json` exports `./tsl`, `./three`, `./three/msdf` |
| MIT | `LICENSE` |

**The refusal, stated plainly:** `packages/runtime-native/AGENTS.md:83` — *"Android QuickJS and iOS
JSC have no WASM engine"* — and `TN_NATIVE_WASM_ON_MOBILE` is a hard guard, not a warning. Android
now defaults to V8, so Android could run it; **iOS cannot, by construction**, since JSC there is the
platform's JIT-less engine. Depending on `@pmndrs/glyph` at runtime would ship a text system that is
absent on one shipped target, and *"a feature that works on web only is unfinished"* applies with
equal force one target down.

**The borrow is the split, not the code:** *shape and rasterise offline, ship an artifact, and let
the runtime do arithmetic.* Glyph proves that split is viable for a serious text system and shows
what the artifact has to carry. This PRD takes that and puts the bake where this repository already
has a bake.

## Design

```
build time                      @threenative/assets: fontPass
  game's .ttf/.otf  ──────────►  atlas (MSDF or bitmap strike) + metrics table
  + declared charset             content-addressed, beside modelPass and texturePass

run time                        @threenative/core
  metrics + atlas   ──────────►  layout → quads → one draw
  no wasm, no document, no rasteriser, on all four targets
```

```ts
// the game owns the font and the material; the framework owns the mechanism
const label = new Text3D({ font: ctx.assets.font("Inter"), material: myTslMaterial });
label.text = "Porta trancada";      // accents, lowercase, whatever the charset carries
ctx.add(label);
```

- **The charset is declared at build time.** This is the honest cost of removing the runtime shaper,
  and it is stated in the docs rather than discovered: a string containing a character the bake did
  not cover fails loudly, the way `TN_REACT_UNKNOWN_GLYPH` already does, and the fix is one line of
  config. Latin-1 plus the game's own strings is a small default; CJK is a declared subset.
- **Complex shaping is out of scope and named.** Arabic joining, Devanagari reordering and Thai
  clustering need a shaper at layout time. Positioning from advances and kern pairs — which is what
  Latin, Cyrillic, Greek, Hebrew, Kana and Han need — is arithmetic and ships here. A PRD that
  quietly implied "all of Unicode" would be lying about a hard limit.
- **The HUD tier and the world tier share the atlas and the layout**, and differ only in whether the
  quads go into the overlay camera or the scene.

## Incumbent census

| Existing thing | Relationship |
| --- | --- |
| `react-glyphs.ts` 5×7 bitmap set, `measureText` (`react-layout.ts:138`), `supportedGlyphs()` | **Stays as the zero-asset default**, and becomes the fallback when a game declares no font. Two live implementations would be a rejection, so the React `text` element's `font` prop — which already exists — becomes the single switch between them, and `measureText` delegates to the baked metrics when a font is set. |
| PRD-217 WebView UI overlay | Untouched. Different tier, different problem: it does not reach world space and it is off under `ui.renderer: "native"`. |
| `@threenative/assets` `modelPass` / `texturePass` (`packages/assets/src/passes/`) | **The pattern the font bake follows.** No new package: the bake is a pass, so nothing inherits a new dependency and charter rule 5 is not engaged. |
| `templates/minimal/src/render/hud.ts` geometry HUD | The existing bitmap consumer. Its continued correctness is the regression guard. |

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `fontPass` — `packages/assets/src/passes/font.ts` | `packages/assets/src/compile.ts` pass list | nothing | n/a | remove the pass → the artifact is absent and the runtime fails loudly, not silently |
| 2 | Baked font artifact + metrics reader | `packages/core/src/…` font loader, reached from `createAssetLoader` | nothing | n/a | corrupt one metrics byte → the reader throws, never renders garbage |
| 3 | `Text3D` — `packages/core/src/text3d.ts` | a template scene that shows a label | nothing (no world text exists) | n/a | remove the object from the scene → the template's label playtest reds |
| 4 | Baked path behind the React `text` `font` prop | `packages/core/src/react-host.ts:195` region | bitmap-only measurement in `react-layout.ts:138` | **delegating**, not duplicated | set a font and assert the advance differs from the monospace advance |
| 5 | Native proof | `packages/runtime-native/conformance/registry.json` case | nothing | n/a | run the case with the atlas missing → refuses, and the refusal is the assertion |

## Execution Phases

### Phase 1 — the bake, on the hardest real subject

**Proof subject:** a real variable-width font with lowercase, accents and kern pairs — the kind a
game actually ships — baked to MSDF, **not** a 16-glyph test font. A bake proved on a toy charset is
a bake that collapses on the first game that uses it.

**Files (4):** `packages/assets/src/passes/font.ts` (NEW), `packages/assets/src/compile.ts` (EDIT —
register the pass), `packages/assets/src/index.ts` (EDIT), `packages/assets/__tests__/font.spec.ts`
(NEW).

- [ ] Input: a font file plus a declared charset. Output: an atlas image and a metrics table
      (advance, bearing, atlas rect, kern pairs), content-addressed like every other pass.
- [ ] Deterministic: the same font and charset produce byte-identical output. A pipeline that
      re-bakes differently every run poisons the content-addressed cache.
- [ ] Failure is loud: a requested character the font does not contain fails the compile with the
      character named.

| Test file | Test name | Assertion | Negative control |
| --- | --- | --- | --- |
| `font.spec.ts` | `should bake identical bytes for the same font and charset` | hash equality across two runs | seed the rasteriser with wall time → hashes differ, reds |
| `font.spec.ts` | `should carry a kern pair for a pair the font kerns` | pair present, non-zero | drop kern extraction → absent, reds |
| `font.spec.ts` | `should fail the compile naming a character the font lacks` | throws, names it | swallow it → silent hole, reds |

### Phase 2 — layout and one draw, in the world

**Files (4):** `packages/core/src/text3d.ts` (NEW), `packages/core/src/assets.ts` (EDIT — font
loading), `packages/core/src/index.ts` (EDIT), `packages/core/__tests__/text3d.spec.ts` (NEW).

- [ ] Layout from the metrics table: advances, kern pairs, line breaking, alignment. Pure, testable,
      no renderer.
- [ ] One geometry, one draw per `Text3D`, rebuilt only when the string changes — a nameplate that
      rebuilds its buffer every frame is the failure mode this has to avoid by construction.
- [ ] Material comes from the game. The default is a TSL MSDF material generated into
      `templates/*/src/render/`, **not** owned here, because it decides how text looks.

| Test file | Test name | Assertion | Negative control |
| --- | --- | --- | --- |
| `text3d.spec.ts` | `should advance a kerned pair less than the sum of its advances` | strict inequality | ignore kerning → equal, reds |
| `text3d.spec.ts` | `should place a lowercase accented character at its baked rect` | rect matches metrics | fall back to the 5×7 path → wrong rect, reds |
| `text3d.spec.ts` | `should not rebuild geometry when the text is reassigned to the same value` | build count 1 | rebuild unconditionally → 2, reds |

### Phase 3 — the HUD tier stops being uppercase

**Files (3):** `packages/core/src/react-layout.ts` (EDIT — `measureText` delegates to baked metrics
when a font is set), `packages/core/src/react-host.ts` (EDIT — the draw path),
`packages/core/__tests__/react-host.spec.ts` (EDIT).

- [ ] With no font declared, behaviour is byte-identical to today. This is the regression the
      existing bitmap tests must keep proving.
- [ ] With a font declared, `<Text>` renders lowercase and accents in the native overlay.
- [ ] `TN_REACT_UNKNOWN_GLYPH` still fires for a character outside the **baked** charset — the loud
      failure survives the upgrade rather than being replaced by a hole.

### Phase 4 — it renders on a phone and on iOS, or it is not done

**Files (3):** a template (EDIT — one visible label in the world and one accented HUD string), its
playtest (NEW/EDIT), `packages/runtime-native/conformance/registry.json` (EDIT).

- [ ] Desktop native, Android device, and the iOS lane each render the same string. **No WASM is
      loaded on any of them** — asserted, because that is the entire reason for this architecture.
- [ ] A non-blank capture is asserted with the text visible; a blank-capture guard already exists
      (`assertCaptureNotBlank`) and is used rather than reimplemented.
- [ ] Any platform that cannot be executed is reported as not executed, not as passing.

## Acceptance criteria (consumer-scoped)

- [ ] A game ships a HUD reading `Vies restantes` and a floating world label reading `Porta
      trancada`, and both render correctly on web, desktop native and Android — screenshots pasted.
- [ ] No `.wasm` is fetched or instantiated on any target, shown by an assertion, not by reading
      the source.
- [ ] A game that declares no font renders exactly what it renders today, and the pre-existing
      bitmap tests prove it unchanged.
- [ ] A string containing a character outside the baked charset fails by name at build or at draw —
      never a blank rectangle.
- [ ] `measureText` returns the baked advance when a font is set and the monospace advance when it
      is not, from **one** code path.
- [ ] The MSDF material lives in `templates/*/src/render/`, and the diff shows no colour, no
      thickness and no outline decision inside `packages/`.
- [ ] Deleting `text3d.ts` breaks the template playtest; deleting `fontPass` breaks the asset
      compile test. Both pasted.

## Open question for the owner, before Phase 1

Charset declaration is the price of dropping the runtime shaper. A game targeting Japanese declares
a subset (or the full Jōyō set, at real atlas cost). **Is that acceptable, or is a CJK game a case
where the WebView UI overlay is the intended answer and world-space CJK is out of scope for now?**
The answer changes Phase 1's default charset and the docs, and nothing should be baked before it is
answered.

## Borrow map — where to read what

Read these before writing anything; they are the reference, not the dependency. Pinned to the
commit this PRD was written against, so the line numbers still mean something: **`pmndrs/glyph` @ `f08a90cf`**.

| To implement | Read |
| --- | --- |
| the offline bake entry point and artifact shape | `packages/glyph/bin/glyph.js`, `packages/glyph/src/bake.ts` |
| layout and placement from a metrics table | `packages/glyph/src/layout.ts`, `src/glyph-placement.ts` |
| the three.js text object shape | `packages/glyph/src/three/text.ts` |
| MSDF TSL node graphs | `packages/glyph/src/tsl/` |
| **do NOT borrow** — WASM at runtime, and iOS JSC has no WASM engine | `packages/glyph/src/shaper.ts:89-92`, `:207`; `src/core/host.ts` |
