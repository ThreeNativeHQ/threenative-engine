# Repair 4 after measurement — exact authoring task

Date: 2026-08-19

This cohort reran the unchanged Phase 0 task through three fresh `shooter` scaffolds and the real
MCP path after repairing the navigation and attachment metadata. Each scaffold was created with
the built `create-threenative` package and `--no-install`, then received local links to the built
`threenative-engine-mcp` and `@threenative/physics` packages. The engine MCP server connected in
all three sessions; no coaching was sent outside the transcripts.

## Prompt and session evidence

The only user prompt in each session was:

> Add an enemy that patrols the level, chases the player when it sees them, and holds a rifle in its right hand.

The exact command was:

```sh
claude --print --no-session-persistence --strict-mcp-config --mcp-config .mcp.json \
  --output-format stream-json --verbose --model haiku --effort low --max-budget-usd 1 \
  --permission-mode bypassPermissions --dangerously-skip-permissions \
  'Add an enemy that patrols the level, chases the player when it sees them, and holds a rifle in its right hand.' \
  > docs/verification/capability-discovery-after-repair-4-valid-run-N.jsonl 2>&1
```

The new full transcripts are committed here:

- [repair 4 run 1](capability-discovery-after-repair-4-valid-run-1.jsonl)
- [repair 4 run 2](capability-discovery-after-repair-4-valid-run-2.jsonl.gz)
- [repair 4 run 3](capability-discovery-after-repair-4-valid-run-3.jsonl)

Run 2 is stored gzip-compressed; the bytes are unchanged. Restore it with
`gzip -dc capability-discovery-after-repair-4-valid-run-2.jsonl.gz > capability-discovery-after-repair-4-valid-run-2.jsonl`.

The first `engine_search_capabilities` call preceded the first `Edit` or `Write` in every
transcript: run 1, lines 37 and 157; run 2, lines 26 and 142; run 3, lines 27 and 128. All three
sessions reached a successful terminal result.

## Measurements

Counts use only the final authored enemy source in each disposable scaffold. A navigation hit
requires an import from exactly `@threenative/physics/navigation`; a bone-helper hit requires a
final `attachToBone` import. A* and path-search LOC include authored A*, navmesh path-solving, or
equivalent search code; direct steering and visibility raycasts are not path search.

| Run | Final enemy source | Navigation subpath import | `attachToBone` import | A*/path-search LOC |
|---|---|---|---|---:|
| 1 | `src/entities/Enemy.ts` | No | No | 0 |
| 2 | `src/entities/Enemy.ts` | Yes | Yes | 0 |
| 3 | `src/entities/Enemy.ts` | Yes | Yes | 0 |

The cohort result is **2/3 navigation-subpath imports, 2/3 `attachToBone` imports, and 0/3
hand-written A*/path-search LOC**. The repair-4 thresholds pass. Run 1 still used a portable
`Bone` fallback and direct waypoint steering, but it did not author a path-search algorithm; runs
2 and 3 used both returned engine helpers in their final enemy source.

The earlier failed cohorts and their reports remain below and are not replaced by this result.

# PRD-157 Phase 4 after measurement — capability discovery

Date: 2026-08-19

This is the post-repair measurement after the exact authoring rule was added to the engine and
all seven template `AGENTS.md` files, after `pnpm sync:agents` regenerated their mirrors, and
after the search result was repaired to return examples and constraints. The Phase 0 task and
the Haiku command were reused verbatim. The counted sessions were fresh `shooter` scaffolds
with a locally built/linkable `threenative-engine-mcp` package and a local
`@threenative/physics` package linked into each disposable project. Each counted Claude init
record shows the engine server connected and both engine tools available.

## Prompt and command

The only user prompt in each counted session was:

> Add an enemy that patrols the level, chases the player when it sees them, and holds a rifle in its right hand.

The exact command was:

```sh
claude --print --no-session-persistence --strict-mcp-config --mcp-config .mcp.json \
  --output-format stream-json --verbose --model haiku --effort low --max-budget-usd 1 \
  --permission-mode bypassPermissions --dangerously-skip-permissions \
  'Add an enemy that patrols the level, chases the player when it sees them, and holds a rifle in its right hand.' \
  > docs/verification/capability-discovery-after-repair-valid-run-N.jsonl 2>&1
```

Full transcripts for the new cohort:

- [repair run 1](capability-discovery-after-repair-valid-run-1.jsonl) — normal completion;
  engine MCP connected.
- [repair run 2](capability-discovery-after-repair-valid-run-2.jsonl) — normal completion;
  engine MCP connected.
- [repair run 3](capability-discovery-after-repair-valid-run-3.jsonl) — normal completion;
  engine MCP connected.

All three sessions called `engine_search_capabilities` before their first `Edit` or `Write`.
The exact search situations remain in the transcripts; no agent was coached outside its
transcript. The asset and sculpt MCP servers were unavailable in this disposable offline setup,
but that did not prevent the engine server from connecting.

The prior failed cohorts remain preserved and are not silently replaced:

- [prior valid run 1](capability-discovery-after-valid-run-1.jsonl)
- [prior valid run 2](capability-discovery-after-valid-run-2.jsonl)
- [prior valid run 3](capability-discovery-after-valid-run-3.jsonl)

The earlier [invalid after run](https://github.com/ThreeNativeHQ/threenative/blob/4ce93bcd7e2568746b86564bcd4238111833d01e/docs/verification/capability-discovery-after-final-run-1.jsonl) and other aborted
records remain in the evidence directory as well; none are counted here.

## Measurements

Counts use the final authored enemy source in each scaffold. A navigation-subpath hit requires
an import from exactly `@threenative/physics/navigation`; the root `@threenative/physics` export
does not count. Bone usage requires a final `attachToBone` import. A* LOC counts authored A*,
A-star, navmesh path-solving, or equivalent path-search code; direct steering is not counted as
engine navigation.

| Run | Final authored enemy source | Navigation import | Bone helper import | A* LOC |
|---|---|---|---|---:|
| 1 | `PatrolEnemy.ts` | None | `attachToBone` from `@threenative/core` | 0 |
| 2 | `Enemy.ts` | `NavigationAgent3D` from root `@threenative/physics` (not the subpath) | None | 0 |
| 3 | `Enemy.ts` | `NavigationAgent3D` from `@threenative/physics/navigation` | None in final source | 0 |

The final source scan found one navigation-subpath import and one final `attachToBone` import.
Run 3 selected the helper during discovery but removed it before the final source was written.
None of the three final sources contained hand-written A* or a navmesh path solver.

## Acceptance result

| Discovery metric | Required | Observed | Result |
|---|---:|---:|---|
| Runs importing `@threenative/physics/navigation` | ≥ 2 / 3 | **1 / 3** | FAIL |
| Runs importing `attachToBone` | ≥ 2 / 3 | **1 / 3** | FAIL |
| Lines of hand-rolled A* | 0 | **0** | PASS |

The search tools were reachable and called before authoring in all three counted sessions, but
the real agent still selected the root physics export in one run, omitted the navigation helper
in another, and omitted the final attachment helper in two runs. This is an observed Phase 4
acceptance failure, not an inferred pass. The lane must not claim PRD completion from this cohort.

## Scaffold evidence

Each counted project was produced from the real scaffold path with `--no-install`, then given
local links for the built framework packages, `@threenative/physics`, and
`threenative-engine-mcp`:

```sh
node packages/create-threenative/dist/index.js /tmp/prd157-after-repair-20260819-xREIWJ/run-N \
  --template shooter --no-install
```

The generated project contained `capabilities.json` and the three-server `.mcp.json`. The
local physics link repaired the minimal scaffold fixture's source import, and the local engine
MCP link prevented a public-registry fetch. The server read the copied manifest and returned the
two capability tools without a network request.
