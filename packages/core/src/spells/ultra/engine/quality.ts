// Ported from Ultra Elements src/engine/quality.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
// Engine: the tier comes from `?q=` when there is a location; there is no `matchMedia` probe on the
// native host, so `mobile` is `?mobile` only.
import { readLaunchValue } from "../../../debug.js";

// Quality tiers. Spells author counts at High; emission is multiplied by Q.emission (tier x auto).
// Anything here that changes a shader define or a target size only changes on an explicit tier
// switch (main.js shows "Recompiling…"); the auto ladder only touches uniforms and sizes.
export const TIERS = {
  low: {
    resolution: 0.6,
    msaa: 2,
    fxScale: 0.5,
    particles: [256, 128],
    debris: 512,
    volumeSteps: 12,
    noiseSize: 64,
    groundSize: 512,
    reflections: false,
    reflectionScale: 0.35,
    reflectFx: false,
    maxLights: 8,
    shadowLights: 0,
    bloomLevels: 3,
    emission: 0.35,
    fluidIterations: 6,
  },
  medium: {
    resolution: 0.85,
    msaa: 4,
    fxScale: 0.5,
    particles: [512, 256],
    debris: 2048,
    volumeSteps: 16,
    noiseSize: 128,
    groundSize: 1024,
    reflections: false,
    reflectionScale: 0.35,
    reflectFx: false,
    maxLights: 16,
    shadowLights: 1,
    bloomLevels: 6,
    emission: 0.7,
  },
  high: {
    resolution: 1,
    msaa: 4,
    fxScale: 0.5,
    particles: [512, 512],
    debris: 4096,
    volumeSteps: 24,
    noiseSize: 128,
    groundSize: 1024,
    reflections: false,
    reflectionScale: 0.35,
    reflectFx: true,
    maxLights: 16,
    shadowLights: 4,
    bloomLevels: 6,
    emission: 1,
  },
  ultra: {
    resolution: 1,
    msaa: 4,
    fxScale: 1,
    particles: [1024, 1024],
    debris: 8192,
    volumeSteps: 32,
    noiseSize: 128,
    groundSize: 2048,
    reflections: false,
    reflectionScale: 0.5,
    reflectFx: true,
    maxLights: 16,
    shadowLights: 4,
    bloomLevels: 6,
    emission: 1.6,
    fluid: true,
    anamorphic: true,
  },
};
export type TierName = keyof typeof TIERS;

// Query-only on purpose: a spell's tier is a page a person opens, and neither knob has an
// environment variable or a global a host would set. `?mobile` naming itself is the ask.
export const mobile = readLaunchValue({ environment: "", query: "mobile" }) !== undefined;
const asked = readLaunchValue({ environment: "", query: "q" });
export const tierName: TierName =
  asked !== undefined && asked in TIERS ? (asked as TierName) : mobile ? "low" : "high";

// live values; auto scales multiply on top (auto.emission, auto.steps)
export const Q = {
  tier: tierName,
  mobile,
  ...TIERS[tierName],
  autoResolution: mobile,
  auto: { emission: 1, steps: 1 },
};
