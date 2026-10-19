---
name: capture-strata-worlds
description: Capture the five Strata terrain preview worlds (forest, coastal, alpine, desert, tundra) as repeatable headed WebGPU screenshots on the real GPU, with a load-time and blank-frame report. Use when asked to see the current state of the Strata terrain, to hand terrain screenshots to someone, or to compare worlds before and after a change. Not a visual judge, and not for FPS (use measure-steady-state-fps).
---

# Capture Strata worlds

One command shape, fixed viewport, fixed views, fixed settle time. Two runs on the same commit and
GPU give comparable frames. A visual change still needs the visual judge subagent from `AGENTS.md`.

## Preconditions

- The lane is headed Chromium. Headless returns a white frame, and the playtest runner's private
  Xvfb can land on SwiftShader. A SwiftShader frame is not valid evidence.
- The script opens a window on the active display for about one to ten minutes. Tell the owner first.
- If `nvidia-smi` reports a driver/library mismatch, load the per-process Vulkan shim before the
  run (see the `nvidia-driver-mismatch-per-process-icd` memory). Check
  `vulkaninfo --summary` names the real GPU.
- A weak integrated GPU (for example Intel gen-9) loads the worlds in minutes and renders slowly.
  Prefer a discrete GPU.

## Steps

1. Build the example from the repo root:
   `pnpm --filter strata-terrain-preview build`
2. Serve the build on loopback:
   `python3 -m http.server 8092 --bind 127.0.0.1 -d examples/strata-terrain-preview/dist &`
3. Capture (headed, real display):
   `DISPLAY=:0 node .claude/skills/capture-strata-worlds/shoot-worlds.mjs http://127.0.0.1:8092 <outDir>`
   Add `--worlds alpine,desert` for a subset, and `--repo <path>` when the served build came from another worktree, so `report.json` records that checkout's commit.
4. Stop the server: `lsof -ti tcp:8092 | xargs -r kill`.

Output per world: `<world>-player|meadow-close|overview|river.png` and one `report.json` with the
commit, adapter, load seconds, frame bytes and the first 20 console or HTTP errors.

## What counts as a result

- The script exits 1 when an adapter is a software renderer, or a frame is blank or still on the
  loading screen (under 150 KB PNG). Report that as the result. Do not keep the frames.
- 404s for `assets.manifest.json`, `temperate/*` and `prepared/kloofendal_48d_2k.hdr` are expected
  without the owner's local-only licensed assets (`examples/strata-terrain-preview/AGENTS.md`). The
  world then draws its procedural fallback. Say so when you hand over frames.
- `?world=` takes the biome key (`forest`, `coastal`, `alpine`, `desert`, `tundra`). `coast` is
  ignored and loads the forest.
- The editor page is a separate lane: `pnpm --filter strata-terrain-preview test:terrain:editor`.
