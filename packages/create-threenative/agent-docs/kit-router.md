## Authoring flow

**Two searches are mandatory. Skipping one is a defect.** Before any mechanic, helper or render stage: `engine_search_capabilities` and `engine_capability_detail`. Before any model, texture, HDRI or animation: `asset_search`, provider `threenative` first. Detail for each step: `threenative-capabilities` skill. Do the steps in order. A step with no result records `none: <reason>`. A hook blocks the first new file under `src/` until step 3 ran for the current prompt (`TN_DISCOVERY_GATE=off` opts out; Codex needs `/hooks` trust).

1. **Kit** (new game only): `engine_search_capabilities {situation: "<the whole request>", scope: "request"}` returns the matching starter kit first. This folder is already a kit.
2. **Mechanics**: per mechanic, `engine_search_references {situation}`, then `engine_reference_detail` on each hit for pinned constants and feel. `engine_watch_reference {query: "<game> <mechanic>"}` returns a contact sheet of real gameplay. Borrow mechanics only: no code, level layouts, character names or art. Cite `file:line`.
3. **Built-ins**: per mechanic, system or symptom, `engine_search_capabilities {situation, scope: "mechanic"}`; rows answer; `engine_capability_detail` only for omitted symbols. Constraints are binding. `verdict: "none"` means the game writes it in `src/`.
4. **Plan** (new game or multi-system change): `prd-creator` with the kit, references and built-ins. With a user, wait for explicit approval. With no user, record the plan and assumptions, then continue.
5. **Assets**: default to `threenative-assets` `lean` mode (Poly Haven CC0 PBR/models); `asset_search`, `asset_get`, `asset_download` (other types: `asset_search_sources`), record `CREDITS.md`. Nothing fits: `sculpt_plan`. Rigged GLB: `animation_inspect` (`threenative-assets` skill). Check `/__assets/` in `pnpm dev` (`?sheet=turntable`).
6. **Build**: gameplay in `src/`, look in `src/render/` (`threenative-context` and `threenative-ui` skills). Parallel work: one area and its files per subagent, then integrate.
7. **Prove**: one fail-closed playtest per mechanic, then `pnpm test` (`threenative-playtest` skill). A fresh judge compares a `--browser-recipe webgpu --headed` capture to the reference image (`threenative-visuals` skill; `node_modules/create-threenative/agent-docs/references/dream-loop.md`).
8. **Report**: the `pnpm dev` URL, `TN_FRAME_BUDGET`, `TN_SCENE_WARNING`, `TN_RENDER_PROJECTION`, and each skipped step with its reason.

A change to an existing game repeats steps 2-3 for that change, then steps 5-8.
