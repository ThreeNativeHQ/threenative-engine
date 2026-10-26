# Metered eye adaptation

`WorldEnvironment` from `@threenative/core` supplies the Unreal 5.8.3 filmic curve and
metered auto exposure by default. A kit's `src/render/quality.ts` spreads the core quality
preset and records its overrides. During PRD-723 migration, a kit awaiting its visual
IMPROVEMENT verdict explicitly retains ACES and fixed exposure.

Core owns the histogram, adaptation history, GPU readback and disposal. Keep the game's
lighting and any policy overrides in `src/render/quality.ts`; the optional
`src/render/exposure.ts` is game-owned policy source, used only when passed as
`exposurePolicy`. Editing an unused policy does not change the world.

```ts
import { WorldEnvironment, exposureSettings, qualityPreset } from "@threenative/core";

const world = new WorldEnvironment({
  ...qualityPreset("high"),
  exposurePolicy: { ...exposureSettings, rateDown: 0.5 },
});
const applied = world.apply(renderer, scene, camera);
const eye = applied.exposure;
// The existing world pass supplies the meter; dispose the whole installed graph together.
applied.dispose?.();
```

The meter rejects histogram tails using `lowPercent` and `highPercent` (10 and 90 by
default). Keep `0 <= lowPercent < highPercent <= 100`. Core's target grey is 0.36;
its response opens at 3 stops per second and closes at 1. A named override replaces
these settings through `exposurePolicy`, without another scene draw or render loop.

`eye.setEnabled(false)` keeps measuring hypothetical adaptation while returning the
supplied constant. The separate `autoExposureEnabled: false` option omits the meter
entirely; pair it with fixed `exposure` in the quality preset. `tonemapMode: "aces"`
selects the named alternative curve. The chain reports applied and refused stages.

The `TN_EXPOSURE` marker distinguishes `measured` from `applied`; before valid readback,
`measured` is false. Readbacks are bounded to one in flight. Qualify an authored policy
at the same camera poses in bright and dark regions, with cuts in both directions,
resets and resolution changes. Inspect actual canvas captures and the named adapter.
A software-adapter image proves pixels, without proving hardware frame cost.
