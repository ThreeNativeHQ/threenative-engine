---
prd_contract: v1
---

# PRD-131 — The physical-qualification orchestrator was built, works, and was never landed

**Status: DONE, 2026-08-17.** Phases 1, 2 and 4 executed 2026-08-16; the last open acceptance
criterion — `examples/native-smoke` reaching `TN_NATIVE_SMOKE_FIRST_FRAME` on the Pixel 8 without a
signal 6 — was executed on 2026-08-17 and passed, with **0 occurrences of `signal 6`/`SIGABRT`** in
the captured logcat. Evidence:
[`prd-131-first-proof-2026-08-17.md`](../../verification/prd-131-first-proof-2026-08-17.md).
**Phase 3 is not done and is not needed here** — it was written as *"the lifecycle half, if it is
needed"*, and every acceptance criterion in §6 is now met without it; the lifecycle scenario and
`window.h`/`window.cpp` remain listed as deliberately left behind, and running the qualification is
PRD-128's scope, not this PRD's.

**Original status, 2026-08-16:** PHASES 1, 2 and 4 DONE. Phase 3 not started. No hardware qualification,
signing or mobile-readiness claim is made by this file — nothing was qualified, and every device
invocation below refused before reading a property from the phone. That is the harness being right.

`pnpm native:qualify:physical` exists on `main` and reaches the same three refusals, in the same
order, that it reached from the branch. Phase 4's parity check passed:

| Invocation | From the branch | From `main` |
| --- | --- | --- |
| `--platform android --device <serial>` | exit 2, `TN_QUALIFY_SIGNING_REQUIRED` | **exit 2, `TN_QUALIFY_SIGNING_REQUIRED`** |
| …`--android-app <apk>` | `TN_QUALIFY_SIGNING_TOOL_REQUIRED` | **`TN_QUALIFY_ARTIFACT_PROVENANCE_REQUIRED`** — Phase 2, see below |
| …with `apksigner` on `PATH` | `TN_QUALIFY_ARTIFACT_PROVENANCE_REQUIRED` | same |

**The middle row moved on purpose.** Phase 2 gave `findExecutable` the Android SDK fallback that
`scripts/engine-load-test/run-android.ts:39` already gives `adb`, so `apksigner` is no longer
reported as an unavailable capability while sitting in `~/Android/Sdk/build-tools/`. Control observed
red: with `HOME`, `ANDROID_HOME` and `PATH` emptied of it, `TN_QUALIFY_SIGNING_TOOL_REQUIRED` fires
again and names the tool.

**The `runtime.cpp` resize hunk was dropped**, as §3 requires. `main`'s version stands.

**Two drift findings the recovery had to fix, neither of them in §3's list:**

1. **The orchestrator drove a package that no longer exists.** It launched
   `com.mystral.engine/.MystralActivity` and read `gfxinfo`/`meminfo` for `com.mystral.engine`. The
   Android identity was renamed while the branch sat unlanded, so it would have launched nothing and
   then collected empty telemetry from a process that never started — a lane reporting no samples
   rather than a failure. Now `ANDROID_APPLICATION_ID`/`ANDROID_LAUNCH_ACTIVITY`, verified against
   the attached Pixel 8: `am start -W -n com.threenative.game/com.threenative.runtime.MystralActivity`
   returns `Status: ok` with a live pid. `main`'s own `orientation-packaging.test.mjs` guard is what
   caught it.
2. **A test assumed the untracked `.runtime/` exists.** `mkdtemp` failed with `ENOENT` on the parent
   in a checkout that had never created it. Fixed in the helper rather than by creating the directory
   out of band.

21 tests in the recovered spec, plus two new ones for the SDK fallback and its precedence
(`PATH` beats the SDK; an explicit override beats both). `typecheck`, `lint`, `test` (1,383) and
`budgets` all green. The native census is reconciled 72,120 → 74,722 in both places that record it.

**Outcome:** `pnpm native:qualify:physical` exists on `main` and reaches the Pixel 8's device gates.
Before this PRD it did not exist at all, and the only implementation sat on a branch 219 commits
behind.

**Depends on:** nothing external. The code, the tests and the fixtures already exist.

**Blocks:** [PRD-128](../native/PRD-128-android-qualification-split.md) Phases 2–3. Everything PRD-128 calls
"the runs" needs a runner.

**Complexity: 6 → MEDIUM-HIGH mode.** No new capability and no design. The difficulty is entirely
that the branch is stale in one specific, dangerous way — see §3.

**Blast radius: ~26 files.** `packages/runtime-native/scripts/qualify-physical-mobile.mjs` and
`physical-device-evidence.mjs` (new), `packages/runtime-native/tests/` (one spec, seven fixtures),
`packages/runtime-native/package.json`, root `package.json`, `examples/native-smoke/src/game.ts`,
`examples/native-smoke/playtests/`, `packages/runtime-native/docs/G3-mobile-bring-up.md` and
`G5-profiling.md`, `docs/PRDs/native/README.md`.

---

## 1. Why this exists

[PRD-128's Phase 0](../../verification/prd-128-phase-0-2026-08-16.md) ran on 2026-08-16 and returned
its second pre-committed outcome. Running the command PRD-056 planned:

```
$ pnpm native:qualify:physical --platform android --device 37251FDJH0037Z
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "native:qualify:physical" not found
exit 254
```

PRD-056 is filed `PLANNING COMPLETE; EXECUTION BLOCKED` under `requires-physical-device`. On `main`
that is exact in a way nobody intended: the planning landed and the execution did not.

**But it was executed.** `linchpin/prd-056-physical-mobile-qualification` carries two commits —
`8bcf0553` and `8bba6603` — totalling ~3,000 changed lines across 26 files: a 1,277-line
orchestrator, a 634-line evidence module, seven fixtures, a 573-line spec, and C++ edits. Run from
that branch against the attached Pixel 8 it behaves correctly:

| Invocation | Exit | Code |
| --- | --- | --- |
| `--platform android --device <serial>` | 2 | `TN_QUALIFY_SIGNING_REQUIRED` |
| …`--android-app <apk>` | blocked | `TN_QUALIFY_SIGNING_TOOL_REQUIRED` |
| …with `apksigner` on `PATH` | blocked | `TN_QUALIFY_ARTIFACT_PROVENANCE_REQUIRED` |

It fails closed, in the right order, before touching the device. **The work is good and it is
stranded.**

That branch is 2 commits ahead of `main` and **219 behind**. A `BLOCKED` folder makes an unlanded
branch look identical to an unwritten one, which is why this went unnoticed for long enough to
accumulate 219 commits of drift.

## 2. What is being recovered, and what is not

**Recover:** `qualify-physical-mobile.mjs`, `physical-device-evidence.mjs`, the seven fixtures, the
spec, the two `package.json` script entries, the `native-smoke` lifecycle playtest scenario and the
game-side hooks it drives, and the two gate-doc sections.

**Do not recover:** the `runtime.cpp` resize hunk. See §3.

**Not in scope:** running the qualification. That is PRD-128 Phase 3. This PRD ends when the command
exists on `main`, its unit tests pass, and it reaches the same three refusal codes from `main` that
it reaches from the branch.

## 3. The one hunk that must be dropped, and why

Cherry-picking `8bcf0553` onto `main` conflicts in five files, seven hunks. Six are mechanical —
parallel additions in `examples/native-smoke/src/game.ts` (2), adjacent entries in
`packages/runtime-native/package.json` (2), and prose in `G5-profiling.md` and PRD-056 itself.

The seventh is not. At the Android resize path the branch adds:

```cpp
if (webgpu_ && !platform::isBackgrounded() && e.width > 0 && e.height > 0) {
    webgpu_->resizeSurface(static_cast<uint32_t>(e.width), static_cast<uint32_t>(e.height));
}
```

`main` carries, at that exact site, a comment written by someone who did that and watched what
happened:

> The swapchain is deliberately NOT reconfigured here … Calling it from this path was tried and
> aborts the process: a launch rotates the display twice before the first frame, and reconfiguring
> the surface from inside the resize callback tears it down under the frame in flight. **A Pixel 8
> died with signal 6 immediately after `TN_NATIVE_SMOKE_FIRST_FRAME`.** … Doing this correctly means
> deferring the reconfigure to a frame boundary, where no surface texture is acquired.

The branch's guards do not address that cause. `!isBackgrounded()` and positive dimensions say
nothing about whether a surface texture is currently acquired. **`main` is newer and right; the
branch is older and wrong.** Take `main`'s version of that hunk.

If the lifecycle rotation gate then fails for want of a real resize, that failure is a genuine
finding about the runtime and belongs in its own PRD — not in a hunk that trades a passing gate for
a crash.

## 4. Phases

### Phase 1 — Land the JavaScript half, with its tests

The orchestrator, the evidence module, the fixtures, the spec, and the two `package.json` entries.
No C++. `pnpm test` must go green with the recovered spec running, and `pnpm typecheck`, `pnpm lint`
and `pnpm budgets` must stay green. The default repository gate must still require no NDK.

Half a day. This is the phase that removes the fifth blocker.

### Phase 2 — Give `apksigner` the lookup `adb` already has

`TN_QUALIFY_SIGNING_TOOL_REQUIRED` fires on this machine while `apksigner` sits in
`~/Android/Sdk/build-tools/{34,35,36}.0.0/`. `scripts/engine-load-test/run-android.ts:39` solved
exactly this for `adb`, with the comment *"`adb` is not on PATH on this machine; the SDK's copy
is."* The qualification script has no equivalent.

This matters beyond one line: **a lane that reports "blocked, tool unavailable" reads identically
whether the tool is absent or merely unfound, and only one of those is a blocker.** An hour.

### Phase 3 — The lifecycle half, if it is needed

`examples/native-smoke/src/game.ts`, the lifecycle playtest scenario, and `window.h`/`window.cpp`,
**excluding the `runtime.cpp` resize hunk**. Land only what a gate actually needs; anything left out
is recorded rather than quietly dropped.

### Phase 4 — Reach the same refusals from `main`

Re-run §1's three invocations against the Pixel 8 from `main` and confirm the same three codes in
the same order. Same device, same conditions. **If any of them differs, the recovery changed
behaviour and is not done.**

## 5. Integration ledger

Filled with real non-test `file:line` during implementation. A `TBD` at phase end means the phase is
incomplete.

| # | Thing built | Caller edited so it is reached | What it replaces | When it may claim green | Negative control |
| --- | --- | --- | --- | --- | --- |
| 1 | `qualify-physical-mobile.mjs` on `main` | root and package `package.json` | a command that exits 254, not found | `pnpm native:qualify:physical` runs and refuses for a stated reason | remove the script entry → the command is not found again, and a test says so |
| 2 | `physical-device-evidence.mjs` validator | the orchestrator | nothing on `main` | the seven fixtures classify as they do on the branch | a fixture missing `telemetry.memory` → exit 1 naming it |
| 3 | SDK fallback for `apksigner` | the signing check | a missing-capability report for a present tool | `TN_QUALIFY_SIGNING_TOOL_REQUIRED` no longer fires with the SDK installed | rename the SDK copy → it fires again, naming the tool |
| 4 | `main`'s resize behaviour preserved | — | the branch's crashing hunk | `examples/native-smoke` still reaches first frame on the Pixel 8 | apply the branch hunk → signal 6 after `TN_NATIVE_SMOKE_FIRST_FRAME` |
| 5 | Parity of refusal codes | Phase 4 | the branch as the only place it runs | all three codes match, same order | TBD |

## 6. Acceptance criteria

- [x] `pnpm native:qualify:physical --platform android --device <serial>` exits **2** with
      `TN_QUALIFY_SIGNING_REQUIRED` **from `main`**, not from a worktree.
- [x] With an APK and `apksigner` reachable, it reaches `TN_QUALIFY_ARTIFACT_PROVENANCE_REQUIRED` —
      the same code, in the same order, as the branch.
- [x] `apksigner` present in the SDK but not on `PATH` no longer produces
      `TN_QUALIFY_SIGNING_TOOL_REQUIRED`, and the control was observed red first.
- [x] The `runtime.cpp` resize hunk is **not** present, and the commit message says it was dropped
      and why.
- [x] `examples/native-smoke` still reaches `TN_NATIVE_SMOKE_FIRST_FRAME` on the Pixel 8 without a
      signal 6. **Run 2026-08-17**: all four markers in order, 300 frames, process alive 3,000 ms,
      **0 occurrences of `signal 6`/`SIGABRT`** in the captured logcat, engine read from the process
      as `V8`. Evidence:
      [`prd-131-first-proof-2026-08-17.md`](../../verification/prd-131-first-proof-2026-08-17.md).
- [x] `pnpm typecheck && pnpm lint && pnpm test && pnpm budgets` pass, and no native toolchain
      becomes part of the default gate.
- [x] The recovered spec runs in `pnpm test` and a test fails if the orchestrator stops being
      reachable from either `package.json`.
- [x] Anything from the branch deliberately left behind is listed, with the reason: the
      `runtime.cpp` resize hunk (§3), and Phase 3's lifecycle scenario and `window.h`/`window.cpp`,
      which are not started.
- [x] No file says mobile-ready. One Android phone is not mobile, and nothing here qualifies
      anything.

## 7. Negative controls

Every row must be **observed red** with its exit code recorded before the matching pass is written.
A pass with no observed red is recorded `UNVERIFIED`.

| Control | Change | Expected | Status |
| --- | --- | --- | --- |
| `command-absent` | remove the `package.json` entry | a test fails naming the missing command | **observed red** — two tests fail |
| `emulator-serial` | pass `emulator-5554` | `blocked`, `TN_QUALIFY_PHYSICAL_DEVICE_REQUIRED`, exit 2 | exists on the branch; must stay red |
| `apksigner-unfound` | rename the SDK copy | the tool error fires again and names it | **observed red** — `TN_QUALIFY_SIGNING_TOOL_REQUIRED` |
| `resize-hunk` | apply the branch's `runtime.cpp` hunk | signal 6 on the Pixel 8 after first frame | **observed on this device before 2026-08-16**; recorded in `runtime.cpp` |
| `evidence-schema` | a fixture missing `telemetry.memory` | exit 1 naming the field | exists on the branch; must stay red |
| `stale-sha` | substitute an older candidate SHA | exit 1 naming the mismatched field | exists on the branch; must stay red |

## 8. Non-goals

- **Not qualifying anything.** No device gate runs here. PRD-128 Phase 3 owns the runs.
- **Not creating a keystore.** PRD-128 names that as an owner decision and this PRD does not touch
  it.
- **Not iOS.** No Apple hardware is attached.
- **Not preserving the branch's history.** Two commits, both authored against a tree 219 commits
  old. A recovery commit that says where the code came from beats a merge that pretends the drift
  did not happen.
- **Not fixing the Android resize properly.** §3 says what doing it correctly would take. That is a
  different PRD and should be one.

## 9. Kill switches and rollback

- **If Phase 1 cannot go green without the C++**, then the orchestrator is not the standalone thing
  §2 assumes, and the split between Phases 1 and 3 is wrong. Say so and re-plan rather than reaching
  for the dropped hunk.
- **If Phase 4's codes do not match**, the recovery changed behaviour. Do not accept the new codes
  as the baseline — find what moved, or the 219 commits of drift are silently inside the harness.
- **If the branch turns out to be substantially wrong** rather than merely stale — which §1's three
  refusals argue against but do not prove, since nothing beyond the refusal path was exercised —
  delete it and write the orchestrator fresh against `main`. Recovering code nobody has reviewed is
  only cheaper while it is actually correct.
- Rollback is reverting one commit. Nothing here is published and nothing is deleted.
