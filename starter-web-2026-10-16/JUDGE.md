# Visual judge: starter, stock three.js (BEFORE) vs Wasm engine (AFTER), tick 789, 1280x720

Method: eyes only on the four raw PNGs. No pixel diff was run. Differences below are estimates from viewing.

## Verdicts
- Pair 1 (before-run1 vs after-run1): NEUTRAL
- Pair 2 (before-run2 vs after-run2): NEUTRAL
- Overall: NEUTRAL. No acceptance criterion is violated. One item to watch (sky horizon band).

## Noise floor
- BEFORE run1 vs run2: match. I see no difference in any region.
- AFTER run1 vs run2: match. I see no difference in any region.
- Both arms are stable. Every difference below is between engines, not run-to-run noise.

## Criterion 1: same content (pass)
Present in all four: sky with clouds, three walls, cylinder, tiled platform, white character, blue cube, blue pawn, flag on the right pillar, and the HUD (SCORE, LIVES, POSITION, bottom bar with pause, restart and the controls text). Shadow shapes and positions match: the long wall shadow near x=850, the cube and pawn contact shadows, and the pillar shadow. Poses are identical.

## Visible differences (BEFORE to AFTER, same in both runs)
1. Sky and horizon, top 0-170 px: AFTER has a deeper blue upper sky. The hazy band just above the walls (y about 118-150) is a flatter warm tan in AFTER and a cooler gray haze in BEFORE. This is the largest difference. It is not worse by eye, but it is a color shift.
2. Blue cube, center (x 600-675, y 395-478): AFTER is more saturated, with stronger specular highlights. BEFORE is a flatter, slightly matte blue. Neutral to a slight gain.
3. Wall and cylinder texture, left and center: AFTER shows crisper tile grid lines and normal-map relief. The cylinder top rim and the cylinder-to-wall edge are a little sharper and darker.
4. Platform front edge, bottom center (y about 540-600): AFTER has a darker, more defined bevel line along the lip. BEFORE is softer.
5. Pawn, flag, character: no visible difference. Edges look the same at this scale.

## Criteria 2-4
- Lighting, shadows, exposure: not darker, not washed out. Shadows are present and equal. AFTER is slightly higher in contrast. No banding seen.
- Edges: no extra aliasing or shimmer visible in either arm. AFTER edges are equal or slightly crisper.
- Artifacts: none in AFTER. No black or missing meshes, wrong textures, z-fighting or seams.

## Caveat
Item 1 (horizon tan band versus gray haze) is the one place where a strict reader could call a regression. A numeric luminance and hue diff of rows 118-150 would settle it.
