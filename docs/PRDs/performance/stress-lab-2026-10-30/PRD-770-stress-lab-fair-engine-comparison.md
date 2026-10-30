# PRD-770 — Stress lab: a fair, workload-equal engine comparison

**Status:** NOT STARTED — tools exist as scratch scripts; no arm is pinned and no fair row is valid yet.
**Priority:** P1 — no comparison row can support a speed claim until arms are pinned, workloads match and the host is quiet (Phases 1-2).
**Owner:** João · 2026-10-30
**Depends on:** none. Feeds PRD-771 to PRD-774, whose gains are measured with this window.

## Why

The owner asked for one thing (2026-10-30): "I just want to make sure measurement is fair". The comparison on the
Stress lab dashboard (`docs/stress-loop/ledger.json`, `scripts/stress-loop.mjs`) failed that in five ways:

1. **Different browsers.** Rows #44 (Wasm) and #36 (three.js engine) came from a DevTools-attached Chrome. Row #45
   (vanilla) came from the clean hunt Brave (CDP 9333). In the clean browser the same Wasm build measured a 14.6 ms busy
   main thread, against 20.73 ms CPU frame p50 in row #44.
2. **Wrong build.** At 06:01Z on 2026-10-30, the coordinator sandbox on :5733 served Wasm `619c541ca21d`, the pre-FS11
   `stress-stack` build. The develop build (`0974fd3b8`) is `4fb0aba5a921` (worktree `stress-fix-fs1112`). The 05:14Z
   window's Wasm GPU p95 of 62.6 ms is the pre-FS11 value.
3. **Loaded host.** The 05:02-05:14Z window ran at a 1-minute load of 17 to 36 (another project's jest run plus lane
   builds). Rows #46-#49 are kept, with variant `loadedHost`, and are out of the comparison.
4. **Different work.**
   - The Wasm host sums main and shadow triangles (`packages/runtime-native/src/engine/wasm/web_host.cpp:787-790`), 7.07 M.
   - Vanilla reports the main pass only: 2.11 M, or 3.42 M with shadows (its `__TN_STRESS__.extra`).
   - Vanilla has one plain sun map, so `?stress&plainShadow` is its like-for-like arm.
   - The three.js engine reports 1 draw and 0 M triangles: a counter bug (lane TM1, `.worktrees/stress-fix-tm1`).
5. **60 Hz cap.** Every browser arm presents at vsync (presented p50 16.67 ms), so FPS cannot show gains past 60.

### Phase 1 — pin and describe every arm

- [ ] Every stress report carries the engine build identity (Wasm sha256 prefix and the package commit) and a non-empty `adapter`. `stress:loop record` refuses a row without them. proof: `pnpm exec vitest run scripts/__tests__/stress-loop.spec.ts`
- [ ] Every arm reports main and shadow draws and triangles as separate fields: the Wasm host (`web_host.cpp:787-790`), vanilla (`extra`) and the three.js engine (TM1 counter fix). proof: three recorded rows with both fields
- [ ] :5733 serves the develop Wasm, and the row's build identity matches `git -C .worktrees/<develop build> rev-parse HEAD`. proof: `sha256sum` of the served `tn-native-engine-web-threads.wasm` against the develop build

### Phase 2 — one fair window, as a repo command

- [ ] `pnpm stress:loop fair <arms...>` runs the arms in ABBA order in one clean browser: no DevTools domains, no profiler, 1280x720 at DPR 1, 80 s per run. It promotes the scratch `~/.cache/tmp-tn/stress-loop/fair-window.sh` and `fair-measure.mjs`. proof: spec plus one recorded window
- [ ] The window holds the measurement lock and the build lock, starts only after the 1-minute load stays under 4 for 60 s, and voids a run whose load rises above 6. proof: spec with a stubbed `/proc/loadavg`
- [ ] Each window adds an uncapped throughput pass (`--disable-frame-rate-limit --disable-gpu-vsync`) beside the vsync pass, so FPS above 60 is visible. proof: a `?stress&plainShadow` row with fps > 60
- [ ] The comparison shows only rows whose counts and shadow mode match the Wasm arm, and marks a mismatch ⚠️ outside best/worst. proof: spec

### Phase 3 — the Unreal 5.8.3 arm

- [ ] The Unreal scene matches: world sizes in metres, materials and colours from `Stress.ts` and `src/render/stress.ts`, and fires as sprites. A fresh visual judge reads CLOSE on a side-by-side at orbit second 10. proof: judge JSON in `sandbox/stress-lab-unreal/`
- [ ] Stock and Lumen-off (`r.DynamicGlobalIlluminationMethod=0 r.ReflectionMethod=2`) rows are recorded from the CSV profiler at 1280x720 in a quiet window. proof: ledger rows with `--engine unreal`

## Blocked on

- Nothing outside the repo. The host must be quiet; a run on a loaded host is void (Phase 2), not blocked.

## Decisions

- 2026-10-30, owner: "I just want to make sure measurement is fair". Rows #46-#49 are moved to variant `loadedHost`.
- 2026-10-30, coordinator: comparison claims use CPU frame p50/p95 and GPU p50/p95 against the 8.33 ms budget, not FPS
  under vsync.

## State left by the 2026-10-29/30 session

- The Unreal sandbox is `sandbox/stress-lab-unreal/`. It holds the level, Python builder and CSV-profiler route; UBT cannot build a C++ module in that engine tree.
  - Two scene bugs are open: grey materials, and cones and fires drawn wrong.
  - Physics boxes were 60 m cubes, which the lane fixed.
  - Read its `CMP-REPORT.md` and `HANDOFF.md` if present.
- The vanilla arm is `sandbox/stress-lab-vanilla/` on :5736. It is instanced by default and keeps the old path behind `?noInstancing`.
- Scratch tools live in `~/.cache/tmp-tn/stress-loop/`: `measure.sh`, `coord-lock2.sh` (no load gate), `fair-window.sh`, `fair-measure.mjs`, `fair-finish.py`.
- A measure-lock holder that waits for an idle host inside the lock, or has no timeout, blocks every lane. FB1 held the lock 35 min. A lease watchdog must exempt the coordinator lock by exact name: the first one killed `coord-lock2.sh`.
