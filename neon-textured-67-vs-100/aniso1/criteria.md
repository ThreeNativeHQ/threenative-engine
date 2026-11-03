# PRD-539 textured same-scene detail bar — visual criteria (written before judging, 2026-11-03)

Scene: the `gi:neon-corridor` Unreal calibration scene, pose `textured` (camera at the left wall, looking along a
brick-textured wall), 1280x720, settled still frame. The same scene is built in both engines from one scene file.
Unreal 5.8.3 stock Epic settings with TSR; ThreeNative with its TRAA reconstruction. Each engine renders at 100%
and at 67% screen percentage (r.ScreenPercentage=67 in Unreal, screenPercentage=67 in ThreeNative), and its
temporal reconstruction brings 67% back to the 1280x720 output.

Columns: UNREAL TSR 100% | UNREAL TSR 67% | THREENATIVE TRAA 100% | THREENATIVE TRAA 67%.
Files: full frames plus a 2x near-wall crop (`full-and-near-crop-run1.png`), and a 3x mid-wall crop for run 1 and
run 2 (`zoom-far-wall-run1.png`, `zoom-far-wall-run2.png`).

The bar (owner decision): at the same input resolution on the same scene, ThreeNative's low-resolution output must
be no worse than Unreal's. Compare each engine's 67% only with THAT engine's 100%. The two engines differ in global
illumination colour and brightness (the walls are more red in Unreal, more orange in ThreeNative). That is a
different PRD. Ignore it.

Judge:
1. Unreal: how much brick detail (mortar line sharpness, brick-face texture grain, distant brick separation) does
   TSR 67% lose against TSR 100%? Rate the loss as none, slight, moderate or severe. Name every artifact (sparkle,
   moire, aliasing, ringing, ghosting).
2. ThreeNative: the same for TRAA 67% against TRAA 100%.
3. Verdict: is ThreeNative's 67% loss SMALLER, EQUAL or LARGER than Unreal's? Also say whether ThreeNative 67% shows
   any artifact that Unreal 67% does not show (over-sharpening, sparkle or moire from a negative mip bias count).
   PASS = SMALLER or EQUAL, with no extra artifact. FAIL otherwise.
4. Ignore any difference that also shows between run 1 and run 2 of the same column.
