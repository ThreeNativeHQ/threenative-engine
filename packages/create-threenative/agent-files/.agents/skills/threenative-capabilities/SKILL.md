---
name: threenative-capabilities
description: Route ThreeNative authoring: the kit AGENTS.md "Authoring flow" in detail. A new game follows kit, mechanics, built-ins, plan, assets, build, prove and report; a change to an existing game searches built-ins for each change and references for each gameplay mechanic.
---

# ThreeNative authoring route

This is the critical planning prerequisite for a new game and the routing entry for a change to an
existing game. The kit `AGENTS.md` "Authoring flow" lists the same eight steps with the exact calls;
this skill holds the detail. Classify the user's intent using the current project and plan: starter
code alone does not make a new-game request an existing-game change. Ask if intent is ambiguous.
Preserve the request's distinctive fantasy and infer concrete mechanics, not just a genre label.

**Tools.** Every server named below is in this game's `.mcp.json`. A session started in this folder
has them, and they can show as deferred: load them with `ToolSearch` `select:` plus the exact names,
for example `select:mcp__threenative-engine__engine_search_capabilities,mcp__threenative-engine__engine_capability_detail,mcp__threenative-engine__engine_search_references,mcp__threenative-engine__engine_reference_detail,mcp__threenative-engine__engine_watch_reference`.
A session started elsewhere (one that ran `create-threenative`) has none of them in its tool list:
run `node node_modules/@threenative/core/mcp/call.mjs <server> <tool> '<json>'` from this folder,
and `call.mjs <server>` lists that server's tools. A tool that is missing from your list never
skips its step.

## New game

Follow steps 1-8 in order; finish steps 2 and 3 before planning. Record actual results, including
explicit `none` with a reason; a blank result blocks plan approval. A session with no user
(`claude -p`, a script) records the plan and its assumptions, then continues; an interactive session
waits for approval. A hook blocks the first new file under `src/` until step 3 ran for the current
prompt (`TN_DISCOVERY_GATE=off` opts out).

1. **Kit** — read the user's complete request and any supplied reference image. Call
   `engine_search_capabilities` with `scope: "request"` for the complete request: it returns the
   matching starter kit first, with its `npx create-threenative <dir> --template <name>` command.
   Inspect the installed `create-threenative` template `kit.json` fields and exact `--genre`
   routing. Choose a matching kit; if no kit matches, use `minimal` (`--template minimal`). Record
   the kit and why it fits. Keep the chosen kit's source as the starting point.
2. **Mechanics** — threenative-reverse-engineer is the mechanics-reference role: the
   `threenative-engine` MCP serves it through `engine_search_references` and
   `engine_reference_detail`. Search named games and the implied mechanics, inspect relevant
   matches, and record pinned sources and feel rules. For Tier-2 matches, read the pinned repo
   and use `engine_save_reference` for the nodes/cards actually walked; unavailable references
   remain `none: references unavailable`, not fabricated matches.
   A card states the numbers, never the arc. When the plan turns on how a mechanic looks moving
   (jump arc, parry window, camera lag, hit reaction), watch a reference instead of inventing the
   motion: `engine_watch_reference {query: "<game> <mechanic>", duration, frames}` returns a
   `sheet.jpg` holding every frame in order; read it, then aim with `pick`, `from` and `at` when the
   first sheet is a menu instead of gameplay. It needs `yt-dlp` and `ffmpeg`. Without the tool, fetch
   `https://raw.githubusercontent.com/ThreeNativeHQ/threenative-reverse-engineer-mcp/main/scripts/watch.mjs`
   and run it with `--duration 20 --frames 6`. Record the sheet path and the frame times with the
   references. Frames are study material, not game assets: commit none of them, and cite a
   mechanic from pinned `file:line`, never from a video. No network or no tools: record
   `none: gameplay frames unavailable`.
3. **Built-ins** — engine_capabilities built-in discovery, served by the same MCP: call
   `engine_search_capabilities` with `scope: "mechanic"` per mechanic, system or symptom; inspect
   hits with `engine_capability_detail`. Record installed capabilities and binding constraints. A
   `verdict: "none"` means game-owned behavior in `src/`; do not rephrase until something matches.
   These role names add no servers.
4. **Plan** — hand **Kit**, **Mechanics** and **References** to `prd-creator`. Plan the core loop
   from both discovery passes, with controls, camera, state, acceptance checks, target platforms
   and appearance/asset needs. With a user, get explicit approval and an instruction to implement
   before downloads or game-source edits. Required texture selection follows the plan.
5. **Assets** — use threenative-asset-mcp (configured as `threenative-assets`).
   From the mechanics matches and reference image, if provided, identify only the textures needed by the plan. Call
   `asset_search_sources`, the returned source's search/list-files tools, then
   `asset_download_file`; verify the returned licence and record downloaded paths/source/licence
   in `CREDITS.md`. Follow `.agents/skills/threenative-assets/SKILL.md`; no unrelated downloads or
   invented tool results. If no textures are required, record `none` and why. Reuse existing files.
6. **Build** — execute the plan, delegate to subagents focused on specific areas. Give each a
   bounded task, explicit file ownership, relevant context and an acceptance check; preserve other
   writers and avoid a single catch-all worker. The coordinator reviews and integrates the areas
   before step 7, resolving interfaces and failures rather than trusting worker reports. Use the
   chosen kit, discovered capabilities and downloaded textures. Keep appearance in game-owned
   `src/render/`; use stock `WorldEnvironment` defaults or explicitly report named overrides.
   Borrow mechanics only: no code, level layouts, character names or art; cite pinned `file:line`
   sources.
7. **Prove** — follow `.agents/skills/threenative-playtest/SKILL.md`. Execute a fail-closed
   scenario for each core mechanic with observable state, real input actions and assertions. An
   empty assertion set or missing observation fails; a screenshot is not mechanics proof. Repair
   failures and rerun the affected scenario. Report only platforms actually run. After mechanics
   pass, use `.agents/skills/threenative-visuals/SKILL.md` and the installed
   `node_modules/create-threenative/agent-docs/references/dream-loop.md` for the
   **Reference-image visual judge**: compare a fresh, nonblank gameplay capture against the supplied
   reference image with a fresh read-only judge. If no image was supplied, ask for a supplied
   target or an explicitly authorized image-tool route, as that existing contract requires; do not
   invent a target or choose a provider/model. A missing target, capture or judgment is unverified,
   not a pass. Require `PASS`; `REQUEST_CHANGES` and `NOT_OBSERVED` block completion. Fix and
   rejudge against the same target.
8. **Report** — give the user the `pnpm dev` URL, play from the spawn, and quote `TN_FRAME_BUDGET`,
   `TN_SCENE_WARNING` and `TN_RENDER_PROJECTION`. Name every step you skipped and why.

## Existing game

A change to an existing game skips step 1 and whole-game planning; do not invoke `prd-creator` just
to restart the game plan. For each change, search before you write:

- Step 3 for every change: `engine_search_capabilities` with `scope: "mechanic"`, then
  `engine_capability_detail` on each hit, so installed systems are reused.
- Step 2 for each gameplay mechanic the change adds or alters: `engine_search_references`, then
  `engine_reference_detail`; use `engine_watch_reference` when the motion is the question.
- Steps 5-8 for the change, using the existing game, plan and context: apply step 5 to the
  requested change (reuse current assets and download only missing required textures), step 6
  with the same ownership and acceptance checks (a coordinator, no catch-all worker), step 7 for
  affected mechanics and their related regressions (keep real captures where needed to observe the
  change), and step 8 for the change.

Ask a targeted question if essential context is missing instead of restarting discovery. If another
binding project gate conflicts, ask the user rather than silently waiving or appending it.

Returned capability constraints are binding, including `@threenative/physics/navigation` subpaths
and platform support. Use `attachToBone` for held weapons (add a portable `Bone` named `RightHand`
when needed) rather than rebuilding installed systems. If MCP
is unavailable, run `npx threenative doctor`; for a new game's capability pass, use the installed
`node_modules/create-threenative/agent-docs/references/capability-reference.md` and report missing
services honestly.
