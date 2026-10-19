# PRD-450 — A FAB asset reaches the game

**Status:** COMPLETE — `threenative-asset-mcp@0.9.4` carries the phase-2/3 fixes, the engine pins it, and every acceptance criterion has evidence
**Complexity:** 4 (MEDIUM): 1–5 implementation files (+1), two independently released packages
(asset MCP on npm, engine pin) (+2), external API (Fab/FabCLI) (+1).
**Owner:** João
**Depends on:** None

## Context

On 2026-09-24 a Codex agent building a forest camp was told to "focus on assets from FAB" and
"try this for the trees" (Fab listing `c6f917b6…`, European Hornbeam). Session:
`~/.codex/sessions/2026/09/24/rollout-2026-09-24T19-06-10-01a0d650-1fbe-7153-b01b-baccae15f86c.jsonl`
(1,748 records, 29 user turns). **No Fab asset reached the game.** The Hornbeam, the only asset the
owner named, never landed, and the 10.4 GB pack was deleted. The owner's words: "are you stuck? are
you getting somewhere?" and "you put a giant trunk of wood on the scene. careful with scale".

`A/` is `/home/joao/projects/threenative/threenative-asset-mcp`, read at `origin/main` `c46be05`
(0.9.3). The friction, ranked by turns lost:

| # | What happened (count) | Root cause | State at 0.9.3 |
|---|---|---|---|
| 1 | `fab_list_owned` → `FABCLI_UNAUTHENTICATED` ×2: "OS keystore read failed … DBus error". The same `fabcli` worked from the agent's shell. Six WebView logins died on Wayland; a manual paste logged in but `ownership` still said "claim needs a Fab session" ×2. ~20 turns. | `A/src/unreal/toolchain.ts:160` forwards `DBUS_SESSION_BUS_ADDRESS` only when the MCP host's env has it. Codex launched the server without it. There is no `unix:path=$XDG_RUNTIME_DIR/bus` fallback, and the error reads "unauthenticated" when the real fault is "keystore unreachable". | open |
| 2 | `asset_import_unreal` on the Hornbeam → `UNREAL_TOOL_FAILED`: "modern UE5 asset converter exited 1 … Loaded export types: UBodySetup, UObject, UMetaData, UNavCollision, UStaticMesh". It loaded the mesh and wrote no geometry. 3 turns. | `A/src/unreal/importer.ts` (modern-converter branch, `:2095` at `c46be05`) reports the last stderr line and stops. #8/#9 fixed UE4-era packs, not this UE5 static-mesh case. | open |
| 3 | `UNREAL_DISK_SPACE`: "needs about 21 GiB … 15 GiB is free" while importing one named package. The agent hid 6.8 GB of textures behind a hand-built symlink. 2 turns. | `A/src/unreal/importer.ts:1378` sums **every file in `sourceDir`**, then doubles it. The `packages` filter is ignored. | open |
| 4 | `fab_download_free_asset` → `FAB_ACQUISITION_REQUIRED` on $0 listings already in the library ×2. | Fab's `isFree` flag lies for sponsored free listings, and the error dead-ended instead of routing to `fab_import_asset`. | **fixed in 0.9.2/0.9.3**, but the engine still pins **0.9.1** (`packages/core/package.json:85`, `packages/core/mcp/servers.mjs:41`, `packages/create-threenative/asset-mcp-tools.json:3`) |
| 5 | Two downloaded GLBs arrived ~890 units tall; the owner rejected them as "giant trunks". | The download path returns files with no size, so the agent placed centimetre-authored meshes without knowing. | open |
| 6 | `fab_search_assets` items all carried `"formats":[]`; `fab_list_filters` answered from a fallback taxonomy. Filtering `formats:["gltf"]` returned Unreal-only listings. | `A/src/fab/client.ts:340` reads formats the search payload does not carry. | open |

## Solution

Fix the four open causes in the asset MCP, publish, and move the engine's three pins in one commit.
No new tools: every fix sits inside a tool the agent already called.

1. **Keystore reachable from any MCP host.** In `childEnvironment` (`toolchain.ts`), when
   `DBUS_SESSION_BUS_ADDRESS` is unset and `$XDG_RUNTIME_DIR/bus` exists, pass
   `unix:path=$XDG_RUNTIME_DIR/bus`. When FabCLI still reports a keystore/DBus error, return a
   distinct code (`FABCLI_KEYSTORE_UNREACHABLE`) that names the missing variable. Do not report
   "unauthenticated" in that case.
2. **Disk pre-flight counts what is imported.** When `packages` is given, size only those packages
   and the files they reference.
3. **A loaded mesh that exports nothing says why.** When the modern converter exits non-zero after
   loading a `UStaticMesh`, retry through the uncooked/UE Viewer branch #9 added. If that also
   fails, return the converter's diagnostic block with the UE version and whether the mesh is
   Nanite, not just the last line.
4. **Size is reported.** Every download and import result carries each GLB's bounding-box size in
   metres. The MCP measures the size and reports it; it does not guess the author's units.
5. **No fake filters.** Drop `formats` from the advertised search filters while the payload does
   not carry it, and say so in `fab_search_assets`'s description.
6. Publish, then bump all three engine pins together and regenerate `asset-mcp-tools.json`
   (`pnpm tsx scripts/capture-asset-mcp-tools.ts`).

Consumer path: agent → `.mcp.json` → `packages/core/mcp/assets.mjs` → `launchMcpServer` (pinned
`threenative-asset-mcp`) → `fab_*` / `asset_import_unreal` → GLB under the game's
`public/assets/` → loaded by the game.

## Acceptance Criteria

- [x] AC-1 [local]: From an MCP server launched with `DBUS_SESSION_BUS_ADDRESS` stripped,
  `fab_list_owned` returns the signed-in library — proof: `A/` vitest for `childEnvironment` plus
  one live stdio call on this machine — Evidence: 2026-09-25, `env -u DBUS_SESSION_BUS_ADDRESS -u
  XDG_RUNTIME_DIR` stdio `fab_list_owned {query:"European Hornbeam"}`: 0.9.3 → `FABCLI_UNAUTHENTICATED`;
  A/ `9ff6940` build → the `c6f917b6…` listing.
- [x] AC-2 [local]: `asset_import_unreal` on the Hornbeam pack with
  `packages:["SM_EuropeanHornbeam_Forest_01"]` passes the disk pre-flight on this machine's free
  space and writes a GLB under the sandbox game's `public/assets/`, or fails with a diagnostic that
  names the UE version and cause — proof: live MCP call — Evidence: 2026-09-25, stdio call against
  the A/ `2ca39f5` build: exported 1, failed 0,
  `sandbox/fab-import-proof/assets/fab/c6f917b6/Models/SM_EuropeanHornbeam_Forest_01.glb` (127 MB with
  `maxTextureSize: 2048`). That is the game's asset source directory; `threenative build` emits it to
  `public/fab/…`. Source: the cached `MS_Hornbeam_UE4` pack, not the UE5 download that failed in the
  2026-09-24 session. Re-run on A/ `dbe7a52` (after the fresh-eyes review fixes) wrote a byte-identical
  GLB with the same `sizeMeters`.
- [x] AC-3 [local]: That GLB loads in a sandbox game, and its reported height is between 3 m and
  40 m — proof: playtest scenario asserting the loaded node's bounds — Evidence: 2026-09-25,
  `sandbox/fab-import-proof` `8a1b4ea`, `playtests/hornbeam.playtest.json` pass on build + preview
  (`--browser-recipe webgpu`, adapter nvidia turing): `fabImportHeights.hornbeam` 16.13 m, 755,677
  triangles, textures loaded 5/5, 0 console errors; `fab-import.playtest.json` control still green.
  Imported with `maxTextureSize: 2048`: the full-resolution import embeds 720 MB of PNGs and the
  page stalls at 0% (`TN_STARTUP_STALLED`, bridge never installs) while the control boots in 2.0 s.
  The game also needed `assets.exclude` for the importer's unmappable `textures/` and a raised
  `assets.budget.uncooked` for the 127 MB GLB.
- [x] AC-4 [local]: A fresh `pnpm sandbox` scaffold launches the published asset MCP version
  carrying these fixes, not 0.9.1 — proof: `tools/list` from the scaffold matches the regenerated
  `asset-mcp-tools.json` — Evidence: 2026-09-26, `threenative-asset-mcp@0.9.4` published; all three
  engine pins moved to 0.9.4 together; `capture-asset-mcp-tools.ts` installed the registry tarball
  into a clean directory and recorded 46 tools, and `TN_GOLDEN_PATH_TEMPLATES=starter pnpm
  verify:golden-path` launched the scaffold's asset server and matched that snapshot.

## Blocked on

None. 2026-09-26: `threenative-asset-mcp@0.9.4` is published and the engine pins it in all three
places, and the FabCLI session the 2026-09-24 run lacked was available for the AC-1/AC-2 calls.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Owned-asset listing/import | `fab_list_owned` / `fab_import_asset` → `childEnvironment` (`A/src/unreal/toolchain.ts`) | adds the bus fallback in place | AC-1 |
| Unreal pack import | `asset_import_unreal` → `A/src/unreal/importer.ts` pre-flight + modern-converter branch | same functions, corrected sizing and fallback | AC-2 |
| Asset size | download/import result objects | new field on existing results | AC-3 |
| Engine consumes the fixed MCP | `packages/core/mcp/servers.mjs:41` → `launch.mjs` | 0.9.1 pin → new version in all three places | AC-4 |

## Decisions

- 2026-09-25 (Claude): the "giant trunk" is fixed by reporting size, not by auto-rescaling. A
  unit guess on arbitrary Fab files is wrong often enough to hide the problem again. The engine's
  "one metre is one metre" convention applies at placement, where the game can measure the size.
- 2026-09-25 (Claude): the bus fallback also derives `/run/user/<uid>/bus`. Stripping only
  `DBUS_SESSION_BUS_ADDRESS` did not reproduce the failure, because libdbus falls back to `XDG_RUNTIME_DIR`. The Codex
  host had neither variable, so the PRD's `$XDG_RUNTIME_DIR/bus` fallback alone would not have fixed it.
- 2026-09-25 (Claude): follow-up, not in scope: a full-resolution Fab import embeds 720 MB of PNGs, which
  stalls a web game at 0%. A game should pass `maxTextureSize`. Whether the importer should default to a
  ceiling is a product call for a later PRD.
- 2026-09-25 (Claude): WebView login crashes on Wayland (`Error 71`) are FabCLI's, not the MCP's.
  They are out of scope. Fix 1 removes the need to log in again when a session already exists.

## Execution Phases

#### Phase 1: The engine runs the MCP that already has the fixes
**Status:** DONE
**Files:** `packages/core/package.json`, `packages/core/mcp/servers.mjs`,
`packages/create-threenative/asset-mcp-tools.json`, `pnpm-lock.yaml`.
- [x] All three pins move to 0.9.3 together, and the tools snapshot is regenerated from the registry. — 2026-09-25: `capture-asset-mcp-tools.ts` recorded 46 tools from the registry; the 11 pin-consuming specs pass (339 tests).
- [x] The listing from the session that returned `FAB_ACQUISITION_REQUIRED` now downloads or routes to `fab_import_asset` through the engine launcher. — 2026-09-25: stdio call via `node packages/core/mcp/assets.mjs` (0.9.3) on `97b20cea…` (fbx) returns `FAB_ACQUISITION_REQUIRED` whose message now says to call `fab_import_asset`. The Hornbeam (`c6f917b6…`, glb) returns `FAB_FORMAT_UNAVAILABLE` with no route; Phase 3 adds the route.

#### Phase 2: Owned assets work from any MCP host
**Status:** DONE
**Files:** `A/src/unreal/toolchain.ts`, `A/src/fab/fabcli.ts` (error mapping), `A/tests/`.
- [x] Bus-address fallback plus `FABCLI_KEYSTORE_UNREACHABLE`; red first with a stripped env (AC-1). — 2026-09-25, A/ `9ff6940`: stripping only `DBUS_SESSION_BUS_ADDRESS` did not reproduce (libdbus reads `XDG_RUNTIME_DIR`); stripping both reproduced the session's exact "X11 autolaunch" `FABCLI_UNAUTHENTICATED` on 0.9.3. The fallback therefore also derives `/run/user/<uid>/bus`. Red specs seen first; `unreal-import` + `fab-import` 111/111.

#### Phase 3: An Unreal pack lands in the game at a known size
**Status:** DONE — code landed in A/ (ThreeNativeHQ/threenative-asset-mcp#12, merged `b4a9ad0`) and published as `0.9.4` (`aa5296b`); the engine pins it in all three places
**Files:** `A/src/unreal/importer.ts`, `A/src/fab/api-download.ts` (size field),
`A/src/fab/client.ts` (drop `formats`), tool descriptions in `A/src/tools/*.ts`, a sandbox playtest.
- [x] Pre-flight sizes only the requested packages; red first from a fixture where the whole tree exceeds free space and one package fits. — A/ `2ca39f5`: red first (the whole-tree fixture imported instead of refusing, because the injected free space was ignored). Live on this machine the volume has 477 GB free, so the live call cannot show the old refusal; the spec carries it.
- [x] Modern-converter no-geometry retries through the UE Viewer branch, or returns the full diagnostic (AC-2). — A/ `2ca39f5`: red first on both halves, with a fake converter that prints several lines and exits 1. The cached Hornbeam is the `MS_Hornbeam_UE4` variant, which imports cleanly, so the UE5 failure path is proven by spec only.
- [x] Results report bounding-box metres; `formats` no longer advertised (AC-3). — A/ `2ca39f5`: `sizeMeters` on import models/scenes and on Fab/direct GLB downloads. Live Hornbeam import reports 9.98 × 16.13 × 8.55, matching an independent `getBounds` read. `formats` is out of the search schema, `fab_list_filters` and the docs. Also A/ `c50872f`: `FAB_FORMAT_UNAVAILABLE` on an Unreal-only listing now names its formats and routes to `fab_import_asset` (live on `c6f917b6…`).
- [x] Engine pins moved to the newly published version, tools snapshot regenerated (AC-4). — 2026-09-26: `threenative-asset-mcp@0.9.4` published from A/ main `aa5296b`; `packages/core/package.json`, `packages/core/mcp/servers.mjs` and `pnpm-lock.yaml` all at 0.9.4; `capture-asset-mcp-tools.ts` recorded 46 tools from the registry.

**Verification:** `npm run typecheck && npx vitest run` in `A/` (its only gate; no CI). In the
engine: `pnpm exec vitest run packages/create-threenative packages/core`, a `pnpm sandbox`
scaffold, and the AC-3 playtest.
