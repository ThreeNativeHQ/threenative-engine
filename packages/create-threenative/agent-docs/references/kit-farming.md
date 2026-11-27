# Kit notes: farming

Kit-specific facts moved out of the kit `AGENTS.md`. Shared conventions: `conventions.md`.

## Ownership

This repository owns the farm rules, the field, the day clock's light, the HUD and every visual decision; `src/game.ts` stays portable and `src/main.ts` is the web-only React mount. Mechanics borrow defaults from the Harvest Moon 64 reference cards (`engine_reference_detail` on `harvest-moon-64`: `day-season-clock`, `crop-growth`, `watering-and-rain`, `stamina-budget`, `tool-charge`, `shipping-income`, `camera-follow`); each constant names its card where it is defined. The cards hold one crop price (the turnip, 60) and no per-crop stage table, so the other prices, seed prices and days to ripen are this kit's own numbers (`src/farm/crops.ts`).

## Commands and map

Controls: WASD or arrows walk; Space or J swings the selected tool on the tile one step ahead (the highlighted tile); keys 1 to 7 select the hoe, can, sickle, hammer and the turnip, tomato and pumpkin seed bags, and Q and R cycle; E picks a ripe crop, ships a carried crop at the bin, buys one seed at the stall, sleeps on the doorstep, and closes the night screen.

The rules are plain TypeScript with no Three.js, in `src/farm/`: `time.ts` is the calendar (30-day seasons, seven weekdays, the 06:00 date turn) and the clock (five game minutes a real second, the faint hour 02:00), `crops.ts` is the crop table, `field.ts` is the tile grid and what each tool does to a tile, `tools.ts` is the hotbar and the stamina budget (250, four tiers), `Farm.ts` is the purse, the bin and the night. Edit the tables, not the scene.

A crop gains one stage on a night when its tile was watered that day and the day's season is its own. Every tile dries overnight. The first day of a season kills the crops that do not belong to it (a withered crop clears with the hoe). The bin pays once, overnight: the night screen lists what it paid. A faint (up past 02:00, or a swing that costs more stamina than is left) skips to the next morning, charges 10 percent of the purse and wakes the farmer at half stamina; sleeping wakes at full stamina.

`src/render/daylight.ts` drives the sky from `farm.minute`. The sky bake costs 45 ms, so the load bakes twelve keyframes and the sky mixes the two around the clock; the visible atmosphere and the key light follow the exact sun (`src/render/sunPath.ts`), and the key light turns to a blue moon below the horizon. `src/render/fieldView.ts` draws every kind of field object as one `InstancedMesh`.

Every figure is `assets/mannequin-combat.glb`, dressed by a material swap in `src/render/props.ts`; the tools are boxes on the right hand (`hand_r`). Every other surface is a procedural metre-grid material or a plain colour. The Numpad keys are playtest stations and clock cheats (`src/scenes/stations.ts`); delete them with the playtests that use them.

## Portable authoring contracts

Scenes use `load`, `enter`, `update`, `exit`; physics nodes are Godot-named and disposable; generated conventions call `GroundSnap` for floor contact, `normaliseToMetres` for authored model scale, and `attachToBone` for the held tool. Register testable entities with `ctx.entities` (`player`); `input.vector("move").y` is +up, so north is `-move.y`. `ctx.random` is seeded in `src/game.ts`.
