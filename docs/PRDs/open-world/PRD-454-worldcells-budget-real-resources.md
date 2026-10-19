---
prd_contract: v1
---

# PRD-454 — World streaming budgets the resources that actually consume memory

**Status:** PROPOSED — filed 2026-09-26.  
**Priority:** P2 — Stated quick-win follow-up: budgets count only placement bytes, not geometry or texture.
**Complexity:** 7 → HIGH. Resource accounting crosses the loader, world residency, texture/geometry ownership and transient loading, but it reuses existing refcounts and device-budget work.  
**Depends on:** [PRD-448 WorldCells](../done/unreal-like-features/PRD-448-world-cells-blender-export-and-streaming.md), [PRD-213 GPU memory accounting](../performance/PRD-213-gpu-memory-is-accounted-and-bounded.md), and [cross-platform asset cooking/device budgets](../done/PRD-448-cross-platform-asset-cooking-and-device-budgets.md).

## Problem

`WorldCells.budgets.bytes` currently means **placement-buffer bytes only**: 32 bytes per placement.
A cell containing 1,000 tiny placements and a cell that references several large meshes/textures can
therefore look equally cheap to the admission gate even though their resident renderer cost is very
different.

The runtime already does several difficult pieces correctly: model loads are concurrency-limited,
assets are refcounted across cells, cancellation is generation-safe, and the asset loader records
compiled artifact bytes. The gap is that these facts are not connected to the memory budget that
decides whether a world cell may stay resident.

This PRD is runtime residency accounting. It does not reopen texture compression, target cooking,
virtual texturing, or PRD-213's driver-attribution work.

## Outcome

`WorldCells` reports and enforces a separate resource-residency budget for the assets it actually
holds: geometry, textures/material-owned textures, loaded LOD rungs/chunks, and bounded transient
load/decode reservations where those bytes are knowable.

Placement bytes remain visible as their own number. Shared assets count once regardless of how many
cells reference them. An unknown resource cost is reported as unknown and handled conservatively; it
is never silently treated as zero.

## Decisions

- **Do not redefine the existing `bytes` field silently.** Preserve its placement-byte meaning for
  compatibility. Add an explicitly named resource budget/stat and document both.
- **Count ownership, not references.** Ten resident cells referencing one geometry/texture set
  consume one resource allocation, not ten.
- **Separate known quantities.** Source/artifact bytes, decoded CPU bytes, estimated GPU-resident
  bytes and transient in-flight reservations are different measurements. Do not collapse them into
  a fake-exact “memory” number.
- **Fail closed under pressure, not mid-frame.** New admissions wait/decline and report pressure;
  already-visible resources are not torn out from underneath a frame merely to satisfy a number.
- **No synchronous GPU readback in the frame loop.** Use resource metadata and lifecycle events;
  PRD-213's device probes remain verification instruments, not the residency controller.

## Integration ledger

| Existing surface | Change |
| --- | --- |
| `packages/core/src/assets.ts` | Expose stable, per-cache-entry resource accounting/lifecycle information without leaking loader internals or creating a second cache. |
| `packages/core/src/world-cells.ts` | Reserve, commit and release resource costs at the same acquire/refcount/evict boundaries that already own residency. |
| `packages/core/src/world-tiles.ts` | Stop treating terrain bytes as unbounded when composed by `WorldCells`; account them explicitly or reserve a named terrain sub-budget. |
| `IWorldCellsStats` | Report placement bytes, resident resource bytes, transient reserved bytes, unknown bytes and pressure separately. |

## Phase 1 — Make the ledger honest before using it as a gate

- [ ] A loaded model exposes deterministic geometry and texture residency estimates plus its compiled/source byte weight where available, and shared geometry/textures are deduplicated by identity. **proof:** focused asset-loader accounting tests load two models sharing resources and assert the shared allocation is counted once while artifact and resident-byte fields remain distinct.
- [ ] `WorldCells.stats()` reports placement, resident-resource, transient-reserved and unknown costs independently, with resource totals rising on first acquire and returning after the final release. **proof:** scripted residency test walks into/out of cells and matches an independently computed ledger at every step.

## Phase 2 — Enforce the resource budget at admission/load boundaries

- [ ] A cell whose known/reserved resource cost would exceed the configured resource budget is queued or refused with named pressure, while a shared already-resident asset adds only its incremental cost. **proof:** two cells with equal placement counts but intentionally different model/texture costs produce different admission results; swapping the heavy asset for a shared resident one changes the result.
- [ ] In-flight model/chunk work has a bounded reservation and cannot temporarily exceed the declared transient allowance by starting many expensive loads together. **proof:** delayed-loader fixture records the peak reserved bytes under concurrent admissions and fails when the limiter is bypassed.

## Phase 3 — Verify the estimate against real device memory behavior

- [ ] The same world route runs browser WebGPU, desktop native and the available Android device/emulator lane with bounded engine-accounted resource bytes and zero lifetime leaks after a return route. **proof:** lane reports include peak resident bytes, peak transient bytes, evictions, failures and end-of-route delta.
- [ ] On the physical-device evidence lane used by PRD-213, increasing/decreasing the world resource budget produces a directionally consistent change in engine-accounted bytes and OS/driver memory without claiming the two numbers are equal. **proof:** paired device table records both ledgers and their delta; if the estimate is not directionally useful, enforcement stays diagnostic-only until corrected.

## Acceptance criteria

Two cells with the same number of placements but radically different asset footprints must no longer
be treated as the same memory cost. Shared assets must count once, released assets must disappear
from the ledger, and temporary loading must remain bounded.

This PRD does not claim that an estimated GPU byte is the driver's exact allocation. Its success
criterion is a conservative, lifecycle-correct admission budget whose relationship to device memory
has been measured rather than assumed.
