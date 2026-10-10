# PRD-587 — The terrain editor never drops an edit

**Status:** NOT STARTED
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

- [ ] AC-1 [local]: Two strokes 50 ms apart both persist to `world.json`. proof: a stroke step in `examples/strata-terrain-preview/playtests/editor.playtest.json` — Evidence: pending.
- [ ] AC-2 [local]: A save answered 409 leaves the edit in a visible "not saved" list with retry and discard. proof: `pnpm exec vitest run packages/terrain/__tests__/editor-save-queue.spec.ts` — Evidence: pending.
- [ ] AC-3 [local]: The dev server starts on a malformed `world.json`, and "reload from disk" recovers after the file is fixed. proof: `editor-document.spec.ts` case — Evidence: pending.
- [ ] AC-4 [local]: After the worker is terminated mid-build, the next edit rebuilds terrain. proof: `editor.playtest.json` step — Evidence: pending.
- [ ] AC-5 [local]: The worker's height, normal and splat buffers arrive transferred (detached on the worker side). proof: `editor-save-queue.spec.ts` or a worker spec — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Command save queue | Brush stroke → `changed()` → POST `commands` | Whole-document POST, discard while saving | AC-1, AC-2 |
| Invalid-file recovery | Dev server start → editor UI buttons | Server crash / dead-end 409 | AC-3 |

## Execution Phases

#### Phase 1: commands and the queue
**Status:** NOT STARTED
**Files:** `packages/terrain/src/editor/app.js`, `packages/terrain/src/editor/server.ts`, `packages/terrain/__tests__/editor-save-queue.spec.ts` (new)
- [ ] Rapid strokes persist. proof: `editor.playtest.json`
- [ ] Rejected edits stay visible. proof: `editor-save-queue.spec.ts`

#### Phase 2: recovery paths
**Status:** NOT STARTED
**Files:** `packages/terrain/src/editor/server.ts`, `app.js`, `worker.js`
- [ ] Malformed file starts and recovers. proof: `editor-document.spec.ts`
- [ ] Worker crash recovers. proof: `editor.playtest.json`
- [ ] Buffers transfer. proof: worker spec
