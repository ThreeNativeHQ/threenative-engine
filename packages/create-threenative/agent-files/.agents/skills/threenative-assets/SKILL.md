---
name: threenative-assets
description: Find, import, license, or sculpt assets for a portable ThreeNative game. Use when the game needs textures, materials, HDRIs, sounds, or models, when importing an owned Fab or Unreal pack, or when sculpting bespoke geometry from a reference image.
---

# ThreeNative assets and sculpting

Use tools for conventional textures, materials, HDRIs, sounds, and models; write bespoke visuals
in `src/render/`. Start the session from the game root so the project-scoped MCP config is read.

1. Run `asset_search_sources` to learn what is reachable, then search with
   `polyhaven_search_assets`, `ambientcg_search_assets`, or `audio_search_assets`.
2. List files with `polyhaven_list_files`/`ambientcg_list_files` before downloading; read the
   license and choose a sane resolution.
3. Download with `asset_download_file`/`audio_download_asset` and `acceptLicense: true`; tools
   write to the configured project directory.
4. Add file, source, license, and URL to `CREDITS.md`. Never state a license not returned by a tool.

Many Fab listings are Unreal-only rather than ready-to-load GLBs. Search with `fab_search_assets`,
check owned listings with `fab_list_owned`, then use `fab_import_asset` to download and convert an
owned listing; use `asset_import_unreal` for an already-downloaded local pack. Both write textured
`.glb` files under `assets/`. If they report `UNREAL_SOURCE_UNCOOKED`, stop: source editor assets
need Unreal Editor export and cannot be recovered by retrying the converter.

If FabCLI needs a session, proactively run `fabcli auth login`. Use Claude browser, or Codex's
`chrome:control-chrome`, to complete the login with the user's active browser session, then retry
the MCP call. If the WebView login fails (it crashes on Wayland), use the `--manual` pty flow in
the reference below. Never read, copy, print, or persist browser cookies or tokens. The MCP checks
entitlement and accepts only Fab Standard or CC-BY; it never claims or buys. Full arguments:
`node_modules/create-threenative/agent-docs/references/finding-assets.md`.

For a bespoke animated creature, follow `node_modules/create-threenative/agent-docs/references/creating-creatures.md`. Call the five
`creature_*` tools through the project asset server, keep the editable spec and claims in
`.threenative/creatures/`, compile into the configured `assets/` source, and get independent
visual review before delivery. `creature_status` distinguishes compile-only availability from
optional preview/check dependencies; an unavailable renderer is not approval.

For a humanoid that needs a skeleton or more motion, follow `node_modules/create-threenative/agent-docs/references/rigging-characters.md`.
Inspect first with `asset_inspect_rig` (a local GLB or the pinned `aether-02` sample), auto-rig an
unrigged biped with `asset_auto_rig` (or pass explicit landmarks when it returns a correction
request), select donors with `asset_retarget_animations` (in-place by default; `root_motion` only
from the matching `_RM` donor), and confirm the result with `asset_preview_animation` on a
nonblank contact sheet before cooking. The 18-bone AETHER sample has no fingers or toes; the
tools report those absent roles instead of inventing them.

Choose the sculpt branch before coding: conventional → asset tools; trivial → portable geometry;
bespoke with a reference → `sculpt_plan`, `sculpt_spec_gate` until every region passes, one
factory per pass in `src/render/`, then `sculpt_compare` and `sculpt_pass_gate` against a real
capture; bespoke without a reference → read `node_modules/create-threenative/agent-docs/references/dream-loop.md` and acquire a
user-supplied or explicitly authorized target before sculpting. Use `node scripts/reference.mjs`
only when the user selected its provider/model; never invent a reference or hide a missing key.
`sculpt_grimoire` supplies techniques. `threenative-sculpt-mcp` guides source and never launches
a browser. A missing/blank capture fails; credit the reference before the turn ends. See
`node_modules/create-threenative/agent-docs/references/sculpt-from-a-reference.md`.
