---
name: prd-creator
description: Plan new ThreeNative games only, after kit selection plus mechanics-reference and built-in capability discovery; hand approved plans to texture selection, execution and verification.
---

# ThreeNative game PRD

Use this for new games only, at step 4 of `threenative-capabilities`, after kit selection and both
mechanics-reference and built-in capability discovery. Existing-game changes follow steps 5-7
using their existing context; do not invoke this skill to restart whole-game planning.
The outcome is a small, distinctive, playable plan grounded in both discovery passes.

## Plan

1. Inspect the existing game, its instructions, and the capability discovery record. If discovery
   is missing or the requested mechanics changed, invoke `threenative-capabilities` before drafting.
2. Preserve the request's fantasy. Define the smallest playable loop that depends on its setting,
   traversal, combat, or simulation rather than reskinning a generic character game.
3. Specify controls, camera, core mechanics, win/loss states, game state, progression, visual and
   audio direction, asset needs and licences, target platforms, performance risks, and non-goals.
4. Define fail-closed playtest acceptance criteria for the loop, including observable state and a
   real capture for visible changes. Unexecuted platforms remain unverified.
5. Record prerequisites: required tools/MCPs, service access, test users, and environment variable
   names. Use placeholders only; never read or write real secrets into planning artifacts.

Copy the three completed discovery sections into `.agent/prd/PRD.md`: **Kit**, **Mechanics**
and **References**. Each needs a value or explicit `none` with a reason; a blank or missing
section blocks approval. Required texture search/download is step 5, after plan approval;
record planned asset needs here without claiming assets have already been selected or downloaded.

Write the concise plan to `.agent/prd/PRD.md`, its short player-facing summary to
`.agent/prd/SUMMARY.md`, and implementation tasks to `.agent/tasks.json`. Tasks must be ordered,
bounded to about 10 minutes each, carry a concrete pass check, and start with `"passes": false`.
The first task verifies prerequisites and selects/downloads required textures from the mechanics
matches and supplied reference. Step 6 delegates to subagents focused on specific areas: every
bounded task names its area, file ownership and acceptance check. The coordinator reviews and
integrates all returned changes before step 7 mechanics playtests; do not use a catch-all worker.
Later tasks playtest mechanics with real actions and assertions, then require the reference-image
visual judge gate from `threenative-capabilities`. Preserve the pre-planning capability decisions
in the relevant task checks.

## Approval gate

Present the plan and direct the user to approve it or request changes. Do not edit game source,
download assets, authenticate services, or begin implementation while planning. Revise the plan
when the user gives feedback.

Start implementation only after explicit approval and a clear execution instruction such as
"execute", "implement", "build it", or an equivalent phrase. One message may contain both. After
that handoff, execute the approved tasks without silently expanding the scope; repeat capability
discovery only when the requested mechanics or target platforms change.
