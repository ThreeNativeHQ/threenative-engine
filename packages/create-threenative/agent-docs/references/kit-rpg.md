# Kit notes: rpg

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the camp and ruin (`src/level.ts`), the rules (`src/rules/`), the world that applies them (`src/systems/`), the actors (`src/entities/Actor.ts`), the HUD and every visual decision. `src/game.ts` stays portable and `src/main.ts` is the web-only React mount. Mechanics borrow defaults from two reference cards: Star Wars: Knights of the Old Republic (reone: `combat-round-timing`, `attack-roll`, `defense-from-abilities`, `damage-dice`, `action-queue`, `party-follow`, `conversation-framing`, `camera-relative-movement`) and The Elder Scrolls III: Morrowind (OpenMW: `walk-run-speed`). Each constant names its card and `file:line` where it is defined. Copy no names, lore or level layouts from either game.

## Controls and map

WASD or arrows move the leader (run by default, hold Shift to walk). A held key clears the leader's queue. F queues an attack on the target (up to four actions). G queues a medpack on the weakest member. E queues a talk with the nearest villager: the leader walks to within 2 m, then the conversation opens. T cycles the target. Q rotates the leader. J opens the journal. 1 to 4 pick a conversation choice, Escape leaves. R restarts.

The camp lies south: a training post (a placeable with the flat defense of 10), a quest elder, a hireling and a second hireling. The ruin lies north, behind a gap in its south wall, with three raiders. Raiders sleep until a party member comes within 9 m, then all of them hunt.

## Rules

`src/rules/d20.ts`: defense is 10 plus the Dexterity modifier (modifier = half the distance from 10, cut toward zero; an unset score is 8). Attack bonus is the class table plus the Strength modifier plus one per ten Melee points. A d20 of 20 always hits and 1 always misses. A roll above `20 - threat` is a critical threat and a second d20 plus the bonus must meet defense to confirm. Damage is the weapon dice plus the Strength modifier, never under 1, times the critical multiplier (2 by default).

`src/rules/rounds.ts`: a round lasts 3 s. The first attack lands at the half mark. An attack on someone who is mid-round and aims back at the attacker joins that round as the second attack when the round is under half old, so both sides get one result and the second lands at 3 s. Combat stays on for 8 s after the last round ends. The attacker cannot move during its round.

`src/rules/queue.ts`: each actor owns an action queue. Only the front action runs. Interactions share a 2 m approach distance, a move completes within 1 m, and an attack registers a round only inside melee reach (1.8 m).

`src/rules/party.ts`: at most three members, the leader first, a fourth is refused. Followers keep 5 m from the leader (plus 1.2 m per extra follower) and run while they are more than 2 m from where they should stand. The rotate key swaps two members or cycles three and clears every queue.

`src/rules/skills.ts`: Melee, Athletics and Persuasion rise with use (Morrowind card `skill-use-gain-and-levelup`): each use adds `1 / ((level + 1) * role factor)` to a meter, and the skill rises at 1. Melee earns a use per hit, Athletics a use per full second of running, Persuasion a use per talk check. Athletics sets the run speed (`walk * (1.75 + 0.01 * athletics * 4)`, the 0.01 weight is from the Morrowind card). The conversation tree (`src/rules/dialogue.ts`) follows reone card `dialog-tree-links-scripts`: the first active link wins. The quest log (`src/rules/quests.ts`) follows Morrowind card `journal-quest-index`: one index per quest, forward only.

`src/render/camera.ts` cuts to the reference's two-subject framing in a conversation (eye 2.25 times the speaker gap to the side, capped at 4 m).

## Playtest stations

`src/playtest-stations.ts` binds F1 to F12 and Digit7 to Digit0 to teleports and rigged dice. They answer only under a playtest runner. `Dice.rig(owner, values)` queues exact die results for one actor: the attack die, then the confirming die, then the damage dice. Delete them with the playtests that use them.

Every figure is `assets/mannequin-combat.glb`, dressed by a material swap in `src/render/props.ts`. Weapons are a few boxes on `hand_r`. The kit ships no other model, texture, HDRI or sound.

## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`; physics nodes are Godot-named and disposable; generated conventions call `GroundSnap` for floor contact, `normaliseToMetres` for authored model scale, and `attachToBone` for held weapons. Register testable entities with `ctx.entities` (`hero`, `ally`, `elder`, `wanderer`, `sellsword`, `raider.1` to `raider.3`). The bridge reads own fields of an entity, not getters: `Actor.sync()` refreshes `queued`, `queueLength`, `melee` and `athletics` each tick. Raiders and rounds act only after `ctx.startup.compileSettled`. `ctx.random` is seeded in `src/game.ts`, so the dice repeat run to run.
