# PRD-766 — shore breakers screenshots

Every frame: headed Chromium, WebGPU, **NVIDIA RTX 2080 (adapter `nvidia` / `turing`)**, 1600×900,
two runs per arm, the arm and pose burned into the frame. Rows are runs, columns are arms.

## WARNING ABOUT THE LANE

`p1-*` and `p2-*` were photographed through `examples/strata-terrain-preview`, whose copy of the sea
code was a byte-for-byte twin of the coastal kit's. **The owner ruled that example off limits on
2026-10-28**, so those edits were reverted (`32d886fdb`) and those arms cannot be reproduced from
this branch. They are kept here because they are the evidence the judge actually saw, and deleting
them would hide a rejection.

`sandbox-kit.jpg` is the replacement lane: `~/projects/threenative/sandbox/prd766-coastal`, a
minimal game built from this branch's tarballs with the coastal starter kit copied in and baked, so
it renders `packages/terrain/starter/coastal/sea.ts` itself. That lane's game frame is still being
wired (the terrain draws untextured and streams only part of the world), so it proves the sea
renders and nothing more yet.

## Phase 1 — the bake replaces the chamfer distance (`p1-*.jpg`)

Left column BEFORE (chamfer distance + exposure flood fill), right column AFTER-P1 (the same thin
surf drawn from `bakeShoreWaves`'s front fields). Poses: `beach` = eye height on the sand,
`oblique` = out over the water looking along the beach, `above` = 90 m up over the coast.

Judge verdict (fresh read-only `claude -p`, opus, this sheet): **beach IMPROVEMENT, oblique NEUTRAL,
above IMPROVEMENT, overall IMPROVEMENT** — a soft surf fringe where BEFORE had a faint stripe, no
seam, banding or foam on dry sand, open sea and sky unchanged.

## Phase 2 — breakers (`p2-*.jpg`), REJECTED

Left column AFTER-P1 (no breakers), right column AFTER-P2 (two trains on the travel-time field, one
pinch budget, peeling foam, Unreal's depth fade on the swell).

Judge verdict on these frames: **beach NEUTRAL, oblique REGRESSION, above REGRESSION** — crests dead
straight and parallel, every crest carrying the same foam band, a raised wall and a chevron where
the bake's rectangle ends, a smeared glassy surf zone. Cause: the eikonal is seeded at the world's
rim, so the fronts are iso-lines of the rectangle rather than of the coast. Re-seeding at the
coastline whose water connects to open sea is the agreed fix.
