---
name: unreal-calibration
description: Run ThreeNative's Unreal calibration experiment - build a scene in stock Unreal Engine 5.8.3, recreate exactly the same scene in ThreeNative, then tune the engine until it matches the Unreal reference, for visuals (pixels), performance (frame and stage cost) or any other measurable behaviour (motion, timing, animation, streaming). ALWAYS use it for any work on a PRD under docs/PRDs/Unreal/ (any subfolder) or any PRD that ports an Unreal feature, when ThreeNative does not match Unreal, when coordinating lanes on an Unreal epic PR, or when the user says "unreal-calibration", "match unreal", "parity with unreal", "calibrate against unreal".
---

# Unreal calibration

**The goal, in the owner's words: "matching unreal default visual + performance".**
Every ThreeNative template ships stock Unreal 5.8.3 defaults, and matches Unreal's look and frame cost on the same scene and quality tier.

**The method is an experiment, not a tune by eye.**

1. **Build the scene in Unreal** with stock defaults: the calibration scene, its poses and its quality tiers. Capture the reference: frames, stage costs, or the behaviour under test (motion lag, timing, animation, streaming).
2. **Recreate exactly the same scene in ThreeNative.** The same geometry, materials, lights, camera, units and tier. Prove the two scenes are the same before you compare any result (`pnpm unreal-look:compare --sameness`). Any difference is a named override that both engines apply (for example Nanite off on the wildwood scene).
3. **Tune the engine until it matches the reference.** Change the engine, not the scene and not the measurement. Each change is one experiment arm, measured against the Unreal reference.

Visual parity is the most common case, but the same loop holds for any measurable behaviour. Pick the measurement that the PRD claims: pixels for a look, GPU ms for a cost, frames-to-90% for a light switch, and so on.

This skill is the process. The harness details live in the repo:
- `.agents/skills/tune-look-to-unreal/` (look sheets, `sheet.py`)
- `docs/PRDs/Unreal/README.md` (the Unreal source clone, the port map)
- `tools/unreal-reference/` (Unreal captures, scenes, `parity-locks.json`)

## 1. The loop for one fix

1. **Name the region (or stage, or behaviour) and the gap with numbers.** For a look, use `pnpm unreal-look:compare` on the layer (L1 to L9) where the gap first appears. A gap that starts at L1 is not a post problem.
2. **Read the Unreal source for that subsystem** (`$UE_SRC`, or the sparse clone in `docs/PRDs/Unreal/README.md`). Port the algorithm, the defaults and the guards. Cite `UE 5.8.3: Engine/...:line`. Never copy code or comments.
3. **Write the acceptance criteria before any capture.** Take them from the PRD box.
4. **Fix it at the root, in the right layer.** The look goes in `scripts/unreal-look/scaffold/render/`. The mechanism goes in `packages/core` plus native C++. Templates change only after the harness layer matches.
5. **Red-green.** A spec fails before the fix and passes after it. An engine change needs native proof: a conformance row or a `--target` playtest.
6. **Capture paired arms from one code state:** BEFORE through a URL knob (`?probes=0`, `?giFollow=0`, `TN_UNREAL_LOOK_QUERY`), AFTER as the default. Use 2 runs per arm, and 5 runs per arm to claim "no change".
7. **Judge, post, lock** (sections 2 and 3).
8. **Queue the SHA** for the merge lane (section 6).

## 2. The visual judge and the PR screenshots (owner rule, required)

Every change that alters what reaches the screen gets a judge verdict and a before/after sheet on the PR. This covers materials, lights, shadows, exposure, fog, sky, GI, reflections, post, foliage, LOD and resolution, and any performance change that touches them. A pixel diff or a green gate is not a verdict.

**Before the capture**
1. Write the acceptance criteria from the PRD box and the reported issue, for example "the floor next to the grass is lit as in Unreal" or "no visible regression".
2. Capture the same pose BEFORE and AFTER, headed, `--browser-recipe webgpu`, with `adapter.info` checked (a real GPU, not SwiftShader). Use 2 runs per arm. Take both arms from one code state through a URL knob when you can.

**The judge**
3. Run the judge command (`pnpm unreal-look:judge --criteria <md> --out <json> --expect improvement --region-limit <dP50>`), or give the images and the criteria to a fresh read-only subagent that did not write the change.
4. The judge returns IMPROVEMENT, NEUTRAL or REGRESSION per frame and overall, and CLOSE or FAR against Unreal. A region past `--region-limit` caps its frame at FAR.
5. A task that promises an improvement needs IMPROVEMENT. A performance-only or appearance-preserving change needs NEUTRAL or IMPROVEMENT with no visible regression. REGRESSION, or NEUTRAL when improvement was promised, means fix the cause and judge again. Do not explain a verdict away.
6. The judge can read CLOSE where the numbers still fail (foliage frames 0.5 to 0.9 dP50 above Unreal read CLOSE). Post the region dP50 or deltaE numbers beside every verdict.
7. A judge report can land with the coordinator instead of the lane. Ask before you rerun a judge.

**The sheet and the PR comment**
8. Burn the column labels in large text: `WASM ENGINE BEFORE` | `WASM ENGINE AFTER` | `UNREAL 5.8.3`. Put close-up crops of the issue region (the seam, the shadow edge, the leaf crown) beside the full frame. The owner reads the crops first.
9. Push the images to the PR's orphan screenshots branch (`<prd>-screenshots`), one folder per sheet, built on the branch tip.
10. Comment on the PR: a heading that names the issue, the column names, the commit SHA, the judge verdict, the measured numbers (dP50, deltaE, GPU ms) and the raw image links.
11. Record the verdict in the PRD box that claims the outcome.
12. The PR comment is the delivery. No phone notification (owner, 2026-10-22), unless the owner asks for one in that session.
13. Every merged fix on a scene the owner watches gets a re-measure sheet. One re-measure lane can batch several merges into one sheet.

## 3. Locks (owner question 2026-10-22: no whack-a-mole)

1. Lock only regions at parity with Unreal. Bound = measured value + the spread of 3 repeat runs from one code state.
2. When a fix brings a region to parity, lock it in the same commit (`calibrate --lock`, `compare --write-locks`).
3. A change may move a lock toward Unreal freely. It may move a lock away from Unreal only with a receipt:
   - (a) the judge shows no regression in that frame;
   - (b) the total distance to Unreal over that scene and layer's locks gets smaller;
   - (c) the same commit re-cuts that lock, with its numbers and reason.
4. A lock break without that receipt is a regression, and the change does not merge.
5. Locks on regions that are not at parity are removed in a re-cut, not moved by each lane.
6. When one root cause moves many locks (for example the diffuse model under a sky change), land the dependent changes as one combined line, measured together.
7. **Ratchets** bound the regions that are not at parity (`tools/unreal-reference/ratchets.json`, apart from the parity locks). A ratchet is the region's value plus its run spread, away from Unreal. `compare --check` fails when a region moves further from Unreal than its ratchet. When a fix moves a region closer, re-cut in the same commit (`pnpm unreal-look:ratchet --cut <sha> --scene reference|gi:<name> --layer <layer> --captures <run>...`), so that the gain cannot be lost later. A cut only tightens. `--relax --reason "<why>"` is the receipt for a move away, and the same 3-part rule applies.
8. **Every scene and layer the change can reach.** A visual change runs `compare --check` on every scene and layer its change can reach, not only the ones it captured. GI, exposure, sky, sun, shadow and post changes reach every scene. It may not turn any lock or ratchet that holds on the lock board (the epic head's `lock-board.json`) into broken. Name the scenes and layers you checked in the queue line.

## 4. Performance parity

- Measure the same scene, pose and quality tier in both engines (Unreal Low, Medium, High, Epic against the TN tier). Report GPU ms per stage (shadows, GI, reflections, post) beside the total.
- Unreal's stage costs come from its own profiler on the same machine (`stat gpu`, `ProfileGPU`). TN's come from the playtest `perf` meters and GPU timestamps (`GIBudget`, the stage labels).
- Timing runs need the GPU alone (an exclusive GPU slot), scheduled at night so that they do not stall the capture queue. In the day, use paired shared runs and state that.
- A perf win counts only when the judge passes: NEUTRAL or IMPROVEMENT, no visible regression. A visual fix states its GPU cost.
- A stage that costs more than Unreal's is a gap like a colour gap. Find Unreal's budget rule (update rates, probe counts, half-resolution passes) in its source and port it. Do not cut quality to win the number.
- A run-time budget compares the whole GPU frame with the frame period, as Unreal's DynamicRenderScaling does (`DynamicResolution.cpp:32-103`: 10% headroom, a 16-frame history, 8 frames between changes, a drop after 2 frames over the period). A fixed millisecond budget for one stage is a bug: the SSGI pass read 6.3 ms at P5 and 2.1 to 3.0 ms at boost on one scene. `BudgetLadder` and `FrameTimeBudget` in `packages/core/src/render/` hold the rule.

## 5. Rules that keep the numbers honest

- **No fitted constants.** A gain picked by eye or fitted to one scene is a value an author must revisit, which is a bug. Find the Unreal rule that produces the value. Examples from the first epic:
  - a metal reflection-hit diffuse share chosen by eye was replaced by Unreal's hit-lighting model;
  - a light-switch fade is ported from Unreal's temporal accumulation rule, not given a hand-picked frame count;
  - a fog-colour fit factor is deleted unless a measured lock needs it.
- **Unreal defaults.** A difference from stock Unreal is a named override, on the same object, applied to both engines and reported honestly (Nanite off on the wildwood scene).
- **Defer, never decline** an Unreal feature. A failed gate becomes Deferred with a revisit condition. A feature for later gets its own PRD, and the work moves on.
- **Check the circular-fit trap.** Unreal's EXR frames are taken after its own post stages, such as gamut expansion. A fit on EXR/PNG pairs finds "none".
- **Never relax acceptance** to pass: no lock move without a receipt, no post stage removed to hide a base-light gap.
- **Find the layer where the gap starts.** A gap at L1 is the base light (BRDF, sun units, sky), not post. Gaps of opposite sign in one frame (one region brighter, one darker) are not one global step.
- **Match the harness first, then the templates.** A template changes only after its harness layer matches Unreal.
- **API parity beats micro-performance.** A cheaper design that breaks three.js idioms (`Object.keys`, spread, `JSON.stringify` on a material) does not ship, because agents write games with those idioms.
- **Name GI and look abstractions with Unreal's terms** (RadianceCache, ScreenProbeGather), with the Unreal terms as aliases for capability search.
- **When a region reaches parity, harden it**: lock it and add the spec in the same commit.

## 6. Coordinating lanes

One epic is one draft PR, and it is never merged during the run. A coordinator splits the work into lanes, one worktree each (`.claude/worktrees/unreal-<name>` on `lane/<name>`, cut from the epic head).

- **Brief per lane:** the PRD, the worktree, the tasks in order, the lanes that are stopped, and a cap of about 5 to 6 hours. One shared rules file holds the rules in this skill, so every lane reads the same rules.
- **Models:** Sonnet high by default, Opus only when a task needs it, Haiku for grunt work. Cheap non-visual work goes to a cheap coding arm.
- **Merges:** a lane appends "lane sha url what" to a merge queue file. One merge lane merges each line into the epic with `--no-ff`, runs the checks and the native build, pushes, and logs the result and the new epic head. The coordinator holds a line by telling the merge lane.
- **Reports:** one final report per lane, no progress messages. At the cap, a lane commits `wip:` and names the next step. The coordinator starts a successor (`<lane>2-lane`) only for real open work.
- **Stopped lanes:** do not message a stopped lane. A message revives it, and it then edits a worktree that its successor owns. Message the successor.
- **Pacing:** pace the token burn against the plan reset with whatever usage meter the machine has. Do not start lanes that would only wait for the GPU.
- **State on disk:** keep briefs, the queue and the lane ledger outside `/tmp`, because a reboot wipes it. Keep a decision log beside them.
- **Start of a run:** record each PRD's box count as a baseline, so the end report can show what moved. Give every PRD in scope an owning lane.
- **Owner priority:** an issue the owner raises gets a dedicated lane at once, not a re-task of a busy lane. Check its start within 15 minutes.
- **Holds and combined lines:** when change B is valid only with change A (sky units with the new diffuse model), the merge lane holds B, and A's lane merges and measures both as one line.
- **Successors:** a successor reads its predecessor's handoff note and keeps its commits (`git log`, `git status` first). Name the stopped lanes in every new brief.
- **Cross-lane findings:** a lane that finds a cause in another lane's file sends that lane the numbers and the file:line. It does not edit that file.
- **End of a run:** update the PRD index comment on the PR, then report boxes ticked, PRDs closed and what is parked.

## 7. Shared GPU and machines

- Every WebGPU capture takes a shared GPU slot. Builds take a build slot, with `--parallel 4` at most. Cheap arms take an arm slot.
- The Unreal editor takes one lock for Unreal and most of the GPU slots, because it ran out of Vulkan memory beside many WebGPU jobs. Take the Unreal lock first, then the GPU slots. Never take the Unreal lock inside a GPU slot, because that deadlocks.
- An exclusive GPU waiter blocks every new shared job, so run exclusive timing at night only.
- Send CPU-only jobs over about 5 minutes to a second machine when one is configured. Native C++ and GPU-vendor lanes stay on the GPU machine.
- Captures are headed, `--browser-recipe webgpu`, with `adapter.info` checked (a real GPU, not SwiftShader). Never take the user's display.

## 8. Traps seen in real runs

- **Stale Wasm pair:** a lane's `.js`/`.wasm` can trail the epic C++ and give black L9 frames. After a merge, grep a marker string in the `.wasm`, or copy a fresher pair from a sibling worktree.
- **Native proof after the last merge:** a queue line that touches native files states that the native build and its tests ran after the lane's last epic merge. An older build proves nothing about the combined tree.
- **"ELIFECYCLE Command failed."** after `cells=N` is the dev server's SIGTERM, not a failure. Read `TN_UNREAL_LOOK_EXIT`.
- **Old harness logs:** check the harness version before you report a capture bug. A failure text that differs from the merged one means an old harness.
- **Exposure wait:** L9 captures of reference scenes wait for the auto exposure to settle. Fixed-exposure calibration scenes skip the wait.
- **Wall-time tests on a loaded host** fail at random. Measure process CPU time (`process.cpuUsage`), best of three.
- **Captures are untracked.** Specs read the committed `gi/<scene>/id` and `scene.json`, so `compare --check` needs the captures in the worktree that runs it.
- **A lane that rebuilds a calibration scene** tells the judge or lock owner in the same hour, because every lock on that scene goes stale.
- **Parallel captures in one worktree** race on the package builds. Run them one after another.
- **Unreal triangle counts:** `get_num_triangles(0)` reads the Nanite fallback mesh. Read the source mesh description for the real count.
- **"No fresh binary" is not a blocker.** Build the host in your own worktree.

## 9. Delivery

- Tick a PRD box only with its proof beside it, in the same commit. Run `pnpm prd:progress <prd>` after each phase.
- A finished PRD moves to `docs/PRDs/done/` with `git mv` in the commit that finishes it.
- At the end of a run, update the PRD index comment on the PR. Report boxes ticked, PRDs closed and what is parked, each with a named blocker.
