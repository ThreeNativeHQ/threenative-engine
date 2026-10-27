---
name: threenative-capabilities
description: Route ThreeNative authoring: new games follow prompt, kit, mechanics discovery, plan, textures, execution, mechanics playtest and reference-image judge; existing games use steps 5-7 only.
---

# ThreeNative authoring route

This is the critical planning prerequisite for a new game and the routing entry for an existing
game. Classify the user's intent using the current project and plan: starter code alone does not
make a new-game request an existing-game change. Ask if intent is ambiguous.
Preserve the request's distinctive fantasy and infer concrete mechanics, not just a genre label.

**Tools.** Every server named below is in this game's `.mcp.json`, and a host loads it only for a
session started in this folder. A session started elsewhere (one that ran `create-threenative`)
has none of them in its tool list: run `node node_modules/@threenative/core/mcp/call.mjs <server>
<tool> '<json>'` from this folder, and `call.mjs <server>` lists that server's tools. A tool that
is missing from your list never skips its step.

## New game

Follow steps 1-8 in order; finish both discovery passes before planning. Record actual results,
including explicit `none` with a reason; a blank discovery result blocks plan approval.

1. **Prompt** — read the user's complete request and any supplied reference image.
2. **Starter kit** — inspect installed `create-threenative` template `kit.json` fields and exact
   `--genre` routing. Choose a matching kit; if no kit matches, use `minimal` (`--template minimal`).
   Record the kit and why it fits. Keep the chosen kit's source as the starting point.
3. **Mechanics discovery** — threenative-reverse-engineer is the mechanics-reference role:
   the current `threenative-engine` MCP serves it through `engine_search_references` and
   `engine_reference_detail`. Search named games and the implied mechanics, inspect relevant
   matches, and record pinned sources and feel rules. For Tier-2 matches, read the pinned repo
   and use `engine_save_reference` for the nodes/cards actually walked; unavailable references
   remain `none: references unavailable`, not fabricated matches.
   PLUS engine_capabilities built-in discovery, served by that same MCP: call
   `engine_search_capabilities` with `scope: "request"` for the complete mechanically explicit
   request, then `scope: "mechanic"` per mechanic; inspect hits with `engine_capability_detail`.
   Record installed capabilities and binding constraints. A `verdict: "none"` means game-owned
   behavior in `src/`; do not rephrase until something matches. These role names add no servers.
4. **Core-mechanics plan** — hand **Kit**, **Mechanics** and **References** to `prd-creator`.
   Plan the core loop from both discovery passes, with controls, camera, state, acceptance checks,
   target platforms and appearance/asset needs. Get explicit approval and an instruction to
   implement before downloads or game-source edits. Required texture selection follows the plan.
5. **Required textures** — use threenative-asset-mcp (configured as `threenative-assets`). From
   the mechanics matches and reference image, if provided, identify only the textures needed by
   the plan. Call `asset_search_sources`, the returned source's search/list-files tools, then
   `asset_download_file`; verify the returned licence and record downloaded paths/source/licence
   in `CREDITS.md`. Follow `.agents/skills/threenative-assets/SKILL.md`; no unrelated downloads or
   invented tool results. If no textures are required, record `none` and why. Reuse existing files.
6. **Execute** — execute plan, delegate to subagents focused on specific areas. Give each a
   bounded task, explicit file ownership, relevant context and an acceptance check; preserve other
   writers and avoid a single catch-all worker. The coordinator reviews and integrates the areas
   before step 7, resolving interfaces and failures rather than trusting worker reports. Use the
   chosen kit, discovered capabilities and downloaded textures. Keep appearance in game-owned `src/render/`; use stock
   `WorldEnvironment` defaults or explicitly report named overrides. Borrow mechanics only:
   no code, level layouts, character names or art; cite pinned `file:line` sources.
7. **Mechanics playtest** — follow `.agents/skills/threenative-playtest/SKILL.md`. Execute a
   fail-closed scenario for each core mechanic with observable state, real input actions and
   assertions. An empty assertion set or missing observation fails; a screenshot is not mechanics
   proof. Repair failures and rerun the affected scenario. Report only platforms actually run.
8. **Reference-image visual judge** — after mechanics pass, use
   `.agents/skills/threenative-visuals/SKILL.md` and the installed
   `node_modules/create-threenative/agent-docs/references/dream-loop.md`: compare a fresh, nonblank
   gameplay capture against the supplied reference image with a fresh read-only judge. If no
   image was supplied, ask for a supplied target or an explicitly authorized image-tool route,
   as that existing contract requires; do not invent a target or choose a provider/model.
   A missing target, capture or judgment is unverified, not a pass. Require `PASS`;
   `REQUEST_CHANGES` and `NOT_OBSERVED` block completion. Fix and rejudge against the same target.

## Existing game

Use steps 5-7 only, with the existing game, plan, mechanics matches and reference context.
Do not repeat kit selection, mechanics discovery or whole-game planning; do not invoke
`prd-creator` just to restart the game plan. Do not add step 8 to this route. If another binding
project gate conflicts, ask the user rather than silently waiving or appending it.

5. **Required textures** — apply new-game step 5 to the requested change using existing context;
   reuse current assets and download only missing required textures. Ask a targeted question if
   essential context is missing instead of restarting discovery.
6. **Execute** — delegate to subagents focused on specific areas with bounded tasks and file ownership,
   using the existing game and plan. The coordinator reviews and integrates their changes before step 7;
   preserve established mechanics, assets, appearance choices and binding capability constraints.
   Apply the same step-6 ownership and acceptance checks above; do not restart planning or use a catch-all worker.
7. **Mechanics playtest** — execute step 7 for affected mechanics and their related regressions.
   Keep real captures where needed to observe the change; do not substitute them for assertions.

Returned capability constraints are binding, including `@threenative/physics/navigation` subpaths
and platform support. Use `attachToBone` for held weapons (add a portable `Bone` named `RightHand`
when needed) rather than rebuilding installed systems. If MCP
is unavailable, run `npx threenative doctor`; for a new game's capability pass, use the installed
`node_modules/create-threenative/agent-docs/references/capability-reference.md` and report missing
services honestly. Existing games keep their existing context and requested 5-7 route.
