# threenative-engine-mcp

The ThreeNative planning gate uses this MCP server to discover engine capabilities and classic-game
mechanics. Start with the installed `threenative-capabilities` skill, then `prd-creator`; the skill
owns the discovery order and plan record.

The server exposes `engine_search_capabilities`, `engine_capability_detail`,
`engine_search_references`, `engine_reference_detail`, and `engine_save_reference`.
Capability search works offline. Full requests use `scope: "request"` (up to 15 deduplicated
matches); mechanic searches use `scope: "mechanic"` (up to five). Inspect `matchedSituation`
and the detail constraints before implementing. A `none` capability result includes up to three
reference suggestions.

First infer the concrete mechanics implied by the request. Call `engine_search_capabilities` once
with that mechanically explicit request and `scope: "request"`, then once per mechanic with
`scope: "mechanic"`. Complete requests return up to 15 deduplicated capabilities; focused
situations return up to five. A request that names a game or genre a starter kit covers (`like mario`, `zelda-style`) leads with a
`starterKits` entry carrying `npx create-threenative <dir> --template <name>`; scaffold it first, then
search the mechanics it does not cover. The kits and their words come from each `kit.json` through
the manifest's `starterKits` section (verdict `"starterKit"` when no mechanic also matched). Every result includes
`matchedSituation`, so an authoring agent can verify why it was selected instead of treating a
lexical coincidence as engine guidance.

Reference search reads a gzipped stub index; detail fetches one pinned game's map and cards lazily.
The source is the latest release of [threenative-reverse-engineer-mcp](https://github.com/ThreeNativeHQ/threenative-reverse-engineer-mcp),
separate CC-BY 4.0 data. Downloads validate before replacing the cache in
`$XDG_CACHE_HOME/threenative/refs` (default `~/.cache/threenative/refs`), refresh with ETags, and
work offline from that cache. The index has a 5-second fetch budget; game files have 30 seconds,
including their response bodies. `THREENATIVE_REFERENCES_URL` overrides the release asset base URL;
`THREENATIVE_REFERENCES_CACHE` overrides the cache directory. Without network or cache, tools report
`references unavailable` and capability discovery keeps working.

Saved references live in the game's `.threenative/refs/<game-id>.json`. Local entries take priority;
published entries without a local override remain searchable and loadable, with their own pinned SHA.
Successive local saves merge by id at the same commit SHA. A conflicting SHA is rejected without changing the saved file.
The save tool returns a `gh issue create` command for a POSIX shell; run it in that shell.
It does not send the contribution. Reference guardrail: mechanics and feel only, with pinned
`file:line` sources; no code, level layouts, character names or art.

## Which manifest the server reads

The first that exists wins, so the manifest can never drift from the engine the project runs:

1. `THREENATIVE_CAPABILITIES_MANIFEST` — an explicit override, resolved against the working
   directory.
2. `node_modules/@threenative/core/capabilities.json` — found by walking up from the working
   directory. The installed package ships the manifest its own build generated, so it always
   describes the engine the project actually links; it moves exactly when the dependency does.
3. `packages/core/capabilities.json` — found by walking up from the running server file, which
   answers from the engine repository's own generated manifest when the server is launched from
   the repository rather than from an installed package.
4. `capabilities.json` in the working directory — the original default, kept for a bare checkout
   with a committed copy and no installed engine package.

A project copy committed at scaffold time is therefore inert whenever the package is installed:
the two never need re-syncing by hand.

## The call log

Every tool call appends one JSON line to `.threenative/engine-mcp.log` in the launch directory, so
a finished session's searches can be read back:

```json
{"time":"2026-09-14T20:20:00.000Z","results":["MultiMesh3D"],"scope":"mechanic","situation":"spawn many identical props","tool":"engine_search_capabilities","verdict":"matched"}
```

A rejected call is logged with its `error`, which is where an agent asked for something the engine
could not answer. `THREENATIVE_ENGINE_MCP_LOG` names another file, or `off` to disable the log. A
log that cannot be written reports once on stderr and never fails a tool call.
