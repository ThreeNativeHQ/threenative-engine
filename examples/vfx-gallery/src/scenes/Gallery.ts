import { GPUParticles3D, type ICtx, Scene, type SceneFrame } from "@threenative/core";
import {
  BoxGeometry,
  Color,
  GridHelper,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  type PerspectiveCamera,
  PlaneGeometry,
  Vector3,
} from "three";
import {
  createBurstFlash,
  createEffekseerHit01,
  createEffekseerHit02,
  createEmberFountain,
  createImpactSparks,
  createMuzzleFlash,
  createSparkStreaks,
} from "../render/combat.js";
import {
  createGodotBloodSplash,
  createGodotFireflies,
  createGodotShieldBreak,
  createGodotWaterfallMist,
  createKenneyConfettiBurst,
  createKenneyLeafSwirl,
  createKenneySlashArc,
  createPixiBubbleStream,
  createPixiCartoonSmokeBlast,
} from "../render/extras.js";
import {
  createAshPlume,
  createDustCloud,
  createEffekseerWind01,
  createEffekseerWind02,
  createEffekseerWind03,
  createExplosionCloud,
  createFire,
  createGroundMist,
  createImpactDust,
  createJetFlame,
  createPoisonCloud,
  createRain,
  createSmoke,
  createSnow,
  createSteamPlume,
} from "../render/fireSmokeWeather.js";
import {
  createEffekseerFire01,
  createEffekseerFire02,
  createEffekseerFire03,
  createEffekseerHoly01,
  createEffekseerIce01,
  createEffekseerIce02,
  createEffekseerIce03,
  createEffekseerLightning01,
  createEffekseerLightning02,
  createEffekseerLightning03,
  createHealingAura,
  createMagicBeam,
  createMagicOrb,
  createMagicWisp,
} from "../render/magic.js";
import { type IPortalVortex, createPortalVortex } from "../render/portalVortex.js";

const EFFECT_IDS = [
  "fire",
  "jet-flame",
  "burst-flash",
  "muzzle-flash",
  "smoke",
  "dust-cloud",
  "steam-plume",
  "ash-plume",
  "explosion-cloud",
  "impact-dust",
  "ground-mist",
  "poison-cloud",
  "rain",
  "snow",
  "spark-streaks",
  "impact-sparks",
  "ember-fountain",
  "magic-wisp",
  "magic-orb",
  "magic-beam",
  "healing-aura",
  "effekseer-fire01",
  "effekseer-fire02",
  "effekseer-fire03",
  "effekseer-lightning01",
  "effekseer-lightning02",
  "effekseer-lightning03",
  "effekseer-ice01",
  "effekseer-ice02",
  "effekseer-ice03",
  "effekseer-holy01",
  "effekseer-hit01",
  "effekseer-hit02",
  "effekseer-wind01",
  "effekseer-wind02",
  "effekseer-wind03",
  "kenney-slash-arc",
  "kenney-confetti-burst",
  "kenney-leaf-swirl",
  "pixi-bubble-stream",
  "pixi-cartoon-smoke-blast",
  "godot-fireflies",
  "godot-portal-vortex",
  "godot-blood-splash",
  "godot-shield-break",
  "godot-waterfall-mist",
] as const;

export const EFFECT_LABELS = [
  { name: "Fire", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Jet Flame", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Burst Flash", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Muzzle Flash", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Smoke", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Dust Cloud", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Steam Plume", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Ash Plume", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Explosion Cloud", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Impact Dust", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Ground Mist", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Poison Cloud", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Rain", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Snow", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Spark Streaks", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Impact Sparks", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Ember Fountain", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Magic Wisp", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Magic Orb", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Magic Beam", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Healing Aura", group: "webgpu-vfx", credit: "MIT PARAMETER PORT" },
  { name: "Effekseer Fire 01", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Fire 02", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Fire 03", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Lightning 01", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Lightning 02", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Lightning 03", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Ice 01", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Ice 02", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Ice 03", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Holy 01", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Hit 01", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Hit 02", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Wind 01", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Wind 02", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Effekseer Wind 03", group: "Effekseer", credit: "CC0 FAMILY RECREATION" },
  { name: "Kenney Slash Arc", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Kenney Confetti Burst", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Kenney Leaf Swirl", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Pixi Bubble Stream", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Pixi Cartoon Smoke Blast", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Godot Fireflies", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Godot Portal Vortex", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Godot Blood Splash", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Godot Shield Break", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
  { name: "Godot Waterfall Mist", group: "extras", credit: "SOURCE-GUIDED RECREATION" },
] as const;

const PAGE_SIZE = 9;
const PAGE_COUNT = Math.ceil(EFFECT_IDS.length / PAGE_SIZE);
const COLUMN_COUNT = 3;
const COLUMN_WIDTH = 4;
const ROW_DEPTH = 3.2;
/** Metres the camera slides sideways per pan; two of the three columns leave the view. */
const PAN_STEP = 16;
/** A frame target no GPU meets, so the measured compute reads as over its share. */
const TIGHT_BUDGET_FPS = 2000;
const RATIO_WINDOW_RENDERS = 60;

/**
 * The frame target the gallery reports to the engine. `?` switches it at run time so one scenario
 * can take the frame over budget and back without reloading.
 */
export const budgetKnob: { maxFps: number | undefined } = { maxFps: undefined };

export type GalleryState = {
  readonly appliedIds: readonly string[];
  readonly evaluatedTiles: number;
  readonly missingTiles: readonly string[];
  readonly page: number;
  readonly pagesVisited: number;
  readonly burstCommands: number;
  readonly gpuCapacity: number;
  readonly portalRingDispatches: number;
  readonly portalRibbonDispatches: number;
  readonly cullOn: boolean;
  readonly panned: boolean;
  readonly tightBudget: boolean;
  readonly emitterCount: number;
  readonly pausedEmitters: number;
  readonly outsideViewPaused: number;
  readonly overBudgetPaused: number;
  readonly pausedWithoutReason: number;
  /** Simulation dispatches per emitter per render over the last 60 renders. */
  readonly dispatchRatio: number;
  /** The same ratio over the emitters that were running; 1 means every one still animates. */
  readonly runningDispatchRatio: number;
  /** `dispatchRatio` captured when the cull was switched on: the panned view with the cull off. */
  readonly baselineRatio: number;
  /** `dispatchRatio` and the paused share captured when the camera pans back: the cull-on pan. */
  readonly culledRatio: number;
  readonly culledPausedFraction: number;
  /** Emitters yielded to the budget at the moment it was relaxed, and whether the least significant went first. */
  readonly yieldedPeak: number;
  readonly yieldedLeastFirst: boolean;
  /** Shortest time any emitter held a cull state before changing it; 0 until one changed twice. */
  readonly shortestDwellSeconds: number;
};

type GalleryCtx = ICtx<GalleryState>;

const initialState: GalleryState = {
  appliedIds: [],
  evaluatedTiles: 0,
  missingTiles: [...EFFECT_IDS],
  page: 0,
  pagesVisited: 1,
  burstCommands: 0,
  gpuCapacity: 0,
  portalRingDispatches: 0,
  portalRibbonDispatches: 0,
  cullOn: true,
  panned: false,
  tightBudget: false,
  emitterCount: 0,
  pausedEmitters: 0,
  outsideViewPaused: 0,
  overBudgetPaused: 0,
  pausedWithoutReason: 0,
  dispatchRatio: 0,
  runningDispatchRatio: 0,
  baselineRatio: 0,
  culledRatio: 0,
  culledPausedFraction: 0,
  yieldedPeak: 0,
  yieldedLeastFirst: false,
  shortestDwellSeconds: 0,
};

type GalleryEvent = { readonly [key: string]: string | number };
const events: GalleryEvent[] = [];

export function drainGalleryEvents(): GalleryEvent[] {
  return events.splice(0, events.length);
}

class GalleryEffectEntity {
  readonly effectId: string;
  readonly page: number;
  #objects: readonly Object3D[] = [];
  #spawnCommands = 0;
  #gpuCapacity = 0;
  #activated = false;
  readonly #placeholder = new Object3D();

  constructor(effectId: string, page: number) {
    this.effectId = effectId;
    this.page = page;
  }

  get mesh(): Object3D {
    return this.#objects[0] ?? this.#placeholder;
  }

  get objects(): readonly Object3D[] {
    return this.#objects;
  }

  get spawnCommands(): number {
    return this.#spawnCommands;
  }

  get gpuCapacity(): number {
    return this.#gpuCapacity;
  }

  setObjects(objects: readonly Object3D[], gpuCapacity: number, spawnCommands: number): void {
    this.deactivate();
    this.#objects = objects;
    this.#gpuCapacity = gpuCapacity;
    this.#spawnCommands = spawnCommands;
    this.#activated = true;
    for (const object of objects) object.visible = true;
    for (const object of objects) {
      if (object instanceof GPUParticles3D) object.emitting = true;
    }
  }

  deactivate(): void {
    for (const object of this.#objects) object.removeFromParent();
    this.#objects = [];
  }

  debug(): Record<string, unknown> {
    return {
      effectId: this.effectId,
      gpuCapacity: this.gpuCapacity,
      spawnCommands: this.spawnCommands,
      evaluated: this.#activated,
      dispatches: this.#objects.reduce(
        (total, object) => total + (object instanceof GPUParticles3D ? object.dispatches : 0),
        0,
      ),
      culled: this.#objects.filter(
        (object) => object instanceof GPUParticles3D && object.cull.state !== "running",
      ).length,
    };
  }
}

type GalleryParticleOptions = ConstructorParameters<typeof GPUParticles3D>[0];
type GalleryEffectFactory = (seed: number) => readonly GalleryParticleOptions[];
type GalleryEffectDefinition = {
  readonly id: string;
  readonly index: number;
  readonly factory: GalleryEffectFactory;
  readonly seed: number;
};

const EFFECT_DEFINITIONS: readonly GalleryEffectDefinition[] = [
  { id: "fire", index: 0, factory: createFire, seed: 11 },
  { id: "jet-flame", index: 1, factory: createJetFlame, seed: 13 },
  { id: "burst-flash", index: 2, factory: createBurstFlash, seed: 71 },
  { id: "muzzle-flash", index: 3, factory: createMuzzleFlash, seed: 73 },
  { id: "smoke", index: 4, factory: createSmoke, seed: 17 },
  { id: "dust-cloud", index: 5, factory: createDustCloud, seed: 19 },
  { id: "steam-plume", index: 6, factory: createSteamPlume, seed: 23 },
  { id: "ash-plume", index: 7, factory: createAshPlume, seed: 29 },
  { id: "explosion-cloud", index: 8, factory: createExplosionCloud, seed: 31 },
  { id: "impact-dust", index: 9, factory: createImpactDust, seed: 37 },
  { id: "ground-mist", index: 10, factory: createGroundMist, seed: 41 },
  { id: "poison-cloud", index: 11, factory: createPoisonCloud, seed: 43 },
  { id: "rain", index: 12, factory: createRain, seed: 47 },
  { id: "snow", index: 13, factory: createSnow, seed: 53 },
  { id: "spark-streaks", index: 14, factory: createSparkStreaks, seed: 79 },
  { id: "impact-sparks", index: 15, factory: createImpactSparks, seed: 83 },
  { id: "ember-fountain", index: 16, factory: createEmberFountain, seed: 89 },
  { id: "magic-wisp", index: 17, factory: createMagicWisp, seed: 103 },
  { id: "magic-orb", index: 18, factory: createMagicOrb, seed: 107 },
  { id: "magic-beam", index: 19, factory: createMagicBeam, seed: 109 },
  { id: "healing-aura", index: 20, factory: createHealingAura, seed: 113 },
  { id: "effekseer-fire01", index: 21, factory: createEffekseerFire01, seed: 127 },
  { id: "effekseer-fire02", index: 22, factory: createEffekseerFire02, seed: 131 },
  { id: "effekseer-fire03", index: 23, factory: createEffekseerFire03, seed: 137 },
  { id: "effekseer-lightning01", index: 24, factory: createEffekseerLightning01, seed: 139 },
  { id: "effekseer-lightning02", index: 25, factory: createEffekseerLightning02, seed: 149 },
  { id: "effekseer-lightning03", index: 26, factory: createEffekseerLightning03, seed: 151 },
  { id: "effekseer-ice01", index: 27, factory: createEffekseerIce01, seed: 157 },
  { id: "effekseer-ice02", index: 28, factory: createEffekseerIce02, seed: 163 },
  { id: "effekseer-ice03", index: 29, factory: createEffekseerIce03, seed: 167 },
  { id: "effekseer-holy01", index: 30, factory: createEffekseerHoly01, seed: 173 },
  { id: "effekseer-hit01", index: 31, factory: createEffekseerHit01, seed: 97 },
  { id: "effekseer-hit02", index: 32, factory: createEffekseerHit02, seed: 101 },
  { id: "effekseer-wind01", index: 33, factory: createEffekseerWind01, seed: 59 },
  { id: "effekseer-wind02", index: 34, factory: createEffekseerWind02, seed: 61 },
  { id: "effekseer-wind03", index: 35, factory: createEffekseerWind03, seed: 67 },
  { id: "kenney-slash-arc", index: 36, factory: createKenneySlashArc, seed: 179 },
  { id: "kenney-confetti-burst", index: 37, factory: createKenneyConfettiBurst, seed: 181 },
  { id: "kenney-leaf-swirl", index: 38, factory: createKenneyLeafSwirl, seed: 191 },
  { id: "pixi-bubble-stream", index: 39, factory: createPixiBubbleStream, seed: 193 },
  { id: "pixi-cartoon-smoke-blast", index: 40, factory: createPixiCartoonSmokeBlast, seed: 197 },
  { id: "godot-fireflies", index: 41, factory: createGodotFireflies, seed: 199 },
  { id: "godot-blood-splash", index: 43, factory: createGodotBloodSplash, seed: 211 },
  { id: "godot-shield-break", index: 44, factory: createGodotShieldBreak, seed: 223 },
  { id: "godot-waterfall-mist", index: 45, factory: createGodotWaterfallMist, seed: 227 },
];

function tilePosition(index: number): Vector3 {
  const slot = index % PAGE_SIZE;
  const column = slot % COLUMN_COUNT;
  const row = Math.floor(slot / COLUMN_COUNT);
  return new Vector3((column - (COLUMN_COUNT - 1) / 2) * COLUMN_WIDTH, 0.18, (row - 1) * ROW_DEPTH);
}

function createGalleryStage(ctx: GalleryCtx): void {
  const floor = ctx.add(
    new Mesh(
      new PlaneGeometry(22, 18),
      new MeshBasicMaterial({ color: 0x050a16, depthWrite: true }),
    ),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02;

  const grid = ctx.add(new GridHelper(22, 22, 0x111a28, 0x091222));
  grid.position.y = 0.005;

  for (let slot = 0; slot < PAGE_SIZE; slot += 1) {
    const plate = ctx.add(
      new Mesh(
        new BoxGeometry(2.6, 0.11, 2.1),
        new MeshBasicMaterial({ color: 0x071020, transparent: true, opacity: 0.88 }),
      ),
    );
    plate.position.copy(tilePosition(slot));
    plate.position.y = 0.055;
  }
}

export class Gallery extends Scene<GalleryState> {
  static override readonly initialState = initialState;

  override enter(ctx: GalleryCtx): SceneFrame<GalleryState> {
    const camera = ctx.camera as PerspectiveCamera;
    camera.position.set(0, 8.35, 11.8);
    camera.lookAt(0, 0.65, 0);
    ctx.viewport.resize();
    ctx.add(camera);
    ctx.scene.background = new Color(0x050a16);
    createGalleryStage(ctx);

    const effectEntities = new Map<string, GalleryEffectEntity>();
    for (const [index, id] of EFFECT_IDS.entries()) {
      const entity = new GalleryEffectEntity(id, Math.floor(index / PAGE_SIZE));
      effectEntities.set(id, entity);
      ctx.entities.add(id, entity);
    }

    let portal: IPortalVortex | undefined;
    const entityFor = (id: string): GalleryEffectEntity => {
      const entity = effectEntities.get(id);
      if (entity === undefined) throw new Error(`VFX gallery effect was not registered: ${id}`);
      return entity;
    };

    let cullOn = true;
    const graceSeconds = (): number => (cullOn ? 1 : Number.POSITIVE_INFINITY);
    const pageEmitters = (): GPUParticles3D[] =>
      [...effectEntities.values()].flatMap((entity) =>
        entity.objects.filter(
          (object): object is GPUParticles3D => object instanceof GPUParticles3D,
        ),
      );

    const mountParticles = (definition: GalleryEffectDefinition): void => {
      const position = tilePosition(definition.index);
      const particles = definition.factory(definition.seed).map((option, layerIndex) => {
        const particle = ctx.add(new GPUParticles3D(option));
        particle.name = `vfx-${definition.id}-${layerIndex}`;
        particle.position.copy(position);
        particle.graceSeconds = graceSeconds();
        return particle;
      });
      entityFor(definition.id).setObjects(
        particles,
        particles.reduce((total, particle) => total + particle.amount, 0),
        particles.length,
      );
    };

    const mountPortal = (): void => {
      const nextPortal = createPortalVortex(229);
      const portalRing = ctx.add(new GPUParticles3D(nextPortal.ring));
      portalRing.name = "vfx-godot-portal-vortex-ring";
      portalRing.position.copy(tilePosition(42));
      const portalRibbons = ctx.add(nextPortal.ribbons);
      portalRibbons.name = "vfx-godot-portal-vortex-ribbons";
      portalRibbons.position.copy(tilePosition(42));
      entityFor("godot-portal-vortex").setObjects(
        [portalRing, portalRibbons],
        nextPortal.gpuCapacity,
        nextPortal.spawnCommands,
      );
      portal = nextPortal;
    };

    const visitedPages = new Set<number>([0]);
    const mountPage = (page: number): void => {
      for (const entity of effectEntities.values()) entity.deactivate();
      for (const definition of EFFECT_DEFINITIONS) {
        if (Math.floor(definition.index / PAGE_SIZE) === page) mountParticles(definition);
      }
      if (page === Math.floor(42 / PAGE_SIZE)) mountPortal();
      visitedPages.add(page);
    };

    mountPage(0);

    if (typeof window !== "undefined") {
      window.addEventListener("threenative-gallery-retrigger", () => {
        const page = ctx.state.getState().page;
        for (const entity of effectEntities.values()) {
          if (entity.page !== page) continue;
          for (const object of entity.objects) {
            if (object instanceof GPUParticles3D) object.restart();
          }
        }
      });
    }

    // One sample per RATIO_WINDOW_RENDERS draws: what the emitters dispatched, what state they are
    // in and why. The playtest reads these numbers; nothing here changes how an emitter behaves.
    const lastDispatches = new Map<GPUParticles3D, number>();
    const lastTransitions = new Map<GPUParticles3D, { count: number; at: number }>();
    let shortestDwell = Number.POSITIVE_INFINITY;
    const latest = { ratio: 0, pausedFraction: 0, overBudget: 0, leastFirst: false };
    let renders = 0;
    ctx.beforeRender(() => {
      const now = performance.now() / 1000;
      const emitters = pageEmitters();
      for (const emitter of emitters) {
        const known = lastTransitions.get(emitter);
        if (known === undefined) {
          lastTransitions.set(emitter, { count: emitter.cull.transitions, at: now });
        } else if (known.count !== emitter.cull.transitions) {
          // The first change has no earlier change to measure a dwell against.
          if (known.count > 0) shortestDwell = Math.min(shortestDwell, now - known.at);
          known.count = emitter.cull.transitions;
          known.at = now;
        }
      }
      renders += 1;
      if (renders % RATIO_WINDOW_RENDERS !== 0 || emitters.length === 0) return;
      let delta = 0;
      let runningDelta = 0;
      let running = 0;
      let outsideView = 0;
      let overBudget = 0;
      let unnamed = 0;
      const camera = ctx.camera;
      let pausedMax = Number.NEGATIVE_INFINITY;
      let runningMin = Number.POSITIVE_INFINITY;
      for (const emitter of emitters) {
        const stepped = emitter.dispatches - (lastDispatches.get(emitter) ?? 0);
        lastDispatches.set(emitter, emitter.dispatches);
        delta += stepped;
        const significance = emitter.budget.significance(camera);
        if (emitter.cull.state === "running") {
          running += 1;
          runningDelta += stepped;
          if (significance !== undefined) runningMin = Math.min(runningMin, significance);
          continue;
        }
        if (emitter.cull.reason === "outside-view") outsideView += 1;
        else if (emitter.cull.reason === "over-budget") overBudget += 1;
        else unnamed += 1;
        if (significance !== undefined) pausedMax = Math.max(pausedMax, significance);
      }
      latest.ratio = delta / (RATIO_WINDOW_RENDERS * emitters.length);
      latest.pausedFraction = (emitters.length - running) / emitters.length;
      latest.overBudget = overBudget;
      latest.leastFirst = pausedMax <= runningMin;
      ctx.state.set({
        emitterCount: emitters.length,
        pausedEmitters: emitters.length - running,
        outsideViewPaused: outsideView,
        overBudgetPaused: overBudget,
        pausedWithoutReason: unnamed,
        dispatchRatio: latest.ratio,
        runningDispatchRatio: running === 0 ? 0 : runningDelta / (RATIO_WINDOW_RENDERS * running),
        shortestDwellSeconds: Number.isFinite(shortestDwell) ? shortestDwell : 0,
      });
    });

    return (frameCtx) => {
      const camera = ctx.camera as PerspectiveCamera;
      if (frameCtx.input.justPressed("panLeft") && cullOn) {
        // The cull-on pan, read before the camera returns and the emitters resume.
        frameCtx.state.set({
          culledRatio: latest.ratio,
          culledPausedFraction: latest.pausedFraction,
        });
      }
      if (frameCtx.input.justPressed("panRight") || frameCtx.input.justPressed("panLeft")) {
        camera.position.x += frameCtx.input.justPressed("panRight") ? PAN_STEP : -PAN_STEP;
        frameCtx.state.set({ panned: Math.abs(camera.position.x) > PAN_STEP / 2 });
      }
      if (frameCtx.input.justPressed("toggleCull")) {
        cullOn = !cullOn;
        // The ratio sampled while the cull was off is the control the cull-on ratio is judged
        // against, so it is kept before the state flips.
        for (const emitter of pageEmitters()) emitter.graceSeconds = graceSeconds();
        frameCtx.state.set(cullOn ? { cullOn, baselineRatio: latest.ratio } : { cullOn });
      }
      if (frameCtx.input.justPressed("toggleBudget")) {
        const tightBudget = budgetKnob.maxFps === undefined;
        budgetKnob.maxFps = tightBudget ? TIGHT_BUDGET_FPS : undefined;
        // Relaxing the budget reads what the tight one had yielded, before anything resumes.
        frameCtx.state.set(
          tightBudget
            ? { tightBudget }
            : { tightBudget, yieldedPeak: latest.overBudget, yieldedLeastFirst: latest.leastFirst },
        );
      }
      if (frameCtx.input.justPressed("nextPage")) {
        const page = (frameCtx.state.getState().page + 1) % PAGE_COUNT;
        mountPage(page);
        const portalDispatches = portal?.ribbons.dispatches ?? 0;
        const complete = visitedPages.size === PAGE_COUNT;
        frameCtx.state.set({
          appliedIds: complete ? [...EFFECT_IDS] : [],
          evaluatedTiles: complete ? EFFECT_IDS.length : 0,
          missingTiles: complete ? [] : [...EFFECT_IDS],
          page,
          pagesVisited: frameCtx.state.getState().pagesVisited + 1,
          burstCommands: complete ? EFFECT_IDS.length : 0,
          gpuCapacity: EFFECT_IDS.reduce((total, id) => total + entityFor(id).gpuCapacity, 0),
          portalRingDispatches: portalDispatches > 0 ? 1 : 0,
          portalRibbonDispatches: portalDispatches,
        });
        events.push({ entity: "gallery", name: "coverage", count: EFFECT_IDS.length });
        events.push({ entity: "gallery", name: "page", page });
        if (portalDispatches > 0) {
          events.push({
            entity: "godot-portal-vortex",
            name: "compute-updated",
            dispatches: portalDispatches,
          });
        }
      }
    };
  }
}
