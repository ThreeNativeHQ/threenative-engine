# PRD-891 — A big world uploads only the instances that moved

**Status:** NOT STARTED — found 2026-11-14 while the PR #677 lane priced the Strata forest frame.
**Priority:** P2 — the upload costs little at a 39 ms frame, but it caps every big-world game that aims at 60 fps.
**Complexity:** 5 (MEDIUM)
**Depends on:** None.
**Chain:** step 5 of [FOREST-PERF-CHAIN.md](../../../packages/terrain/docs/PRDs/done/FOREST-PERF-CHAIN.md) · **PR:** #677 (owner, 2026-11-14)

## Problem

The PR #677 lane read these engine counters at the Strata preview overview on the RTX 2080, at about 25 fps. They are not re-measured here:

| Counter | Per second | Per frame |
| --- | --- | --- |
| `queueWriteBytes` | ~1.1 GB | ~44 MB |
| `dirtyTransforms` | ~437 k | ~17 k |

About 17 k moved matrices of 64 B is about 1.1 MB. The frame writes about 40 times that, which is about the whole resident instance set (~500 k instances).

What the code shows (read 2026-11-14, not measured):

- The engine honours `updateRanges`. `geometry_cache.cpp:63-88` uploads the union of the ranges and merges only spans that overlap.
- `world-cell-batches.ts:987-1010` (`#touched`) collapses all dirty records of one mesh into one low-to-high span, and turns a span over half the drawn range into the whole drawn range. This was a fix for three's backend, which issues one `writeBuffer` per range. With dirty records spread across a mesh, that span is close to the whole buffer.
- A still camera over a static forest should dirty close to 0 transforms. The source of the ~17 k per frame is unknown.

## Validation scene (proposed, not evidence)

- **Consumer:** the Strata preview forest (the owner tests on the preview at port 5310), default engine, RTX 2080 on the real display, headed `--browser-recipe webgpu`, `adapter.info` recorded.
- **Benefit load:** the overview pose with a still camera for 300 frames, then the walking replay that PRD-584 AC-4 uses.
- **Control:** the forest kit ground view, where few instances move. It charges the new bookkeeping, so its frame p95 must not rise above run noise.
- **Comparison:** baseline and candidate from one code state, 2 runs per arm, paired.
- **Bar:** upload bytes per frame scale with moved instances (Phase 2), and the whole-frame CPU or GPU p95 gain is above run noise, or equal with lower bytes. A smaller counter with no frame gain does not pass the acceptance box alone.

## Execution phases

### Phase 1 — attribute the bytes

- [ ] Bytes uploaded per frame, split by buffer owner (world batch matrices, other attributes, uniforms), at the Strata overview with a still camera and during a walk. proof: Chrome DevTools run with `?tnDebug=1`, the `attributeUploadBytes` and `bufferUploadBytes` counters, numbers written here
- [ ] The source of the per-frame dirty transforms at a still camera is named with its file and line. proof: the same run, plus a stack or counter that names the writer

### Phase 2 — fix the cause

- [ ] The root cause from Phase 1 is fixed in the shared code path, with a unit test where N scattered dirty records upload at most N × 64 B plus a bounded merge slack on the owned engine. proof: a `packages/core/__tests__/` spec, red then green
- [ ] A still camera at the overview writes at most 1 MB per frame. proof: Chrome DevTools, `queueWriteBytes` per frame, 2 runs
- [ ] The `engine: "threejs"` arm issues no more `writeBuffer` calls per frame than before the fix, because the span collapse exists for that arm. proof: Chrome DevTools on the threejs arm, before and after

### Phase 3 — no regression

- [ ] Frame p95 at the overview and at the walking pose is not worse, paired, 2 runs per arm on one code state. proof: Chrome DevTools, the same build on both arms
- [ ] The same capture pose is pixel-identical before and after, or a visual judge returns NEUTRAL. proof: frame diff of the two captures, else a fresh judge subagent

## Acceptance criteria

- [ ] At the Strata overview, upload bytes per frame scale with the moved instances, not with the resident set. proof: the Phase 2 counters

## Blocked on

- Desktop counters: native desktop needs `pnpm native:build` on this machine. The claim is web-only until a `--target desktop` run reads the same counters.

## Decisions

- 2026-11-14, owner: file a separate PRD for this gap, and land it on the PR #677 branch.
