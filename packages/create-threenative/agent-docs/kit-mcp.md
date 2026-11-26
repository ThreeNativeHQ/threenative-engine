## MCP servers

`.mcp.json` wires six servers, and a session started here loads them. Deferred tools: load them with `ToolSearch` `select:` plus the exact names, for example `select:mcp__threenative-engine__engine_search_capabilities,mcp__threenative-engine__engine_capability_detail`. A session started outside this folder runs `node node_modules/@threenative/core/mcp/call.mjs <server> <tool> '<json>'`; `call.mjs <server>` lists that server's tools.

- `threenative-engine`: the capability search above, and a slow frame or a wrong image. `engine_search_capabilities`, `engine_capability_detail`, `engine_search_references`, `engine_reference_detail`, `engine_watch_reference`.
- `threenative-assets`: textures, HDRIs, audio, models (`lean` default vs `detailed` AI mode). `asset_search`, `asset_get`, `asset_download`, `audio_search_assets`, `mesh_optimize`.
- `threenative-sculpt`: a bespoke mesh or character from a reference image. `sculpt_plan`, `sculpt_spec_gate`, `sculpt_compare`, `sculpt_pass_gate`.
- `threenative-animation`: a rigged GLB with a held prop, foot slide or loop seam. `animation_inspect`, `animation_attach`, `animation_verify`.
- `threenative-terrain`: any terrain, from words. `terrain_generate`.
- `threenative-devtools`: after `npx @threenative/playtest trace` names no cause. `performance_start_trace`, `performance_analyze_insight`.
