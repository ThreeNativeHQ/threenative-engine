# PRD-055 — the HUD hole, reopened with a real game's evidence

**Status: BLOCKED AT TOUCH PLAYABILITY, 2026-08-09.** Candidate G now renders generated HUD
source on browser, desktop, and the Android emulator. Acceptance criterion 2 remains blocked.

**Priority:** P1 — Native HUD parity unfinished: scaffolded HUD on desktop and Android, touch playability blocked at adb EPERM.
Three review defects were repaired on 2026-08-09:

1. **Row 25 was synthetic.** It changed only projection numbers, so it passed without the
   renderer or canvas ever resizing. It now resizes the real renderer at four viewports and
   reads back the drawing buffer; `conformance/overlay-anchor.mjs` throws
   `TN_CONFORMANCE_RESIZE_NOT_APPLIED` when the resize is removed, with its own negative tests
   in `tests/parity-contract.test.mjs`.
2. **The scaffold HUD checks grepped source and watched the React DOM path.** Every template's
   HUD now reports the glyph count it pushed to the GPU, and the minimal template's `pnpm test`
   asserts that count changed on the booted project (`377 → 361` glyphs, `trivial: false`). The
   minimal template gained `playtest()` so its scenario can observe rather than fail closed on
   a missing bridge. Starter and platformer boot to a `boot` scene, where the bridge advertises
   no `runtime.components` capability, so they keep the source-level contract only — recorded
   in `docs/verification/integration-2026-08-09-six-prds.md`, not worked around.
3. **The 1,200-line template cap** is retired by product-owner decision, so the HUD no longer
   competes with gameplay for template lines. `pnpm budgets` still reports template LOC.

Reopens the candidate-D decision in
`docs/PRDs/native/done/PRD-051-native-ui-layer.md`, which requires "a new PRD with new
evidence". Evidence: `docs/verification/probe-real-game-cross-platform-2026-08-09.md`.

**What this owns:** whether "everything that works on web works on desktop and mobile" is
allowed to exclude the user interface.

**What this does not own:** how a HUD looks. The rule that the framework never owns the look is not in question here
and nothing proposed below ships a component library, a layout engine or a style.

## 1. What PRD-051 decided, and what it did not have

PRD-051 chose candidate D: `@threenative/ui` stays web-only, the framework ships no native
HUD abstraction, and "a native game authors its on-canvas interface in its own Three.js
source." It killed candidate A on measured evidence — a Canvas2D-texture HUD produced 1,939
bright text pixels in the browser and **0** on the Linux desktop host, with
`copyExternalImageToTexture: unsupported source type`.

That evidence was about a 43-line spike. It was not about a game.

## 2. What a game costs

The platformer ported on 2026-08-09 needed, to show on desktop and Android what the browser
showed for free in fourteen lines of `main.ts` and some CSS:

| Piece | Why it had to be written | Lines |
| --- | --- | --- |
| Camera-parented overlay, pixel-space layout, resize handling | there is no screen space; a HUD is world geometry or nothing | ~60 |
| Seven-segment digit renderer | there is no text. `CanvasTexture` samples black under WebGPU and Canvas2D is broken on the host, so a coin count is 7 rectangles per digit | ~70 |
| Hearts, coin, gem, clock composition | the readouts themselves | ~90 |
| Thumbstick, jump and dash buttons, hit-testing | there are no touch controls, and mobile has no keyboard | ~90 |
| Pointer tracking by id | `raw.pointer` is one cursor, so stick-plus-jump is impossible (PRD-053) | ~20 |

**330 lines, none of it about this game.** A score, a health bar, a clock and a d-pad are not
this game's identity — they are what every game has. Rule 1 says a thing a competent developer
writes in under 20 lines stays out of the framework. This is not that thing, and the same 330
lines will be rewritten, worse, by every native game that follows.

The material result is on record: before this was written, the desktop and Android builds
rendered a complete, correct world with **no hearts, no coin count and no clock**, and on
Android no way to move at all. Every gate in the repository was green.

## 3. The tension, stated honestly

Rule 3 — never own the look — is the reason PRD-051 answered as it did, and it is right. A
HUD is the most screenshot-visible surface in a game and the framework must not decide how it
looks.

But there is a difference between **owning the look** and **owning the ability to draw at
all**. Today the framework owns neither, and the consequence is not that games look
different: it is that they have no interface on two of three targets. "Write once, run
anywhere" with an asterisk over the UI is the asterisk that swallows the promise, because the
UI is the part of a game a player reads.

## 4. Candidates, narrower than PRD-051's

PRD-051 weighed a HUD component library (B) and a DOM/CSS engine (C) and rejected both on
Charter grounds. Neither returns. The live question is smaller.

- **E — text, and nothing else.** The framework ships a way to draw a string in screen space
  and stops. No layout, no widgets, no styling beyond what Three.js materials already offer.
  An SDF atlas or `TextGeometry`-equivalent, portable by construction because it is geometry.
  This is the single highest-leverage line: with text, a game writes its own HUD in tens of
  lines instead of hundreds, and the seven-segment digit renderer above disappears.
- **F — text plus a screen-space anchor.** E, plus the camera-parented pixel-space group and
  resize plumbing that every overlay reimplements identically. Still no widgets: the game adds
  its own meshes to an anchored group.
- **G — generated source, not package code.** Ship the overlay in
  `create-threenative/templates/*/src/render/hud.ts` as ordinary user source the model can
  rewrite or delete, exactly as `lighting.ts` and `materials.ts` already work. Costs the
  framework nothing, keeps rule 3 intact, and every new project starts with a working
  cross-platform HUD instead of a blank canvas.
- **D — status quo.** Every game writes all 330 lines.

**Recommendation: G now, E next.** G is available immediately, breaks no rule — the templates
already ship load-bearing render source that games own — and closes the "a scaffolded project
has no HUD on native" hole this week. E is the durable fix and needs its own spike, because
text rendering is the thing that made candidate A fail and nothing has yet proven a portable
path. F only after E; the anchor is worthless without something to put in it.

## 5. Phase 0 — the spike that decides E

Before any text implementation is chosen, prove one can exist on all three targets:

1. Render the string `SCORE 1200` at 32 px in screen space on web, Linux desktop native and
   the Android emulator, from one source file, with no per-target branch.
2. Measure bright-glyph pixel counts on each, exactly as PRD-051 measured candidate A. The
   number that killed A was 0 on desktop; anything above a stated floor on **all three**
   passes.
3. Compare glyph bounds across targets within the tolerance PRD-054 sets for its rows.
4. Record the authored line count. If a game reaches readable text in under 20 lines with
   candidate G alone, E is not needed and this PRD closes with G.

Fail closed: a missing or blank capture on any target is a failed spike, never a skipped one.

## 6. Self-verification

Every claim runs through PRD-054's harness, emulator-first for mobile:

```sh
pnpm parity --rows 25-camera-parented-overlay,30-screen-space-text
```

New registry rows this PRD adds and must leave passing on web, desktop and the Android
emulator:

- `25-camera-parented-overlay` — a pixel-space anchor holds position across two viewport
  sizes and two orientations.
- `30-screen-space-text` — a known string is legible on every target, asserted by glyph pixel
  count and bounds, not by a human glance.
- `31-hud-readout-updates` — a counter changes on screen when game state changes. This is the
  row that catches a HUD which renders once and then never updates.

A scaffolded project must additionally boot on the emulator and show its HUD with no code
written by the user. That is the acceptance test for candidate G and it belongs in the
scaffold smoke lane.

## 7. Acceptance criteria

1. A project scaffolded from any template shows hearts-or-score, a counter and a clock on
   web, desktop **and** the Android emulator with no user-authored HUD code.
2. On a touch target it is playable with no keyboard: the shipped source includes controls, or
   the framework's input surface plus twenty lines does.
3. No package under `packages/` gains a widget, a layout system or a style. Rule 3 holds.
4. Whatever is not portable is listed in PRD-054's Tier 3 with a reason and an owner. React
   DOM and Tailwind may legitimately stay there — but then the templates that ship them must
   say so where a user reads it, not only in a PRD.

## 8. What this changes about the promise

If this PRD lands as G+E, "everything that works on web works on desktop and mobile" becomes
true for the interface too, and `@threenative/ui` remains what it is: a React convenience for
web-only games, clearly labelled. If it lands as D again, the promise must be rewritten
wherever it appears, because today it is stated without the asterisk that the code enforces.

## Budget justification

2026-08-10: PRD-055 owns the native HUD/text conformance scenes and their fail-closed test
coverage in `conformance/` and `tests/`. The exact count and commit attribution are in
`docs/verification/native-loc-trigger-2026-08-10.md`. The kill switch keeps these proof scenes
because they distinguish a readable native HUD from a blank or stale frame; it does not create
a framework widget, layout system, or native UI abstraction. The native LOC trigger remains
unchanged.

## Criterion 2 rerun — 2026-08-10

The lane result is recorded in
[`docs/verification/prd-055-touch-criterion-2-2026-08-10.md`](../../../verification/prd-055-touch-criterion-2-2026-08-10.md).
The actual template contains a 181-line touch-controls implementation wired through
`Level.ts`, so Path 1's source contract is satisfied. Android execution remains blocked
before touch assertions by the recorded ADB result:
`TN_PARITY_ANDROID_ADB_BLOCKED: spawnSync /home/joao/Android/Sdk/platform-tools/adb EPERM`.
Criterion 2 remains open; no Android touch-playability claim is made.
