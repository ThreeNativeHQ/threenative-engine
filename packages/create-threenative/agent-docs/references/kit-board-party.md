# Kit notes: board-party

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the board, the turn machine, the CPU choices, the minigames and the HUD. `src/game.ts` stays portable and `src/main.ts` is the web-only React mount. Mechanics borrow defaults from the Mario Party 1 reference cards (`engine_reference_detail` on `mario-party-1`, kind `card`: `board-space-graph`, `board-chain-cursor`, `board-walk-and-turn`, `board-camera-follow`, `turn-rotation-reseat`, `landed-space-coins`, `junction-prompt`, `star-space-rotation`, `star-purchase`, `match-turn-limits`, `cpu-decision-walk`, `random-stream`, `camera-slot-defaults`, `minigame-camera-bringup`). Each constant names its card and `file:line` where it is defined. No card pins the die, the start coins, the minigame rules or the minigame prize: those are the kit's own, and the code says so.

## Commands and map

Controls: Space or Y rolls, takes the shortcut and buys the star; N or Q declines; in the rope game Space hops; in the dash game hold the right arrow after GO; R restarts. The HUD buttons send the same answers as intents.

`src/board/layout.ts` is the whole board as data: 27 space records, two chains (the 24-space ring and a 3-space shortcut that rejoins the ring), the one junction and the seven star candidates. A pawn's place is a cursor `(chain, slot)` plus a lookahead, so a branch rewrites one cursor and leaves the current space alone. `src/board/star.ts` shuffles the candidates (30 passes, priority-biased), marks the live star and the used trail, and never hands out one space twice in a row.

`src/match/turn.ts` is the turn machine: roll, walk space by space at a fixed travel, ask at the junction, offer the star on a pass or a landing, apply the coin space, rotate over four pawns, then a minigame after the fourth pawn, and the end at the turn limit (10 turns, ranked by stars then coins). It owns no meshes: the scene reads its numbers. `src/match/decide.ts` is the CPU answer: a list of guarded weights where the weight is the percent chance of the intended answer. `src/rng.ts` is the one seeded stream every draw uses.

`src/minigames/` holds Dash (a start light, false start freeze, first across the line wins) and Rope (a speeding bar, hop or be knocked out, last standing wins). Each moves four plain points. The scene dresses them in the four mannequins. A minigame winner takes 10 coins.

Every figure is `assets/mannequin-combat.glb`, dressed by a material swap in `src/render/props.ts` (`dress` changes skinned meshes only). The board, the arena, the die and the star are primitives on the grid materials. The Digit0-9 keys are playtest stations (see `src/stations.ts`) that set up one mechanic in one tick; they answer only under a playtest runner.

## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`. Register testable entities with `ctx.entities` (`player`, `cpu.1`, `cpu.2`, `cpu.3`). The match advances only after `ctx.startup.compileSettled`, and publishes `time` so a scenario waits for it. `ctx.random` seeds the match, so a run with one seed replays the same. `src/render/` is yours to edit: the prototype grid look and the two camera framings (`render/camera.ts`: the board at the 45 degree lens, the arena at a 10 degree lens).
