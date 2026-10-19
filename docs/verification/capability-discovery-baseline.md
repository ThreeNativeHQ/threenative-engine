# PRD-157 Phase 0 baseline — capability discovery

Date: 2026-08-19

This is the pre-feature measurement for PRD-157. Three independent fresh authoring sessions
completed against fresh `shooter` scaffolds from the current tree. The two additional aborted
attempts are retained as execution evidence but are not counted as runs.

## Harness

The scaffold was created with the current local CLI and installed with the scaffold's published
package versions:

```sh
node packages/create-threenative/dist/index.js \
  docs/verification/.prd157-baseline-work/run-N --template shooter --no-install
pnpm install --ignore-workspace
```

Each counted session was a new non-persistent Claude Code process launched from its own project
directory. The scaffold `.mcp.json` was loaded strictly, so the session had the existing asset and
sculpt servers and no engine-capability server. The only user prompt was exactly:

> Add an enemy that patrols the level, chases the player when it sees them, and holds a rifle in its right hand.

The counted sessions used `claude --model haiku --effort low --max-budget-usd 1`; the model and
flags were identical for runs 1–3. Full `stream-json --verbose` transcripts, including tool calls
and results, are committed beside this report:

- [baseline run 1](capability-discovery-baseline-run-1.jsonl)
- [baseline run 2](capability-discovery-baseline-run-2.jsonl)
- [baseline run 3](capability-discovery-baseline-run-3.jsonl.gz)

Run 3 is stored gzip-compressed; the bytes are unchanged. Restore it with
`gzip -dc capability-discovery-baseline-run-3.jsonl.gz > capability-discovery-baseline-run-3.jsonl`.

## Measurements

LOC is counted in the newly authored entity file. “Navigation LOC” is the inclusive line range
covering the visibility scan and patrol/chase movement implementation. “A* LOC” is the count of
hand-written A* or navmesh path-solving lines; direct waypoint steering is reported separately and
is not mislabeled as A*.

| Run | Engine symbols imported for the new enemy | Navigation LOC | A* LOC | Bone-attachment LOC | Export maps inspected? |
|---|---|---:|---:|---:|---|
| 1 | `ICtx`, `ScheduleHandle`, `CharacterBody3D`, `CollisionShape3D`, `IPhysicsContext` | 66 (`Enemy.ts:55–120`) | 0 | 0 | No |
| 2 | `ICtx`, `ScheduleHandle`, `RigidBody3D`, `CollisionShape3D`, `IPhysicsContext` | 56 (`Rifleman.ts:61–116`) | 0 | 0 | No |
| 3 | `ICtx`, `ScheduleHandle`, `CharacterBody3D`, `CollisionShape3D`, `IPhysicsContext` | 55 (`Enemy.ts:60–114`) | 0 | 0 | No |

The rifle visuals were hand-built meshes rather than bone attachments: 22, 22, and 26 visual
lines respectively. No run imported `NavigationAgent3D`, `@threenative/physics/navigation`, or
`attachToBone`; no run inspected a `package.json` `exports` map. The sessions inspected installed
type declarations and existing source patterns instead.

## Baseline result

| Discovery metric | Actual baseline |
|---|---:|
| Sessions importing `@threenative/physics/navigation` or `NavigationAgent3D` | **0 / 3** |
| Sessions importing `attachToBone` | **0 / 3** |
| Sessions writing hand-written A* | **0 lines in 3 / 3** |
| Sessions writing direct patrol/chase steering | **3 / 3** |

The discovery failure reproduced: none of the three completed sessions found the navigation
subpath or attachment helper. The PRD's illustrative “roughly 200 A* lines” did not reproduce in
these runs because all three agents chose direct waypoint/chase steering; that deviation is
recorded rather than rounded up. The measured navigation implementation still stayed in game code
and the engine capabilities remained undiscovered.

## Aborted attempts, not counted

- [Opus attempt](https://github.com/ThreeNativeHQ/threenative/blob/4ce93bcd7e2568746b86564bcd4238111833d01e/docs/verification/capability-discovery-baseline-aborted-opus.jsonl): real fresh session, 69 turns,
  entered context compaction after the playtest, then was stopped; final record is
  `aborted_streaming`, cost `$7.747`.
- [Sonnet attempt](https://github.com/ThreeNativeHQ/threenative/blob/4ce93bcd7e2568746b86564bcd4238111833d01e/docs/verification/capability-discovery-baseline-aborted-sonnet.jsonl): real fresh session,
  stopped after approximately five minutes of internal reasoning before it modified the scaffold.

These attempts do not contribute to the 0/3 metrics. No feature code was changed in the engine
worktree during Phase 0.

## Checkpoint

Phase 0 is complete and provides the negative control for Phase 4. The next permitted change is
Phase 1 manifest implementation.
