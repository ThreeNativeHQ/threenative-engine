# PRD-362 execution record — 2026-09-07

Status: **PARTIAL; acceptance remains open.** This is a recovery record for the existing
PRD-362 implementation on `origin/main`. It records the focused scaffold/looks check and the
device check requested for this lane. It does not add or re-run the adaptive implementation.

## Run identity

Observed before this record was added:

```text
date -Is
2026-09-07T00:29:00-07:00

git rev-parse HEAD
d365509793ee934298380dc4143e419354795d5d

git status --short
(no output)
```

`HEAD` equals `origin/main` in this worktree. The prior worker handoff reported that its final
provider stream ended with the exact text `Google Antigravity returned HTTP 429`; it made no source
changes and left this worktree clean. This record is the only intended change from this recovery.

Source PRD: PRD-362.
Its parent remains [PRD-287](../PRDs/useful-defaults/PRD-287-the-default-look-holds-the-phones-budget.md).

## Current implementation anchors

These are the incumbent files observed in the current checkout; they are not new changes in this
lane.

| Anchor | Observed responsibility |
| --- | --- |
| [`quality.ts:59-71`](../../packages/create-threenative/templates/starter/src/render/quality.ts#L59-L71) | Explicit tier wins; otherwise the platform selects the boot tier. |
| [`adaptiveQuality.ts:46-60`](../../packages/create-threenative/templates/starter/src/render/adaptiveQuality.ts#L46-L60) | Generated-source defaults: two overloaded windows, five healthy windows, 20% headroom, 5-second cooldown, startup and GPU-age limits. |
| [`adaptiveQuality.ts:105-183`](../../packages/create-threenative/templates/starter/src/render/adaptiveQuality.ts#L105-L183) | Reads fresh GPU timing, names presentation fallback/staleness, validates windows, applies hysteresis, and changes tiers. |
| [`postprocessing.ts:32-35`](../../packages/create-threenative/templates/starter/src/render/postprocessing.ts#L32-L35) and [`:47-99`](../../packages/create-threenative/templates/starter/src/render/postprocessing.ts#L47-L99) | Receives completed frame windows, replaces one active graph, and disposes the old/current graph. |
| [`game.ts:6-12`](../../packages/create-threenative/templates/starter/src/game.ts#L6-L12) | Connects the existing `frameBudget.onWindow` callback to the starter controller. |
| [`Play.ts:142-149`](../../packages/create-threenative/templates/starter/src/scenes/Play.ts#L142-L149) and [`:349-356`](../../packages/create-threenative/templates/starter/src/scenes/Play.ts#L349-L356) | Creates the quality entity with configured FPS/readiness and disposes it on scene exit. |

The incumbent unit/lifecycle evidence is in [`template-quality.spec.ts`](../../packages/create-threenative/__tests__/template-quality.spec.ts#L174-L543)
and [`world-environment-lifetime.spec.ts`](../../packages/create-threenative/__tests__/world-environment-lifetime.spec.ts#L7-L40).
The retained native proof is [`prd-362-native-load-2026-09-05/README.md`](prd-362-native-load-2026-09-05/README.md):
it is desktop Linux under private Xvfb only and explicitly makes no phone, browser, real-workload,
or frame-rate claim.

## Focused green check

Exact command run on 2026-09-07:

```sh
pnpm exec vitest run packages/create-threenative/__tests__/looks.spec.ts packages/create-threenative/__tests__/scaffold.spec.ts
```

Exit: `0`.

The authoritative result lines from the non-interactive run were:

```text
(node:3172673) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)

 RUN  v4.1.10 /home/joao/projects/threenative/threenative-engine/.worktrees/prd-362-starter-quality-adapts-to-measured-load-20260906

 ✓ packages/create-threenative/__tests__/looks.spec.ts (29 tests) 1490ms
 ✓ packages/create-threenative/__tests__/scaffold.spec.ts (55 tests) 5506ms

 Test Files  2 passed (2)
      Tests  84 passed (84)
   Start at  00:29:19
   Duration  6.29s (transform 555ms, setup 0ms, import 1.11s, tests 7.00s, environment 0ms)
```

The same output reported `asset health: 4 asset(s), 9 ok, 5 warn, 0 fail`. The five asset warnings
were the existing unknown-license/collider warnings; the target-specific compression-skipped
messages were also emitted. No test failure was reported.

## Documentation link check

Because this recovery adds a documentation record with source/evidence links, the focused
repository documentation check also ran:

```sh
pnpm check:docs
```

Exit: `0`.

```text
Checked 1541 relative documentation links across 954 Markdown files.
```

## Prior gate/setup record

The full gates were not re-run in this narrowed recovery lane. The prior retained evidence records
the following exact summaries:

```text
pnpm build exited 0.
pnpm typecheck initially failed with missing workspace declarations in the fresh worktree; after
the build, the same command exited 0.
```

The raw files named by that record (`artifacts/batch-2026-09-05/build-prerequisites.log` and
`typecheck.log`) are not present as tracked files in this checkout, so no more precise initial
stderr is claimed here. No separate prior setup failure is recorded for `pnpm build`, `pnpm lint`,
or `pnpm budgets`.

The implementation commit's retained base summary was:

```text
pnpm typecheck 0
pnpm lint 0 (599 warnings)
pnpm test 0 (391 files passed, 2 skipped; 4,289 tests passed, 7 skipped)
pnpm budgets 0
```

These are historical results from commit `79f879143570859a398a19f449db05193f59c7c9`, not current
reruns. The broader batch ledger also records `pnpm lint` exit 0 with 599 warnings and 1,975 files
checked, and `pnpm budgets` exit 0 after the required evidence-index/census restoration. No current
full-gate claim is made by this record.

## Android device gate

Exact command run on 2026-09-07:

```sh
adb devices -l
```

Exact stdout:

```text
List of devices attached
```

Exit status: `0`.

No device or serial was listed. The PRD's 120-second browser-Android and native-Android
performance gate is therefore **UNVERIFIED**. No adapter, thermal state, GPU time, FPS, tier
sequence, or device acceptance result is inferred.

## Evidence status

| Criterion or gate | Status | Evidence and remaining risk |
| --- | --- | --- |
| Existing starter adaptive implementation and lifecycle | Observed incumbent | Source anchors above; this lane did not modify or re-prove them. |
| Focused starter look/scaffold integrity | PASS | The exact Vitest command above: 2 files and 84 tests passed. |
| Existing desktop/native synthetic-load proof | Observed, bounded | The retained proof reports normal/pinned desktop runs, but its own limitations exclude phone, browser, real-workload and FPS acceptance. |
| Browser Android ≥30 FPS for 120 seconds, with the first window discarded | **UNVERIFIED** | No attached Android device. |
| Native Android ≥55 FPS for 120 seconds, with the first window discarded | **UNVERIFIED** | No attached Android device. |
| Qualified phone thermal/build/tier captures, controlled recovery, and pinned-load proof | **UNVERIFIED** | No serial, adapter, thermal, or runtime observation exists from this lane. |
| Full current `typecheck`/`lint`/`test`/`budgets` gates | Not run here | Historical summaries are recorded above; they are not relabeled as current execution. |

Overall verdict: the focused scaffold/looks evidence is green, but PRD-362 remains partial and is
not accepted. The next evidence-producing action is a qualified physical Android run that records
the build identity, serial, adapter, thermal state, GPU time, FPS, tier and retained 120-second
windows.
