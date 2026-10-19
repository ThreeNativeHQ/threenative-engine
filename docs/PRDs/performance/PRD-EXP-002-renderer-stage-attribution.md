---
prd_contract: v1
---

# PRD-EXP-002 — WebGPU renderer-stage attribution and truthful counters

**Status:** IMPLEMENTED — browser complete, Android gate open. Instrumentation only; no renderer fork or optimization authorized.
**Priority:** P2 — One open box: a physical Android report with render, draw and pass counts.
**Depends on:** reconcile the `renderer.info` portion of PRD-071 with current `packages/core/src/renderer.ts`.
**Evidence:** `docs/verification/render-work-reduction-2026-08-11.md`; `docs/verification/prd-exp-002-renderer-stage-attribution-2026-08-11.md`.

## 1. Decision

Instrument the existing upstream Three.js WebGPU render path deeply enough to distinguish render-object traversal/list/sort cost from material/node/geometry/binding/pipeline preparation and backend command encoding. Keep Three.js behavior authoritative. Do not copy `_renderScene`, create a second renderer, or expose these experimental internals as stable public API.

The current diagnostic matrix found 4,000 independent shared-material meshes at 5.70–6.90 ms median `renderAsync()` wall time, 4,000 distinct equal-looking materials at 8.60–10.00 ms, and instanced/merged equivalents at 0.20 ms. Pixel 8 evidence points in the same direction. Total render time alone cannot tell whether the next framework work belongs in traversal/list creation, material/pipeline preparation, or backend encoding.

## 2. Scope

Add an experiment-only collector around a pinned `three@0.185.1` renderer instance after initialization. Record call count and inclusive time for:

- top-level `_renderScene`, with recursive output-transform calls separated by depth/pass identity;
- `_projectObject` as one combined traversal/cull/list-build stage;
- render-list sort where reachable;
- `_renderObjects` and `_renderObjectDirect`;
- node, geometry, binding, pipeline and texture manager update methods;
- backend `beginRender`, `draw`, and `finishRender`;
- actual `info.render.drawCalls`, triangles, render calls/frame, compute calls, and pass count;
- cache-miss counters for new pipelines/material render objects when observable without copying upstream logic.

Where a stage cannot be separated without modifying upstream source, report it combined. Do not invent attribution by subtraction when regions overlap.

## 3. Files and ownership

Expected experiment paths:

- `scripts/render-profile/renderer-stage-hooks.ts` — version-pinned hook installation and restoration;
- `scripts/profile-native-cpu.ts` — collector integration and report metadata;
- `scripts/__tests__/renderer-stage-hooks.spec.ts` — fake-object hook tests and nested-pass accounting;
- `examples/native-cpu-load-test/src/main.ts` — consume the collector only through the experiment contract;
- `docs/verification/` — dated reports.

No modifications to `node_modules`, Three.js source, or production `packages/core` behavior are allowed in this PRD.

## 4. Phases

### Phase 1 — counter correctness

Replace any use of `info.render.calls` as a draw counter with `info.render.drawCalls`. Add tests that make the old counter choice fail. Record per-frame deltas or explicitly reset/read the upstream info object according to its real semantics.

### Phase 2 — stable stage hooks

Install and restore wrappers by object identity. Reject unsupported Three.js versions and missing methods with a clear experimental error. Track nesting so output-color recursive renders are not double-counted as top-level frames.

### Phase 3 — controlled matrix

Run 1k and 4k logical objects across independent shared material, independent distinct equal-looking materials, instanced, merged, one pass, and redundant two-pass scenarios. Use 60+ warm-up frames, 120+ samples, three repeats, one source SHA and one adapter class.

### Phase 4 — physical Android correlation

Port only counters/hooks that work under the real ThreeNative runtime. Run the existing Pixel 8 game subject and a controlled render-object ladder. If private hooks are unavailable under QuickJS/bundling, record that boundary and retain the production-safe total/counter surface rather than patching the renderer.

## 5. Acceptance criteria

- [x] `renderer.info.render.drawCalls`, not `render.calls`, is verified against 1,001 and 4,001-draw controls.
- [x] A nested output-transform render does not inflate top-level frame count.
- [x] Every stage declares whether timing is inclusive or exclusive; overlapping totals are never summed as attribution.
- [x] Hook installation is pinned to the exact Three.js version and restoration leaves original method identities intact, including lazy render-list wrappers.
- [x] Software WebGPU reports are labeled diagnostic and cannot satisfy the Android gate.
- [ ] At least one physical Android report includes total render time, draw count, pass count, render-object count and every reachable stage. Open. Blocker note corrected 2026-08-23: `adb` IS installed on this host off PATH (`platform-tools/adb`), and physical-device lanes ran on 2026-08-16 and 2026-08-21; the criterion awaits its preflight-disciplined device report, not a tool install.
- [x] No upstream source, public Three.js class or renderer semantics are copied or replaced.
- [x] Targeted tests, sandbox build, typecheck and `git diff --check` pass.

## 6. Negative controls

| Control | Change | Expected |
|---|---|---|
| wrong draw counter | read `info.render.calls` as draws | 1,001-draw fixture fails |
| nested pass inflation | count every recursive `_renderScene` as a frame | nested-pass test fails |
| missing private method | remove one pinned hook target | collector exits unsupported, never silently omits it |
| overlap lie | sum inclusive `_renderObjects` and `_renderObjectDirect` as separate total cost | report validator rejects overlapping attribution |
| software authority | mark SwiftShader report hardware | report validator exits non-zero |

## 7. Kill and rollback

Remove a private hook if it changes rendering, adds more than 3% median overhead to the measured workload, or becomes unstable under the pinned Three.js build. If reliable stage hooks require vendoring or forking the renderer, stop and retain only total render time plus public counters. The experiment can be deleted without changing production behavior.
