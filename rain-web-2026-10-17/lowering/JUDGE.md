# Rain: one lowering per material (b7362aa5b) — visual judge

Fresh read-only judge, 2 runs per arm, rain pose 1904x960, RTX 2080 (nvidia/turing).
Panels: BEFORE = Wasm pre-fix, AFTER = Wasm with fix, REFERENCE = stock three.js.

Verdict: NEUTRAL (perf-only change; image unchanged). All 5 criteria NEUTRAL in both runs:
sky/clouds/haze, coast silhouette and depth against sky, rain/lamps/road/trees, match to
REFERENCE, no new artifacts. Only the FPS HUD digits differ. Mean pixel diff 0.002-0.004.

Performance (3 alternating pairs, idle GPU): frame GPU 117.7 -> 43.9 ms (stock three 44.4 ms),
main 1080p pass 112.6 -> 38.8 ms (stock three 38.1-38.8 ms).
