# PRD-752 — Web games run in a worker, so the page cannot stall them

**Status:** NOT STARTED
**Priority:** P1 — on a loaded host every web game collapses (shooter kit: frame p50 33 ms, p95 100 ms, main thread 100% busy); no phase below is done yet.
**Complexity:** 8 (HIGH) — 10+ files across core, the web host, the Wasm engine and the harness (+3), a new host-capability layer (+2), worker and `OffscreenCanvas` boot (+2), Wasm threads and isolation headers (+1); risk override: none
**Owner:** João
**Parent:** [PRD-573](./PRD-573-unreal-class-performance-in-release-cycles.md), Cycle v5 (v5.1 worker mode, v5.2 Wasm threads). This PRD carries the v5 boxes; PRD-573 points here.
**Depends on:** None. The waste cuts on the main thread are PR #574 and are not part of this PRD.

**Update rule:** one PRD, one PR. Each phase lands as commits on that PR. Each box is ticked, with its result, in the commit that proves it.

## Goal and route

**Goal:** a web game keeps its frame time when the page, the browser or the host is busy. The game, its AI, the JS-to-Wasm glue and render submission leave the browser main thread.

**Route:**

```mermaid
flowchart LR
  subgraph Main[Main thread]
    DOM[DOM, React HUD, input, audio, pointer lock]
  end
  subgraph Worker[Worker]
    G[Game and AI] --> E[Wasm engine]
    E --> C[OffscreenCanvas]
  end
  DOM -- intents --> G
  G -- one state snapshot per frame --> DOM
```

1. Core reaches the DOM only through one **host-capability layer**. Today 23 core files read `document.` or `window.` (audio, pointer lock, gamepads, `localStorage`).
2. Behind a flag, and without COOP/COEP, the game and engine boot in a worker on an `OffscreenCanvas`.
3. With cross-origin isolation, the engine adds Wasm threads (`TN_WEB_THREADS`) for its job pool. Without isolation it reports `threads: off`.

## Evidence

Clean CPU profile of the shooter kit (NVIDIA, no DevTools, 2026-10-26): frame median 33 ms, p95 100 ms, main thread 100% busy. The game, AI, React HUD, JS-to-Wasm glue and render submission all share the one main thread.

## Honest expectation

- A worker moves the game and its cost off the main thread. React, the DOM, extensions and GC stay behind: about 5-10% of the frame in a production build.
- Wasm threads help the C++ side only: about 15-20%.
- Neither fixes the fragility when every core is busy. PR #574 cuts waste separately.
- So the KPIs are **measured** main-thread busy and p95 under a **stated** CPU load, set from the phase 1 baseline. They are not guesses. The numbers in the boxes below are targets to confirm or revise against that baseline, in a `## Decisions` entry.

## Decisions

- 2026-10-26 (owner): the worker HUD contract is confirmed: the HUD gets one state snapshot per frame from the worker and sends intents back. "Yes, and v5.2 threads too." This clears the last v5.1 line under PRD-573 "Blocked on" and adds v5.2.
- 2026-10-26 (lead): this PRD has 4 phases and 14 boxes, above R5, because it carries the parent's v5.1 and v5.2 boxes plus the measurement phase. PRD-573 waived R5 for the same epic. Splitting it would cut the baseline from the KPI it sets.
- 2026-10-26 (owner): scale-down rule. Bounded implementation slices go to a cheaper arm (`opencode-go/deepseek-v4.1-flash`, variant `max`, at most 2 arms). The lead designs, writes the red tests and reviews every diff.

### Phase 1: Loaded-host baseline
**Status:** NOT STARTED

Sets the KPI baseline. Shooter kit and starter kit, same machine, same stated load.

- [ ] A repeatable loaded-host profile exists: it starts N busy-loop processes (N and load recorded), runs the shooter and the starter, and prints main-thread busy %, frame p50 and p95. proof: `sh scripts/xvfb.sh pnpm profile:wasm-page -- --url <url> --cpu-work --seconds 10 --json`, with the command and output path in this box
- [ ] The baseline for the shooter and the starter is recorded in this PRD under `## Decisions`, with load, adapter name (not SwiftShader) and three runs per arm. The v5 KPI numbers are set from it. proof: the `## Decisions` entry, `adapter.info` captured in the run

### Phase 2: Host-capability layer
**Status:** NOT STARTED

- [ ] A red-green core spec scans `packages/core/src` and fails on any direct `document.` or `window.` read outside the host-capability layer (an allow-list of the one layer file). It is red on the 23 current files and green after the move. proof: `pnpm exec vitest run packages/core/__tests__/host-capability-boundary.spec.ts`
- [ ] The native host runs core unmodified through the same layer, with no dynamic `import()` in core. proof: `pnpm exec vitest run scripts/__tests__/check-core-boundary.spec.ts`; `pnpm native:verify:desktop`
- [ ] The starter plays through a loopback proxy (main thread talks to the layer over a message channel in the same thread) with unchanged behaviour. proof: `pnpm test:templates` on the starter, green

### Phase 3: Worker mode and v5 KPI
**Status:** NOT STARTED

- [ ] Behind a flag, without COOP/COEP, the starter boots in a worker on an `OffscreenCanvas`; input, pointer lock and audio forward from the main thread, and the HUD takes one state snapshot per frame and sends intents back. proof: `pnpm test:templates` with the flag, starter scenario green
- [ ] The playtest harness captures the worker canvas (screenshot not blank, frame counter advances). proof: `pnpm test:templates` with the flag; `node packages/playtest/dist/runner/cli.js doctor --url <url> --text`
- [ ] Main-thread busy falls below the target set in phase 1 (first target: below 0.5x of the main-thread arm) and p50 is no worse, under the same stated load. proof: `profile:wasm-page` worker URL against the main-thread `--control` URL, three runs per arm
- [ ] A fresh visual judge subagent returns IMPROVEMENT or NEUTRAL on worker against main-thread frames, at least two runs per arm, `--browser-recipe webgpu`, `adapter.info` checked. proof: the verdict in this box and the images on the PR
- [ ] The shooter kit plays through the worker with the same checks. proof: `pnpm test:templates` with the flag on the shooter scenario

### Phase 4: Wasm threads and gate
**Status:** NOT STARTED

- [ ] A `TN_WEB_THREADS` build costs at most 2% on one thread against the non-threaded build. proof: `profile:wasm-page` A/B, three runs per arm
- [ ] Without cross-origin isolation the engine reports `threads: off` and runs unchanged; with isolation (COOP/COEP) it reports the pool size. proof: `native_engine_wasm_browser_backend` for both isolation states
- [ ] The job pool cuts engine frame CPU on the threaded build. proof: `profile:wasm-page` A/B on the shooter, threaded against not
- [ ] Stability gate S is green on web with and without isolation headers. proof: the S commands in [PRD-573](./PRD-573-unreal-class-performance-in-release-cycles.md)

## Blocked on

- None. The platform proof rule applies: a helper admitted for being unportable ships native proof in the same commit (`packages/runtime-native/AGENTS.md`).
