# PRD-741 drawn-frame visual judges (2026-10-26)

Each frame ends a 1000-tick drawn window (one frame per tick, steady-state TAA). AFTER is 0.72 TAAU (8878b0e75, TAP6). BEFORE is 1.0 TAA. The judges are fresh Opus `gauntlet-critic` subagents at effort high.

- Hop Garden: NEUTRAL in 6 of 6 window pairs. The trailing rim of the right enemy (w2) shows a band that is faint at 1x and clear at 2x. Grey rim pixels: BEFORE 471/477, previous build 547/547, TAP6 492/512.
- Lantern Vale: NEUTRAL in 15 of 15 pairs (5 runs per arm). In 1 of 5 runs, a firefly over the hero left a faint green square (faint at 1x). The wisp rim is grainier at 2x.
- Clover Cup idle and drive: NEUTRAL in 4 of 4 pairs. No ghost appears behind the AI karts. About 100 kerb speckle pixels and ragged moving-kart edges show only at 4x and above.
- GATE6 experiment (drops history on uncovered moving pixels unless their motion matches): the judge found it NEUTRAL on all kits, and it brings the rim to 469/484, equal to BEFORE. But below a 1 px tolerance it fails `traa_swaying_blades` (75.6 > 45). At a 4 px tolerance the test passes (35.6) and the rim returns to 506/507. It is not shipped.
