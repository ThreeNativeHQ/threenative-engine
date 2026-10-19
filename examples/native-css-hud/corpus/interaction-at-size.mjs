#!/usr/bin/env node
// Run the interaction oracle (`interaction.mjs`, unchanged) with some scenarios at another viewport.
//
// Android cannot present a display edge under 200 px or a portrait viewport in the landscape HUD APK,
// so `android.mjs` runs those scenarios enlarged, and the Chromium expectation has to be computed at
// that same viewport (layout depends on it). The oracle reads each scenario's `size` from the shared
// `interactions.mjs` module, so this resizes the named entries in place and then runs the oracle in
// the same module graph: one definition of the expectation, at the viewport the device really shows.
//
// Usage: TN_INTERACTION_SIZES='{"clipped-hit-test":[240,230]}' CHROMIUM_ONLY=1 node corpus/interaction-at-size.mjs <name...>
import { INTERACTIONS } from "./interactions.mjs";

const sizes = JSON.parse(process.env.TN_INTERACTION_SIZES ?? "{}");
for (const scenario of INTERACTIONS) {
  if (sizes[scenario.name] !== undefined) scenario.size = sizes[scenario.name];
}
await import("./interaction.mjs");
