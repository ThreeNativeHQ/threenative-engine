# Template rendering

The shared Unreal 5.8.3 look comes from `@threenative/core`: `WorldEnvironment`,
`qualityPreset` and `qualityTiers`. Keep scene lighting, materials and authored stages in
`src/render/`. Each kit's `quality.ts` spreads the core preset and names any override with
its reason. `tonemapMode: "aces"` and `autoExposureEnabled: false` with fixed `exposure`
are explicit overrides, reported by the chain.

The tuning target is `scripts/unreal-look/scaffold/Reference.ts.in` at L9 and the
`CalibrationScene.ts.in` scenes. Judge the kit's own game against two headed WebGPU runs
per arm and the target frames. Each migration requires a fresh read-only judge's
IMPROVEMENT, with gameplay subjects at least as readable. Adjust old look assertions only
after that verdict. Keep frame budgets and timeouts fixed; a budget breach selects a lower
`renderChainTier`, keeping the filmic curve and metered exposure.

PRD-723 migrates the kits one at a time. Until a kit's visual judge approves migration,
its `quality.ts` explicitly retains ACES and fixed exposure to preserve its baseline.
