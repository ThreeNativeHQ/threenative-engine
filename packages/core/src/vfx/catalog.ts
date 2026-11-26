import { uniform } from "three/tsl";
import { GPUParticles3D } from "../particles.js";
import * as named from "./index.js";
import { type IParticleOptions, type IVfxOverrides, presetClock } from "./particles.js";
import { type RibbonField, createPortalVortex } from "./portal.js";

export type VfxPresetCategory =
  | "Fire & Smoke"
  | "Combat & Impacts"
  | "Magic & Spells"
  | "Weather & Ambient"
  | "Stylized";

export interface IVfxPresetOverrides {
  readonly scale?: number;
  readonly intensity?: number;
  readonly tint?: string;
}

export interface IVfxPreset {
  readonly id: string;
  readonly name: string;
  readonly category: VfxPresetCategory;
  readonly tags: readonly string[];
  readonly kind: "loop" | "burst";
  readonly defaults: Readonly<Required<IVfxPresetOverrides>>;
}

export interface IVfxPresetEffect {
  readonly objects: readonly (GPUParticles3D | RibbonField)[];
  replay(): void;
  dispose(): void;
}

const fire = "Fire & Smoke";
const combat = "Combat & Impacts";
const magic = "Magic & Spells";
const weather = "Weather & Ambient";
const stylized = "Stylized";
const defaults = Object.freeze({ scale: 1, intensity: 1, tint: "#ffffff" });

type Recipe = readonly [
  id: string,
  name: string,
  category: VfxPresetCategory,
  tags: readonly string[],
  factory: (overrides: IVfxOverrides) => readonly IParticleOptions[],
  kind?: "burst",
];

const recipes: readonly Recipe[] = [
  ["fire", "Fire", fire, ["torch", "flame"], named.createFire],
  ["jet-flame", "Jet Flame", fire, ["thruster", "engine"], named.createJetFlame],
  ["burst-flash", "Burst Flash", combat, ["explosion", "impact"], named.createBurstFlash, "burst"],
  ["muzzle-flash", "Muzzle Flash", combat, ["gun", "shot"], named.createMuzzleFlash, "burst"],
  ["smoke", "Smoke", fire, ["plume", "soot"], named.createSmoke],
  ["dust-cloud", "Dust Cloud", weather, ["debris", "dirt"], named.createDustCloud],
  ["steam-plume", "Steam Plume", weather, ["vapor", "vent"], named.createSteamPlume],
  ["ash-plume", "Ash Plume", fire, ["soot", "volcano"], named.createAshPlume],
  [
    "explosion-cloud",
    "Explosion Cloud",
    combat,
    ["blast", "smoke"],
    named.createExplosionCloud,
    "burst",
  ],
  ["impact-dust", "Impact Dust", combat, ["landing", "debris"], named.createImpactDust, "burst"],
  ["ground-mist", "Ground Mist", weather, ["fog", "floor"], named.createGroundMist],
  ["poison-cloud", "Poison Cloud", magic, ["toxic", "gas"], named.createPoisonCloud],
  ["rain", "Rain", weather, ["water", "storm"], named.createRain],
  ["snow", "Snow", weather, ["winter", "flakes"], named.createSnow],
  ["spark-streaks", "Spark Streaks", combat, ["metal", "welding"], named.createSparkStreaks],
  ["impact-sparks", "Impact Sparks", combat, ["hit", "metal"], named.createImpactSparks, "burst"],
  ["ember-fountain", "Ember Fountain", fire, ["sparks", "embers"], named.createEmberFountain],
  ["magic-wisp", "Magic Wisp", magic, ["spirit", "orb"], named.createMagicWisp],
  ["magic-orb", "Magic Orb", magic, ["sphere", "energy"], named.createMagicOrb],
  ["magic-beam", "Magic Beam", magic, ["ray", "energy"], named.createMagicBeam],
  ["healing-aura", "Healing Aura", magic, ["heal", "buff"], named.createHealingAura],
  ["effekseer-fire01", "Curling Flame", fire, ["effekseer", "flame"], named.createCurlingFlame],
  [
    "effekseer-fire02",
    "Flame With Embers",
    fire,
    ["effekseer", "sparks"],
    named.createFlameWithEmbers,
  ],
  ["effekseer-fire03", "Bonfire", fire, ["effekseer", "campfire"], named.createBonfire],
  [
    "effekseer-lightning01",
    "Lightning Burst",
    magic,
    ["effekseer", "electric"],
    named.createLightningBurst,
    "burst",
  ],
  [
    "effekseer-lightning02",
    "Lightning Column",
    magic,
    ["effekseer", "electric"],
    named.createLightningColumn,
  ],
  [
    "effekseer-lightning03",
    "Lightning Sphere",
    magic,
    ["effekseer", "electric"],
    named.createLightningSphere,
  ],
  [
    "effekseer-ice01",
    "Frost Burst",
    magic,
    ["effekseer", "freeze"],
    named.createFrostBurst,
    "burst",
  ],
  ["effekseer-ice02", "Frost Aura", magic, ["effekseer", "cold"], named.createFrostAura],
  [
    "effekseer-ice03",
    "Ice Shatter",
    combat,
    ["effekseer", "shards"],
    named.createIceShatter,
    "burst",
  ],
  ["effekseer-holy01", "Holy Glow", magic, ["effekseer", "blessing"], named.createHolyGlow],
  [
    "effekseer-hit01",
    "Impact Burst",
    combat,
    ["effekseer", "hit"],
    named.createImpactBurst,
    "burst",
  ],
  [
    "effekseer-hit02",
    "Impact Flash",
    combat,
    ["effekseer", "hit"],
    named.createImpactFlash,
    "burst",
  ],
  ["effekseer-wind01", "Wind Streaks", weather, ["effekseer", "gust"], named.createWindStreaks],
  ["effekseer-wind02", "Wind Gust", weather, ["effekseer", "air"], named.createWindGust],
  ["effekseer-wind03", "Whirlwind", weather, ["effekseer", "tornado"], named.createWhirlwind],
  ["kenney-slash-arc", "Slash Arc", combat, ["kenney", "sword"], named.createSlashArc, "burst"],
  [
    "kenney-confetti-burst",
    "Confetti Burst",
    stylized,
    ["kenney", "celebration"],
    named.createConfettiBurst,
    "burst",
  ],
  ["kenney-leaf-swirl", "Leaf Swirl", weather, ["kenney", "autumn"], named.createLeafSwirl],
  ["pixi-bubble-stream", "Bubble Stream", stylized, ["pixi", "water"], named.createBubbleStream],
  [
    "pixi-cartoon-smoke-blast",
    "Cartoon Smoke Blast",
    stylized,
    ["pixi", "poof"],
    named.createCartoonSmokeBlast,
    "burst",
  ],
  ["godot-fireflies", "Fireflies", weather, ["godot", "insects"], named.createFireflies],
  [
    "godot-blood-splash",
    "Blood Splash",
    combat,
    ["godot", "hit"],
    named.createBloodSplash,
    "burst",
  ],
  [
    "godot-shield-break",
    "Shield Break",
    combat,
    ["godot", "shatter"],
    named.createShieldBreak,
    "burst",
  ],
  [
    "godot-waterfall-mist",
    "Waterfall Mist",
    weather,
    ["godot", "spray"],
    named.createWaterfallMist,
  ],
];
const portalId = "godot-portal-vortex";

/**
 * The searchable metadata for all 46 engine gallery effects.
 * @situation browse the engine's particle VFX presets by category, tags and trigger type
 * @example const fire = VFX_PRESETS.find(({ id }) => id === "fire");
 */
export const VFX_PRESETS: readonly IVfxPreset[] = [
  ...recipes.map<IVfxPreset>(([id, name, category, tags, , kind]) => ({
    id,
    name,
    category,
    tags,
    kind: kind ?? "loop",
    defaults,
  })),
  {
    id: portalId,
    name: "Portal Vortex",
    category: magic,
    tags: ["godot", "warp", "gate"],
    kind: "loop",
    defaults,
  },
];

const recipeById = new Map(recipes.map((recipe) => [recipe[0], recipe]));

/**
 * Build the renderable layers of a catalog preset.
 * @situation apply a shared engine VFX preset from its catalog ID and tune its size, speed or tint
 * @constraint add each object with ctx.add for GPU dispatch; use replay for bursts and dispose when finished
 * @override scale, intensity and tint match the catalog controls
 * @example const effect = createVfxPreset("fire", { scale: 1.5 }); for (const layer of effect.objects) ctx.add(layer);
 */
export function createVfxPreset(id: string, overrides: IVfxPresetOverrides = {}): IVfxPresetEffect {
  const recipe = recipeById.get(id);
  if (recipe === undefined && id !== portalId) throw new Error(`Unknown VFX preset: ${id}.`);

  const { scale = 1, intensity = 1, tint } = overrides;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("VFX scale must be positive.");
  if (!Number.isFinite(intensity) || intensity < 0) {
    throw new Error("VFX intensity must be nonnegative.");
  }
  if (tint !== undefined && !/^#[0-9a-f]{6}$/iu.test(tint)) {
    throw new Error("VFX tint must be a six-digit hex color.");
  }

  let started: number | undefined;
  const age = uniform(0).onFrameUpdate(({ time }) => {
    started ??= time;
    return (time - started) * intensity;
  });
  const options = { color: tint, [presetClock]: { age, burst: recipe?.[5] === "burst" } };
  const portal = recipe === undefined ? createPortalVortex(options) : undefined;
  const layers = portal === undefined ? (recipe?.[4](options) ?? []) : [portal.ring];
  const objects: (GPUParticles3D | RibbonField)[] = layers.map(
    (settings) => new GPUParticles3D(settings),
  );
  if (portal !== undefined) objects.push(portal.ribbons);
  for (const object of objects) object.scale.setScalar(scale);

  let disposed = false;
  return {
    objects,
    replay() {
      started = undefined;
      age.value = 0;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const object of objects) {
        object.removeFromParent();
        object.detach();
        if (object instanceof GPUParticles3D) object.material.dispose();
      }
    },
  };
}
