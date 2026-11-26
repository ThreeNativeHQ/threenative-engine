# Spells

A spell is a timeline that changes the world it lands in: it charges, releases, travels, impacts and
lingers, and each beat drives several systems at once. `@threenative/core/spells` ships that
machinery.

It is its own module, so a game that never casts a spell ships none of it.

## The cast loop

```ts
import { CastPool, SpellWorld, createFireball } from "@threenative/core/spells";

const world = new SpellWorld({
  scene: ctx.scene,
  // Where every pooled object is added. `ctx.add` parents *and* attaches, which a
  // `GPUParticles3D` needs before it can emit.
  add: (object) => void ctx.add(object),
  camera: ctx.camera,
  // Floor height under a point. Without it a spell lands at y = 0.
  groundAt: (x, z) => floorHeightAt(x, z),
  reducedFlashes: settings.reduceMotion,
});
const casts = new CastPool(world);
const fireball = createFireball(world);

// In the scene's per-frame function:
casts.update(dt);
world.update(dt);

// Where the cast happens:
casts.cast(fireball, target);
```

`CastPool` is fixed and recycles the cast alive longest; it never grows. The first cast costs what
the hundredth does, because nothing is built at cast time. A ball that has passed its target lands on
the target, however late the frame notices.

`SpellWorld` is everything a spell may touch: the scene, the floor, the light pool, the reaction
field, one camera shake and one flash limiter. Damage, mana, cooldowns and who the target is stay in
your game: read `cast.pos` and `cast.phase`.

## The six factories

Every one of them takes the world and named overrides on the same call.

| Factory | Spell |
| --- | --- |
| `createFireball` | A ball of fire that charges, crosses the room and leaves the floor burning |
| `createThunderstrike` | A bolt out of the sky: charges, strikes the point instantly, burns a mark where it lands |
| `createGlacialSpike` | A shard of ice that flies flat and fast and freezes the ground it breaks on |
| `createArcaneBarrage` | A volley of arcane missiles, each popping on arrival |
| `createAegis` | A ward around the caster: it forms, holds, and breaks outward when it expires |
| `createInferno` | A pillar of fire that erupts where it lands and keeps burning |

`createSpell(world, recipe)` builds your own from the same beats: a name, a shape, a tint, the four
beat lengths and the numbers between them. `ReactionField` is the marks a spell leaves on the floor
— heat, char, wet, frost, crack and glow — each decaying on its own half-life, and it draws nothing:
what a mark looks like is yours. `SpellLights` is the pool of flashes a charge or a travelling ball
casts on what it passes.

## The stock look is the one exception

A spell is judged on its silhouette in one frame, and a bare mechanism has none, so each factory
ships a stock look. It is the framework's only look other than the default scene look, and it is
overridable in full: every colour, size, count and timing is a named override on the call
(`core`, `highlight`, `speed`, `charge`, `impact`, `linger`, `radius`, `burst`, `trail`,
`lingerBurst`, `light`, `shake`, `scorch`). Pass the fields you want and the rest stay stock, or
replace the appearances with your own `src/render/` code.

## Accessibility

`reducedFlashes` refuses a fourth flash inside one second rather than dimming it, which is the form
WCAG 2.3.1 asks for. Turn it on from a player setting.

## Which engine runs it

The spells are ordinary scene objects and TSL materials, so they follow the same rule as the rest of
the look. The `action-rpg` kit pins `engine: "threejs"` because the owned engine does not bind every
import that template uses; a native build with the default engine names each import it cannot bind
with `TN_NATIVE_ENGINE_UNBOUND`, so the answer for your game is the one its own build prints rather
than a general claim.

`@threenative/core/spells/ultra` is a second, larger set: volumetric spells ported from Ultra
Elements (MIT, Copyright (c) 2026 Humpalumps), on the Three.js TSL node API. It has its own
`createFx` world, calls `bakeNoise` before the first frame, and is WebGPU-only.

## Source

- [cast-pool.ts](../../packages/core/src/spells/cast-pool.ts)
- [spell-world.ts](../../packages/core/src/spells/spell-world.ts)
- [spells.ts](../../packages/core/src/spells/spells.ts)
- [spell.ts](../../packages/core/src/spells/spell.ts)
