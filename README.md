# PRD-889 — woodland-floor judge evidence

AC-7 is **open**. Two independent read-only judges returned **NEUTRAL**, both rounds.

**Round 2 (the files at the top level).** Pose turned onto the tree line, every prop lifted by its
own bake offset and scaled up.
- `run-{before,after}-{1,2}.png`, `sheet-{before,after}.png` — 4 runs, same seed, camera and input.
- `ground-{before,after}.png` — ground band at 2×.
- `change-map.png` — after minus before, brightness ×5. A diagnostic, not a look.
- Verdict: the ferns read; the logs read as "large flat-topped slabs" sunk to ground level and the
  litter is unresolvable. Nothing floats, nothing regressed.

**Round 1 (`round1-*`).** The pose looking down the path with the props as first written. Black
frames in that pack are the capture path, not the game — see below.

Both rounds are the packaged desktop host's own framebuffer readback. `page.screenshot` returns a
pure black WebGPU canvas on this machine, and the kit's pre-existing `grass.playtest.json` fails the
playtest's 5% capture guard with the identical ratio, so a frame screenshot is not a gate here.
