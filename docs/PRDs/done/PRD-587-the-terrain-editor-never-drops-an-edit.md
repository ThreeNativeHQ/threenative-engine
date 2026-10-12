# PRD-587 — The terrain editor never drops an edit

**Status:** IN PROGRESS
**Priority:** P1 — A second stroke during a save is silently rolled back and a failed save overwrites the local edit without saying what was lost (AC-1, AC-2): user work is lost.
**Complexity:** 4 (MEDIUM); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** None
**Parent:** [PRD-467](../done/PRD-467-strata-live-terrain-editor.md)
**Epic:** [Strata terrain hardening](../strata-terrain-hardening/README.md)

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

- [x] AC-1 [local]: Two strokes 50 ms apart both persist to `world.json`. proof: a stroke step in `examples/strata-terrain-preview/playtests/editor.playtest.json` — Evidence: 2026-10-12, NVIDIA Turing, private Xvfb, full `test:terrain:editor` lane green. Steps `brush-apply` and `second-stroke-50ms` are three fixed ticks apart (50 ms of simulation time at 60 Hz). `editorPersistedStrokes` is asserted per step (2 then 3, then 4 after recovery), and `verify-editor.mjs` reads the server's `world.json` after the run: its `Sculpt stroke` layer count equals the controller snapshot. Red run: a wrong expected count (999) and a four-tick spacing are both rejected. Not measured: wall-clock 50 ms.
- [x] AC-2 [local]: A save answered 409 leaves the edit in a visible "not saved" list with retry and discard. proof: a playtest that forces a 409 and reads the rendered not-saved list — Evidence: 2026-10-12, same green lane. `editor-conflict.playtest.json` now runs from `verify-editor.mjs` on the conflict fixture: a refused stroke shows in the rendered not-saved list, retry keeps it listed, and a discard click leaves `editorUnsentCount` at 0 with `editorPersistedStrokes` unchanged. 17 deliberately wrong conflict expectations are rejected (red run). Unit spec `editor-save-queue.spec.ts` 22/22 stays as the node-level proof.
- [x] AC-3 [local]: The dev server starts on a malformed `world.json`, and "reload from disk" recovers after the file is fixed. proof: `editor-document.spec.ts` case — Evidence: 9/9 passed; malformed start reports a diagnostic, reload recovers, and restore is refused when the file was never valid.
- [x] AC-4 [local]: After the worker is terminated mid-build, the next edit rebuilds terrain. proof: `editor.playtest.json` step — Evidence: 2026-10-12 GREEN. `pnpm --filter strata-terrain-preview test:terrain:editor` exit 0 on a private Xvfb with the real NVIDIA adapter (nvidia/turing), host load 12. Steps: the scenario cancels a 513² build that a heavy erosion layer keeps running for about 6 s (the runner's per-step settling alone took about 3 s, longer than the 1.95 s plain build, which is why the first cancel click found no button), asserts `editorWorkerBusy` true then false, `editorBuildCancelled` true, then returns the preview to 129² and applies a stroke: `editorRebuiltAfterCancel` true.
- [x] AC-5 [local]: The worker's height, normal and splat buffers arrive transferred (detached on the worker side). proof: `editor-save-queue.spec.ts` or a worker spec — Evidence: 2026-10-11 RED against prior worker: expected 3 transfer buffers, got 0. GREEN: `editor-save-queue.spec.ts` 24/24 and `terrain-consumer.spec.ts` 18/18. Source and built worker each evaluate twice: 6 height/normal/splat buffers detach (byteLength 0), receiver arrays stay populated; normals match `bakeMesh`. Terrain build/publint and strict typecheck pass.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Command save queue | Brush stroke → `changed()` → POST `commands` | Whole-document POST, discard while saving | AC-1, AC-2 |
| Invalid-file recovery | Dev server start → editor UI buttons | Server crash / dead-end 409 | AC-3 |

## Execution Phases

#### Phase 1: commands and the queue
**Status:** PARTIAL — queue wired and refused-edit list implemented with Node coverage; browser runtime proof pending
**Files:** `packages/terrain/src/editor/app.js`, `packages/terrain/src/editor/saveQueue.ts` (new), `packages/terrain/src/editor/server.ts`, `packages/terrain/__tests__/editor-save-queue.spec.ts` (new)
- [x] Rapid strokes persist. proof: `editor.playtest.json` — green 2026-10-12, see AC-1 evidence.
- [x] Refused edits are kept and never resent. proof: `editor-save-queue.spec.ts` — 22/22 passed in isolation; ordered journal, retry/discard, whole-document rebase against the latest confirmed document, and incompatible replay refusal. Browser integration remains uncommitted and unverified. Browser integration verified 2026-10-12: Evidence: 2026-10-12, same green lane. The conflict fixture counts commit writes per intent (3, 2, 1 across the three intents): one retry per refused intent and no resend of a listed intent, asserted as `editorCommitWrites`. Unit spec 22/22.

#### Phase 2: recovery paths
**Status:** PARTIAL — malformed-file recovery and never-valid restore guard landed; worker/playtest deferred
**Files:** `packages/terrain/src/editor/server.ts`, `app.js`, `worker.js`
- [x] Malformed file starts and recovers. proof: `editor-document.spec.ts` — 9/9 passed. `restore` now refuses when the document was never valid.
- [x] Worker crash recovers. proof: `editor.playtest.json` — 2026-10-12 `test:terrain:editor` exit 0 (see AC-4).
- [x] Buffers transfer. proof: worker spec — 2026-10-11, 24/24 queue/worker tests; source + built entry, 2 evaluations each, 3 detached buffers each; normals are generated by `bakeMesh`, not fabricated zeros.

## Execution notes

2026-10-10: offline frozen dependencies installed in the isolated durability checkout; `pnpm prd:progress` runs (1/5 acceptance criteria verified). Server recovery/controller changes are the accepted phase: malformed startup remains diagnostic/read-only, reload recovers a repaired file, atomic restore requires a genuinely previously valid state. Independently ran `editor-document.spec.ts` (9/9).

The command queue, UI recovery controls and worker edits remain an uncommitted draft, excluded from the server-phase commit. Three reviewed incomplete fixes led to an explicitly approved narrower intent-journal replan. That arm reproduced discard losing sibling rejected edits, then added an ordered journal and reload/restore guards. Independently ran `editor-save-queue.spec.ts`, `editor-document.spec.ts`, `terrain-consumer.spec.ts` (43/43 total); edited JS syntax checks pass. Arm ran terrain build/publint and Biome successfully. These units do not prove the rendered editor lifecycle. Queue review remains open for reload-response races, queued whole-document saves after an external conflict, and synchronising replayed merged state with the editable terrain. AC-1/AC-2/AC-4/AC-5 and the queue phase remain open; no playtest has been run.

Parent integration: the initial focused run loaded stale terrain output (7/9), then rebuilding exposed premature recovery callbacks passed to the unchanged UI. Removed only those two mount bindings; the controller methods remain available. Rebuilt terrain successfully, including declarations/publint, then independently passed all 9 document recovery tests. UI bindings remain part of the isolated durability draft.

2026-10-10 follow-up: reproduced a queued whole-document save dropping an unrelated remote layer after an earlier 409 rebase, then fixed transaction construction to reuse the existing three-way merge. A real remote layer removal also reproduces an incompatible queued toggle; transaction-construction errors now retain that intent as refused and let the queue settle. Queue units are 22/22; focused strict source/spec typechecks pass. These checks cover the isolated queue only. Reload/restore response races, editable-terrain synchronisation, browser evidence and worker transfer/restart proof remain open.

2026-10-10 queue review correction: both adopted-snapshot regressions fail against the prior queue (remote amplitude 3 replaces newer amplitude 11), including a queued config intent. Recording against the displayed confirmed snapshot plus replayed journal preserves remote ownership; later edits remain separate intents. Removed the unused command coalescer. Independently reran queue units (22/22), focused strict source/spec typecheck and Biome (pass with existing complexity warnings). Browser wiring and runtime acceptance remain open.

2026-10-10 parent queue integration: the adopted-remote-layer regression and queued-config variant now preserve the latest remote amplitude (11 rather than stale 3). Both queue commits are integrated locally; terrain build/declarations/publint and 45 queue/document/consumer tests pass (815 ms). The unused coalescer was removed. This proves the standalone journal, not the rendered editor; rapid strokes, retry/discard UI, reload races and real worker transfer/restart remain open.

2026-10-11 AC-1 integration: wired the existing ordered SaveQueue into the typed editor; removed save-time pointer/keyboard guards and the control lock. RED: the new editor integration spec persisted only the first of two sculpt strokes 50 ms apart. GREEN: 25/25 durability/queue/worker specs; terrain strict typecheck and build/publint pass. The editor scenario now applies two strokes three fixed ticks apart and reads their persisted count through the document GET route. Example strict tsc and scoped Biome pass (complexity warnings only). Generated capability/API sync produced no tracked drift. Browser AC-1 remains open for the coordinator.

2026-10-11 AC-2 integration: added a typed-DOM Not saved panel with native Retry/Discard buttons, failure announcements through the existing live region, and focus restoration when an item disappears. Discard replays surviving intents into editable terrain. RED: a real stale-revision refusal had no rendered panel and no functioning discard button. GREEN: 33/33 focused durability/queue/source specs, including real document-authority 409s, retry persistence, sibling-preserving discard and fixture transport; terrain strict typecheck, build/publint, example strict tsc and scoped Biome pass. The example-only conflict fixture makes exactly two outgoing writes stale; the real HTTP server must produce both 409s. The new editor-conflict scenario reads list text, buttons and visibility, then retries. No package test backdoor was added. AC-2 remains open until the coordinator runs the browser scenario.

2026-10-12 cancellation timing investigation: the 513² build stayed busy for 1,951 ms (648 ms CPU worker), but the start-build observation arrived 3,193 ms after dispatch because the scenario subject never resolves to an entity and incurs 30 display-frame settling attempts. Removing the subject reached cancellation in 207 ms but exposed stale render-backed observations throughout the scenario, so that change was reverted. The proof now seeds a disabled hydraulic erosion fixture, enables it before the resolution change, retains the cancel click and all assertions, and disables it as the next edit to trigger worker recreation. The fourth GPU lane stopped before the scenario because the initial fixture exceeded the 200,000-droplet recipe limit; corrected to 200,000 droplets / 128 steps. CPU evaluation accepts the corrected fixture and takes 2,163 ms at 129² and 5,866 ms at 513²; scoped Biome, syntax and diff checks pass. The four-run GPU budget is exhausted, so the corrected editor lane and AC-4 remain unverified. Captures were redirected to /tmp; the probe script and captures were removed.


2026-10-12 supersedes the cancellation-timing note above: the corrected editor lane (seeded 200,000-droplet / 128-step erosion layer enabled before the resolution change) ran green headless on the real NVIDIA adapter, so AC-4 and the persistence and conflict boxes carry their evidence above.