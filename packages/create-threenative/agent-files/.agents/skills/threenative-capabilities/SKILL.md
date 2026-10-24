---
name: threenative-capabilities
description: Run the one ThreeNative planning gate before prd-creator and before writing game source: kit, mechanics, references, assets and audio, look, proof.
---

# ThreeNative planning gate

This is a critical planning prerequisite. Complete this discovery record before `prd-creator`
drafts a plan and before the first `src/` write. Preserve the request's distinctive fantasy;
infer its concrete mechanics instead of replacing it with a generic genre loop.

Record these six sections in order. Each ends with a value or explicit `none` and its reason;
a blank section blocks plan approval. Search now; asset downloads wait for implementation approval.

1. **Kit** — inspect installed `create-threenative` template `kit.json` aliases and `--genre`
   routing. Record the chosen kit and why it fits, or `none` for an existing/custom game.
2. **Mechanics** — call `engine_search_capabilities` for the mechanically explicit full request
   with `scope: "request"`, then each mechanic with `scope: "mechanic"`. Inspect every relevant
   match with `engine_capability_detail`; record capabilities, binding constraints and no-matches.
   A genre label alone is not a query. A `verdict: "none"` is actionable: own that behavior in
   `src/`, without rephrasing until something matches.
3. **References** — call `engine_search_references` for the named games and each mechanic;
   inspect relevant cards and map nodes with `engine_reference_detail`. Record ids, pinned sources
   and the feel rules to borrow. For a Tier-2 result, read its repo at a pinned SHA, then call
   `engine_save_reference` with the map nodes walked and cards written. If unavailable, record
   `none: references unavailable`; keep capability discovery working.
4. **Assets and audio** — use the threenative-assets MCP: `asset_search_sources`, then the
   source's search tool (for example `polyhaven_search_assets`), and `audio_search_assets`.
   Read `.agents/skills/threenative-assets/SKILL.md` for sculpt/blender routing when needed.
   Record candidate assets, audio, licences and source links, or `none` with a reason for each.
5. **Look** — record the stock Unreal 5.8.3 defaults (`WorldEnvironment`: filmic tone curve,
   metered auto exposure) or a named override on that object with its reason. Keep appearance in
   game-owned `src/render/`; report overrides explicitly.
6. **Proof** — use `.agents/skills/threenative-playtest/SKILL.md` to plan one fail-closed
   playtest scenario per mechanic, with observable state, actions and assertions. Name the target
   platforms and capture needed for visible changes; unexecuted platforms remain unverified.

Hand this record to `prd-creator`. Reference guardrail: borrow algorithms and defaults, cite
pinned `file:line` sources, copy no code, level layouts, character names or art. Cards describe
mechanics and feel only: constants, state machines and camera rules.

The manifest is the complete public surface, including `@threenative/physics/navigation`.
Returned constraints are binding: use returned subpaths and `attachToBone` for held weapons
(add a portable `Bone` named `RightHand` when needed); never invent platform support.
If MCP is unavailable after `npx threenative doctor`, use
`node_modules/create-threenative/agent-docs/references/capability-reference.md` for the full-request
and per-mechanic pass, and record unavailable tools explicitly in the other sections.
