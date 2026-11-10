## MCP servers

`.mcp.json` wires six servers, and a session started in this folder loads them. Their tools can show as deferred: load them with `ToolSearch` `select:` plus the exact names, for example `select:mcp__threenative-engine__engine_search_capabilities,mcp__threenative-engine__engine_capability_detail,mcp__threenative-engine__engine_search_references,mcp__threenative-engine__engine_reference_detail,mcp__threenative-engine__engine_watch_reference`. A session started outside this folder runs `node node_modules/@threenative/core/mcp/call.mjs <server> <tool> '<json>'`; `call.mjs <server>` lists that server's tools.

- `threenative-engine`: before any new mechanic, helper or render stage, and on a slow frame or a wrong image. `engine_search_capabilities`, `engine_capability_detail`, `engine_search_references`, `engine_reference_detail`, `engine_watch_reference`.
- `threenative-assets`: a texture, HDRI, sound or model. `asset_search_sources`, `asset_download_file`, `audio_search_assets`, `mesh_optimize`.
- `threenative-sculpt`: a bespoke mesh or character from a reference image. `sculpt_plan`, `sculpt_spec_gate`, `sculpt_compare`, `sculpt_pass_gate`.
- `threenative-animation`: a rigged GLB with a held prop, foot slide or loop seam. `animation_inspect`, `animation_attach`, `animation_verify`.
- `threenative-terrain`: any terrain, from words. `terrain_generate`.
- `threenative-devtools`: after `npx @threenative/playtest trace` names no cause. `performance_start_trace`, `performance_analyze_insight`.
