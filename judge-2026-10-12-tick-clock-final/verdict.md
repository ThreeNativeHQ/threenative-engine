# PRD-569 tick-clock visual judge, final (2026-10-12)

Each montage: BEFORE (pre-change engine) on the left, AFTER (post-change engine) on the right, same pose.

## Web pairs (`judge-2026-10-12-tick-clock-final/web/`)
Runs: post A to D, pre C, D, A2, B2 (A and B retried). Peak over-budget yield 9 in all eight runs.
Judge (fresh read-only Sonnet, high): NEUTRAL on all eight montages. Differences: which emitters are paused, and particle phase.

## Native pairs (`judge-2026-10-12-tick-clock-final/native/`)
Runs: post 1 and 2, pre 1 and 2. All four exit 0 with 19 of 19 pass. Peak yield: post 9 and 9; pre 7 and 9.
Judge: NEUTRAL on all six montages. Differences: which emitters are paused, and particle phase. The faint lower-left wedge in the panned frame is a smoke phase difference.

## Measured windows (not the same metric as yield)
Web: post 5 to 7, pre 3 to 4. Native: post 8 and 8, pre 2 and 3.
The window closes after `reportEvery` simulated ticks now. The pre arm closed after frames.

Rule used: the owner's delegated rule (PRD Decisions, 2026-10-11) passes NEUTRAL for a change meant to be invisible.
