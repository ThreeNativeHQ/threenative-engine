# PRD-587 — The terrain editor never drops an edit

**Status:** IN PROGRESS
**Priority:** P1 — A second stroke during a save is silently rolled back and a failed save overwrites the local edit without saying what was lost (AC-1, AC-2): user work is lost.
**Complexity:** 4 (MEDIUM); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** None
**Parent:** [PRD-467](../done/PRD-467-strata-live-terrain-editor.md)
**Epic:** [Strata terrain hardening](README.md)

## Context

Editor audit of `2d2124792` (2026-10-10), `packages/terrain/src/editor/`:

- `app.js:360-393` (`changed()`) POSTs the whole document on every edit and waits. While a save
  is in flight, a new edit is reverted with `terrain.loadJSON(saved…)` and the toast "Wait for the
  current save" (`app.js:362-367`). The keyboard handler drops undo/redo the same way (`app.js:1013`).
- On a failed save (`app.js:379-392`) the editor refetches and replaces the local edit with no
  record of what was lost.
- A malformed `world.json` at startup throws in the `TerrainEditorDocument` constructor
  (`server.ts:156-160`) and takes down the Vite dev server. After a later bad external save,
  `commit` answers 409 "restore a valid save before editing" (`server.ts:187-188`), and the UI
  offers no way to restore.
- A crashed worker stays referenced; the next `build()` posts to it (`app.js:106-160`), and its
  error text ("Serve the source over HTTP…", `app.js:154`) names the wrong cause.
- The worker returns the evaluated state by structured clone with no transfer list
  (`worker.js:13`), so every build copies every typed array.
- The server already accepts `commands` (`upsert`, `update`, `remove`, `move`, `toggle`), but the
  browser sends whole documents.

## Solution

Queue edits in the browser and send them as `commands`, coalesced, with the last-known revision.
A conflict rebases the queued commands on the new revision and retries once. A rejected command
stays in a visible "not saved" list with retry and discard. The server starts on a malformed file
in a read-only diagnostic state, and the UI offers "reload from disk" and "overwrite disk with
the last valid state". The worker is recreated after a crash. Typed arrays transfer.

## Acceptance Criteria

- [ ] AC-1 [local]: Two strokes 50 ms apart both persist to `world.json`. proof: a stroke step in `examples/strata-terrain-preview/playtests/editor.playtest.json` — Evidence: pending. Not run this arm (playtest deferred).
- [ ] AC-2 [local]: A save answered 409 leaves the edit in a visible "not saved" list with retry and discard. proof: a playtest that forces a 409 and reads the rendered not-saved list — Evidence: untested UI. `editor-save-queue.spec.ts` (20/20) proves each refused edit stays in `unsent`, discarding one keeps the others, and retry/discard behave, but no test drives the rendered list, so this stays open.
- [x] AC-3 [local]: The dev server starts on a malformed `world.json`, and "reload from disk" recovers after the file is fixed. proof: `editor-document.spec.ts` case — Evidence: 9/9 passed; malformed start reports a diagnostic, reload recovers, and restore is refused when the file was never valid.
- [ ] AC-4 [local]: After the worker is terminated mid-build, the next edit rebuilds terrain. proof: `editor.playtest.json` step — Evidence: pending. Not run this arm (worker/playtest deferred).
- [ ] AC-5 [local]: The worker's height, normal and splat buffers arrive transferred (detached on the worker side). proof: `editor-save-queue.spec.ts` or a worker spec — Evidence: pending. Fabricated `state.normal` zeros deleted; transfer list kept for the next phase.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Command save queue | Brush stroke → `changed()` → POST `commands` | Whole-document POST, discard while saving | AC-1, AC-2 |
| Invalid-file recovery | Dev server start → editor UI buttons | Server crash / dead-end 409 | AC-3 |

## Execution Phases

#### Phase 1: commands and the queue
**Status:** PARTIAL — queue, config/whole-document fallback and refused-edit list landed; rapid-stroke and refused-list UI playtests deferred
**Files:** `packages/terrain/src/editor/app.js`, `packages/terrain/src/editor/saveQueue.ts` (new), `packages/terrain/src/editor/server.ts`, `packages/terrain/__tests__/editor-save-queue.spec.ts` (new)
- [ ] Rapid strokes persist. proof: `editor.playtest.json` — not run this arm.
- [ ] Refused edits are kept and never resent. proof: `editor-save-queue.spec.ts` — 17/17 passed; local-observation diffs, coalesce fix, config/asset as whole document, one 409 rebase-retry that merges unrelated external edits, per-field whole-document rebase, adopt-during-save, retry, and discard (no resend).

#### Phase 2: recovery paths
**Status:** PARTIAL — malformed-file recovery and never-valid restore guard landed; worker/playtest deferred
**Files:** `packages/terrain/src/editor/server.ts`, `app.js`, `worker.js`
- [x] Malformed file starts and recovers. proof: `editor-document.spec.ts` — 9/9 passed. `restore` now refuses when the document was never valid.
- [ ] Worker crash recovers. proof: `editor.playtest.json` — not run this arm.
- [ ] Buffers transfer. proof: worker spec — deferred; fabricated `state.normal` zeros deleted.

## Execution notes

2026-10-10: offline frozen dependencies installed in the isolated durability checkout; `pnpm prd:progress` runs (1/5 acceptance criteria verified). Server recovery/controller changes are the accepted phase: malformed startup remains diagnostic/read-only, reload recovers a repaired file, atomic restore requires a genuinely previously valid state. Independently ran `editor-document.spec.ts` (9/9).

The command queue, UI recovery controls and worker edits remain an uncommitted draft, excluded from the server-phase commit. Three reviewed incomplete fixes led to an explicitly approved narrower intent-journal replan. That arm reproduced discard losing sibling rejected edits, then added an ordered journal and reload/restore guards. Independently ran `editor-save-queue.spec.ts`, `editor-document.spec.ts`, `terrain-consumer.spec.ts` (43/43 total); edited JS syntax checks pass. Arm ran terrain build/publint and Biome successfully. These units do not prove the rendered editor lifecycle. Queue review remains open for reload-response races, queued whole-document saves after an external conflict, and synchronising replayed merged state with the editable terrain. AC-1/AC-2/AC-4/AC-5 and the queue phase remain open; no playtest has been run.
