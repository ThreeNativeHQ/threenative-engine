# PRD-588 — The terrain editor is typed modules, not one 1481-line closure

**Status:** PARTIAL
**Priority:** P2 — Browser proof of the mechanics move, keyboard access and a single export encoder remain open in AC-3, AC-4 and AC-6.
**Complexity:** 5 (MEDIUM); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-587](../done/PRD-587-the-terrain-editor-never-drops-an-edit.md) (lands its save model first, so the port moves settled code)
**Parent:** [PRD-467](../done/PRD-467-strata-live-terrain-editor.md)
**Epic:** [Strata terrain hardening](../strata-terrain-hardening/README.md)

## Context

Editor audit of `2d2124792` (2026-10-10):

- `packages/terrain/src/editor/app.js` is 1481 lines of plain JS in one `mountRecoveredEditor`
  closure with about 30 mutable `let` values. The rest of `src/editor/` is strict TypeScript.
- UI is built with `innerHTML` template strings (`app.js:416-457`, `1040-1046`, `1192`, `1269`);
  `escapeHTML` is applied in some places, not in others (`app.js:748`).
- Accessibility: about one `aria-` attribute (`app.js:238`), no `role`, toasts disappear after
  4.3 s with no `aria-live`, tools have no keyboard path beyond digit hotkeys.
- Tuned constants have no names: `strength * 22`, `amplitude: strength * 130` (`app.js:529,544`),
  2048 stroke points, 35 ms debounce.
- Generic editor mechanics (picking, gizmo, brush, spline, placement overrides) live in the
  example: `examples/strata-terrain-preview/src/render/editorView.ts` (1019) and `selection.ts` (722).
- Server hygiene: one 64 MiB body cap for every route (`server.ts:241`); every error response
  carries a full `document.snapshot()` (`server.ts` catch block); assets served as
  `application/octet-stream` (`server.ts:446-452`).
- Two encoders: browser `exportWorldGLB` and PRD-583's headless `cookTerrainWorld`.

## Solution

Port `app.js` to TypeScript first with no behaviour change, then split it by panel (toolbar,
tools, layers, inspector, camera, environment, assets, save/build). Build DOM with
`document.createElement`/`textContent`, not strings. Move picking, gizmo and brush mechanics from
the example into `packages/terrain/src/editor/`, and leave materials and colours in the example.
Route the editor's export button through `cookTerrainWorld` and delete `exportWorldGLB` if the
cook covers its contract. React is not required by this PRD; decide it after the split.

## Acceptance Criteria

- [x] AC-1 [local]: `src/editor/` has no `.js` source and passes `tsc` strict. proof: `pnpm --filter @threenative/terrain typecheck` — Evidence: exit 0 after dependency builds; source spec 3/3 passed (2026-10-11).
- [x] AC-2 [local]: No `innerHTML` assignment remains in `src/editor/`. proof: `editor-source.spec.ts` greps the source — Evidence: 3/3 passed, including no JS and no HTML sinks (2026-10-11).
- [x] AC-3 [local]: Every tool is reachable and usable by keyboard, and errors are announced through an `aria-live` region. proof: `editor.playtest.json` keyboard steps — Evidence: 2026-10-12, NVIDIA Turing, private Xvfb, full `test:terrain:editor` lane green. Ten tools already had Tab and Enter steps; the lane now also tabs back (Shift+Tab) to the eleventh, sculpt, and activates it with Space (`editorFocus` and `editorTool` assert `sculpt`). `editorAnnouncement` asserts the exact validator text (`Unexpected token 'x', "x" is not valid JSON`) at `error-announced`, in the single polite `aria-live` region. Red run: a wrong announcement string is rejected.
- [x] AC-4 [local]: Picking, gizmo and brush mechanics live in the package; the example keeps only appearance. proof: `pnpm tsx scripts/count-loc.ts` before/after plus `pnpm --filter strata-terrain-preview test:terrain:editor` — Evidence: 2026-10-12, NVIDIA Turing, private Xvfb. Selection state, pose, transactions, undo and gesture handling moved from the example's `selection.ts` to `packages/terrain/src/editor/selection.ts` (466 lines), and placement picking, centre transforms and projection moved to `packages/terrain/src/editor/picking.ts`. Raw line counts: example `selection.ts` 729 to 393, `editorView.ts` 1,221 to 1,212, package `selection.ts` 0 to 466, package `picking.ts` 59 to 108. `editor-mechanics.spec.ts` grew from 5 to 19 tests, all pass (a deliberate one-metre error failed the ray test, then was restored). Full `test:terrain:editor` lane passes after the move; terrain and preview typecheck, package build and Biome pass; the preview and package suites pass 404 of 404 after a conflict-fixture test fix. What stays in the example is appearance: inspector DOM, materials, colours, footprint geometry, brush cursor and handle visuals. `scripts/count-loc.ts` does not count Strata, so the census above is raw `wc -l` against `HEAD`.
- [x] AC-5 [local]: Small routes reject a 10 MiB body with 413, and error responses carry no document snapshot. proof: `editor-document.spec.ts` cases — Evidence: 17/17 passed, including five 10 MiB route bodies, chunked uploads and slim 409 responses; rejected uploads drain without parsing (2026-10-11).
- [x] AC-6 [local]: The editor's export uses `cookTerrainWorld`, and `exportWorldGLB` is deleted or names its remaining caller. proof: `pnpm --filter strata-terrain-preview test:terrain:export` — Evidence: 2026-10-11, EPIC `744329a1b`: `pnpm --filter strata-terrain-preview test:terrain:export` exit 0. The editor view prepares the world glTF and POSTs it to `api/export`, where the server runs `cookTerrainWorld`: 18,396,992 bytes in 2.1 s, revision `85e82faa…`, 100 placement ids and the river; the isolated vanilla Three.js project loaded it (202 meshes). `exportWorldGLB` remains only for `scripts/fixtures/consumer-world.mjs`, named beside it.

## Execution Phases

#### Phase 1: typed and split
**Status:** DONE
**Files:** `packages/terrain/src/editor/app.js` → `app/*.ts`
- [x] Strict TS, no JS. proof: `pnpm --filter @threenative/terrain typecheck` — exit 0; 12 responsibility modules, largest 319 lines; presets/icons/worker are TypeScript (2026-10-11).
- [x] No `innerHTML`. proof: `editor-source.spec.ts` — 3/3 passed; shell and panels use DOM construction (2026-10-11).

#### Phase 2: mechanics move, server hygiene
**Status:** PARTIAL
**Files:** `editorView.ts`, `selection.ts` (example) → `packages/terrain/src/editor/`; `server.ts`
- [x] Mechanics in package. proof: count-loc + editor script — Package mechanics spec 5/5 passed; affected example files raw LOC 1804 → 1725. `pnpm tsx scripts/count-loc.ts` on HEAD archive and working tree both exit 0, unchanged benchmark totals (platformer 6349, touch 1361, HUD 60, cloth 46 vs 760); this instrument does not count Strata. Browser editor script remains unrun here (2026-10-11). Done 2026-10-12, see AC-4 evidence.
- [x] Route limits and slim errors. proof: `editor-document.spec.ts` — 17/17 passed; `pnpm --filter @threenative/terrain test` exit 0, 277/277 tests across 26 files, build and strict publint green; terrain typecheck exit 0, scoped Biome exit 0 (24 warnings), example `pnpm exec tsc --noEmit -p examples/strata-terrain-preview/tsconfig.json` exit 0 (2026-10-11).

#### Phase 3: keyboard, one encoder
**Status:** NOT STARTED
- [x] Keyboard and `aria-live`. proof: `editor.playtest.json` — green 2026-10-12, see AC-3 evidence.
- [x] One encoder. proof: `test:terrain:export` Done 2026-10-12, NVIDIA Turing, private Xvfb: `cookTerrainWorld` is the only static-world GLB encoder. The browser `exportWorldGLB` and its binary branch are deleted from `packages/terrain/src/export.ts` (7 added, 53 removed), the consumer fixtures now call `prepareWorldGLTF` in the browser and cook in node, and the API surface, capability manifest, agent guide and changelog are updated. `test:terrain:export` passes, `CONSUMER_GAME=skip test:consumer` passes for five worlds, terrain and engine-mcp suites pass 409 of 409. The export lane asserts the decoded GLB structure (100 placements, 202 meshes, 404 PBR maps, 56,668 triangles, 4 materials) unchanged. Not measured: pixel equivalence of consumer renders; the exported file sizes and the saved editor export hash changed because the writer changed. Known and untouched: `@threenative/assets` typecheck fails at `terrain-world.spec.ts:471` (`unknown` passed as `number`), which is outside this change. Deleting a public export is breaking; the package is pre-1.0 and PRD-583 and this PRD both require it.
