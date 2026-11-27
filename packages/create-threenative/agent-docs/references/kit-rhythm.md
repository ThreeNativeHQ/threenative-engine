# Kit notes: rhythm

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the chart, the beat clock, the judge, the rating, the stage and the HUD; `src/game.ts` stays portable and `src/main.ts` is the web-only React mount. Mechanics borrow defaults from the PaRappa the Rapper 2 reference cards (`engine_reference_detail` on `parappa-the-rapper-2`: `song-clock`, `beat-cell-window`, `late-answer-pass`, `paired-hit-weight`, `rank-ladder`, `answer-loop`); each constant names its card where it is defined. The kit ships no audio: the beat is visual, and the game plays muted.

## Commands and map

Controls: arrows, Z and X answer the call; on a pad the d-pad, A and B do. R restarts. A press during the teacher's call is a free dance step and is not graded.

`src/rhythm/chart.ts` is the whole song as tables: tempo (`BPM`), the count-in and the eight lines, each a list of notes (a beat in the four-beat part and a button). Edit the table, not the judge. Keep notes at least half a beat apart.

`src/rhythm/clock.ts` counts seconds of frame time into beats, so the clock cannot drift against the picture and a playtest replays it tick for tick. The song starts four beats below zero and waits for the startup compile, so a slow launch never eats the count-in.

`src/rhythm/judge.ts` grades a press against the nearest open note of the same button. Windows are in cells (a 24th of a beat): cool is 2 either side, good is 4 early and 6 late, bad is 6 early and 8 late. A stray press costs one point, a matched pair earns two, and a line is clean at half its best score. In the cool rating an extra press on an off-beat eighth with no note near it is freestyle: +2, at most four per line. `src/rhythm/rating.ts` moves a nine-rung ladder one rung per judged line (cool, good, bad, awful, end); the end rung fails the stage, and only cool or good at the last line clears it.

`src/rhythm/session.ts` ties them together and emits events (`call`, `press`, `miss`, `line`, `end`); `src/scenes/Play.ts` turns events into poses. It publishes every number a scenario reads: `songBeat`, `part`, `lastGrade`, `lastTiming`, `rung`, `freestyle`.

Both performers are `assets/mannequin-combat.glb`, dressed by a material swap in `src/render/props.ts`. Each button maps to one clip in `src/entities/Performer.ts`; a press steps the dancer sideways or back and a bob rides the beat. The stage in `src/render/stage.ts` is grid materials, a truss of three spot lights and two pads whose glow pulses on the beat.

## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`; generated conventions call `GroundSnap` for floor contact, `normaliseToMetres` for authored model scale and `attachToBone` for a held prop (none here). Register testable entities with `ctx.entities` (`player`, `teacher`, `stage`). The camera is fixed in front of the stage (`render/camera.ts`); keep both performers in frame and nothing solid between the lens and the player, or the kit contract row `camera-sees-subject` fails.
