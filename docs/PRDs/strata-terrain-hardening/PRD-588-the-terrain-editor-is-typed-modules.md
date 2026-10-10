# PRD-588 — The terrain editor is typed modules, not one 1481-line closure

**Status:** NOT STARTED
**Priority:** P2 — `app.js` stays untyped, string-built and mouse-only until AC-1 to AC-5 land; it slows every editor fix after PRD-587.
**Complexity:** 5 (MEDIUM); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-587](PRD-587-the-terrain-editor-never-drops-an-edit.md) (lands its save model first, so the port moves settled code)
**Parent:** [PRD-467](../done/PRD-467-strata-live-terrain-editor.md)
**Epic:** [Strata terrain hardening](README.md)

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

- [ ] AC-1 [local]: `src/editor/` has no `.js` source and passes `tsc` strict. proof: `pnpm --filter @threenative/terrain typecheck` — Evidence: pending.
- [ ] AC-2 [local]: No `innerHTML` assignment remains in `src/editor/`. proof: a spec that greps the source — Evidence: pending.
- [ ] AC-3 [local]: Every tool is reachable and usable by keyboard, and errors are announced through an `aria-live` region. proof: `editor.playtest.json` keyboard steps — Evidence: pending.
- [ ] AC-4 [local]: Picking, gizmo and brush mechanics live in the package; the example keeps only appearance. proof: `pnpm tsx scripts/count-loc.ts` before/after plus `pnpm --filter strata-terrain-preview test:terrain:editor` — Evidence: pending.
- [ ] AC-5 [local]: Small routes reject a 10 MiB body with 413, and error responses carry no document snapshot. proof: `editor-document.spec.ts` cases — Evidence: pending.
- [ ] AC-6 [local]: The editor's export uses `cookTerrainWorld`, and `exportWorldGLB` is deleted or names its remaining caller. proof: `pnpm --filter strata-terrain-preview test:terrain:export` — Evidence: pending.

## Execution Phases

#### Phase 1: typed and split
**Status:** NOT STARTED
**Files:** `packages/terrain/src/editor/app.js` → `app/*.ts`
- [ ] Strict TS, no JS. proof: typecheck
- [ ] No `innerHTML`. proof: grep spec

#### Phase 2: mechanics move, server hygiene
**Status:** NOT STARTED
**Files:** `editorView.ts`, `selection.ts` (example) → `packages/terrain/src/editor/`; `server.ts`
- [ ] Mechanics in package. proof: count-loc + editor script
- [ ] Route limits and slim errors. proof: `editor-document.spec.ts`

#### Phase 3: keyboard, one encoder
**Status:** NOT STARTED
- [ ] Keyboard and `aria-live`. proof: `editor.playtest.json`
- [ ] One encoder. proof: `test:terrain:export`
