# PRD-775 AC-7 visual judge 1 (three 0.185.1 -> 0.187.0)

Judge: read-only subagent, did not write the change. Input: 16 sheets plus raw 1280x720 frames (before-1/2, after-1/2).
Method: full sheets, amplified diff maps (B1-B2 noise vs B2-A2), region crops, region mean luminance (L, 0-255).
Criteria: AC-7, AFTER NEUTRAL or IMPROVEMENT against BEFORE in exposure, shadows, PMREM, SSR, skinning, instancing, post.

Mean abs RGB diff, noise (B1-B2) vs change (B-A): action-rpg 0.08 vs 1.8, kart 0.27 vs 3.5, minimal 0.10 vs 0.94, snow 0.69 vs 4.5, shooter 1.34 vs 4.4, runner 0.97 vs 10-14, others within about 2x noise.

| Template | Verdict | Criterion | Region and change |
| --- | --- | --- | --- |
| action-rpg | NEUTRAL | shadows / AO | The floor shadow of the big right wall is about 4% darker and slightly bluer in both AFTER runs (L 132 -> 126). Placement, softness and character shadows are unchanged, with no acne or banding. This is reproducible, so it is a real but small look shift (watch item). |
| adventure | NEUTRAL | post, foliage | No visible change beyond run noise. Fireflies, grass sway and god rays move the same amount between runs of one arm. |
| collectathon | NEUTRAL | instancing, foliage | No visible change beyond run noise. Coin spin, windmill and enemy positions differ per run, and grass, trees and shadows match. |
| kart | NEUTRAL | exposure, PMREM | Static scenery matches. The right grass hill is about 3% darker with slightly more contrast (L 124 -> 120), visible only in a zoomed side-by-side. Pose not matched: AFTER is in the start countdown (0'00"00) and BEFORE is 2.6 s into the race, so the kart pack differs. |
| minimal | NEUTRAL | shadows, skinning | Cube, ramp and character shadows and the cylinder wall match. Only the character walk phase and camera follow differ slightly. |
| platformer | NEUTRAL | instancing | No visible change beyond run noise. Coins, windmill and waterfall animate. The timer reads 00:03 vs 00:04. |
| puzzle | NEUTRAL | lights | The lantern glow and crate lighting are about 2% darker (L 84 -> 82), and this is not visible without measurement. Ward glow, crates and character match. |
| racing | NEUTRAL | exposure | No visible change beyond run noise. Grass, sky, track and car match. Pose not matched: the race clock reads 3 s in AFTER and 6-9 s in BEFORE. |
| rain | NEUTRAL | fog, weather | No visible change beyond run noise. Run 1 is nearly pixel-identical (mean diff 0.00). |
| rts | NEUTRAL | instancing, AO | No visible change beyond run noise. Units, crystals, rocks and the grid match. The diff shows only faint AO-level edges. |
| runner | NEUTRAL | AO, skinning | The floor material, sky and cube shading match, and the character skin is correct. Pose not matched: BEFORE is CRASHED at 80 m and AFTER is still running at 49/54 m with a dust puff. Floor and sky L differ by 1-3%, but AFTER varies by the same amount between its own runs. |
| sailing | NEUTRAL | PMREM, water | Run 2 (both at 4.7 s) matches within noise for water, island, ship and sails. AFTER run 1 was captured at 4.2 s, so its wave and foam pattern differs, and that is timing. |
| shooter | NEUTRAL | shadows, skinning, AO | Facades, window and awning shadows, the ground and the weapon match. The enemy is nearer in AFTER (game clock 1:42 vs 1:40/1:41) and is skinned correctly. The diff ghosts on facades are sub-pixel shadow shifts, with no visible change. |
| snow | NEUTRAL | shadows, foliage | Snow, trees, the ball and character shading match. The trees average 2-3% darker because the camera framing shifts, and the footprints differ because the sim is earlier (contacts 496 vs 562). |
| starter | NEUTRAL | shadows | No visible change beyond run noise. |
| tower-defense | NEUTRAL | instancing, AO | No visible change beyond run noise. The tree instances and pads match. |

## Overall: NEUTRAL

No template shows a visible regression in exposure, shadows, PMREM, SSR, skinning, instancing or post.

Watch items (not regressions):
1. action-rpg floor shadow about 4% darker (reproducible).
2. kart hill about 3% darker (reproducible).

Capture caveat: kart, runner, racing, shooter, snow and sailing run 1 are not time-matched between arms (game clock or sim state differs). For these templates, the verdict on dynamic objects rests on run-to-run comparability, not on pixel identity.
