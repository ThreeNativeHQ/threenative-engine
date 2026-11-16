# PRD-895 — A refused frame fails fast, and a failed start can be retried

**Status:** IN PROGRESS
**Priority:** P1 — PRD-894 (on `develop`, inside the open Release 0.3.14 PR #676) turned a drawn-but-refused frame from a hard stop into a throw on every frame, so a warm-up that waits for `markBaked` runs to its timeout (AC-1)
**Complexity:** 3 (LOW) — 1–5 files (1), Wasm rebuild (+2); risk override: none
**Owner:** Claude Code / Codex
**Depends on:** PRD-894 (`08ff24681` on `develop`)

## Context

An independent review of `08ff24681` on 2026-11-16, read in the code:

1. **Medium.** `web_host.cpp` `tnw_web_render`: a frame that was drawn but carries a render database
   diagnostic (`TN_NATIVE_MATERIAL_UNSUPPORTED`, `TN_CALLBACK_FAILED`, `TN_NATIVE_LIGHTS_UNSUPPORTED`)
   now calls `refuse(...)` instead of `fail(...)`. `refuse` returns 1, and `browser-renderer.ts`
   `render()` (about lines 670–700) throws in `#drawStatus` before `this.info.frame += 1`, the frame
   field read and the `#bakingEnvironment` / `markBaked` check. While the diagnostic stays, every
   frame throws, `info.frame` stays frozen, and a warm-up that waits for `markBaked` waits until its
   timeout. Before PRD-894 the host latched Failed and the game stopped with the code.
2. **Low.** The same path calls `frameGate.submitted(...)` for a refused frame that submitted nothing
   (about line 525). That pulls `signalDelayMs_` toward 0.
3. **Low.** `browser-renderer.ts` `init()` (about lines 463–480) sets `started = this.domElement`
   before `_malloc`, `string()` and `_tnw_web_init`. If one of those throws, the slot is released but
   `started` stays set, and the next renderer polls a host that never started, Pending for ever.
   Before PRD-894, `TN_WASM_RENDERER_SINGLE` blocked that retry.
4. **Low.** `abi.cpp`: the call path at about line 911 uses `toBinding` without `numberArguments`, so a
   refusal there has no argument position.

## Solution

1. A drawn frame with a diagnostic answers 0 and names the diagnostic once (`refuse()` prints each
   distinct message once and sets `tnw_web_error`). The page counts the frame and runs the bake check.
   A frame that drew nothing (a thrown refusal) still answers 1.
2. Set `started` only after `_tnw_web_init` returned.

## Acceptance Criteria

- [x] AC-1 [local]: A frame that skips a mesh with a refused material (`sheen`) answers 0 on each frame, names the refusal in `tnw_web_error`, and leaves the host Ready, so `render()` does not throw and counts the frame. proof: the Wasm host refusal test (`packages/runtime-native/tests/web-host-refusal.test.mjs`) — Evidence: 2026-11-16, `pnpm wasm:build` then `TN_WEB_HOST_REQUIRE=1 vitest run --config vitest.config.ts tests/web-host-refusal.test.mjs` in Chromium under Xvfb: 1/1. On the same build without the fix the case fails with `refusedMesh` `[1, 1]`.
- [x] AC-2 [local]: A start whose `_tnw_web_init` throws leaves no `started` element, and the next start runs its own init. proof: `browser-renderer` spec — Evidence: 2026-11-16, `pnpm exec vitest run packages/three-native/__tests__/browser-renderer.spec.ts` 58/58; the new case fails without the fix (init called once). The PRD-894 slot case now expects the second start to report the refusal again, because it used to pass only through the skipped init.

## Decisions

- 2026-11-16 (Claude Code, João chose "fix PRD-895, then release"): out of scope, kept as review notes only.
  Finding 2 (`frameGate.submitted` after a refused frame) changes how the frame gate learns its delay, so it needs
  a frame-time measurement of its own, and a refused frame is rare. Finding 4 (argument numbering on the third ABI
  call path) improves a message only. Neither blocks Release 0.3.14.

## Execution Phases

#### Phase 1: Fail fast, retry clean

**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/wasm/web_host.cpp`,
`packages/three-native/src/browser-renderer.ts`, tests.
**Verification:** AC-1 and AC-2, `pnpm wasm:build`, `pnpm typecheck && pnpm lint && pnpm test`.
