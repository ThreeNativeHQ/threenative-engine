# PRD-478 screenshots (2026-10-17)

The images come from an RTX 2080 (Turing), headed WebGPU, 1280×720, scale 1, live clock, with the same cooked assets for every build. Each image shows BEFORE on the left and AFTER (the PRD-478 final candidate) on the right. These are run 1 of 2.

- `vs-develop/`: BEFORE is the develop-equivalent (this branch with its 5 branch-only core files restored to the merge-base). Verdict: no REGRESSION. Raters D and E scored 8/8/0 and 7/9/0 (candidate better / equal / develop better). The labelled judge returned IMPROVEMENT on canyon views v2–v4 and NEUTRAL on the rest. The pop series returned PASS.
- `vs-a602467db/`: BEFORE is the pinned baseline `a602467db`. Verdict: no pose worse. Raters C, F and G scored 10/6/0, 6/10/0 and 6/10/0.

In the walk poses the camera moves in real time, so the two sides can stand at different points on the route.
