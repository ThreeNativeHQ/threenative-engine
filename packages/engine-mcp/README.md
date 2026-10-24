# threenative-engine-mcp

An offline MCP server that lets a ThreeNative authoring agent search the committed engine
capability manifest by situation and inspect one capability in detail.

The server exposes exactly two read-only tools: `engine_search_capabilities` and
`engine_capability_detail`.

First infer the concrete mechanics implied by the request. Call `engine_search_capabilities` once
with that mechanically explicit request and `scope: "request"`, then once per mechanic with
`scope: "mechanic"`. Complete requests return up to 15 deduplicated capabilities; focused
situations return up to five. A request that names a game or genre a starter kit covers (`like mario`, `zelda-style`) leads with a
`starterKits` entry carrying `npx create-threenative <dir> --template <name>`; scaffold it first, then
search the mechanics it does not cover. The kits and their words come from each `kit.json` through
the manifest's `starterKits` section (verdict `"starterKit"` when no mechanic also matched). Every result includes
`matchedSituation`, so an authoring agent can verify why it was selected instead of treating a
lexical coincidence as engine guidance.

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
